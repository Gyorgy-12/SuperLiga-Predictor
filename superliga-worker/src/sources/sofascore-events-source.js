import { normalizeLiveMatch } from '../core/normalize-live.js';

const DEFAULT_SOFASCORE_BASE = 'https://www.sofascore.com/api/v1';
const SOFASCORE_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  'referer': 'https://www.sofascore.com/football/romania/superliga/152',
  'origin': 'https://www.sofascore.com',
  'cache-control': 'no-cache'
};

const TEAM_ALIASES = {
  'universitatea cluj': ['u cluj', 'u. cluj', 'fc universitatea cluj', 'universitatea cluj'],
  'universitatea craiova': ['u craiova', 'u. craiova', 'cs universitatea craiova', 'universitatea craiova'],
  'farul constanta': ['farul', 'fc farul constanta', 'farul constanta', 'farul constanța'],
  'rapid bucuresti': ['rapid', 'rapid bucuresti', 'rapid bucurești', 'fc rapid bucuresti'],
  'fc voluntari': ['voluntari', 'fc voluntari'],
  'fc botosani': ['botosani', 'botoșani', 'fc botosani', 'fc botoșani'],
  'otelul galati': ['otelul', 'oțelul', 'otelul galati', 'oțelul galați'],
  'petrolul ploiesti': ['petrolul', 'petrolul ploiesti', 'petrolul ploiești'],
  'cfr cluj': ['cfr', 'cfr cluj'],
  'fcsb': ['fcsb', 'fc fcsb'],
  'fc arges': ['arges', 'argeș', 'fc arges', 'fc argeș'],
  'uta arad': ['uta', 'uta arad'],
  'dinamo': ['dinamo', 'dinamo bucuresti', 'dinamo bucurești'],
  'sepsi osk': ['sepsi', 'sepsi osk', 'acs sepsi osk'],
  'csikszereda': ['csikszereda', 'fk csikszereda', 'miercurea ciuc', 'csikszereda miercurea ciuc'],
  'corvinul hunedoara': ['corvinul', 'corvinul hunedoara', 'cs corvinul hunedoara']
};

/**
 * SofaScore event-master adapter.
 *
 * Main goal: enrich LiveScore score snapshots with event incidents:
 *   - scorers
 *   - yellow cards
 *   - red cards
 *   - second-yellow red cards
 *
 * It deliberately does not have to be the score master. If SofaScore fails,
 * LiveScore can still keep /live-results alive.
 */
export async function fetchSofaScoreEvents(env, fixtures = [], opts = {}) {
  const base = resolveBase(env, opts);
  const warnings = [];
  const urls = [];
  const results = {};

  if (opts.disabled || String(env.SOFASCORE_DISABLED || '').toLowerCase() === 'true') {
    return { ok: true, source: 'sofascore-disabled', results: {}, warnings: ['SOFASCORE_DISABLED=true'] };
  }

  const targetFixtures = (fixtures || []).filter(Boolean);
  if (!targetFixtures.length) return { ok: true, source: 'sofascore-empty-fixtures', results: {}, count: 0, matched: [], unmatched: [] };

  const scheduledPack = await fetchScheduledEvents(base, targetFixtures, opts);
  urls.push(...scheduledPack.urls);
  warnings.push(...scheduledPack.warnings);

  const mapped = mapFixturesToSofaEvents(targetFixtures, scheduledPack.events, opts);
  const matched = [];
  const unmatched = [];

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
      status: event.status || null
    });

    const incidentPack = await fetchEventIncidents(base, event.id, opts).catch(error => ({ ok: false, incidents: [], url: null, error: error?.message || String(error) }));
    if (incidentPack.url) urls.push(incidentPack.url);
    if (incidentPack.error) warnings.push(`event ${event.id}: ${incidentPack.error}`);

    const raw = sofaEventToRaw(event, incidentPack.incidents || []);
    const hasEventData = raw.events.length || raw.scorers.length || raw.yellowCards.length || raw.redCards.length || raw.doubleYellowCards.length;
    const hasScoreData = raw.h != null || raw.a != null || raw.started || raw.finished;

    // In normal sync, only return a match if it has useful incident data or can be a score fallback.
    // In source-test?schedule=1 / scheduled=1, include mapped scheduled events as diagnostics too.
    if (!hasEventData && !hasScoreData && !opts.includeScheduled && !opts.scheduled) continue;

    const normalized = normalizeLiveMatch(
      fixture.id,
      { ...raw, eventSource: 'sofascore', source: 'sofascore' },
      fixture,
      { eventSource: 'sofascore', source: 'sofascore' }
    );
    if (normalized) results[fixture.id] = normalized;
  }

  return {
    ok: true,
    source: 'sofascore',
    base,
    urls: [...new Set(urls)],
    rawEventCount: scheduledPack.events.length,
    count: Object.keys(results).length,
    matched,
    unmatched: unmatched.slice(0, Number(opts.unmatchedLimit || 24)),
    warnings: [...new Set(warnings)].slice(0, 30),
    results
  };
}

function resolveBase(env, opts = {}) {
  const raw = opts.base || opts.sofascoreBase || env.SOFASCORE_BASE_URL || DEFAULT_SOFASCORE_BASE;
  return String(raw || DEFAULT_SOFASCORE_BASE).replace(/\/$/, '');
}

function candidateDates(fixtures = [], opts = {}) {
  const dates = new Set();
  if (opts.date) dates.add(String(opts.date).slice(0, 10));
  for (const f of fixtures) {
    const date = String(f?.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
  }
  if (!dates.size) {
    const now = new Date();
    dates.add(now.toISOString().slice(0, 10));
  }
  const max = Number(opts.maxDates || opts.sofascoreMaxDates || 8);
  return [...dates].filter(Boolean).slice(0, max);
}

async function fetchScheduledEvents(base, fixtures, opts = {}) {
  const urls = [];
  const warnings = [];
  const events = [];
  const dates = candidateDates(fixtures, opts);

  for (const date of dates) {
    const url = `${base}/sport/football/scheduled-events/${date}`;
    urls.push(url);
    try {
      const res = await fetch(url, {
        headers: SOFASCORE_HEADERS,
        cf: { cacheTtl: Number(opts.force ? 0 : 45), cacheEverything: false }
      });
      if (!res.ok) {
        warnings.push(`${url} HTTP ${res.status}`);
        continue;
      }
      const json = await res.json().catch(() => null);
      if (!json) {
        warnings.push(`${url} returned invalid JSON`);
        continue;
      }
      const extracted = extractSofaEvents(json, date);
      events.push(...extracted);
      if (!extracted.length && opts.force) warnings.push(`${url} no events extracted`);
    } catch (error) {
      warnings.push(`${url}: ${error?.message || String(error)}`);
    }
  }

  return { events: dedupeEvents(events), urls, warnings };
}

function extractSofaEvents(json, fallbackDate = null) {
  const output = [];
  const queue = [json];
  const seen = new WeakSet();

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (looksLikeSofaEvent(node)) output.push(normalizeSofaEvent(node, fallbackDate));

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
    (node.homeTeam.name || node.homeTeam.shortName) &&
    (node.awayTeam.name || node.awayTeam.shortName)
  );
}

function normalizeSofaEvent(ev, fallbackDate = null) {
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
    rawSofaEvent: ev
  };
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
    map.set(event.id, event);
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
  const base = [canonical];
  for (const [key, list] of Object.entries(TEAM_ALIASES)) {
    const normKey = canonicalName(key);
    const normalizedList = list.map(canonicalName);
    if (canonical === normKey || normalizedList.includes(canonical)) return [...new Set([normKey, ...normalizedList])];
  }
  return base;
}

function canonicalName(value) {
  const norm = normalizeLoose(value);
  for (const [key, list] of Object.entries(TEAM_ALIASES)) {
    const normKey = normalizeLoose(key);
    const normalizedList = list.map(normalizeLoose);
    if (norm === normKey || normalizedList.includes(norm)) return normKey;
  }
  return norm;
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
    .replace(/\b(fc|sc|acs|as|clubul|club|fotbal|fotbalistic|sportiv|cs|csm)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchEventIncidents(base, eventId, opts = {}) {
  if (!eventId) return { ok: false, incidents: [], error: 'missing event id' };
  const url = `${base}/event/${eventId}/incidents`;
  const res = await fetch(url, {
    headers: SOFASCORE_HEADERS,
    cf: { cacheTtl: Number(opts.force ? 0 : 15), cacheEverything: false }
  });
  if (!res.ok) return { ok: false, incidents: [], url, error: `HTTP ${res.status}` };
  const json = await res.json().catch(() => null);
  const incidents = json?.incidents || json?.data?.incidents || [];
  return { ok: true, url, incidents: Array.isArray(incidents) ? incidents : [] };
}

function sofaEventToRaw(event, incidents = []) {
  const parsed = incidentsToRaw(incidents);
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

function incidentsToRaw(incidents = []) {
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
    const team = item.isHome === false ? 'a' : 'h';
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

function readIncidentPlayer(item) {
  return item.player?.name || item.player?.shortName || item.playerName || item.name || item.person?.name || '';
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
  return klass.includes('yellowred') || klass.includes('yellow red') || klass.includes('second') || type.includes('yellowred') || item.cardType === 'yellowRed' || item.secondYellow;
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
