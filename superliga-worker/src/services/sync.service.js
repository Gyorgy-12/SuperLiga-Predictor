import { normalizeLiveMatch } from '../core/normalize-live.js';
import { interestingFixtures } from '../core/match-window.js';
import { kickoffMs } from '../utils/time.js';
import { mergeLiveResults, getLiveSnapshot } from './memory-cache.service.js';
import { readStoredResults, writeFinalIfChanged } from './results.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchSofaScoreEvents } from '../sources/sofascore-events-source.js';
import { fetchEspnEvents } from '../sources/espn-source.js';
import { fetchFlashscoreEvents, fetchFlashscoreMatchDetails } from '../sources/flashscore-source.js';
import { discoverFlashscoreMids } from '../sources/flashscore-mid-discovery-source.js';
import { fetchOfficialSuperligaEvents, fetchOfficialSuperligaMatchDetails } from '../sources/official-superliga-source.js';

export async function syncLive(env, opts = {}) {
  const fixtures = await getFixtures(env);
  const stored = await readStoredResults(env);
  const active = Array.isArray(opts.activeFixtures)
    ? opts.activeFixtures
    : selectActiveFixtures(fixtures, stored.results, opts);

  if (!active.length && !opts.force) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_interesting_fixtures',
      results: getLiveSnapshot().results,
      active: []
    };
  }

  const commonOpts = {
    ...opts,
    includeScheduled: opts.includeScheduled || opts.scheduled,
    date: opts.date,
    maxDates: opts.maxDates || env.LIVE_SOURCE_MAX_DATES || undefined
  };

  const incidentOpts = {
    ...commonOpts,
    includeIncidents: true,
    detailLimit: opts.detailLimit || opts.matchDetailLimit || env.INCIDENT_DETAIL_LIMIT || 12
  };

  // Flashscore-first pipeline:
  // 1) Flashscore is both the score master and the incident master.
  // 2) LiveScore is intentionally not called anywhere in the production sync path.
  // 3) Official/ESPN/SofaScore remain narrow fallbacks only when Flashscore has no usable live row.
  // The compact Flashscore list feed is the only source in this pipeline
  // that carries the actual running clock. Detail incidents contain event
  // minutes, which are not the same thing as the current minute.
  const now = Date.now();
  const clockFixtures = active.filter(fixture => {
    const ko = kickoffMs(fixture);
    return Number.isFinite(ko) && now >= ko - 15 * 60_000 && now <= ko + 4 * 60 * 60_000;
  });
  const flashscoreClockPack = clockFixtures.length
    ? await discoverFlashscoreMids(env, clockFixtures, {
        ...commonOpts,
        maxFeeds: Math.min(6, Number(env.FLASHSCORE_CLOCK_MAX_FEEDS || 4)),
        matchThreshold: 80,
        ambiguityGap: 5
      }).catch(error => sourceErrorPack('flashscore-list-clock', error))
    : skippedSourcePack('flashscore-list-clock', 'no_live_window_fixture');
  const flashscoreListClockById = Object.fromEntries(
    (flashscoreClockPack.matched || []).map(row => [String(row.id), row])
  );

  const flashscorePack = await fetchStoredFlashscoreIncidents(env, active, {
    ...incidentOpts,
    flashscoreListClockById,
    requestBudgetMode: 'strict',
    primaryFeedOnly: true,
    primaryBaseOnly: true,
    pendingOnEmpty: true,
    skipHtml: true,
    feedProbeLimit: 4
  }).catch(error => sourceErrorPack('flashscore-stored-details', error));

  const flashPendingIds = new Set();
  const officialActive = [];
  for (const fixture of active) {
    const id = String(fixture.id);
    const flash = flashscorePack.results?.[id];
    if (isPendingFeedResult(flash)) flashPendingIds.add(id);
    if (needsSecondaryProviderFlashFirst(flash, fixture, opts)) officialActive.push(fixture);
  }

  let officialPack = skippedSourcePack('official-superliga-stored-details-b26', 'flashscore_usable_or_pending');
  if (officialActive.length) {
    officialPack = await fetchStoredOfficialFinalizer(env, officialActive, incidentOpts)
      .catch(error => sourceErrorPack('official-superliga-stored-details', error));
  }

  const primaryResolvedIds = new Set();
  const fallbackActive = [];
  for (const fixture of active) {
    const id = String(fixture.id);
    const flash = flashscorePack.results?.[id];
    const official = officialPack.results?.[id];
    if (!needsSecondaryProviderFlashFirst(flash, fixture, opts) || providerClosesPrimaryGap(flash, official)) primaryResolvedIds.add(id);
    else fallbackActive.push(fixture);
  }

  let espnPack = skippedSourcePack('espn-incidents', 'primary_flashscore_or_official_usable');
  if (fallbackActive.length) {
    espnPack = await fetchEspnEvents(env, fallbackActive, { ...incidentOpts, source: 'espn-incidents' })
      .catch(error => sourceErrorPack('espn-incidents', error));
  }

  const sofaActive = fallbackActive.filter(fixture => {
    const id = String(fixture.id);
    const primary = chooseBestProviderResult(
      flashscorePack.results?.[id],
      officialPack.results?.[id],
      null,
      null
    );
    return !providerClosesPrimaryGap(primary, espnPack.results?.[id]);
  });
  let sofaPack = skippedSourcePack('sofascore', fallbackActive.length ? 'espn_fallback_usable_or_no_remaining_fixture' : 'primary_flashscore_or_official_usable');
  if (sofaActive.length) {
    sofaPack = await fetchSofaScoreBudgeted(env, sofaActive, commonOpts)
      .catch(error => sourceErrorPack('sofascore', error));
  }

  const eventPack = combineIncidentPacks(active, flashscorePack, officialPack, espnPack, sofaPack);
  const scorePack = combineScorePacksFlashFirst(active, flashscorePack, officialPack, espnPack, sofaPack);
  const previous = getLiveSnapshot().results || {};
  const merged = mergeScoreAndEvents(active, scorePack.results || {}, eventPack.results || {}, previous);
  const changed = mergeLiveResults(merged, 'sync-live-b26');
  const visibleResults = { ...(getLiveSnapshot().results || {}), ...merged };

  const finalWrites = [];
  for (const match of Object.values(merged)) {
    const write = await writeFinalIfChanged(env, match).catch(error => ({ written: false, id: match.id, error: error?.message || String(error) }));
    if (write.written || write.error) finalWrites.push(write);
  }

  return {
    ok: true,
    source: opts.source || 'sync-live-flashscore-first',
    active: active.map(f => ({
      id: f.id,
      r: f.r,
      date: f.date,
      t: f.t,
      h: f.h,
      a: f.a,
      flashscoreUrl: getFlashscoreUrl(f),
      flashscoreMid: getFlashscoreMid(f),
      officialUrl: getOfficialUrl(f)
    })),
    activeCount: active.length,
    count: Object.keys(merged).length,
    changed,
    scoreSource: summarizeSource(scorePack),
    eventSource: summarizeSource(eventPack),
    finalWrites,
    results: visibleResults,
    updatedAt: new Date().toISOString(),
    debug: opts.debug ? {
      scoreMatched: scorePack.matched || [],
      scoreUnmatched: scorePack.unmatched || [],
      eventMatched: eventPack.matched || [],
      eventUnmatched: eventPack.unmatched || [],
      flashscoreMatched: flashscorePack.matched || [],
      flashscoreUnmatched: flashscorePack.unmatched || [],
      officialMatched: officialPack.matched || [],
      officialUnmatched: officialPack.unmatched || [],
      espnMatched: espnPack.matched || [],
      espnUnmatched: espnPack.unmatched || [],
      sofaMatched: sofaPack.matched || [],
      sofaUnmatched: sofaPack.unmatched || [],
      scoreUrls: scorePack.urls || [],
      eventUrls: eventPack.urls || [],
      flashscoreUrls: flashscorePack.urls || [],
      officialUrls: officialPack.urls || [],
      espnUrls: espnPack.urls || [],
      sofaUrls: sofaPack.urls || [],
      incidentDebug: [
        ...(flashscorePack.incidentDebug || []),
        ...(officialPack.incidentDebug || []),
        ...(espnPack.incidentDebug || []),
        ...(sofaPack.incidentDebug || [])
      ],
      providers: eventPack.providers || {},
      flashscoreClock: summarizeSource(flashscoreClockPack),
      flashscoreClockMatched: flashscoreClockPack.matched || [],
      fallback: {
        flashPendingIds: [...flashPendingIds],
        officialFixtureIds: officialActive.map(f => String(f.id)),
        primaryResolvedIds: [...primaryResolvedIds],
        espnFixtureIds: fallbackActive.map(f => String(f.id)),
        sofaFixtureIds: sofaActive.map(f => String(f.id)),
        espnSkipped: !!espnPack.skipped,
        sofaSkipped: !!sofaPack.skipped
      },
      requestBudget: {
        mode: 'strict-flashscore-first',
        flashscoreMaxRequestsPerFixture: 4,
        flashscorePrimaryFeeds: ['df_sui', 'dc', 'df_dos', 'df_scr'],
        officialOnlyForHardMisses: true,
        liveScoreDisabled: true,
        sofascoreSearchDisabled: true,
        sofascoreSingleBase: true,
        flashscoreProbeRequestCount: (flashscorePack.incidentDebug || []).reduce(
          (sum, row) => sum + (row.feedProbes || []).length,
          0
        ),
        sourceUrlCount: dedupe([
          ...(scorePack.urls || []),
          ...(flashscorePack.urls || []),
          ...(officialPack.urls || []),
          ...(espnPack.urls || []),
          ...(sofaPack.urls || [])
        ]).length
      }
    } : undefined
  };
}

async function fetchStoredFlashscoreIncidents(env, active = [], opts = {}) {
  const detailLimit = clampNumber(opts.detailLimit || opts.matchDetailLimit || env.INCIDENT_DETAIL_LIMIT || 12, 0, 48);
  const results = {};
  const matched = [];
  const unmatched = [];
  const incidentDebug = [];
  const urls = [];

  const rows = active
    .map(fixture => ({ fixture, url: getFlashscoreUrl(fixture), id: getFlashscoreId(fixture), mid: getFlashscoreMid(fixture) }))
    .filter(row => row.url || row.id || row.mid);

  const limitedRows = detailLimit > 0 ? rows.slice(0, detailLimit) : rows;

  for (const row of limitedRows) {
    const input = row.url || row.mid || row.id;
    const detail = await fetchFlashscoreMatchDetails(env, input, {
      ...opts,
      mid: row.mid || opts.mid || opts.flashscoreMid || undefined,
      matchKey: row.mid || opts.matchKey || undefined,
      flashscoreUrl: row.url || undefined,
      requestBudgetMode: opts.requestBudgetMode || 'strict',
      primaryFeedOnly: opts.primaryFeedOnly ?? true,
      primaryBaseOnly: opts.primaryBaseOnly ?? true,
      pendingOnEmpty: opts.pendingOnEmpty ?? true,
      skipHtml: opts.skipHtml ?? true,
      feedProbeLimit: opts.feedProbeLimit || 2,
      fixtureDate: row.fixture.date || undefined,
      fixtureTime: row.fixture.t || row.fixture.time || undefined,
      fixtureTimezone: opts.fixtureTimezone || env?.SCHEDULER_TIMEZONE || 'Europe/Bucharest',
      listClock: opts.flashscoreListClockById?.[String(row.fixture.id)] || null
    });
    const url = detail.url || row.url || buildFlashscoreUrl(row.id);
    urls.push(url);

    const normalized = makeEventResult(row.fixture, detail, {
      provider: 'flashscore',
      url,
      id: row.id,
      mid: row.mid || null,
      sourceUrlField: 'flashscoreUrl',
      sourceIdField: 'flashscoreId'
    });
    results[String(row.fixture.id)] = normalized;

    matched.push({
      id: row.fixture.id,
      date: row.fixture.date,
      h: row.fixture.h,
      a: row.fixture.a,
      provider: 'flashscore',
      url,
      sourceId: row.id || null,
      matchKey: detail.matchKey || row.mid || null,
      flashscoreMid: row.mid || null,
      ok: !!detail.ok,
      status: detail.status || null,
      state: detail.state || null,
      hasScore: !!detail.score,
      incidentCount: countIncidents(normalized),
      signals: detail.signals || null
    });

    incidentDebug.push({
      id: row.fixture.id,
      provider: 'flashscore',
      url,
      matchKey: detail.matchKey || row.mid || null,
      ok: !!detail.ok,
      status: detail.status || null,
      title: detail.title || null,
      score: detail.score || null,
      signals: detail.signals || null,
      feedProbes: (detail.feedProbes || []).map(probe => ({
        label: probe.label || null,
        url: probe.url || null,
        ok: !!probe.ok,
        status: probe.status || null,
        bytes: probe.bytes || 0,
        elapsedMs: probe.elapsedMs || 0,
        error: probe.error || null
      })),
      eventSamples: detail.eventSamples?.slice(0, 8) || [],
      warning: detail.warning || null,
      error: detail.error || null
    });
  }

  const matchedIds = new Set(matched.map(x => String(x.id)));
  for (const fixture of active || []) {
    if (!matchedIds.has(String(fixture.id))) {
      unmatched.push({
        id: fixture.id,
        h: fixture.h,
        a: fixture.a,
        date: fixture.date,
        reason: getFlashscoreUrl(fixture) || getFlashscoreId(fixture) || getFlashscoreMid(fixture) ? 'detail_limit' : 'missing_flashscore_url_or_mid'
      });
    }
  }

  let discovery = null;
  if (unmatched.some(x => x.reason === 'missing_flashscore_url') && (opts.discoverMissing === true || opts.forceDiscover === true)) {
    discovery = await fetchFlashscoreEvents(env, active, { ...opts, includeIncidents: false }).catch(error => ({ ok: false, source: 'flashscore-discovery', error: error?.message || String(error), results: {} }));
  }

  return {
    ok: true,
    source: 'flashscore-stored-details-b26',
    count: Object.keys(results).length,
    results,
    matched,
    unmatched,
    urls: dedupe(urls),
    incidentDebug,
    discovery,
    warnings: discovery?.error ? [discovery.error] : []
  };
}

async function fetchStoredOfficialFinalizer(env, active = [], opts = {}) {
  const detailLimit = clampNumber(opts.officialDetailLimit || opts.detailLimit || opts.matchDetailLimit || env.OFFICIAL_DETAIL_LIMIT || 12, 0, 48);
  const results = {};
  const matched = [];
  const unmatched = [];
  const incidentDebug = [];
  const urls = [];

  const rows = active
    .map(fixture => ({ fixture, url: getOfficialUrl(fixture), id: getOfficialId(fixture) }))
    .filter(row => row.url || row.id);

  const limitedRows = detailLimit > 0 ? rows.slice(0, detailLimit) : rows;

  for (const row of limitedRows) {
    const input = row.url || row.id;
    const detail = await fetchOfficialSuperligaMatchDetails(env, input, { ...opts, fixture: row.fixture });
    const url = detail.url || row.url || buildOfficialUrl(env, row.id);
    urls.push(url);

    const normalized = makeEventResult(row.fixture, detail, {
      provider: 'official-superliga',
      url,
      id: row.id,
      sourceUrlField: 'officialUrl',
      sourceIdField: 'officialId'
    });
    results[String(row.fixture.id)] = normalized;

    matched.push({
      id: row.fixture.id,
      date: row.fixture.date,
      h: row.fixture.h,
      a: row.fixture.a,
      provider: 'official-superliga',
      url,
      sourceId: row.id || null,
      matchKey: detail.matchKey || row.mid || null,
      flashscoreMid: row.mid || null,
      ok: !!detail.ok,
      status: detail.status || null,
      hasScore: !!detail.score,
      incidentCount: countIncidents(normalized),
      signals: detail.signals || null
    });

    incidentDebug.push({
      id: row.fixture.id,
      provider: 'official-superliga',
      url,
      ok: !!detail.ok,
      status: detail.status || null,
      title: detail.title || null,
      score: detail.score || null,
      scoreDebug: detail.scoreDebug || null,
      signals: detail.signals || null,
      eventSamples: detail.eventSamples?.slice(0, 8) || [],
      warning: detail.warning || null,
      error: detail.error || null
    });
  }

  const matchedIds = new Set(matched.map(x => String(x.id)));
  for (const fixture of active || []) {
    if (!matchedIds.has(String(fixture.id))) {
      unmatched.push({
        id: fixture.id,
        h: fixture.h,
        a: fixture.a,
        date: fixture.date,
        reason: getOfficialUrl(fixture) || getOfficialId(fixture) ? 'detail_limit' : 'missing_official_url'
      });
    }
  }

  let discovery = null;
  if (unmatched.some(x => x.reason === 'missing_official_url') && (opts.discoverMissing === true || opts.forceDiscover === true)) {
    discovery = await fetchOfficialSuperligaEvents(env, active, { ...opts, includeIncidents: false }).catch(error => ({ ok: false, source: 'official-discovery', error: error?.message || String(error), results: {} }));
  }

  return {
    ok: true,
    source: 'official-superliga-stored-details-b26',
    count: Object.keys(results).length,
    results,
    matched,
    unmatched,
    urls: dedupe(urls),
    incidentDebug,
    discovery,
    warnings: discovery?.error ? [discovery.error] : []
  };
}

function makeEventResult(fixture, detail = {}, meta = {}) {
  const score = detail.score || null;
  const state = detail.state || (score || detail.events?.length ? 'event_feed' : (detail.meta && Object.keys(detail.meta).length ? 'prematch' : 'unknown'));
  const isPrematch = state === 'prematch' || state === 'pending_feed';
  const providerStatus = String(detail.matchStatus || detail.statusText || detail.matchState || '').trim().toUpperCase();
  const providerFinished = detail.finished === true || ['FT', 'AET', 'PEN', 'FULL_TIME', 'COMPLETE', 'FINISHED', 'FINAL'].includes(providerStatus);
  const inferredFinished = !isPrematch && !providerFinished && shouldSafelyFinalizeFlashscoreFixture(fixture, detail, score);
  const finished = providerFinished || inferredFinished;
  const started = !isPrematch && (finished || detail.started === true || !!score || !!detail.events?.length);
  const finalStatus = providerStatus === 'AET' || providerStatus === 'PEN' ? providerStatus : 'FT';
  const status = state === 'pending_feed'
    ? 'PENDING_FEED'
    : isPrematch
      ? 'PREMATCH'
      : finished
        ? finalStatus
        : (providerStatus || (score ? 'DETAIL_SCORE' : null));
  const row = {
    id: fixture.id,
    group: fixture.g || 'SL',
    round: fixture.r || null,
    homeTeam: fixture.h,
    awayTeam: fixture.a,
    date: fixture.date,
    started,
    finished,
    status,
    minute: finished ? null : (detail.minute ?? null),
    providerMinute: finished ? null : (detail.providerMinute ?? detail.minute ?? null),
    latestIncidentMinute: detail.latestIncidentMinute ?? null,
    minuteSource: detail.minuteSource || (detail.providerMinute != null ? 'provider-list' : null),
    clockObservedAt: detail.clockObservedAt || null,
    h: score?.h ?? detail.h ?? null,
    a: score?.a ?? detail.a ?? null,
    pH: detail.pH ?? null,
    pA: detail.pA ?? null,
    scorers: detail.scorers || [],
    yellowCards: detail.yellowCards || [],
    redCards: detail.redCards || [],
    doubleYellowCards: detail.doubleYellowCards || [],
    substitutions: detail.substitutions || [],
    penalties: detail.penalties || [],
    matchMeta: detail.meta && Object.keys(detail.meta).length ? detail.meta : undefined,
    flashscoreState: meta.provider === 'flashscore' ? state : undefined,
    prematch: isPrematch,
    feedValid: detail.signals?.feedUseful === true || state === 'pending_feed' || detail.ok === true,
    eventSource: meta.provider || detail.source || null,
    scoreSource: score ? (meta.provider || detail.source || null) : null,
    source: meta.provider || detail.source || null,
    updatedAt: new Date().toISOString()
  };

  if (inferredFinished) {
    row.finalInferred = true;
    row.finalInferenceReason = 'kickoff_age_and_90plus_event';
  }
  if (meta.sourceUrlField) row[meta.sourceUrlField] = meta.url || null;
  if (meta.sourceIdField) row[meta.sourceIdField] = meta.id || null;
  if (meta.mid) row.flashscoreMid = meta.mid;
  return row;
}

function shouldSafelyFinalizeFlashscoreFixture(fixture, detail = {}, score = null, now = Date.now()) {
  if (!score || !Number.isFinite(Number(score.h)) || !Number.isFinite(Number(score.a))) return false;
  const ko = kickoffMs(fixture);
  if (!Number.isFinite(ko)) return false;
  const elapsedMinutes = (now - ko) / 60_000;
  if (elapsedMinutes < 130) return false;

  const minuteValues = [
    detail.minute,
    ...(detail.events || []).map(row => row?.minute),
    ...(detail.scorers || []).map(row => row?.minute),
    ...(detail.yellowCards || []).map(row => row?.minute),
    ...(detail.redCards || []).map(row => row?.minute),
    ...(detail.doubleYellowCards || []).map(row => row?.minute),
    ...(detail.substitutions || []).map(row => row?.minute),
    ...(detail.penalties || []).map(row => row?.minute)
  ];
  const latestMinute = minuteValues.reduce((max, value) => Math.max(max, eventMinuteNumber(value)), -1);

  // At 130+ minutes after kickoff, a 90th-minute event means the provider's
  // event feed has simply failed to expose FT. At 155+ minutes even an empty
  // incident list is safe to finalize when a real score exists.
  return latestMinute >= 90 || elapsedMinutes >= 155;
}

function eventMinuteNumber(value) {
  const text = String(value ?? '').replace(/[’'′]/g, '').trim();
  if (!text) return -1;
  const match = text.match(/(\d{1,3})(?:\+(\d{1,2}))?/);
  if (!match) return -1;
  const base = Number(match[1]);
  const added = Number(match[2] || 0);
  return Number.isFinite(base) ? base + (Number.isFinite(added) ? added / 100 : 0) : -1;
}

async function fetchSofaScoreBudgeted(env, fixtures = [], opts = {}) {
  const dates = dedupe((fixtures || []).map(f => String(f?.date || '').slice(0, 10)).filter(Boolean));
  const base = String(
    opts.sofascoreBase ||
    env.SOFASCORE_API_BASE_URL ||
    env.SOFASCORE_BASE_URL ||
    'https://www.sofascore.com/api/v1'
  ).replace(/\/$/, '');

  return fetchSofaScoreEvents(env, fixtures, {
    ...opts,
    base,
    sofascoreBase: base,
    singleBase: true,
    baseOnly: true,
    skipSearch: true,
    searchLimit: 0,
    maxDates: Math.max(1, dates.length),
    skipPrematchIncidents: true,
    requestBudgetMode: 'strict'
  });
}

function combineScorePacksFlashFirst(active, flashscorePack = {}, officialPack = {}, espnPack = {}, sofaPack = {}) {
  const results = {};
  const matched = [];
  const unmatched = [];

  for (const fixture of active || []) {
    const id = String(fixture.id);
    const candidates = [
      flashscorePack.results?.[id],
      officialPack.results?.[id],
      espnPack.results?.[id],
      sofaPack.results?.[id]
    ];
    const chosen = candidates.find(hasUsableScoreSignal) || candidates.find(isProviderResultUsable) || null;
    if (chosen) {
      results[id] = chosen;
      matched.push({ id: fixture.id, h: fixture.h, a: fixture.a, provider: chosen.scoreSource || chosen.source || chosen.eventSource || 'fallback' });
    } else {
      unmatched.push({ id: fixture.id, h: fixture.h, a: fixture.a, date: fixture.date });
    }
  }

  return {
    ok: true,
    source: 'flashscore-first-score-pack',
    count: Object.keys(results).length,
    results,
    matched,
    unmatched,
    urls: dedupe([
      ...(flashscorePack.urls || []),
      ...(officialPack.urls || []),
      ...(espnPack.urls || []),
      ...(sofaPack.urls || [])
    ]),
    providers: {
      flashscore: summarizeSource(flashscorePack),
      official: summarizeSource(officialPack),
      espn: summarizeSource(espnPack),
      sofascore: summarizeSource(sofaPack)
    }
  };
}

function hasUsableScoreSignal(row) {
  return !!(
    row &&
    ((row.h != null && row.a != null) || row.started || row.finished ||
      /^(LIVE|HT|FT|AET|PEN|1H|2H|ET|BREAK)$/i.test(String(row.status || '').trim()))
  );
}

function combineIncidentPacks(active, flashscorePack = {}, officialPack = {}, espnPack = {}, sofaPack = {}) {
  const results = {};
  const matched = [];
  const unmatched = [];

  for (const fixture of active || []) {
    const id = String(fixture.id);
    const flash = flashscorePack.results?.[id];
    const official = officialPack.results?.[id];
    const espn = espnPack.results?.[id];
    const sofa = sofaPack.results?.[id];

    const chosen = chooseBestProviderResult(flash, official, espn, sofa);
    if (chosen) results[id] = chosen;
  }

  if (Array.isArray(flashscorePack.matched)) matched.push(...flashscorePack.matched.map(x => ({ ...x, provider: x.provider || 'flashscore' })));
  if (Array.isArray(officialPack.matched)) matched.push(...officialPack.matched.map(x => ({ ...x, provider: x.provider || 'official-superliga' })));
  if (Array.isArray(espnPack.matched)) matched.push(...espnPack.matched.map(x => ({ ...x, provider: x.provider || 'espn' })));
  if (Array.isArray(sofaPack.matched)) matched.push(...sofaPack.matched.map(x => ({ ...x, provider: x.provider || 'sofascore' })));

  const matchedIds = new Set(matched.map(x => String(x.id)));
  for (const fixture of active || []) {
    if (!matchedIds.has(String(fixture.id))) unmatched.push({ id: fixture.id, h: fixture.h, a: fixture.a, date: fixture.date });
  }

  return {
    ok: !!(flashscorePack.ok || officialPack.ok || espnPack.ok || sofaPack.ok),
    source: hasAnyIncidents(results) ? 'flashscore-official-fallback-incidents-b26' : 'flashscore-official-fallback-detail-b26',
    count: Object.keys(results).length,
    results,
    matched,
    unmatched,
    warnings: [
      ...(flashscorePack.warnings || []),
      ...(officialPack.warnings || []),
      ...(espnPack.warnings || []),
      ...(sofaPack.warnings || [])
    ],
    providers: {
      flashscore: summarizeSource(flashscorePack),
      official: summarizeSource(officialPack),
      espn: summarizeSource(espnPack),
      sofascore: summarizeSource(sofaPack)
    },
    urls: [
      ...(flashscorePack.urls || []),
      ...(officialPack.urls || []),
      ...(espnPack.urls || []),
      ...(sofaPack.urls || [])
    ]
  };
}

function chooseBestProviderResult(flash, official, espn, sofa) {
  // Rank the whole provider rows instead of accepting the first row that has
  // any card/substitution. A cards-only Flashscore snapshot must not beat a
  // fallback row that actually contains the scorers for a 3-1 live score.
  const rows = [flash, official, espn, sofa].filter(Boolean);
  const ranked = rows
    .filter(row => !isPendingFeedResult(row) && isProviderResultUsable(row))
    .map((row, index) => ({ row, index, score: providerIncidentQuality(row) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked.length) return ranked[0].row;
  if (isPendingFeedResult(flash)) return flash;
  for (const row of [official, espn, sofa]) if (isPendingFeedResult(row)) return row;
  return null;
}

function providerIncidentQuality(row) {
  if (!row) return -1;
  const totalGoals = resultGoalTotal(row);
  const scorerCount = validScorerRows(row.scorers).length;
  const completeGoalBonus = totalGoals != null && scorerCount >= totalGoals ? 10000 : 0;
  const scoreBonus = totalGoals != null ? 500 : 0;
  const finishedBonus = row.finished === true ? 250 : 0;
  return completeGoalBonus + scorerCount * 1000 + countIncidents(row) * 10 + scoreBonus + finishedBonus;
}

function providerClosesPrimaryGap(primary, secondary) {
  if (!primary || isPendingFeedResult(primary)) return isProviderResultUsable(secondary);
  if (!isProviderResultUsable(secondary)) return false;
  if (!scorerCoverageIncomplete(primary)) return true;
  const primaryScorers = validScorerRows(primary.scorers).length;
  const secondaryScorers = validScorerRows(secondary.scorers).length;
  return secondaryScorers > primaryScorers || !scorerCoverageIncomplete(secondary);
}

function resultGoalTotal(row) {
  const h = Number(row?.h);
  const a = Number(row?.a);
  return Number.isFinite(h) && Number.isFinite(a) && h >= 0 && a >= 0 ? h + a : null;
}

function validScorerRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const text = [row?.type, row?.kind, row?.label, row?.detail, row?.reason].filter(Boolean).join(' ').toLowerCase();
    return !(row?.missed === true || row?.penaltyMissed === true || Number(row?.code) === 11 || /penalty[_ -]?(missed|saved)|missed penalty|kihagyott|ratat/.test(text));
  });
}

function scorerCoverageIncomplete(row) {
  const total = resultGoalTotal(row);
  if (total == null || total <= 0 || row?.prematch === true || row?.started === false) return false;
  return validScorerRows(row?.scorers).length < total;
}

function isProviderResultUsable(row) {
  return !!(row && (hasIncidentRows(row) || hasAnyDetailSignal(row)));
}

function isPendingFeedResult(row) {
  return !!(row && (row.flashscoreState === 'pending_feed' || row.status === 'PENDING_FEED'));
}

function needsSecondaryProviderFlashFirst(primaryRow, fixture = null, opts = {}) {
  if (!primaryRow) return true;
  if (!isPendingFeedResult(primaryRow)) {
    if (!isProviderResultUsable(primaryRow)) return true;
    // A live score whose total is larger than the parsed scorer list is only a
    // partial incident snapshot. Keep the fallback chain alive for the goals.
    return scorerCoverageIncomplete(primaryRow);
  }

  // A stored Flashscore MID may legitimately have no published detail feed before kickoff.
  // Once the scheduled start has passed, however, treat a still-pending feed as a hard miss
  // so the narrow fallback chain can recover the score without touching LiveScore.
  return fixtureLikelyStarted(fixture, opts);
}

function fixtureLikelyStarted(fixture, opts = {}) {
  if (!fixture) return !!opts.force;
  const date = String(fixture.date || '').slice(0, 10);
  const time = String(fixture.t || fixture.time || '00:00').slice(0, 5);
  const start = Date.parse(`${date}T${time}:00+03:00`);
  if (!Number.isFinite(start)) return !!opts.force;
  const graceMs = Number(opts.flashscorePendingGraceMs || 2 * 60 * 1000);
  return Date.now() >= start + graceMs;
}

function hasAnyDetailSignal(row) {
  return !!(
    row &&
    (row.h != null || row.a != null ||
      (row.flashscoreState === 'prematch' || row.flashscoreState === 'pending_feed') ||
      row.prematch === true ||
      (row.matchMeta && Object.keys(row.matchMeta).length) ||
      (row.scorers || []).length ||
      (row.yellowCards || []).length ||
      (row.redCards || []).length ||
      (row.doubleYellowCards || []).length)
  );
}

function hasIncidentRows(row) {
  return !!(
    row &&
    ((row.scorers || []).length ||
      (row.yellowCards || []).length ||
      (row.redCards || []).length ||
      (row.doubleYellowCards || []).length ||
      (row.substitutions || []).length ||
      (row.penalties || []).length)
  );
}

function hasAnyIncidents(results) {
  return Object.values(results || {}).some(hasIncidentRows);
}

function countIncidents(row) {
  return (row?.scorers || []).length +
    (row?.yellowCards || []).length +
    (row?.redCards || []).length +
    (row?.doubleYellowCards || []).length +
    (row?.substitutions || []).length +
    (row?.penalties || []).length;
}

function mergeScoreAndEvents(fixtures, scoreResults, eventResults, previousResults = {}) {
  const merged = {};
  for (const fixture of fixtures) {
    const score = scoreResults[fixture.id];
    const events = eventResults[fixture.id];
    const previous = previousResults[fixture.id] || null;
    if (!score && !events) continue;

    const base = score || events || previous;
    // A parsed Flashscore event feed is authoritative even if one category is empty.
    // This allows corrected data to remove a stale fake scorer, such as a missed penalty.
    const authoritativeIncidentFeed = !!events && events.prematch !== true &&
      (events.authoritativeIncidents === true || String(events.flashscoreState || '').toLowerCase() === 'event_feed');
    const incidentList = key => {
      const eventRows = Array.isArray(events?.[key]) ? events[key] : [];
      // Authority is category-specific. A cards-only event_feed is not allowed
      // to erase scorer rows while the score itself says that goals exist.
      const categoryAuthoritative = authoritativeIncidentFeed &&
        (key !== 'scorers' || !scorerCoverageIncomplete({
          ...events,
          h: score?.h ?? events?.h,
          a: score?.a ?? events?.a,
          started: score?.started ?? events?.started
        }));
      if (categoryAuthoritative) return eventRows;
      if (eventRows.length) return eventRows;
      if (Array.isArray(score?.[key]) && score[key].length) return score[key];
      return Array.isArray(previous?.[key]) ? previous[key] : [];
    };
    const raw = {
      ...(previous || {}),
      ...(events || {}),
      ...(score || {}),
      scorers: incidentList('scorers'),
      redCards: incidentList('redCards'),
      yellowCards: incidentList('yellowCards'),
      doubleYellowCards: incidentList('doubleYellowCards'),
      substitutions: incidentList('substitutions'),
      penalties: incidentList('penalties'),
      matchMeta: {
        ...(previous?.matchMeta || {}),
        ...(events?.matchMeta || {}),
        ...(score?.matchMeta || {})
      },
      flashscoreState: events?.flashscoreState || previous?.flashscoreState || null,
      prematch: score?.started ? false : (events?.prematch ?? previous?.prematch ?? false),
      eventSource: isProviderResultUsable(events) ? (events?.eventSource || events?.source || previous?.eventSource || null) : (previous?.eventSource || score?.eventSource || null),
      scoreSource: score?.scoreSource || previous?.scoreSource || events?.scoreSource || (score ? (score?.source || score?.scoreSource || 'flashscore') : events?.source || 'detail')
    };

    // Do not regress a live/final row to PREMATCH if a provider temporarily returns metadata-only data.
    if (previous?.started && !score?.started && events?.prematch) {
      raw.started = previous.started;
      raw.finished = previous.finished;
      raw.status = previous.status;
      raw.minute = previous.minute;
      raw.providerMinute = previous.providerMinute ?? null;
      raw.latestIncidentMinute = previous.latestIncidentMinute ?? null;
      raw.minuteSource = previous.minuteSource ?? null;
      raw.clockObservedAt = previous.clockObservedAt ?? null;
      raw.h = previous.h;
      raw.a = previous.a;
      raw.pH = previous.pH;
      raw.pA = previous.pA;
      raw.prematch = false;
    }

    const normalized = normalizeLiveMatch(fixture.id, raw, fixture, {
      source: score && events ? 'merged-flashscore-first' : (score ? (score?.source || score?.scoreSource || 'flashscore') : (events?.source || 'detail')),
      scoreSource: raw.scoreSource,
      eventSource: raw.eventSource
    });
    if (!normalized) continue;

    // normalizeLiveMatch intentionally keeps a compact public shape; re-attach B26 metadata fields.
    if (raw.matchMeta && Object.keys(raw.matchMeta).length) normalized.matchMeta = raw.matchMeta;
    if (raw.substitutions?.length) normalized.substitutions = raw.substitutions;
    if (raw.penalties?.length) normalized.penalties = raw.penalties;
    if (raw.providerMinute != null) normalized.providerMinute = raw.providerMinute;
    if (raw.latestIncidentMinute != null) normalized.latestIncidentMinute = raw.latestIncidentMinute;
    if (raw.minuteSource) normalized.minuteSource = raw.minuteSource;
    if (raw.clockObservedAt) normalized.clockObservedAt = raw.clockObservedAt;
    if (raw.flashscoreState) normalized.flashscoreState = raw.flashscoreState;
    if (raw.prematch === true && !normalized.started) normalized.prematch = true;
    if (events?.flashscoreMid || previous?.flashscoreMid) normalized.flashscoreMid = events?.flashscoreMid || previous?.flashscoreMid;
    merged[fixture.id] = normalized;
  }
  return merged;
}

function selectActiveFixtures(fixtures = [], results = {}, opts = {}) {
  let list = fixtures.filter(Boolean);

  const ids = Array.isArray(opts.ids)
    ? opts.ids
    : String(opts.ids || '').split(',').map(x => x.trim()).filter(Boolean);
  if (ids.length) list = list.filter(f => ids.includes(String(f.id)));
  if (opts.round) list = list.filter(f => String(f.r) === String(opts.round));
  if (opts.date) list = list.filter(f => String(f.date || '').slice(0, 10) === String(opts.date).slice(0, 10));

  if (opts.all || ids.length || opts.round || opts.date || Array.isArray(opts.activeFixtures)) return limitFixtures(list, opts);

  const interesting = interestingFixtures(list, results);
  if (interesting.length) return limitFixtures(interesting, opts);

  if (opts.force) {
    const now = Date.now();
    const upcoming = list
      .map(f => ({ f, t: Date.parse(`${String(f.date || '').slice(0, 10)}T${String(f.t || '00:00').slice(0, 5)}:00+03:00`) }))
      .filter(x => Number.isFinite(x.t) && x.t >= now - 6 * 60 * 60 * 1000)
      .sort((a, b) => a.t - b.t)
      .map(x => x.f);
    return limitFixtures(upcoming, { ...opts, limit: opts.limit || opts.forceLimit || 16 });
  }

  return [];
}

function limitFixtures(list, opts = {}) {
  const limit = Number(opts.limit || opts.liveLimit || 0);
  if (limit > 0) return list.slice(0, limit);
  return list;
}

function sourceErrorPack(source, error) {
  const message = error?.message || String(error);
  return { ok: false, source, count: 0, results: {}, matched: [], unmatched: [], urls: [], error: message, warnings: [message] };
}

function skippedSourcePack(source, reason) {
  return { ok: true, skipped: true, source, reason, count: 0, results: {}, matched: [], unmatched: [], urls: [], warnings: [] };
}

function summarizeSource(pack = {}) {
  return {
    ok: !!pack.ok,
    source: pack.source || null,
    count: pack.count ?? Object.keys(pack.results || {}).length,
    rawCount: pack.rawCount ?? pack.rawEventCount ?? null,
    error: pack.error || null,
    warnings: pack.warnings || [],
    skipped: !!pack.skipped,
    reason: pack.reason || null
  };
}

function getFlashscoreMid(fixture) {
  return fixture?.flashscoreMid || fixture?.sourceIds?.flashscoreMid || fixture?.sourceIds?.flashscoreEventId || null;
}

function getFlashscoreUrl(fixture) {
  return fixture?.flashscoreUrl || fixture?.sourceIds?.flashscoreUrl || buildFlashscoreUrl(fixture?.sourceIds?.flashscore || fixture?.flashscoreId);
}

function getFlashscoreId(fixture) {
  return fixture?.flashscoreId || fixture?.sourceIds?.flashscore || extractFlashscoreId(fixture?.flashscoreUrl || fixture?.sourceIds?.flashscoreUrl);
}

function buildFlashscoreUrl(id) {
  if (!id) return null;
  if (/^https?:\/\//i.test(String(id))) return String(id);
  return `https://www.flashscore.com/match/${String(id).replace(/^\/+|\/+$/g, '')}/`;
}

function extractFlashscoreId(url) {
  const parts = String(url || '').split('/').filter(Boolean);
  const idx = parts.findIndex(p => p === 'match');
  if (idx >= 0) return parts.slice(idx + 1).join('/').replace(/\/$/, '');
  return null;
}

function getOfficialUrl(fixture) {
  return fixture?.officialUrl || fixture?.sourceIds?.officialUrl || buildOfficialUrl(null, fixture?.sourceIds?.official || fixture?.officialId);
}

function getOfficialId(fixture) {
  return fixture?.officialId || fixture?.sourceIds?.official || extractOfficialId(fixture?.officialUrl || fixture?.sourceIds?.officialUrl);
}

function buildOfficialUrl(env, id) {
  if (!id) return null;
  if (/^https?:\/\//i.test(String(id))) return String(id);
  const base = env?.OFFICIAL_SUPERLIGA_BASE_URL || 'https://www.superliga.ro';
  return `${String(base).replace(/\/+$/g, '')}/meci/${String(id).replace(/^\/+|\/+$/g, '')}`;
}

function extractOfficialId(url) {
  const parts = String(url || '').split('/').filter(Boolean);
  const idx = parts.findIndex(p => p === 'meci');
  if (idx >= 0) return parts[idx + 1] || null;
  return null;
}

function dedupe(arr) { return [...new Set((arr || []).filter(Boolean))]; }
function clampNumber(value, min, max) { const n = Number(value); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
