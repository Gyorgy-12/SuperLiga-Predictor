import { normalizeLiveMatch } from '../core/normalize-live.js';
import { normTeam, sameTeam } from '../core/team-match.js';

const DEFAULT_ESPN_LEAGUE = 'rou.1';
const DEFAULT_ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const DEFAULT_WEB_REFERER = 'https://www.espn.com/soccer/scoreboard/_/league/rou.1';

export async function fetchEspnEvents(env, fixtures = [], opts = {}) {
  const league = getLeague(env, opts);
  const base = getBase(env, opts);
  const includeIncidents = !!(
    opts.includeIncidents ||
    opts.incidents ||
    opts.withSummary ||
    opts.summary ||
    opts.source === 'incidents' ||
    opts.source === 'espn-incidents'
  );

  const urls = [];
  const warnings = [];
  const active = Array.isArray(opts.activeFixtures) ? opts.activeFixtures : fixtures;
  const dates = buildDateList(active, opts);
  const rawEvents = [];

  for (const d of dates) {
    const url = `${base}/${league}/scoreboard?dates=${toEspnDate(d)}&limit=${Number(opts.scoreboardLimit || env.ESPN_SCOREBOARD_LIMIT || 200)}`;
    urls.push(url);
    const payload = await fetchJson(url, env, opts).catch(error => {
      warnings.push(`${url} ${error?.message || String(error)}`);
      return null;
    });
    const events = Array.isArray(payload?.events) ? payload.events : [];
    for (const event of events) {
      const parsed = parseScoreboardEvent(event, league);
      if (parsed) rawEvents.push(parsed);
    }
  }

  const matched = [];
  const unmatched = [];
  const matchedRawIds = new Set();
  const results = {};
  const incidentDebug = [];

  for (const fixture of active || []) {
    const raw = findBestEspnEvent(fixture, rawEvents, opts);
    if (!raw) {
      unmatched.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        espnId: fixture.espnId || fixture.sourceIds?.espn || null
      });
      continue;
    }

    matchedRawIds.add(String(raw.id));
    let rawForNormalize = {
      ...raw,
      id: fixture.id,
      group: fixture.g || 'SL',
      round: fixture.r ?? null,
      homeTeam: fixture.h,
      awayTeam: fixture.a,
      scoreSource: 'espn',
      eventSource: includeIncidents ? 'espn' : null,
      source: 'espn',
      updatedAt: new Date().toISOString()
    };

    let summaryPack = null;
    if (includeIncidents && raw.id) {
      summaryPack = await fetchEspnSummary(env, raw.id, { ...opts, league, base, fixture, debug: opts.debug }).catch(error => ({
        ok: false,
        source: 'espn-summary',
        eventId: raw.id,
        error: error?.message || String(error),
        warnings: [error?.message || String(error)],
        scorers: [],
        yellowCards: [],
        redCards: [],
        doubleYellowCards: []
      }));
      if (summaryPack?.warnings?.length) warnings.push(...summaryPack.warnings.map(w => `summary ${raw.id}: ${w}`));
      rawForNormalize = {
        ...rawForNormalize,
        scorers: summaryPack?.scorers || [],
        yellowCards: summaryPack?.yellowCards || [],
        redCards: summaryPack?.redCards || [],
        doubleYellowCards: summaryPack?.doubleYellowCards || [],
        eventSource: 'espn',
        espnSummaryUrl: summaryPack?.url || null
      };
      incidentDebug.push({
        id: fixture.id,
        eventId: raw.id,
        url: summaryPack?.url || null,
        ok: !!summaryPack?.ok,
        scorerCount: summaryPack?.scorers?.length || 0,
        yellowCount: summaryPack?.yellowCards?.length || 0,
        redCount: summaryPack?.redCards?.length || 0,
        doubleYellowCount: summaryPack?.doubleYellowCards?.length || 0,
        eventItemCount: summaryPack?.eventItemCount || 0,
        warningCount: summaryPack?.warnings?.length || 0,
        sample: summaryPack?.sample || []
      });
    }

    const normalized = normalizeLiveMatch(fixture.id, rawForNormalize, fixture, {
      source: 'espn',
      scoreSource: 'espn',
      eventSource: includeIncidents ? 'espn' : null
    });
    if (normalized) results[fixture.id] = normalized;

    matched.push({
      id: fixture.id,
      espnId: String(raw.id),
      date: raw.date,
      h: fixture.h,
      a: fixture.a,
      rawHome: raw.rawHome,
      rawAway: raw.rawAway,
      status: raw.status,
      score: scoreLabel(raw),
      summaryFetched: !!summaryPack,
      scorerCount: summaryPack?.scorers?.length || 0,
      yellowCount: summaryPack?.yellowCards?.length || 0,
      redCount: summaryPack?.redCards?.length || 0
    });
  }

  const rawUnmatched = opts.debug ? rawEvents
    .filter(raw => !matchedRawIds.has(String(raw.id)))
    .slice(0, Number(opts.rawUnmatchedLimit || 40))
    .map(raw => ({
      rawId: raw.id,
      date: raw.date,
      home: raw.rawHome,
      away: raw.rawAway,
      status: raw.status,
      league: raw.league || null
    })) : undefined;

  return {
    ok: true,
    source: includeIncidents ? 'espn-incidents' : 'espn-scoreboard',
    league,
    base,
    urls,
    rawEventCount: rawEvents.length,
    count: matched.length,
    results,
    matched,
    unmatched,
    rawUnmatched,
    incidentDebug,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

export async function fetchEspnSummary(env, eventId, opts = {}) {
  if (!eventId) {
    return { ok: false, source: 'espn-summary', error: 'missing_event_id', scorers: [], yellowCards: [], redCards: [], doubleYellowCards: [] };
  }
  const league = opts.league || getLeague(env, opts);
  const base = opts.base || getBase(env, opts);
  const url = `${base}/${league}/summary?event=${encodeURIComponent(String(eventId))}`;
  const payload = await fetchJson(url, env, opts);
  const parsed = parseSummary(payload, opts.fixture || null, { eventId, url, debug: opts.debug });
  return {
    ok: true,
    source: 'espn-summary',
    eventId: String(eventId),
    league,
    url,
    ...parsed,
    updatedAt: new Date().toISOString()
  };
}

function getLeague(env, opts = {}) {
  return String(opts.league || env.ESPN_SOCCER_LEAGUE || env.ESPN_LEAGUE || DEFAULT_ESPN_LEAGUE).trim() || DEFAULT_ESPN_LEAGUE;
}

function getBase(env, opts = {}) {
  return String(opts.base || env.ESPN_SITE_API_BASE_URL || DEFAULT_ESPN_BASE).replace(/\/+$/, '');
}

function buildDateList(fixtures = [], opts = {}) {
  if (opts.date) return [String(opts.date).slice(0, 10)];
  const dates = [...new Set((fixtures || []).map(f => String(f.date || '').slice(0, 10)).filter(Boolean))].sort();
  const max = Number(opts.maxDates || 0);
  if (max > 0) return dates.slice(0, max);
  return dates.length ? dates : [new Date().toISOString().slice(0, 10)];
}

function toEspnDate(dateLike) {
  return String(dateLike || '').slice(0, 10).replace(/-/g, '');
}

async function fetchJson(url, env, opts = {}) {
  const headers = {
    accept: 'application/json,text/plain,*/*',
    'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: env.ESPN_REFERER || DEFAULT_WEB_REFERER,
    'user-agent': env.ESPN_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 SuperLigaPredictor/1.0'
  };
  const response = await fetch(url, { headers, cf: opts.force ? { cacheTtl: 0, cacheEverything: false } : undefined });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

function parseScoreboardEvent(event, league) {
  if (!event || !event.id) return null;
  const comp = Array.isArray(event.competitions) ? event.competitions[0] : event.competition || null;
  const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
  const home = competitors.find(c => String(c.homeAway || '').toLowerCase() === 'home') || competitors[0] || null;
  const away = competitors.find(c => String(c.homeAway || '').toLowerCase() === 'away') || competitors[1] || null;
  if (!home || !away) return null;

  const statusObj = comp?.status || event.status || {};
  const type = statusObj.type || {};
  const rawStatus = type.shortDetail || type.detail || type.description || type.name || statusObj.displayClock || event.status?.type?.name || 'NS';
  const state = String(type.state || '').toLowerCase();
  const completed = !!type.completed;
  const inProgress = state === 'in' || state === 'inprogress' || state === 'in_progress' || /in[_ ]?progress/i.test(String(type.name || ''));
  const date = String(comp?.date || event.date || '').slice(0, 10);

  return {
    id: String(event.id),
    espnId: String(event.id),
    date,
    time: toLocalTime(comp?.date || event.date),
    league,
    rawHome: teamDisplayName(home),
    rawAway: teamDisplayName(away),
    homeTeam: teamDisplayName(home),
    awayTeam: teamDisplayName(away),
    h: cleanScore(home.score),
    a: cleanScore(away.score),
    status: rawStatus,
    minute: statusObj.displayClock || type.detail || null,
    started: inProgress || completed || hasScore(home.score) || hasScore(away.score),
    finished: completed,
    homeTeamId: String(home.team?.id || home.id || ''),
    awayTeamId: String(away.team?.id || away.id || ''),
    scoreSource: 'espn',
    eventSource: null,
    source: 'espn'
  };
}

function teamDisplayName(competitor) {
  const team = competitor?.team || competitor || {};
  return team.displayName || team.shortDisplayName || team.name || competitor?.displayName || competitor?.name || '';
}

function toLocalTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function cleanScore(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasScore(value) {
  return cleanScore(value) !== null;
}

function findBestEspnEvent(fixture, rawEvents = [], opts = {}) {
  const explicit = fixture.espnId || fixture.sourceIds?.espn || fixture.sourceIds?.espnEvent || fixture.espnEventId;
  if (explicit) {
    const byId = rawEvents.find(raw => String(raw.id) === String(explicit));
    if (byId) return byId;
  }

  const fixtureDate = String(fixture.date || '').slice(0, 10);
  const candidates = rawEvents.filter(raw => !fixtureDate || !raw.date || raw.date === fixtureDate);
  let best = null;
  let bestScore = 0;
  for (const raw of candidates) {
    const directHome = sameTeam(fixture.h, raw.rawHome) ? 50 : softTeamScore(fixture.h, raw.rawHome);
    const directAway = sameTeam(fixture.a, raw.rawAway) ? 50 : softTeamScore(fixture.a, raw.rawAway);
    const swapHome = sameTeam(fixture.h, raw.rawAway) ? 50 : softTeamScore(fixture.h, raw.rawAway);
    const swapAway = sameTeam(fixture.a, raw.rawHome) ? 50 : softTeamScore(fixture.a, raw.rawHome);
    const direct = directHome + directAway;
    const swapped = swapHome + swapAway - 18;
    const score = Math.max(direct, swapped);
    if (score > bestScore) {
      bestScore = score;
      best = raw;
    }
  }
  const threshold = Number(opts.matchThreshold || 82);
  return bestScore >= threshold ? best : null;
}

function softTeamScore(a, b) {
  const aa = normTeam(a);
  const bb = normTeam(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 50;
  if (aa.includes(bb) || bb.includes(aa)) return 42;
  const sa = new Set(aa.split(' ').filter(Boolean));
  const sb = new Set(bb.split(' ').filter(Boolean));
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit ? Math.round((hit / Math.max(sa.size, sb.size)) * 40) : 0;
}

function scoreLabel(raw) {
  if (raw.h == null || raw.a == null) return '---';
  return `${raw.h}-${raw.a}`;
}

function parseSummary(payload, fixture, meta = {}) {
  const teamMap = extractTeamMap(payload, fixture);
  const items = collectEventItems(payload);
  const scorers = [];
  const yellowCards = [];
  const redCards = [];
  const doubleYellowCards = [];
  const sample = [];

  for (const item of items) {
    const parsed = parseEventItem(item, fixture, teamMap);
    if (!parsed) continue;
    if (sample.length < 12) sample.push({ type: parsed.type, minute: parsed.minute, player: parsed.player, team: parsed.team, text: parsed.text?.slice?.(0, 180) || '' });

    if (parsed.type === 'goal') {
      scorers.push({ team: parsed.team, minute: parsed.minute, player: parsed.player, penalty: parsed.penalty, og: parsed.og, sourceText: parsed.text });
    } else if (parsed.type === 'yellow') {
      yellowCards.push({ team: parsed.team, minute: parsed.minute, player: parsed.player, yellow: true, sourceText: parsed.text });
    } else if (parsed.type === 'red') {
      redCards.push({ team: parsed.team, minute: parsed.minute, player: parsed.player, red: true, sourceText: parsed.text });
    } else if (parsed.type === 'double-yellow') {
      doubleYellowCards.push({ team: parsed.team, minute: parsed.minute, player: parsed.player, yellowRed: true, red: true, sourceText: parsed.text });
      redCards.push({ team: parsed.team, minute: parsed.minute, player: parsed.player, yellowRed: true, red: true, sourceText: parsed.text });
    }
  }

  return {
    scorers: dedupeEvents(scorers),
    yellowCards: dedupeEvents(yellowCards),
    redCards: dedupeEvents(redCards),
    doubleYellowCards: dedupeEvents(doubleYellowCards),
    eventItemCount: items.length,
    teamMap,
    sample,
    rawKeys: meta.debug ? Object.keys(payload || {}).slice(0, 50) : undefined
  };
}

function extractTeamMap(payload, fixture) {
  const map = { byId: {}, home: fixture?.h || null, away: fixture?.a || null };
  const competitors = payload?.header?.competitions?.[0]?.competitors || payload?.boxscore?.teams || [];
  for (const c of competitors) {
    const team = c.team || c;
    const id = String(team.id || c.id || '').trim();
    const name = team.displayName || team.shortDisplayName || team.name || c.displayName || c.name || '';
    const homeAway = String(c.homeAway || c.homeAwayDisplay || '').toLowerCase();
    if (id) map.byId[id] = { name, homeAway };
    if (homeAway === 'home' && name) map.home = fixture?.h || name;
    if (homeAway === 'away' && name) map.away = fixture?.a || name;
  }
  return map;
}

function collectEventItems(payload) {
  const items = [];
  const seen = new Set();
  const directKeys = ['keyEvents', 'plays', 'commentary', 'scoringPlays'];
  for (const key of directKeys) {
    const arr = payload?.[key];
    if (Array.isArray(arr)) pushItems(items, seen, arr, key);
  }
  const compDetails = payload?.header?.competitions?.[0]?.details;
  if (Array.isArray(compDetails)) pushItems(items, seen, compDetails, 'header.details');

  // ESPN soccer payloads have moved these arrays around a few times. This keeps the source useful
  // even when the exact key changes, without trying to parse the whole API object as events.
  walkForEventLikeArrays(payload, items, seen, 0, new Set());
  return items;
}

function pushItems(out, seen, arr, origin) {
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const text = textOf(item);
    const type = typeText(item);
    if (!text && !type && item.scoringPlay !== true) continue;
    const key = `${origin}:${item.id || item.sequence || text}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, __origin: origin });
  }
}

function walkForEventLikeArrays(value, out, seen, depth, visited) {
  if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    const eventLike = value.filter(x => x && typeof x === 'object' && (textOf(x) || typeText(x) || x.scoringPlay === true));
    if (eventLike.length >= 1 && eventLike.length <= 200) pushItems(out, seen, eventLike, `walk:${depth}`);
    for (const item of value.slice(0, 50)) walkForEventLikeArrays(item, out, seen, depth + 1, visited);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['athletes', 'competitors', 'teams', 'leaders', 'standings', 'statistics'].includes(key)) continue;
    walkForEventLikeArrays(child, out, seen, depth + 1, visited);
  }
}

function parseEventItem(item, fixture, teamMap) {
  const text = textOf(item);
  const type = typeText(item);
  const hay = `${type} ${text}`.toLowerCase();
  const scoring = item.scoringPlay === true || /\bgoal\b|penalty.*goal|own goal/i.test(hay);
  const isSecondYellow = /second yellow|yellow-red|yellow\/red|2nd yellow/i.test(hay);
  const isRed = /\bred card\b|sent off|dismissed/i.test(hay) || isSecondYellow;
  const isYellow = /\byellow card\b|booked/i.test(hay) && !isRed;

  let kind = null;
  if (scoring && !/goal kick|goalkeeper|goal line/i.test(hay)) kind = 'goal';
  else if (isSecondYellow) kind = 'double-yellow';
  else if (isRed) kind = 'red';
  else if (isYellow) kind = 'yellow';
  if (!kind) return null;

  const player = extractPlayer(item, text, kind);
  const minute = extractMinute(item, text);
  const team = extractSide(item, text, fixture, teamMap);

  return {
    type: kind,
    team,
    minute,
    player,
    penalty: /penalty|pen\b|spot kick/i.test(hay),
    og: /own goal|\bog\b/i.test(hay),
    text
  };
}

function textOf(item) {
  return String(item?.text || item?.shortText || item?.description || item?.displayText || item?.headline || '').trim();
}

function typeText(item) {
  const t = item?.type || item?.playType || item?.eventType || {};
  if (typeof t === 'string') return t;
  return String(t.text || t.displayName || t.name || t.abbreviation || t.slug || item?.typeText || '').trim();
}

function extractPlayer(item, text, kind) {
  const direct = item?.athlete?.displayName || item?.athlete?.fullName || item?.athlete?.shortName ||
    item?.athletes?.[0]?.displayName || item?.athletes?.[0]?.fullName || item?.participants?.[0]?.athlete?.displayName ||
    item?.player?.displayName || item?.playerName || item?.name;
  if (direct) return String(direct).trim();

  let m = text.match(/^([^()]+?)\s*\(([^)]+)\)\s*(?:Yellow Card|Red Card|Second Yellow|is shown|receives)/i);
  if (m) return cleanPlayerName(m[1]);

  m = text.match(/^([^–—-]+?)\s+[–—-]\s+\d{1,3}(?:\+\d+)?'/);
  if (m) return cleanPlayerName(m[1]);

  if (kind === 'goal') {
    m = text.match(/Goal!.*?\.\s*([^().]+?)\s*\(([^)]+)\)/i);
    if (m) return cleanPlayerName(m[1]);
    m = text.match(/^([^()]+?)\s*\(([^)]+)\).*?goal/i);
    if (m) return cleanPlayerName(m[1]);
  }

  m = text.match(/^([A-ZÁÉÍÓÖŐÚÜŰĂÂÎȘȚŞŢ][^,.;()]{2,60})/u);
  if (m) return cleanPlayerName(m[1]);
  return '';
}

function cleanPlayerName(value) {
  return String(value || '')
    .replace(/\b(Goal|Yellow Card|Red Card|Penalty|Own Goal)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[–—-]+$/g, '')
    .trim();
}

function extractMinute(item, text) {
  const candidates = [
    item?.clock?.displayValue,
    item?.clock?.display_value,
    item?.displayClock,
    item?.time?.displayValue,
    item?.timeDisplay,
    item?.time_display,
    item?.minute,
    item?.clock
  ].filter(v => v !== undefined && v !== null && v !== '');
  for (const v of candidates) {
    if (typeof v === 'number') return String(Math.max(0, Math.round(v / 60)));
    const s = String(v).trim();
    const m = s.match(/(\d{1,3})(?:\+\d+)?/);
    if (m) return m[0];
  }
  const m = String(text || '').match(/(?:at\s*)?(\d{1,3})(?:\+\d+)?'/i) || String(text || '').match(/\b(\d{1,3})(?:\+\d+)?\s*(?:min|minute)/i);
  return m ? m[0].replace(/'/g, '') : null;
}

function extractSide(item, text, fixture, teamMap) {
  const homeAway = String(item?.homeAway || item?.team?.homeAway || '').toLowerCase();
  if (homeAway === 'home') return 'h';
  if (homeAway === 'away') return 'a';

  const teamId = String(item?.team?.id || item?.teamId || item?.team_id || '').trim();
  if (teamId && teamMap?.byId?.[teamId]?.homeAway) {
    return teamMap.byId[teamId].homeAway === 'away' ? 'a' : 'h';
  }

  const names = [
    item?.team?.displayName,
    item?.team?.shortDisplayName,
    item?.team?.name,
    item?.teamName,
    item?.team_name,
    teamId && teamMap?.byId?.[teamId]?.name
  ].filter(Boolean).map(String);

  const paren = String(text || '').match(/\(([^)]+)\)/);
  if (paren) names.push(paren[1]);

  for (const name of names) {
    if (fixture?.h && sameTeam(name, fixture.h)) return 'h';
    if (fixture?.a && sameTeam(name, fixture.a)) return 'a';
    if (teamMap?.home && sameTeam(name, teamMap.home)) return 'h';
    if (teamMap?.away && sameTeam(name, teamMap.away)) return 'a';
  }

  return 'h';
}

function dedupeEvents(events = []) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = [e.team, e.minute || '', normTeam(e.player || ''), e.penalty ? 'p' : '', e.og ? 'og' : '', e.red ? 'r' : '', e.yellow ? 'y' : '', e.yellowRed ? 'yr' : ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => Number(String(a.minute || '').match(/\d+/)?.[0] || 999) - Number(String(b.minute || '').match(/\d+/)?.[0] || 999));
}
