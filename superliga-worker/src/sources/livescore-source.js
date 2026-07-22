import { normalizeLiveMatch } from '../core/normalize-live.js';
import { sameTeam } from '../core/team-match.js';

const LIVESCORE_APP_BASE = 'https://prod-public-api.livescore.com/v1/api/app';
const DEFAULT_LIVESCORE_WEB_PAGE = 'https://www.livescore.com/en/football/romania/liga-1/';
const DEFAULT_LEAGUE_HINTS = ['romania', 'liga 1', 'superliga', 'super liga', 'liga i'];

const LIVESCORE_HEADERS = {
  'x-fsign': 'SW9D1eZo',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 SuperLigaPredictorWorker/0.7',
  accept: 'application/json,text/plain,*/*',
  'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
  'cache-control': 'no-cache'
};

/**
 * LiveScore score-master adapter.
 *
 * Goals:
 *   - fetch LiveScore app JSON for the relevant fixture dates;
 *   - map events to our internal fixture ids by source id when available,
 *     otherwise by team names + match date;
 *   - return only real live/final scores by default;
 *   - allow scheduled diagnostics with opts.includeScheduled / source-test?scheduled=1.
 */
export async function fetchLiveScoreResults(env, fixtures = [], opts = {}) {
  const targetFixtures = Array.isArray(fixtures) ? fixtures.filter(Boolean) : [];
  const warnings = [];
  const urls = [];
  let rawList = [];
  let source = 'livescore-empty';

  const appPack = await fetchLiveScoreAppEvents(env, targetFixtures, opts)
    .catch(error => ({ ok: false, raw: [], urls: [], warnings: [error?.message || String(error)] }));
  rawList = rawList.concat(appPack.raw || []);
  urls.push(...(appPack.urls || []));
  warnings.push(...(appPack.warnings || []));
  if ((appPack.raw || []).length) source = appPack.source || 'livescore-app-json';

  if (!rawList.length || opts.webFallback === true || opts.fallback === 'web') {
    const fallbackUrl = opts.url && !isLiveScoreAppUrl(opts.url) ? opts.url : resolveWebUrl(env, opts);
    const fetchPack = await fetchSource(fallbackUrl, opts).catch(error => ({ ok: false, error: error?.message || String(error), text: '', contentType: '' }));
    urls.push(fallbackUrl);
    if (fetchPack.ok) {
      const parsed = await parseSourceBody(fetchPack);
      const list = extractMatchList(parsed.data, parsed.text).map(ev => ({ ...ev, sourceUrl: fallbackUrl }));
      if (list.length) {
        rawList = dedupeRawEvents(rawList.concat(list));
        source = source === 'livescore-empty' ? (parsed.source || 'livescore-web') : `${source}+${parsed.source || 'web'}`;
      }
      warnings.push(...(parsed.warnings || []));
    } else if (!rawList.length) {
      warnings.push(`web fallback failed: ${fetchPack.error || 'unknown_error'}`);
    }
  }

  rawList = dedupeRawEvents(rawList);
  const mappedPack = mapRawMatchesToResults(rawList, targetFixtures, opts);

  return {
    ok: true,
    source,
    urls: [...new Set(urls)],
    rawCount: rawList.length,
    count: Object.keys(mappedPack.results).length,
    results: mappedPack.results,
    matched: mappedPack.matched,
    unmatched: mappedPack.unmatched.slice(0, Number(opts.unmatchedLimit || 24)),
    warnings: [...new Set(warnings)].slice(0, 40)
  };
}

function isLiveScoreAppUrl(url = '') {
  const s = String(url || '');
  return !s || s.includes('prod-public-api.livescore.com') || s.includes('/v1/api/app');
}

function resolveWebUrl(env, opts = {}) {
  return opts.url || env.LIVE_SCORE_WEB_URL || env.LIVESCORE_WEB_URL || DEFAULT_LIVESCORE_WEB_PAGE;
}

function resolveAppBase(env, opts = {}) {
  if (opts.url && isLiveScoreAppUrl(opts.url)) return String(opts.url).replace(/\/$/, '');
  return String(env.LIVE_SCORE_APP_BASE_URL || env.LIVESCORE_APP_BASE_URL || LIVESCORE_APP_BASE).replace(/\/$/, '');
}

function candidateDateStrings(fixtures = [], opts = {}) {
  const dates = new Set();
  if (opts.date) dates.add(String(opts.date).replace(/-/g, '').slice(0, 8));

  if (opts.force || opts.live || opts.fresh || opts.includeScheduled || opts.scheduled) {
    const now = Date.now();
    dates.add(ymdInZone(now, 'Europe/Bucharest'));
    dates.add(ymdInZone(now - 24 * 60 * 60 * 1000, 'Europe/Bucharest'));
    dates.add(ymdInZone(now + 24 * 60 * 60 * 1000, 'Europe/Bucharest'));
  }

  for (const f of fixtures || []) {
    const d = String(f?.date || '').replace(/-/g, '').slice(0, 8);
    if (/^\d{8}$/.test(d)) dates.add(d);
  }
  if (!dates.size) {
    const now = Date.now();
    dates.add(ymdInZone(now, 'Europe/Bucharest'));
    dates.add(ymdInZone(now + 24 * 60 * 60 * 1000, 'Europe/Bucharest'));
  }
  const max = Number(opts.maxDates || opts.liveScoreMaxDates || (opts.includeScheduled ? 10 : 6));
  return [...dates].filter(Boolean).slice(0, Math.max(1, max));
}

function ymdInZone(ms, timeZone = 'Europe/Bucharest') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}`;
}

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function fetchLiveScoreAppEvents(env, fixtures = [], opts = {}) {
  const base = resolveAppBase(env, opts);
  const dates = candidateDateStrings(fixtures, opts);
  const raw = [];
  const warnings = [];
  const urls = [];

  for (const date of dates) {
    const candidates = [
      `${base}/date/soccer/${date}/0?locale=en&MD=1`,
      `${base}/match/list/date/soccer/${date}/0?MD=1&Lang=en&Tzn=Europe%2FBucharest`,
      `${base}/match/list/date/soccer/${date}/0?MD=1&Lang=en&Tzn=Europe%2FBudapest`
    ];

    let foundForDate = false;
    for (const url of candidates) {
      urls.push(url);
      try {
        const res = await fetch(url, {
          headers: LIVESCORE_HEADERS,
          cf: { cacheTtl: Number(opts.force ? 0 : 15), cacheEverything: false }
        });
        if (!res.ok) {
          warnings.push(`${url} HTTP ${res.status}`);
          continue;
        }
        const data = await res.json().catch(() => null);
        if (!data) {
          warnings.push(`${url} invalid_json`);
          continue;
        }
        const list = parseLiveScoreEvents(data, date);
        if (list.length) {
          raw.push(...list);
          foundForDate = true;
          break;
        }
      } catch (error) {
        warnings.push(`${url}: ${error?.message || String(error)}`);
      }
    }
    if (!foundForDate && opts.force) warnings.push(`no LiveScore app events for ${date}`);
  }

  return { ok: true, source: raw.length ? 'livescore-app-json' : 'livescore-app-empty', raw, urls, warnings };
}

function parseLiveScoreEvents(json, fallbackYmd = null) {
  // LiveScore date payloads are grouped by Stages. Prefer that path first,
  // because it preserves country/competition metadata. The generic deep walk
  // finds every event but loses the parent stage context, which creates huge
  // unmatched debug dumps from MLS, Brazil, friendlies, etc.
  const staged = extractStageEvents(json, fallbackYmd);
  if (staged.length) return filterRomaniaEvents(dedupeRawEvents(staged));

  const out = [];
  const seen = new WeakSet();
  const queue = [json];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);

    if (looksLikeLiveScoreEvent(node)) {
      const normalized = normalizeLiveScoreEvent(node, fallbackYmd);
      if (normalized.homeTeam && normalized.awayTeam) out.push(normalized);
    }

    if (Array.isArray(node)) {
      for (const child of node) queue.push(child);
    } else {
      for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push(value);
    }
  }

  return filterRomaniaEvents(dedupeRawEvents(out));
}

function extractStageEvents(json, fallbackYmd = null) {
  const stages = findStageArrays(json);
  const out = [];
  for (const stage of stages) {
    const events = stage?.Events || stage?.events || stage?.Matches || stage?.matches || [];
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!looksLikeLiveScoreEvent(event)) continue;
      const enriched = {
        ...event,
        stageName: stage.Snm || stage.name || stage.Nm || stage.CompN || null,
        competition: stage.Cnm || stage.CompN || stage.CompD || stage.countryName || null,
        competitionName: stage.CompN || stage.Snm || null,
        countryName: stage.Cnm || stage.Csnm || null,
        liveScoreStage: {
          sid: stage.Sid || stage.id || null,
          name: stage.Snm || stage.name || null,
          country: stage.Cnm || stage.Csnm || null,
          compId: stage.CompId || null,
          compName: stage.CompN || null
        }
      };
      const normalized = normalizeLiveScoreEvent(enriched, fallbackYmd);
      if (normalized.homeTeam && normalized.awayTeam) out.push(normalized);
    }
  }
  return out;
}

function findStageArrays(root) {
  const out = [];
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some(x => x && typeof x === 'object' && (Array.isArray(x.Events) || Array.isArray(x.events)))) out.push(...node);
      for (const item of node) walk(item);
      return;
    }
    if (Array.isArray(node.Stages)) out.push(...node.Stages);
    if (Array.isArray(node.stages)) out.push(...node.stages);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  }
  walk(root);
  return out.filter(x => x && typeof x === 'object' && (Array.isArray(x.Events) || Array.isArray(x.events)));
}

function looksLikeLiveScoreEvent(node) {
  if (!node || typeof node !== 'object') return false;
  const hasId = node.Eid != null || node.ID != null || node.id != null || node.eventId != null;
  const t1 = (node.T1 || node.t1 || [])[0] || node.homeTeam || node.home || null;
  const t2 = (node.T2 || node.t2 || [])[0] || node.awayTeam || node.away || null;
  const h = readPossibleName(t1) || node.homeName || node.HomeTeam;
  const a = readPossibleName(t2) || node.awayName || node.AwayTeam;
  return !!(hasId && h && a);
}

function normalizeLiveScoreEvent(ev, fallbackYmd = null) {
  const t1 = (ev.T1 || ev.t1 || [])[0] || ev.homeTeam || ev.home || {};
  const t2 = (ev.T2 || ev.t2 || [])[0] || ev.awayTeam || ev.away || {};
  const homeTeam = readPossibleName(t1) || ev.homeName || ev.HomeTeam || ev.homeTeam || '';
  const awayTeam = readPossibleName(t2) || ev.awayName || ev.AwayTeam || ev.awayTeam || '';
  const status = String(ev.Eps || ev.EpsL || ev.Epr || ev.Status || ev.status || ev.statusText || '').trim().toUpperCase();
  const statusText = String(ev.EpsL || ev.EtTx || ev.Epr || ev.statusText || ev.state || '').trim().toUpperCase();
  const pH = firstInt(ev.Tr1P, ev.tr1p, ev.Trp1, ev.trp1, ev.PenaltyHome, ev.penaltyHome);
  const pA = firstInt(ev.Tr2P, ev.tr2p, ev.Trp2, ev.trp2, ev.PenaltyAway, ev.penaltyAway);
  const startDate = extractEventDate(ev, fallbackYmd);

  return {
    eventId: ev.Eid != null ? String(ev.Eid) : (ev.ID != null ? String(ev.ID) : (ev.id != null ? String(ev.id) : null)),
    id: ev.Eid != null ? String(ev.Eid) : (ev.ID != null ? String(ev.ID) : (ev.id != null ? String(ev.id) : null)),
    date: startDate,
    homeTeam: String(homeTeam || '').trim(),
    awayTeam: String(awayTeam || '').trim(),
    h: firstInt(ev.Tr1, ev.tr1, ev.Score1, ev.score1, ev.homeScore, ev.home?.score),
    a: firstInt(ev.Tr2, ev.tr2, ev.Score2, ev.score2, ev.awayScore, ev.away?.score),
    pH: Number.isFinite(pH) ? pH : null,
    pA: Number.isFinite(pA) ? pA : null,
    status,
    statusText,
    minute: extractMinuteLabel(ev),
    started: isStartedStatus(status, statusText),
    finished: isFinishedStatus(status, statusText),
    scorers: extractGoalScorers(ev),
    redCards: extractCards(ev).filter(c => c.red || c.yellowRed),
    yellowCards: extractCards(ev).filter(c => c.yellow && !c.red && !c.yellowRed),
    doubleYellowCards: extractCards(ev).filter(c => c.yellowRed),
    competition: ev.stageName || ev.competition || ev.Cnm || ev.Snm || ev.CompN || ev.competitionName || null,
    rawLiveScoreEvent: ev
  };
}

function readPossibleName(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj.Nm || obj.name || obj.Snm || obj.shortName || obj.Name || obj.TeamName || '';
}

function extractEventDate(ev, fallbackYmd = null) {
  const candidates = [ev.Esd, ev.esd, ev.Edt, ev.date, ev.startDate, ev.startTime, ev.startTimestamp, ev.Sd, ev.kickoffAt];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const s = String(c);
    if (/^\d{8}/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const n = Number(c);
    if (Number.isFinite(n) && n > 1000000000) {
      const ms = n > 9999999999 ? n : n * 1000;
      const d = new Date(ms);
      if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  if (fallbackYmd && /^\d{8}$/.test(String(fallbackYmd))) return `${fallbackYmd.slice(0, 4)}-${fallbackYmd.slice(4, 6)}-${fallbackYmd.slice(6, 8)}`;
  return null;
}

function filterRomaniaEvents(events) {
  const hasLeagueHints = events.some(ev => DEFAULT_LEAGUE_HINTS.some(h => normBlob(ev.competition || ev.stageName || '').includes(h)));
  if (!hasLeagueHints) return events;
  return events.filter(ev => {
    const blob = normBlob(`${ev.competition || ''} ${ev.stageName || ''} ${JSON.stringify(ev.rawLiveScoreEvent || {}).slice(0, 800)}`);
    return DEFAULT_LEAGUE_HINTS.some(h => blob.includes(h));
  });
}

function normBlob(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function mapRawMatchesToResults(rawMatches, fixtures, opts = {}) {
  const results = {};
  const matched = [];
  const unmatched = [];

  for (const raw of rawMatches || []) {
    const fixture = findMappedFixture(raw, fixtures, opts);
    if (!fixture) {
      unmatched.push({ rawId: raw.id || raw.eventId, date: raw.date || null, home: readHomeName(raw), away: readAwayName(raw), status: raw.status || raw.statusText || null });
      continue;
    }
    if (!shouldExposeLiveScore(raw, opts)) {
      matched.push({ id: fixture.id, rawId: raw.id || raw.eventId, date: raw.date || null, h: fixture.h, a: fixture.a, rawHome: readHomeName(raw), rawAway: readAwayName(raw), scheduledOnly: true });
      continue;
    }
    const normalized = normalizeLiveMatch(
      fixture.id,
      { ...raw, source: 'livescore', scoreSource: 'livescore', eventSource: raw.scorers?.length || raw.redCards?.length ? 'livescore' : null },
      fixture,
      { source: 'livescore', scoreSource: 'livescore', eventSource: 'livescore' }
    );
    if (normalized) {
      const liveScoreId = raw.id || raw.eventId || null;
      results[fixture.id] = {
        ...normalized,
        livescoreId: liveScoreId,
        sourceIds: { ...(normalized.sourceIds || {}), livescore: liveScoreId }
      };
      matched.push({
        id: fixture.id,
        rawId: liveScoreId,
        date: raw.date || null,
        h: fixture.h,
        a: fixture.a,
        rawHome: readHomeName(raw),
        rawAway: readAwayName(raw),
        status: normalized.status,
        score: `${normalized.h ?? '-'}-${normalized.a ?? '-'}`
      });
    }
  }

  return { results, matched, unmatched };
}

function findMappedFixture(raw, fixtures, opts = {}) {
  const rawId = raw.id || raw.matchId || raw.eventId || raw.Eid || raw.Id;
  const home = readHomeName(raw);
  const away = readAwayName(raw);
  const rawDate = String(raw.date || '').slice(0, 10);

  if (rawId) {
    const byId = fixtures.find(f => String(f.sourceId || f.livescoreId || f.sourceIds?.livescore || '') === String(rawId));
    if (byId) return byId;
  }

  const teamMatches = fixtures.filter(f => sameTeam(home, f.h) && sameTeam(away, f.a));
  if (!teamMatches.length) return null;
  if (!rawDate) return teamMatches.length === 1 ? teamMatches[0] : null;

  const exactDate = teamMatches.find(f => String(f.date || '').slice(0, 10) === rawDate);
  if (exactDate) return exactDate;

  // Timezone edge case: LiveScore can expose UTC date, while LPF fixture date is Romania local date.
  const rawMs = Date.parse(`${rawDate}T12:00:00Z`);
  if (Number.isFinite(rawMs)) {
    const near = teamMatches
      .map(f => ({ fixture: f, diff: Math.abs(Date.parse(`${String(f.date || '').slice(0, 10)}T12:00:00Z`) - rawMs) }))
      .filter(x => Number.isFinite(x.diff) && x.diff <= 36 * 60 * 60 * 1000)
      .sort((a, b) => a.diff - b.diff)[0];
    if (near) return near.fixture;
  }

  if (teamMatches.length === 1 && (opts.force || opts.live || opts.fresh || opts.includeScheduled || opts.scheduled)) return teamMatches[0];

  return null;
}

function readHomeName(raw) {
  return raw.homeTeam || raw.home?.name || raw.T1?.[0]?.Nm || raw.T1?.[0]?.Name || raw.HomeTeam || raw.homeName || raw.home || '';
}

function readAwayName(raw) {
  return raw.awayTeam || raw.away?.name || raw.T2?.[0]?.Nm || raw.T2?.[0]?.Name || raw.AwayTeam || raw.awayName || raw.away || '';
}

function shouldExposeLiveScore(match, opts = {}) {
  if (opts.includeScheduled || opts.scheduled) return true;
  return !!(match.started || match.finished || match.h != null || match.a != null || /LIVE|HT|FT|AET|PEN|\d{1,3}'/.test(`${match.status || ''} ${match.statusText || ''}`));
}

function firstInt(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractMinuteLabel(ev) {
  const candidates = [ev.Eps, ev.EpsL, ev.Epr, ev.Ecov, ev.Min, ev.Minute, ev.Mi, ev.Emin, ev.minute].filter(x => x !== undefined && x !== null);
  for (const candidate of candidates) {
    const value = String(candidate).trim();
    const up = value.toUpperCase();
    if (up === 'HT' || up.includes('HALF TIME') || up.includes('HALFTIME') || up.includes('INTERVAL')) return 'HT';
    const plus = value.match(/(\d{1,3})\s*\+\s*(\d{1,2})/);
    if (plus) return `${plus[1]}+${plus[2]}'`;
    const simple = value.match(/(^|\D)(\d{1,3})(\D|$)/);
    if (simple) {
      const minute = Number(simple[2]);
      if (minute > 0 && minute <= 130) return `${minute}'`;
    }
  }
  return null;
}

function isFinishedStatus(status, statusText) {
  const s = `${status} ${statusText}`.toUpperCase();
  return ['FT', 'AET', 'AP', 'PEN', 'FINISHED', 'FULL TIME', 'AFTER PEN', 'COMPLETE'].some(x => s.includes(x));
}

function isStartedStatus(status, statusText) {
  const s = `${status} ${statusText}`.toUpperCase();
  if (!s.trim()) return false;
  if (['NS', 'TBD', 'POSTP', 'CANC', 'CANCL', 'SCHEDULED'].some(x => s.includes(x))) return false;
  return ['LIVE', 'HT', '1H', '2H', 'ET', 'PEN', 'IN PLAY', "'"].some(x => s.includes(x)) || /\b\d{1,3}\b/.test(s);
}

function incidentPlayerName(inc = {}) {
  const direct = [
    inc.FullName, inc.fullName, inc.DisplayName, inc.displayName,
    inc.PlayerName, inc.playerName, inc.Pnm,
    inc.Player, inc.player, inc.Pn, inc.Nm, inc.name, inc.Name,
    inc.Scorer, inc.scorer, inc.GoalScorer, inc.goalScorer
  ];
  const nested = [inc.Player, inc.player, inc.Scorer, inc.scorer, inc.Athlete, inc.athlete, inc.Person, inc.person];
  for (const obj of nested) {
    if (!obj || typeof obj !== 'object') continue;
    direct.push(obj.fullName, obj.displayName, obj.PlayerName, obj.name, obj.Name, obj.Nm, obj.Fn, obj.Snm, obj.Sdn);
  }
  const names = direct.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  if (!names.length) return '';
  names.sort((a, b) => incidentPlayerNameScore(b) - incidentPlayerNameScore(a));
  return names[0];
}

function incidentPlayerNameScore(name) {
  const text = String(name || '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const initials = (text.match(/\b\p{L}\./gu) || []).length;
  return text.length + (parts.length >= 2 ? 20 : 0) - initials * 12;
}

function incidentTextBlob(inc = {}) {
  try { return JSON.stringify(inc).toUpperCase(); }
  catch { return ''; }
}

function incidentIsGoal(type, detail, inc = {}, blob = incidentTextBlob(inc)) {
  const compact = String(type || '').replace(/[^A-Z0-9]+/g, '');
  if (['G', 'GOAL', 'OG', 'OWNGOAL', 'P', 'PG', 'PEN', 'PENALTY', 'PENALTYGOAL'].includes(compact)) return true;
  if (/\b(?:GOAL|OWN\s*GOAL|PENALTY\s*GOAL)\b/.test(`${detail} ${blob}`)) return true;
  return inc.goal === true || inc.isGoal === true || inc.Goal === true;
}

function incidentOwnGoal(type, detail, inc = {}, blob = incidentTextBlob(inc)) {
  const compact = String(type || '').replace(/[^A-Z0-9]+/g, '');
  return !!(
    compact === 'OG' || compact === 'OWNGOAL' ||
    /\bOWN[ _-]?GOAL\b|\bAUTOGOL\b/.test(`${detail} ${blob}`) ||
    inc.og === true || inc.ownGoal === true || inc.isOwnGoal === true
  );
}

function incidentPenaltyGoal(type, detail, inc = {}, blob = incidentTextBlob(inc)) {
  const compact = String(type || '').replace(/[^A-Z0-9]+/g, '');
  return !!(
    ['P', 'PG', 'PEN', 'PENALTY', 'PENALTYGOAL'].includes(compact) ||
    /\bPENALTY\b|\bSPOT KICK\b/.test(`${detail} ${blob}`) ||
    inc.penalty === true || inc.pen === true || inc.pk === true || inc.fromPenalty === true
  );
}

function extractGoalScorers(root) {
  const lists = [root?.Incs, root?.incs, root?.Eve, root?.eve, root?.Events, root?.events, root?.Incidents, root?.incidents, ...collectIncidentLists(root)];
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const inc of list) {
      const type = String(inc.Type || inc.type || inc.Tp || inc.IT || inc.Cd || inc.code || inc.incidentType || '').toUpperCase();
      const detail = String(inc.Detail || inc.detail || inc.Info || inc.info || inc.Txt || inc.text || inc.Comment || inc.comment || inc.Name || inc.name || inc.Desc || inc.description || inc.incidentClass || '').toUpperCase();
      const blob = incidentTextBlob(inc);
      if (!incidentIsGoal(type, detail, inc, blob)) continue;
      const player = incidentPlayerName(inc);
      const minuteRaw = inc.Min ?? inc.min ?? inc.Mi ?? inc.Minute ?? inc.minute ?? inc.time;
      const minute = minuteRaw != null ? String(minuteRaw).replace(/'/g, '') : null;
      const teamRaw = inc.T ?? inc.Tn ?? inc.Team ?? inc.team ?? (inc.isHome === false ? '2' : '1');
      const team = String(teamRaw).toLowerCase() === 'a' || String(teamRaw) === '2' || String(teamRaw).toLowerCase().includes('away') ? 'a' : 'h';
      const og = incidentOwnGoal(type, detail, inc, blob);
      const penalty = incidentPenaltyGoal(type, detail, inc, blob);
      out.push({ team, minute: minute || '', player: player || '', og, penalty });
    }
  }
  return dedupeEvents(out);
}

function extractCards(root) {
  const lists = [root?.Incs, root?.incs, root?.Eve, root?.eve, root?.Events, root?.events, root?.Incidents, root?.incidents, ...collectIncidentLists(root)];
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const inc of list) {
      const type = String(inc.Type || inc.type || inc.Tp || inc.IT || inc.Cd || inc.code || inc.incidentType || '').toUpperCase();
      const detail = String(inc.Detail || inc.detail || inc.Info || inc.info || inc.Txt || inc.text || inc.Comment || inc.comment || inc.Name || inc.name || inc.Desc || inc.description || inc.incidentClass || '').toUpperCase();
      const blob = JSON.stringify(inc).toUpperCase();
      const isYellowRed = type.includes('YRC') || type.includes('SECOND') || detail.includes('SECOND YELLOW') || inc.yellowRed === true || inc.secondYellow === true;
      const isYellow = !isYellowRed && (type.includes('YC') || type.includes('YELLOW') || detail.includes('YELLOW CARD') || blob.includes('YELLOW CARD') || inc.yellow === true || inc.yellowCard === true);
      const isDirectRed = !isYellowRed && (type.includes('RC') || type.includes('RED') || detail.includes('RED CARD') || blob.includes('RED CARD') || inc.red === true || inc.redCard === true);
      if (!isYellow && !isYellowRed && !isDirectRed) continue;
      const player = incidentPlayerName(inc);
      const minuteRaw = inc.Min ?? inc.min ?? inc.Mi ?? inc.Minute ?? inc.minute ?? inc.time;
      const minute = minuteRaw != null ? String(minuteRaw).replace(/'/g, '') : '';
      const teamRaw = inc.T ?? inc.Tn ?? inc.Team ?? inc.team ?? (inc.isHome === false ? '2' : '1');
      const team = String(teamRaw).toLowerCase() === 'a' || String(teamRaw) === '2' || String(teamRaw).toLowerCase().includes('away') ? 'a' : 'h';
      if (isYellow) out.push({ team, minute, player, yellow: true, type: 'yellow' });
      else if (isYellowRed) out.push({ team, minute, player, yellowRed: true, red: true, type: 'yellowRed' });
      else out.push({ team, minute, player, red: true, type: 'red' });
    }
  }
  return dedupeEvents(out);
}

function collectIncidentLists(root) {
  const out = [];
  const seen = new Set();
  function walk(node, key = '') {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (/inc|incident|event|timeline|comment/i.test(key)) out.push(node);
      for (const item of node) walk(item, key);
      return;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value) && /inc|incident|event|timeline|comment/i.test(childKey)) out.push(value);
      walk(value, childKey);
    }
  }
  walk(root);
  return out;
}

async function fetchSource(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,text/html,*/*',
      'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
      'user-agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 SuperLigaPredictorWorker/0.7'
    },
    cf: { cacheTtl: Number(opts.force ? 0 : 15), cacheEverything: false }
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, contentType, text: '' };
  return { ok: true, text: await res.text(), contentType };
}

async function parseSourceBody(pack) {
  const text = pack.text || '';
  const warnings = [];
  if (pack.contentType.includes('application/json') || /^[\s\r\n]*[\[{]/.test(text)) {
    try { return { source: 'livescore-json', data: JSON.parse(text), text, warnings }; }
    catch (error) { warnings.push(`json parse failed: ${error.message}`); }
  }
  const next = parseNextData(text);
  if (next) return { source: 'livescore-next-data', data: next, text, warnings };
  const embedded = extractEmbeddedJsonCandidates(text);
  if (embedded.length) return { source: 'livescore-embedded-json', data: embedded, text, warnings };
  return { source: 'livescore-html-text', data: parseLiveScoreHtmlText(text), text, warnings };
}

function extractMatchList(data, htmlText = '') {
  if (!data) return [];
  if (Array.isArray(data)) return data.flatMap(item => extractMatchList(item, htmlText));
  if (Array.isArray(data.matches)) return data.matches;
  if (Array.isArray(data.fixtures)) return data.fixtures;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.events)) return data.events;
  if (data.Stages) return flattenLiveScoreStages(data.Stages);
  if (data.data?.Stages) return flattenLiveScoreStages(data.data.Stages);
  if (data.props?.pageProps) return extractMatchList(data.props.pageProps, htmlText);
  if (data.pageProps) return extractMatchList(data.pageProps, htmlText);
  if (data.initialState) return extractMatchList(data.initialState, htmlText);
  if (data.appState) return extractMatchList(data.appState, htmlText);
  if (htmlText) return parseLiveScoreHtmlText(htmlText);
  return [];
}

function flattenLiveScoreStages(stages) {
  const out = [];
  for (const stage of stages || []) {
    for (const event of stage.Events || stage.events || []) {
      out.push(normalizeLiveScoreEvent({ ...event, stageName: stage.Snm || stage.name || stage.Nm, competition: stage.Cnm || stage.countryName }, null));
    }
  }
  return out;
}

function parseNextData(html) {
  const m = String(html || '').match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(htmlDecode(m[1])); }
  catch { return null; }
}

function extractEmbeddedJsonCandidates(html) {
  const out = [];
  const text = String(html || '');
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(text))) {
    const body = htmlDecode(m[1] || '').trim();
    if (!/(Stages|Events|Eid|T1|T2|homeTeam|awayTeam)/.test(body)) continue;
    const jsons = extractBalancedJson(body);
    for (const raw of jsons) { try { out.push(JSON.parse(raw)); } catch {} }
  }
  return out;
}

function extractBalancedJson(text) {
  const out = [];
  const starts = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '{' || text[i] === '[') starts.push(i);
  for (const start of starts.slice(0, 100)) {
    let depth = 0, inString = false, quote = '', escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        if (candidate.length > 40 && /(Stages|Events|Eid|T1|T2|homeTeam|awayTeam)/.test(candidate)) out.push(candidate);
        break;
      }
    }
  }
  return out;
}

function parseLiveScoreHtmlText(html) {
  const text = textFromHtml(html);
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const timeMatch = line.match(/\b(\d{1,2}:\d{2}|FT|HT|LIVE|\d{1,3}'(?:\+\d+)?)\b/i);
    if (!timeMatch) continue;
    const win = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 10)).join(' ');
    const score = win.match(/\b(\d{1,2})\s*[-–:]\s*(\d{1,2})\b/);
    const teams = guessTwoTeams(win);
    if (!teams) continue;
    out.push({
      homeTeam: teams[0],
      awayTeam: teams[1],
      status: /^\d/.test(timeMatch[1]) && timeMatch[1].includes(':') ? 'NS' : timeMatch[1].toUpperCase(),
      minute: timeMatch[1].includes("'") ? timeMatch[1] : null,
      h: score ? Number(score[1]) : null,
      a: score ? Number(score[2]) : null,
      started: !!score || /FT|HT|LIVE|'/.test(timeMatch[1]),
      finished: /FT/i.test(timeMatch[1])
    });
  }
  return out;
}

const ROMANIA_TEAMS = [
  'FCSB', 'FC Argeș', 'FC Arges', 'Corvinul Hunedoara', 'Csikszereda', 'Miercurea Ciuc',
  'Universitatea Cluj', 'U Cluj', 'Farul Constanța', 'Farul Constanta', 'Rapid București', 'Rapid Bucuresti',
  'Sepsi OSK', 'FC Voluntari', 'FC Botoșani', 'FC Botosani', 'Oțelul Galați', 'Otelul Galati',
  'CFR Cluj', 'Universitatea Craiova', 'UTA Arad', 'Petrolul Ploiești', 'Petrolul Ploiesti', 'Dinamo Bucuresti', 'Dinamo'
];

function guessTwoTeams(text) {
  const found = [];
  for (const team of ROMANIA_TEAMS) {
    if (containsTeam(text, team) && !found.some(x => sameTeam(x, team))) found.push(team);
  }
  return found.length >= 2 ? found.slice(0, 2) : null;
}

function containsTeam(text, team) {
  const nText = normBlob(text).replace(/[^a-z0-9]+/g, ' ');
  const nTeam = normBlob(team).replace(/[^a-z0-9]+/g, ' ').trim();
  return nTeam && nText.includes(nTeam);
}

function dedupeEvents(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = [item.team, item.minute, item.player, item.type, item.og ? 'og' : '', item.penalty ? 'p' : '', item.red ? 'r' : '', item.yellow ? 'y' : '', item.yellowRed ? 'yr' : ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRawEvents(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = [item.id || item.eventId || '', item.date || '', readHomeName(item), readAwayName(item), item.status || '', item.h ?? '', item.a ?? ''].join('|').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function textFromHtml(html) {
  return htmlDecode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:tr|td|th|div|p|li|h\d|section|article)>/gi, '\n')
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
