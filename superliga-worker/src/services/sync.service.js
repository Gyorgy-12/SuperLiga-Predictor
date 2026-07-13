import { normalizeLiveMatch } from '../core/normalize-live.js';
import { interestingFixtures } from '../core/match-window.js';
import { mergeLiveResults, getLiveSnapshot } from './memory-cache.service.js';
import { readStoredResults, writeFinalIfChanged } from './results.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchLiveScoreResults } from '../sources/livescore-source.js';
import { fetchSofaScoreEvents } from '../sources/sofascore-events-source.js';
import { fetchEspnEvents } from '../sources/espn-source.js';
import { fetchFlashscoreEvents, fetchFlashscoreMatchDetails } from '../sources/flashscore-source.js';
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

  // B26 request-budget pipeline:
  // 1) LiveScore + Flashscore run first. Flashscore gets at most df_sui + dc per fixture.
  // 2) Official runs only for hard Flashscore misses (pending_feed is enough while NS).
  // 3) ESPN and SofaScore are progressively narrowed fallbacks.
  const [scorePack, flashscorePack] = await Promise.all([
    fetchLiveScoreResults(env, active, commonOpts).catch(error => sourceErrorPack('livescore', error)),
    fetchStoredFlashscoreIncidents(env, active, {
      ...incidentOpts,
      requestBudgetMode: 'strict',
      primaryFeedOnly: true,
      primaryBaseOnly: true,
      pendingOnEmpty: true,
      skipHtml: true,
      feedProbeLimit: 2
    }).catch(error => sourceErrorPack('flashscore-stored-details', error))
  ]);

  const flashPendingIds = new Set();
  const officialActive = [];
  for (const fixture of active) {
    const id = String(fixture.id);
    const flash = flashscorePack.results?.[id];
    const score = scorePack.results?.[id];
    if (isPendingFeedResult(flash)) flashPendingIds.add(id);
    if (needsSecondaryProvider(flash, score)) officialActive.push(fixture);
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
    const score = scorePack.results?.[id];
    const flash = flashscorePack.results?.[id];
    const official = officialPack.results?.[id];
    if (!needsSecondaryProvider(flash, score) || isProviderResultUsable(official)) primaryResolvedIds.add(id);
    else fallbackActive.push(fixture);
  }

  let espnPack = skippedSourcePack('espn-incidents', 'primary_flashscore_or_official_usable');
  if (fallbackActive.length) {
    espnPack = await fetchEspnEvents(env, fallbackActive, { ...incidentOpts, source: 'espn-incidents' })
      .catch(error => sourceErrorPack('espn-incidents', error));
  }

  const sofaActive = fallbackActive.filter(fixture => !isProviderResultUsable(espnPack.results?.[String(fixture.id)]));
  let sofaPack = skippedSourcePack('sofascore', fallbackActive.length ? 'espn_fallback_usable_or_no_remaining_fixture' : 'primary_flashscore_or_official_usable');
  if (sofaActive.length) {
    sofaPack = await fetchSofaScoreBudgeted(env, sofaActive, commonOpts)
      .catch(error => sourceErrorPack('sofascore', error));
  }

  const eventPack = combineIncidentPacks(active, flashscorePack, officialPack, espnPack, sofaPack);
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
    source: opts.source || 'sync-live-b26-request-budget',
    active: active.map(f => ({
      id: f.id,
      r: f.r,
      date: f.date,
      t: f.t,
      h: f.h,
      a: f.a,
      livescoreId: f.livescoreId || f.sourceIds?.livescore || null,
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
        mode: 'strict-b26',
        flashscoreMaxRequestsPerFixture: 2,
        flashscorePrimaryFeeds: ['df_sui', 'dc'],
        officialOnlyForHardMisses: true,
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
      feedProbeLimit: opts.feedProbeLimit || 2
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
  const row = {
    id: fixture.id,
    group: fixture.g || 'SL',
    round: fixture.r || null,
    homeTeam: fixture.h,
    awayTeam: fixture.a,
    date: fixture.date,
    started: !isPrematch && !!(score || detail.events?.length),
    finished: false,
    status: state === 'pending_feed' ? 'PENDING_FEED' : (isPrematch ? 'PREMATCH' : (score ? 'DETAIL_SCORE' : null)),
    minute: null,
    h: score?.h ?? null,
    a: score?.a ?? null,
    pH: null,
    pA: null,
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

  if (meta.sourceUrlField) row[meta.sourceUrlField] = meta.url || null;
  if (meta.sourceIdField) row[meta.sourceIdField] = meta.id || null;
  if (meta.mid) row.flashscoreMid = meta.mid;
  return row;
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
  // Incident-rich rows win first. A pending Flashscore feed is intentionally
  // lower priority than any provider that returned real detail, but it remains
  // a safe prematch placeholder when every secondary provider is empty.
  for (const row of [flash, official, espn, sofa]) if (hasIncidentRows(row)) return row;
  for (const row of [flash, official, espn, sofa]) {
    if (!isPendingFeedResult(row) && isProviderResultUsable(row)) return row;
  }
  if (isPendingFeedResult(flash)) return flash;
  for (const row of [official, espn, sofa]) if (isPendingFeedResult(row)) return row;
  return null;
}

function isProviderResultUsable(row) {
  return !!(row && (hasIncidentRows(row) || hasAnyDetailSignal(row)));
}

function isPendingFeedResult(row) {
  return !!(row && (row.flashscoreState === 'pending_feed' || row.status === 'PENDING_FEED'));
}

function needsSecondaryProvider(primaryRow, scoreRow = null) {
  if (!primaryRow) return true;
  // While LiveScore still says NS, a valid stored MID with an unpublished
  // Flashscore detail feed is normal and must not trigger request fan-out.
  if (isPendingFeedResult(primaryRow)) return !!scoreRow?.started;
  return !isProviderResultUsable(primaryRow);
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
    const raw = {
      ...(previous || {}),
      ...(events || {}),
      ...(score || {}),
      // Never wipe a previously known event list because a valid prematch/temporarily-empty feed returned [].
      scorers: events?.scorers?.length ? events.scorers : (score?.scorers?.length ? score.scorers : previous?.scorers || []),
      redCards: events?.redCards?.length ? events.redCards : (score?.redCards?.length ? score.redCards : previous?.redCards || []),
      yellowCards: events?.yellowCards?.length ? events.yellowCards : (score?.yellowCards?.length ? score.yellowCards : previous?.yellowCards || []),
      doubleYellowCards: events?.doubleYellowCards?.length ? events.doubleYellowCards : (score?.doubleYellowCards?.length ? score.doubleYellowCards : previous?.doubleYellowCards || []),
      substitutions: events?.substitutions?.length ? events.substitutions : (score?.substitutions?.length ? score.substitutions : previous?.substitutions || []),
      penalties: events?.penalties?.length ? events.penalties : (score?.penalties?.length ? score.penalties : previous?.penalties || []),
      matchMeta: {
        ...(previous?.matchMeta || {}),
        ...(events?.matchMeta || {}),
        ...(score?.matchMeta || {})
      },
      flashscoreState: events?.flashscoreState || previous?.flashscoreState || null,
      prematch: score?.started ? false : (events?.prematch ?? previous?.prematch ?? false),
      eventSource: isProviderResultUsable(events) ? (events?.eventSource || events?.source || previous?.eventSource || null) : (previous?.eventSource || score?.eventSource || null),
      scoreSource: score?.scoreSource || previous?.scoreSource || events?.scoreSource || (score ? 'livescore' : events?.source || 'detail')
    };

    // Do not regress a live/final row to PREMATCH if a provider temporarily returns metadata-only data.
    if (previous?.started && !score?.started && events?.prematch) {
      raw.started = previous.started;
      raw.finished = previous.finished;
      raw.status = previous.status;
      raw.minute = previous.minute;
      raw.h = previous.h;
      raw.a = previous.a;
      raw.pH = previous.pH;
      raw.pA = previous.pA;
      raw.prematch = false;
    }

    const normalized = normalizeLiveMatch(fixture.id, raw, fixture, {
      source: score && events ? 'merged-b26' : (score ? 'livescore' : (events?.source || 'detail')),
      scoreSource: raw.scoreSource,
      eventSource: raw.eventSource
    });
    if (!normalized) continue;

    // normalizeLiveMatch intentionally keeps a compact public shape; re-attach B26 metadata fields.
    if (raw.matchMeta && Object.keys(raw.matchMeta).length) normalized.matchMeta = raw.matchMeta;
    if (raw.substitutions?.length) normalized.substitutions = raw.substitutions;
    if (raw.penalties?.length) normalized.penalties = raw.penalties;
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
