import { normalizeLiveMatch } from '../core/normalize-live.js';

const DEFAULT_SOFASCORE_BASES = [
  'https://www.sofascore.com/api/v1',
  'https://api.sofascore.com/api/v1'
];

const SOFASCORE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'referer': 'https://www.sofascore.com/football/romania/superliga/152',
  'origin': 'https://www.sofascore.com',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty'
};

const TEAM_ALIASES = {
  'universitatea cluj': ['u cluj', 'u. cluj', 'fc universitatea cluj', 'universitatea cluj'],
  'universitatea craiova': ['u craiova', 'u. craiova', 'cs universitatea craiova', 'universitatea craiova'],
  'farul constanta': ['farul', 'fc farul constanta', 'fcv farul constanta', 'farul constanta', 'farul constanța'],
  'rapid bucuresti': ['rapid', 'rapid bucuresti', 'rapid bucurești', 'fc rapid bucuresti', 'fc rapid 1923'],
  'fc voluntari': ['voluntari', 'fc voluntari'],
  'fc botosani': ['botosani', 'botoșani', 'fc botosani', 'fc botoșani'],
  'otelul galati': ['otelul', 'oțelul', 'otelul galati', 'oțelul galați'],
  'petrolul ploiesti': ['petrolul', 'petrolul ploiesti', 'petrolul ploiești'],
  'cfr cluj': ['cfr', 'cfr cluj', 'cfr 1907 cluj'],
  'fcsb': ['fcsb', 'fc fcsb'],
  'fc arges': ['arges', 'argeș', 'fc arges', 'fc argeș', 'fc arges pitesti', 'acs champions fc arges'],
  'uta arad': ['uta', 'uta arad'],
  'dinamo': ['dinamo', 'dinamo bucuresti', 'dinamo bucurești', 'fc dinamo bucuresti'],
  'sepsi osk': ['sepsi', 'sepsi osk', 'acs sepsi osk'],
  'csikszereda': ['csikszereda', 'fk csikszereda', 'miercurea ciuc', 'csikszereda miercurea ciuc'],
  'corvinul hunedoara': ['corvinul', 'corvinul hunedoara', 'cs corvinul hunedoara']
};

/**
 * SofaScore incidents adapter.
 *
 * Intended role:
 *   - NOT score master. LiveScore should remain score/status/minute master.
 *   - SofaScore is an optional event/incidents layer for goals + cards.
 *
 * Fetch strategy:
 *   1) use existing fixture.sofascoreId/sourceIds.sofascore if present;
 *   2) try scheduled-events by date;
 *   3) if scheduled-events is blocked/empty, try SofaScore search endpoints per active fixture;
 *   4) for every mapped event id, fetch /event/{id}/incidents.
 */
export async function fetchSofaScoreEvents(env, fixtures = [], opts = {}) {
  const bases = resolveBases(env, opts);
  const warnings = [];
  const urls = [];
  const results = {};

  if (opts.disabled || String(env.SOFASCORE_DISABLED || '').toLowerCase() === 'true') {
    return { ok: true, source: 'sofascore-disabled', results: {}, warnings: ['SOFASCORE_DISABLED=true'] };
  }

  const targetFixtures = (fixtures || []).filter(Boolean);
  if (!targetFixtures.length) {
    return { ok: true, source: 'sofascore-empty-fixtures', results: {}, count: 0, matched: [], unmatched: [] };
  }

  const explicitEvents = buildExplicitEvents(targetFixtures, opts);
  let events = [...explicitEvents];

  const scheduledPack = await fetchScheduledEvents(bases, targetFixtures, opts);
  urls.push(...scheduledPack.urls);
  warnings.push(...scheduledPack.warnings);
  events.push(...scheduledPack.events);
  events = dedupeEvents(events);

  let mapped = mapFixturesToSofaEvents(targetFixtures, events, opts);

  const missingAfterScheduled = targetFixtures.filter(f => !mapped.has(f.id));
  let searchPack = { events: [], urls: [], warnings: [] };
  if (missingAfterScheduled.length && String(opts.skipSearch || env.SOFASCORE_SKIP_SEARCH || '').toLowerCase() !== 'true') {
    searchPack = await fetchSearchEvents(bases, missingAfterScheduled, opts);
    urls.push(...searchPack.urls);
    warnings.push(...searchPack.warnings);
    events = dedupeEvents([...events, ...searchPack.events]);
    mapped = mapFixturesToSofaEvents(targetFixtures, events, opts);
  }

  const matched = [];
  const unmatched = [];
  const incidentDebug = [];

  for (const fixture of targetFixtures) {
    const event = mapped.get(fixture.id);
    if (!event) {
      unmatched.push({ id: fixture.id, date: fixture.date, h: fixture.h, a: fixture.a });
      continue;
    }

    matched.push({
      id: fixture.id,
      sofascoreId: event.id,
      date: fixture.date,
      h: fixture.h,
      a: fixture.a,
      sofaHome: event.homeTeam,
      sofaAway: event.awayTeam,
      tournament: event.tournament || null,
      uniqueTournamentId: event.uniqueTournamentId || null,
      category: event.category || null,
      origin: event.origin || null,
      status: event.status || null
    });

    const skipPrematchIncidents = (opts.skipPrematchIncidents === true || opts.skipPrematchIncidents === '1')
      && !event.started
      && !event.finished
      && !isStartedSofaStatus(event.status);
    const incidentPack = skipPrematchIncidents
      ? { ok: true, skipped: true, incidents: [], urls: [], error: null }
      : await fetchEventIncidents(bases, event.id, opts).catch(error => ({
          ok: false,
          incidents: [],
          urls: [],
          error: error?.message || String(error)
        }));
    urls.push(...(incidentPack.urls || []));
    if (incidentPack.warning) warnings.push(incidentPack.warning);
    if (incidentPack.error) warnings.push(`event ${event.id}: ${incidentPack.error}`);
    incidentDebug.push({
      id: fixture.id,
      sofascoreId: event.id,
      ok: !!incidentPack.ok,
      skipped: !!incidentPack.skipped,
      reason: incidentPack.skipped ? 'prematch_request_budget_guard' : null,
      count: incidentPack.incidents?.length || 0,
      error: incidentPack.error || null
    });

    const raw = sofaEventToRaw(event, incidentPack.incidents || []);
    const hasEventData = raw.events.length || raw.scorers.length || raw.yellowCards.length || raw.redCards.length || raw.doubleYellowCards.length;
    const hasScoreData = raw.h != null || raw.a != null || raw.started || raw.finished;

    if (!hasEventData && !hasScoreData && !opts.includeScheduled && !opts.scheduled && !opts.force) continue;

    const normalized = normalizeLiveMatch(
      fixture.id,
      { ...raw, eventSource: 'sofascore', source: 'sofascore-b26-budgeted' },
      fixture,
      { eventSource: 'sofascore', source: 'sofascore-b26-budgeted' }
    );
    if (normalized) results[fixture.id] = normalized;
  }

  return {
    ok: true,
    source: 'sofascore-b26-budgeted',
    bases,
    urls: [...new Set(urls)],
    rawEventCount: events.length,
    scheduledRawEventCount: scheduledPack.events.length,
    searchRawEventCount: searchPack.events.length,
    count: Object.keys(results).length,
    matched,
    unmatched: unmatched.slice(0, Number(opts.unmatchedLimit || 24)),
    incidentDebug,
    warnings: [...new Set(warnings)].slice(0, 50),
    results
  };
}

function resolveBases(env, opts = {}) {
  const values = [];
  if (opts.base || opts.sofascoreBase) values.push(opts.base || opts.sofascoreBase);
  if (opts.url) values.push(opts.url);
  if (env.SOFASCORE_BASE_URL) values.push(env.SOFASCORE_BASE_URL);
  if (env.SOFASCORE_API_BASE_URL) values.push(env.SOFASCORE_API_BASE_URL);
  values.push(...DEFAULT_SOFASCORE_BASES);
  const bases = [...new Set(values.map(v => String(v || '').replace(/\/$/, '')).filter(Boolean))];
  if (opts.singleBase === true || opts.singleBase === '1' || opts.baseOnly === true || opts.baseOnly === '1') {
    return bases.slice(0, 1);
  }
  return bases;
}

function candidateDates(fixtures = [], opts = {}) {
  const dates = new Set();
  if (opts.date) dates.add(String(opts.date).slice(0, 10));
  for (const f of fixtures) {
    const date = String(f?.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
  }
  if (!dates.size) dates.add(new Date().toISOString().slice(0, 10));
  const max = Number(opts.maxDates || opts.sofascoreMaxDates || 8);
  return [...dates].filter(Boolean).slice(0, max);
}

function buildExplicitEvents(fixtures, opts = {}) {
  const events = [];
  const explicitParam = opts.eventId || opts.sofascoreId || opts.sofaScoreId;
  const oneFixtureOnly = fixtures.length === 1 && explicitParam;

  for (const fixture of fixtures) {
    const id = oneFixtureOnly
      ? explicitParam
      : fixture.sofascoreId || fixture.sofaScoreId || fixture.sourceIds?.sofascore || fixture.sourceIds?.sofaScore;
    if (!id) continue;
    events.push({
      id: String(id),
      date: String(fixture.date || '').slice(0, 10) || null,
      homeTeam: fixture.h || '',
      awayTeam: fixture.a || '',
      homeTeamId: null,
      awayTeamId: null,
      tournament: 'Liga 1',
      category: 'Romania',
      uniqueTournamentId: null,
      status: 'NS',
      h: null,
      a: null,
      pH: null,
      pA: null,
      started: false,
      finished: false,
      origin: 'fixture-explicit-id',
      rawSofaEvent: null
    });
  }

  return events;
}

async function fetchScheduledEvents(bases, fixtures, opts = {}) {
  const urls = [];
  const warnings = [];
  const events = [];
  const dates = candidateDates(fixtures, opts);

  for (const base of bases) {
    for (const date of dates) {
      const url = `${base}/sport/football/scheduled-events/${date}`;
      urls.push(url);
      const pack = await fetchJson(url, opts);
      if (!pack.ok) {
        warnings.push(`${url} ${pack.error}`);
        continue;
      }
      const extracted = extractSofaEvents(pack.json, date, 'scheduled-events');
      events.push(...filterLikelyRomaniaLiga1(extracted, opts));
      if (!extracted.length && opts.force) warnings.push(`${url} no events extracted`);
    }
    if (events.length) break;
  }

  return { events: dedupeEvents(events), urls, warnings };
}

async function fetchSearchEvents(bases, fixtures, opts = {}) {
  const urls = [];
  const warnings = [];
  const events = [];
  const maxQueries = Number(opts.searchLimit || opts.sofascoreSearchLimit || 12);
  const queries = buildSearchQueries(fixtures).slice(0, maxQueries);

  for (const base of bases) {
    for (const q of queries) {
      const paths = [
        `/search/all?q=${encodeURIComponent(q)}`,
        `/search/events?q=${encodeURIComponent(q)}`
      ];
      for (const path of paths) {
        const url = `${base}${path}`;
        urls.push(url);
        const pack = await fetchJson(url, opts);
        if (!pack.ok) {
          warnings.push(`${url} ${pack.error}`);
          continue;
        }
        const extracted = extractSofaEvents(pack.json, null, 'search');
        events.push(...filterLikelyRomaniaLiga1(extracted, opts));
      }
    }
    if (events.length) break;
  }

  return { events: dedupeEvents(events), urls, warnings };
}

function buildSearchQueries(fixtures) {
  const queries = [];
  for (const fixture of fixtures) {
    const h = String(fixture.h || '').trim();
    const a = String(fixture.a || '').trim();
    if (h && a) queries.push(`${h} ${a}`);
    if (h && a) queries.push(`${shortSearchName(h)} ${shortSearchName(a)}`);
    if (h) queries.push(h);
  }
  return [...new Set(queries.map(q => q.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function shortSearchName(name) {
  const canonical = canonicalName(name);
  const aliases = aliasesFor(canonical);
  return aliases.sort((a, b) => a.length - b.length)[0] || name;
}

function isStartedSofaStatus(status) {
  const value = String(status || '').toLowerCase();
  return /inprogress|in_progress|live|first half|second half|halftime|extra time|penalties|started/.test(value);
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, {
      headers: SOFASCORE_HEADERS,
      cf: { cacheTtl: Number(opts.force ? 0 : 30), cacheEverything: false }
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, status: res.status, error: 'invalid JSON' };
    return { ok: true, status: res.status, json };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
}

function extractSofaEvents(json, fallbackDate = null, origin = null) {
  const output = [];
  const queue = [json];
  const seen = new WeakSet();

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (looksLikeSofaEvent(node)) output.push(normalizeSofaEvent(node, fallbackDate, origin));

    if (Array.isArray(node)) {
      for (const child of node) queue.push(child);
      continue;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }

  return output.filter(ev => ev.id && ev.homeTeam && ev.awayTeam);
}

function looksLikeSofaEvent(node) {
  return !!(
    node &&
    typeof node === 'object' &&
    (node.id || node.eventId) &&
    node.homeTeam &&
    node.awayTeam &&
    (node.homeTeam.name || node.homeTeam.shortName || node.homeTeam.slug) &&
    (node.awayTeam.name || node.awayTeam.shortName || node.awayTeam.slug)
  );
}

function normalizeSofaEvent(ev, fallbackDate = null, origin = null) {
  const start = ev.startTimestamp ? new Date(Number(ev.startTimestamp) * 1000) : null;
  const statusType = ev.status?.type || ev.status?.description || ev.status?.code || null;
  const statusDesc = ev.status?.description || ev.status?.type || ev.status?.code || null;
  return {
    id: String(ev.id || ev.eventId),
    date: start && Number.isFinite(start.getTime()) ? start.toISOString().slice(0, 10) : fallbackDate,
    startTimestamp: ev.startTimestamp || null,
    homeTeam: ev.homeTeam?.name || ev.homeTeam?.shortName || ev.homeTeam?.slug || '',
    awayTeam: ev.awayTeam?.name || ev.awayTeam?.shortName || ev.awayTeam?.slug || '',
    homeTeamId: ev.homeTeam?.id || null,
    awayTeamId: ev.awayTeam?.id || null,
    tournament: ev.tournament?.name || ev.tournament?.uniqueTournament?.name || null,
    category: ev.tournament?.category?.name || ev.tournament?.category?.slug || null,
    uniqueTournamentId: ev.tournament?.uniqueTournament?.id || ev.uniqueTournament?.id || null,
    status: sofaStatus(statusType, statusDesc),
    statusRaw: ev.status || null,
    h: readSofaScore(ev, 'home'),
    a: readSofaScore(ev, 'away'),
    pH: readSofaPenaltyScore(ev, 'home'),
    pA: readSofaPenaltyScore(ev, 'away'),
    started: sofaStarted(statusType, ev),
    finished: sofaFinished(statusType, ev),
    origin,
    rawSofaEvent: ev
  };
}

function filterLikelyRomaniaLiga1(events, opts = {}) {
  if (opts.noTournamentFilter || opts.noSofaTournamentFilter) return events;
  return (events || []).filter(ev => {
    const txt = normalizeLoose(`${ev.tournament || ''} ${ev.category || ''} ${ev.uniqueTournamentId || ''}`);
    if (String(ev.uniqueTournamentId || '') === String(opts.tournamentId || opts.uniqueTournamentId || '152')) return true;
    if (/romania|romanian|superliga|liga 1|liga i/.test(txt)) return true;
    // Keep search results with empty tournament metadata. Pair matching will decide later.
    return !ev.tournament && !ev.category && !ev.uniqueTournamentId;
  });
}

function readSofaScore(ev, side) {
  const score = side === 'home' ? ev.homeScore : ev.awayScore;
  const candidates = [score?.current, score?.display, score?.normaltime, score?.period1, score?.period2];
  for (const value of candidates) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readSofaPenaltyScore(ev, side) {
  const score = side === 'home' ? ev.homeScore : ev.awayScore;
  const value = score?.penalties;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sofaStatus(type, desc) {
  const raw = String(type || desc || '').toLowerCase();
  if (!raw) return 'NS';
  if (raw.includes('inprogress') || raw.includes('live')) return 'LIVE';
  if (raw.includes('halftime')) return 'HT';
  if (raw.includes('postponed')) return 'POSTP';
  if (raw.includes('canceled') || raw.includes('cancelled')) return 'CANC';
  if (raw.includes('finished') || raw.includes('ended')) return 'FT';
  if (raw.includes('notstarted') || raw.includes('not started')) return 'NS';
  return String(desc || type || 'NS');
}

function sofaStarted(type, ev) {
  const raw = String(type || ev?.status?.description || '').toLowerCase();
  return raw.includes('inprogress') || raw.includes('halftime') || raw.includes('finished') || raw.includes('ended') || readSofaScore(ev, 'home') != null || readSofaScore(ev, 'away') != null;
}

function sofaFinished(type, ev) {
  const raw = String(type || ev?.status?.description || '').toLowerCase();
  return raw.includes('finished') || raw.includes('ended');
}

function dedupeEvents(events) {
  const map = new Map();
  for (const event of events) {
    if (!event?.id) continue;
    const current = map.get(event.id);
    if (!current || event.origin === 'fixture-explicit-id' || event.tournament || event.rawSofaEvent) map.set(event.id, event);
  }
  return [...map.values()];
}

function mapFixturesToSofaEvents(fixtures, sofaEvents, opts = {}) {
  const byFixture = new Map();
  const explicit = new Map();
  for (const ev of sofaEvents) explicit.set(String(ev.id), ev);

  for (const fixture of fixtures) {
    const explicitId = fixture.sofascoreId || fixture.sofaScoreId || fixture.sourceIds?.sofascore || fixture.sourceIds?.sofaScore;
    if (explicitId && explicit.has(String(explicitId))) {
      byFixture.set(fixture.id, explicit.get(String(explicitId)));
      continue;
    }

    const sameDateEvents = sofaEvents.filter(ev => !fixture.date || !ev.date || String(ev.date).slice(0, 10) === String(fixture.date).slice(0, 10));
    const candidates = sameDateEvents.length ? sameDateEvents : sofaEvents;
    let best = null;
    let bestScore = 0;

    for (const ev of candidates) {
      const direct = pairScore(fixture.h, fixture.a, ev.homeTeam, ev.awayTeam);
      const swapped = pairScore(fixture.h, fixture.a, ev.awayTeam, ev.homeTeam) - 0.18;
      const competitionBoost = competitionScore(ev, opts);
      const score = Math.max(direct, swapped) + competitionBoost;
      if (score > bestScore) {
        bestScore = score;
        best = ev;
      }
    }

    if (best && bestScore >= Number(opts.matchThreshold || 1.42)) byFixture.set(fixture.id, best);
  }

  return byFixture;
}

function competitionScore(ev, opts = {}) {
  const targetTournament = String(opts.tournament || opts.competition || '').toLowerCase();
  const txt = normalizeLoose(`${ev.tournament || ''} ${ev.category || ''} ${ev.uniqueTournamentId || ''}`);
  let score = 0;
  if (/romania|romanian|superliga|liga 1|liga i/.test(txt)) score += 0.25;
  if (String(ev.uniqueTournamentId || '') === String(opts.tournamentId || opts.uniqueTournamentId || '152')) score += 0.35;
  if (targetTournament && txt.includes(normalizeLoose(targetTournament))) score += 0.25;
  return score;
}

function pairScore(aHome, aAway, bHome, bAway) {
  return nameScore(aHome, bHome) + nameScore(aAway, bAway);
}

function nameScore(a, b) {
  const aa = canonicalName(a);
  const bb = canonicalName(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const aAliases = aliasesFor(aa);
  const bAliases = aliasesFor(bb);
  for (const x of aAliases) for (const y of bAliases) if (x === y) return 0.98;
  if (aAliases.some(x => bb.includes(x) || x.includes(bb)) || bAliases.some(x => aa.includes(x) || x.includes(aa))) return 0.86;

  const aTokens = new Set(aa.split(' ').filter(t => t.length > 2));
  const bTokens = new Set(bb.split(' ').filter(t => t.length > 2));
  let common = 0;
  for (const t of aTokens) if (bTokens.has(t)) common++;
  const denom = Math.max(aTokens.size, bTokens.size, 1);
  return common / denom;
}

function aliasesFor(canonical) {
  const base = [canonical].filter(Boolean);
  for (const [key, list] of Object.entries(TEAM_ALIASES)) {
    const normKey = canonicalNameRaw(key);
    const normalizedList = list.map(canonicalNameRaw);
    if (canonical === normKey || normalizedList.includes(canonical)) return [...new Set([normKey, ...normalizedList])];
  }
  return base;
}

function canonicalName(value) {
  const norm = canonicalNameRaw(value);
  for (const [key, list] of Object.entries(TEAM_ALIASES)) {
    const normKey = canonicalNameRaw(key);
    const normalizedList = list.map(canonicalNameRaw);
    if (norm === normKey || normalizedList.includes(norm)) return normKey;
  }
  return norm;
}

function canonicalNameRaw(value) {
  return normalizeLoose(value);
}

function normalizeLoose(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ș/g, 's')
    .replace(/ț/g, 't')
    .replace(/ă/g, 'a')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|sc|acs|as|clubul|club|fotbal|fotbalistic|sportiv|cs|csm|osk|afc)\b/g, ' ')
    .replace(/\b(1923|1948|2013|52)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchEventIncidents(bases, eventId, opts = {}) {
  if (!eventId) return { ok: false, incidents: [], urls: [], error: 'missing event id' };
  const urls = [];
  const warnings = [];

  for (const base of bases) {
    const url = `${base}/event/${eventId}/incidents`;
    urls.push(url);
    const pack = await fetchJson(url, opts);
    if (!pack.ok) {
      warnings.push(`${url} ${pack.error}`);
      continue;
    }
    const incidents = pack.json?.incidents || pack.json?.data?.incidents || [];
    return {
      ok: true,
      urls,
      incidents: Array.isArray(incidents) ? incidents : [],
      warning: warnings.length ? warnings.join(' | ') : null
    };
  }

  return { ok: false, incidents: [], urls, error: warnings.join(' | ') || 'all incident endpoints failed' };
}

function sofaEventToRaw(event, incidents = []) {
  const parsed = incidentsToRaw(incidents, event);
  return {
    h: event.h,
    a: event.a,
    pH: event.pH,
    pA: event.pA,
    status: event.status,
    started: event.started || parsed.events.length > 0,
    finished: event.finished,
    events: parsed.events,
    scorers: parsed.scorers,
    yellowCards: parsed.yellowCards,
    redCards: parsed.redCards,
    doubleYellowCards: parsed.doubleYellowCards,
    rawSofaEvent: event.rawSofaEvent
  };
}

function incidentsToRaw(incidents = [], event = null) {
  const events = [];
  const scorers = [];
  const yellowCards = [];
  const redCards = [];
  const doubleYellowCards = [];

  for (const item of incidents || []) {
    if (!item || typeof item !== 'object') continue;
    const incidentType = lower(item.incidentType || item.type || item.eventType || item.kind);
    const incidentClass = lower(item.incidentClass || item.class || item.cardType || item.reason || item.description || item.text);
    const player = readIncidentPlayer(item);
    const minute = readIncidentMinute(item);
    const team = readIncidentTeam(item, event);
    const base = { team, minute, player };

    if (isGoalIncident(incidentType, incidentClass, item)) {
      const goal = {
        ...base,
        type: 'goal',
        penalty: isPenaltyGoal(incidentType, incidentClass, item),
        og: isOwnGoal(incidentType, incidentClass, item)
      };
      events.push(goal);
      scorers.push(goal);
      continue;
    }

    if (isCardIncident(incidentType, incidentClass, item)) {
      const card = {
        ...base,
        type: cardTypeLabel(incidentType, incidentClass, item),
        yellow: isYellowCard(incidentType, incidentClass, item),
        red: isRedCard(incidentType, incidentClass, item),
        yellowRed: isSecondYellow(incidentType, incidentClass, item)
      };
      events.push(card);
      if (card.yellowRed) doubleYellowCards.push({ ...card, red: true });
      else if (card.red) redCards.push(card);
      else if (card.yellow) yellowCards.push(card);
    }
  }

  return { events, scorers, yellowCards, redCards, doubleYellowCards };
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function readIncidentTeam(item, event) {
  if (item.isHome === true) return 'h';
  if (item.isHome === false) return 'a';
  const teamId = item.team?.id || item.player?.team?.id || item.teamId;
  if (teamId && event?.homeTeamId && String(teamId) === String(event.homeTeamId)) return 'h';
  if (teamId && event?.awayTeamId && String(teamId) === String(event.awayTeamId)) return 'a';
  const side = lower(item.homeAway || item.side || item.teamSide);
  if (side.includes('away')) return 'a';
  return 'h';
}

function readIncidentPlayer(item) {
  return item.player?.name || item.player?.shortName || item.playerName || item.name || item.person?.name || item.assist1?.name || '';
}

function readIncidentMinute(item) {
  const time = item.time ?? item.minute ?? item.matchTime ?? item.addedTimeDisplay;
  const added = item.addedTime ?? item.injuryTime ?? item.extraTime;
  if (time == null || time === '') return null;
  if (added != null && added !== '' && Number(added) > 0) return `${time}+${added}'`;
  return `${time}`;
}

function isGoalIncident(type, klass, item) {
  return type.includes('goal') || klass.includes('goal') || item.goalType || item.homeScore != null || item.awayScore != null;
}

function isPenaltyGoal(type, klass, item) {
  return type.includes('penalty') || klass.includes('penalty') || item.from === 'penalty' || item.goalType === 'penalty';
}

function isOwnGoal(type, klass, item) {
  return type.includes('own') || klass.includes('own') || item.ownGoal || item.goalType === 'own';
}

function isCardIncident(type, klass, item) {
  return type.includes('card') || klass.includes('yellow') || klass.includes('red') || item.cardType || item.isRed || item.isYellow;
}

function isSecondYellow(type, klass, item) {
  return klass.includes('yellowred') || klass.includes('yellow red') || klass.includes('second') || type.includes('yellowred') || item.cardType === 'yellowRed' || item.cardType === 'yellow-red' || item.secondYellow;
}

function isRedCard(type, klass, item) {
  return isSecondYellow(type, klass, item) || klass.includes('red') || type.includes('red') || item.cardType === 'red' || item.isRed;
}

function isYellowCard(type, klass, item) {
  return !isRedCard(type, klass, item) && (klass.includes('yellow') || type.includes('yellow') || item.cardType === 'yellow' || item.isYellow);
}

function cardTypeLabel(type, klass, item) {
  if (isSecondYellow(type, klass, item)) return 'yellowRed';
  if (isRedCard(type, klass, item)) return 'red';
  if (isYellowCard(type, klass, item)) return 'yellow';
  return item.cardType || klass || type || 'card';
}
