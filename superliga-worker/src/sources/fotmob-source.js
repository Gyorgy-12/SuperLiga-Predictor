import { normalizeLiveMatch } from '../core/normalize-live.js';
import { sameTeam } from '../core/team-match.js';

const DEFAULT_FOTMOB_API_BASE = 'https://www.fotmob.com/api';
const DEFAULT_FOTMOB_LEAGUE_ID = '189';
const DEFAULT_FOTMOB_CCODE3 = 'ROU';
const DEFAULT_FOTMOB_SEASON = '2026/2027';
const DEFAULT_REFERER = 'https://www.fotmob.com/ro/leagues/189/overview/liga-i';

export async function fetchFotmobEvents(env, fixtures = [], opts = {}) {
  const base = getBase(env, opts);
  const leagueId = getLeagueId(env, opts);
  const ccode3 = getCountryCode(env, opts);
  const includeIncidents = !!(
    opts.includeIncidents ||
    opts.incidents ||
    opts.withDetails ||
    opts.details ||
    opts.source === 'incidents' ||
    opts.source === 'fotmob-incidents'
  );

  const urls = [];
  const warnings = [];
  const active = Array.isArray(opts.activeFixtures) ? opts.activeFixtures : fixtures;
  const dates = buildDateList(active, opts);
  const rawEvents = [];
  const seen = new Set();

  for (const d of dates) {
    for (const url of buildDateUrls(base, d, ccode3, opts)) {
      urls.push(url);
      const payload = await fetchJson(url, env, opts).catch(error => {
        warnings.push(`${url} ${error?.message || String(error)}`);
        return null;
      });
      for (const raw of collectFotmobMatches(payload, { origin: 'date', url, leagueId })) {
        if (!raw?.id) continue;
        const key = String(raw.id);
        if (seen.has(key)) continue;
        seen.add(key);
        rawEvents.push(raw);
      }
    }
  }

  const shouldTryLeague = opts.includeLeague === true || opts.leagueSearch === true || rawEvents.length === 0;
  if (shouldTryLeague) {
    for (const url of buildLeagueUrls(base, leagueId, ccode3, opts)) {
      urls.push(url);
      const payload = await fetchJson(url, env, opts).catch(error => {
        warnings.push(`${url} ${error?.message || String(error)}`);
        return null;
      });
      for (const raw of collectFotmobMatches(payload, { origin: 'league', url, leagueId })) {
        if (!raw?.id) continue;
        const key = String(raw.id);
        if (seen.has(key)) continue;
        seen.add(key);
        rawEvents.push(raw);
      }
    }
  }

  const matched = [];
  const unmatched = [];
  const matchedRawIds = new Set();
  const results = {};
  const incidentDebug = [];

  for (const fixture of active || []) {
    const raw = findBestFotmobEvent(fixture, rawEvents, opts);
    if (!raw) {
      unmatched.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        fotmobId: fixture.fotmobId || fixture.matchId || fixture.sourceIds?.fotmob || null
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
      scoreSource: 'fotmob',
      eventSource: includeIncidents ? 'fotmob' : null,
      source: 'fotmob',
      updatedAt: new Date().toISOString()
    };

    let detailPack = null;
    if (includeIncidents && raw.id) {
      detailPack = await fetchFotmobMatchDetails(env, raw.id, { ...opts, base, fixture, debug: opts.debug }).catch(error => ({
        ok: false,
        source: 'fotmob-match-details',
        matchId: String(raw.id),
        error: error?.message || String(error),
        warnings: [error?.message || String(error)],
        scorers: [],
        yellowCards: [],
        redCards: [],
        doubleYellowCards: []
      }));
      if (detailPack?.warnings?.length) warnings.push(...detailPack.warnings.map(w => `details ${raw.id}: ${w}`));
      rawForNormalize = {
        ...rawForNormalize,
        ...(detailPack?.scorePatch || {}),
        scorers: detailPack?.scorers || [],
        yellowCards: detailPack?.yellowCards || [],
        redCards: detailPack?.redCards || [],
        doubleYellowCards: detailPack?.doubleYellowCards || [],
        eventSource: 'fotmob',
        fotmobDetailsUrl: detailPack?.url || null
      };
      incidentDebug.push({
        id: fixture.id,
        matchId: String(raw.id),
        url: detailPack?.url || null,
        ok: !!detailPack?.ok,
        scorerCount: detailPack?.scorers?.length || 0,
        yellowCount: detailPack?.yellowCards?.length || 0,
        redCount: detailPack?.redCards?.length || 0,
        doubleYellowCount: detailPack?.doubleYellowCards?.length || 0,
        eventItemCount: detailPack?.eventItemCount || 0,
        warningCount: detailPack?.warnings?.length || 0,
        sample: detailPack?.sample || []
      });
    }

    const normalized = normalizeLiveMatch(fixture.id, rawForNormalize, fixture, {
      source: 'fotmob',
      scoreSource: 'fotmob',
      eventSource: includeIncidents ? 'fotmob' : null
    });
    if (normalized) results[fixture.id] = normalized;

    matched.push({
      id: fixture.id,
      fotmobId: String(raw.id),
      matchId: String(raw.id),
      date: raw.date,
      time: raw.time || null,
      h: fixture.h,
      a: fixture.a,
      rawHome: raw.rawHome,
      rawAway: raw.rawAway,
      status: raw.status,
      score: scoreLabel(raw),
      pageUrl: raw.pageUrl || null,
      origin: raw.origin || null,
      detailFetched: !!detailPack,
      scorerCount: detailPack?.scorers?.length || 0,
      yellowCount: detailPack?.yellowCards?.length || 0,
      redCount: detailPack?.redCards?.length || 0,
      doubleYellowCount: detailPack?.doubleYellowCards?.length || 0
    });
  }

  const rawUnmatched = opts.debug ? rawEvents
    .filter(raw => !matchedRawIds.has(String(raw.id)))
    .slice(0, Number(opts.rawUnmatchedLimit || 50))
    .map(raw => ({
      rawId: raw.id,
      date: raw.date,
      time: raw.time || null,
      home: raw.rawHome,
      away: raw.rawAway,
      status: raw.status,
      origin: raw.origin,
      pageUrl: raw.pageUrl || null
    })) : undefined;

  return {
    ok: true,
    source: includeIncidents ? 'fotmob-incidents' : 'fotmob-fixtures',
    leagueId,
    ccode3,
    base,
    urls: dedupe(urls),
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

export async function fetchFotmobMatchDetails(env, matchId, opts = {}) {
  if (!matchId) {
    return { ok: false, source: 'fotmob-match-details', error: 'missing_matchId', scorers: [], yellowCards: [], redCards: [], doubleYellowCards: [] };
  }
  const base = opts.base || getBase(env, opts);
  const url = `${base}/matchDetails?matchId=${encodeURIComponent(String(matchId))}`;
  const payload = await fetchJson(url, env, opts);
  const parsed = parseMatchDetails(payload, opts.fixture || null, { matchId, url, debug: opts.debug });
  return {
    ok: true,
    source: 'fotmob-match-details',
    matchId: String(matchId),
    url,
    ...parsed,
    updatedAt: new Date().toISOString()
  };
}

function getBase(env, opts = {}) {
  return String(opts.base || env.FOTMOB_API_BASE_URL || DEFAULT_FOTMOB_API_BASE).replace(/\/+$/, '');
}

function getLeagueId(env, opts = {}) {
  return String(opts.leagueId || opts.league || env.FOTMOB_LEAGUE_ID || DEFAULT_FOTMOB_LEAGUE_ID).trim() || DEFAULT_FOTMOB_LEAGUE_ID;
}

function getCountryCode(env, opts = {}) {
  return String(opts.ccode3 || env.FOTMOB_CCODE3 || DEFAULT_FOTMOB_CCODE3).trim() || DEFAULT_FOTMOB_CCODE3;
}

function buildDateList(fixtures = [], opts = {}) {
  if (opts.date) return [String(opts.date).slice(0, 10)];
  const dates = [...new Set((fixtures || []).map(f => String(f.date || '').slice(0, 10)).filter(Boolean))].sort();
  const max = Number(opts.maxDates || 0);
  if (max > 0) return dates.slice(0, max);
  return dates.length ? dates : [new Date().toISOString().slice(0, 10)];
}

function buildDateUrls(base, dateLike, ccode3, opts = {}) {
  const ymd = toFotmobDate(dateLike);
  const tz = encodeURIComponent(String(opts.timezone || opts.tz || 'Europe/Bucharest'));
  const urls = [
    `${base}/matches?date=${ymd}`,
    `${base}/matches?date=${ymd}&ccode3=${encodeURIComponent(ccode3)}`,
    `${base}/matches?date=${ymd}&timezone=${tz}`,
    `${base}/matches?date=${ymd}&ccode3=${encodeURIComponent(ccode3)}&timezone=${tz}`,
    `${base}/matches?date=${ymd}&ccode3=${encodeURIComponent(ccode3)}&timezone=${tz}&show=all`,
    `${base}/matches?date=${ymd}&ccode3=${encodeURIComponent(ccode3)}&lang=en`
  ];
  if (opts.url) urls.unshift(String(opts.url));
  return dedupe(urls);
}

function buildLeagueUrls(base, leagueId, ccode3, opts = {}) {
  const season = String(opts.season || opts.fotmobSeason || envless(opts, 'FOTMOB_SEASON') || DEFAULT_FOTMOB_SEASON);
  const seasonHyphen = season.replace('/', '-');
  const tz = encodeURIComponent(String(opts.timezone || opts.tz || 'Europe/Bucharest'));
  const urls = [
    `${base}/leagues?id=${encodeURIComponent(leagueId)}&ccode3=${encodeURIComponent(ccode3)}`,
    `${base}/leagues?id=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}`,
    `${base}/leagues?id=${encodeURIComponent(leagueId)}&ccode3=${encodeURIComponent(ccode3)}&season=${encodeURIComponent(season)}`,
    `${base}/leagues?id=${encodeURIComponent(leagueId)}&ccode3=${encodeURIComponent(ccode3)}&season=${encodeURIComponent(seasonHyphen)}`,
    `${base}/leagues?id=${encodeURIComponent(leagueId)}&ccode3=${encodeURIComponent(ccode3)}&season=${encodeURIComponent(season)}&timezone=${tz}`
  ];
  return dedupe(urls);
}

function envless(opts, key) {
  return opts?.env?.[key] || undefined;
}

function toFotmobDate(dateLike) {
  return String(dateLike || '').slice(0, 10).replace(/-/g, '');
}

async function fetchJson(url, env, opts = {}) {
  const attempts = buildFetchAttempts(env, opts);
  const errors = [];

  for (const attempt of attempts) {
    const response = await fetch(url, {
      headers: attempt.headers,
      redirect: 'follow',
      cf: opts.force ? { cacheTtl: 0, cacheEverything: false } : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (!response.ok) {
      errors.push(`${attempt.name} HTTP ${response.status}${contentType ? ` ${contentType.split(';')[0]}` : ''}${text ? ` body=${compactBodySample(text)}` : ''}`);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      errors.push(`${attempt.name} JSON_PARSE ${error?.message || String(error)} body=${compactBodySample(text)}`);
    }
  }

  throw new Error(errors.join(' | ') || 'no_fotmob_fetch_attempt_succeeded');
}

function buildFetchAttempts(env, opts = {}) {
  const referer = env.FOTMOB_REFERER || opts.referer || DEFAULT_REFERER;
  const userAgent = env.FOTMOB_USER_AGENT || opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 SuperLigaPredictor/1.0';
  const baseHeaders = {
    accept: 'application/json,text/plain,*/*',
    'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer,
    origin: 'https://www.fotmob.com',
    'user-agent': userAgent
  };

  const explicitXfm = opts.xFmReq || opts.xfm || env.FOTMOB_X_FM_REQ || null;
  const xfmValues = dedupe([explicitXfm, 'true', '1', 'SuperLigaPredictor']).filter(Boolean);
  const attempts = [];

  for (const value of xfmValues) {
    attempts.push({
      name: `xfm:${String(value).slice(0, 24)}`,
      headers: {
        ...baseHeaders,
        'x-fm-req': String(value),
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty'
      }
    });
  }

  // Keep the plain browser-like request last, so the debug output shows whether x-fm-req changed anything.
  attempts.push({ name: 'plain-browser-like', headers: baseHeaders });
  return attempts;
}

function compactBodySample(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function collectFotmobMatches(payload, meta = {}) {
  const out = [];
  const seenObjects = new WeakSet();

  function walk(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    const parsed = parseFotmobMatchObject(value, meta);
    if (parsed) out.push(parsed);

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child);
    }
  }

  walk(payload);
  return out;
}

function parseFotmobMatchObject(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = pick(raw.id, raw.matchId, raw.fixtureId, raw.eventId, raw.general?.matchId, raw.header?.id);
  if (!id) return null;

  const homeObj = raw.home || raw.homeTeam || raw.team1 || raw.header?.teams?.[0] || raw.general?.homeTeam;
  const awayObj = raw.away || raw.awayTeam || raw.team2 || raw.header?.teams?.[1] || raw.general?.awayTeam;
  const homeName = teamName(homeObj) || raw.homeName || raw.homeTeamName || raw.home?.longName;
  const awayName = teamName(awayObj) || raw.awayName || raw.awayTeamName || raw.away?.longName;
  if (!homeName || !awayName) return null;

  const dateInfo = parseDateTime(
    raw.time || raw.utcTime || raw.matchTimeUTC || raw.matchTimeUtc || raw.status?.utcTime || raw.header?.status?.utcTime || raw.general?.matchTimeUTC || raw.general?.matchTimeUtc || raw.date
  );
  const score = extractScore(raw);
  const status = parseStatus(raw.status || raw.header?.status || raw);
  const leagueId = raw.leagueId || raw.parentLeagueId || raw.primaryId || raw.tournament?.id || raw.league?.id || meta.leagueId || null;

  return {
    id: String(id),
    rawId: String(id),
    rawHome: String(homeName),
    rawAway: String(awayName),
    homeId: homeObj?.id ?? raw.homeId ?? raw.general?.homeTeam?.id ?? null,
    awayId: awayObj?.id ?? raw.awayId ?? raw.general?.awayTeam?.id ?? null,
    date: dateInfo.date,
    time: dateInfo.time,
    h: score.h,
    a: score.a,
    status: status.status,
    started: status.started,
    finished: status.finished,
    minute: status.minute,
    pageUrl: raw.pageUrl || raw.matchPageUrl || raw.url || raw.general?.matchUrl || null,
    origin: meta.origin || raw.origin || null,
    leagueId,
    source: 'fotmob'
  };
}

function findBestFotmobEvent(fixture, rawEvents = [], opts = {}) {
  const existing = fixture.fotmobId || fixture.matchId || fixture.sourceIds?.fotmob || null;
  if (existing) {
    const exact = rawEvents.find(raw => String(raw.id) === String(existing));
    if (exact) return exact;
  }

  let best = null;
  let bestScore = 0;
  for (const raw of rawEvents) {
    const score = fotmobMatchScore(fixture, raw, opts);
    if (score > bestScore) {
      bestScore = score;
      best = raw;
    }
  }
  const threshold = Number(opts.matchThreshold || 145);
  return bestScore >= threshold ? best : null;
}

function fotmobMatchScore(fixture, raw, opts = {}) {
  if (!fixture || !raw) return 0;
  let score = 0;
  const sameHome = sameTeam(fixture.h, raw.rawHome);
  const sameAway = sameTeam(fixture.a, raw.rawAway);
  const reverseHome = sameTeam(fixture.h, raw.rawAway);
  const reverseAway = sameTeam(fixture.a, raw.rawHome);
  if (sameHome) score += 80;
  if (sameAway) score += 80;
  if (reverseHome && reverseAway) score -= 80;

  const fd = String(fixture.date || '').slice(0, 10);
  const rd = String(raw.date || '').slice(0, 10);
  if (fd && rd) {
    if (fd === rd) score += 40;
    else if (Math.abs(Date.parse(`${fd}T12:00:00Z`) - Date.parse(`${rd}T12:00:00Z`)) <= 36 * 60 * 60 * 1000) score += 12;
    else score -= 50;
  }

  const ft = String(fixture.t || '').slice(0, 5);
  const rt = String(raw.time || '').slice(0, 5);
  if (ft && rt && ft === rt) score += 8;

  const wantedLeague = String(opts.leagueId || opts.league || DEFAULT_FOTMOB_LEAGUE_ID);
  if (raw.leagueId && String(raw.leagueId) === wantedLeague) score += 8;
  return score;
}

function parseMatchDetails(payload, fixture = null, meta = {}) {
  const teams = extractDetailTeams(payload);
  const status = parseStatus(payload?.header?.status || payload?.general || payload);
  const scorePatch = extractDetailScore(payload, status);
  const events = collectDetailEvents(payload);
  const scorers = [];
  const yellowCards = [];
  const redCards = [];
  const doubleYellowCards = [];

  for (const event of events) {
    const parsed = normalizeFotmobEvent(event, fixture, teams);
    if (!parsed) continue;
    if (parsed.kind === 'goal') scorers.push(parsed.row);
    else if (parsed.kind === 'yellow') yellowCards.push(parsed.row);
    else if (parsed.kind === 'red') redCards.push(parsed.row);
    else if (parsed.kind === 'double-yellow') doubleYellowCards.push(parsed.row);
  }

  const sample = meta.debug ? events.slice(0, 12).map(e => ({
    type: e.type || e.eventType || e.card || e.cardType || null,
    time: e.time ?? e.minute ?? e.min ?? null,
    overloadTime: e.overloadTime ?? e.addedTime ?? null,
    player: playerName(e),
    isHome: e.isHome ?? null,
    teamId: e.teamId || e.team?.id || null
  })) : undefined;

  return {
    eventItemCount: events.length,
    scorers,
    yellowCards,
    redCards,
    doubleYellowCards,
    scorePatch,
    sample,
    warnings: []
  };
}

function extractDetailTeams(payload) {
  const home = payload?.general?.homeTeam || payload?.header?.teams?.[0] || payload?.content?.lineup?.lineup?.[0]?.team || null;
  const away = payload?.general?.awayTeam || payload?.header?.teams?.[1] || payload?.content?.lineup?.lineup?.[1]?.team || null;
  return {
    homeId: home?.id ?? home?.teamId ?? null,
    awayId: away?.id ?? away?.teamId ?? null,
    homeName: teamName(home),
    awayName: teamName(away)
  };
}

function extractDetailScore(payload, status = {}) {
  const scoreStr = payload?.header?.status?.scoreStr || payload?.general?.status?.scoreStr || status.scoreStr || '';
  const parsed = parseScoreString(scoreStr);
  return {
    h: parsed.h,
    a: parsed.a,
    status: status.status,
    started: status.started,
    finished: status.finished,
    minute: status.minute
  };
}

function collectDetailEvents(payload) {
  const direct = payload?.content?.matchFacts?.events?.events;
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(payload?.content?.matchFacts?.events)) return payload.content.matchFacts.events;

  const out = [];
  const seenObjects = new WeakSet();
  function walk(value, key = '') {
    if (!value) return;
    if (Array.isArray(value)) {
      const looksLikeEvents = /event|incident|timeline|facts/i.test(String(key)) && value.some(isFotmobEventLike);
      if (looksLikeEvents) {
        for (const item of value) if (isFotmobEventLike(item)) out.push(item);
        return;
      }
      for (const item of value) walk(item, key);
      return;
    }
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
  }
  walk(payload);
  return out;
}

function isFotmobEventLike(value) {
  if (!value || typeof value !== 'object') return false;
  const text = `${value.type || ''} ${value.eventType || ''} ${value.card || ''} ${value.cardType || ''}`.toLowerCase();
  return (
    value.time != null || value.minute != null || value.min != null ||
    text.includes('goal') || text.includes('yellow') || text.includes('red') || text.includes('card') ||
    value.player || value.playerName || value.name
  );
}

function normalizeFotmobEvent(event, fixture, teams) {
  const text = `${event.type || ''} ${event.eventType || ''} ${event.card || ''} ${event.cardType || ''} ${event.incidentType || ''}`.toLowerCase().replace(/[_-]+/g, ' ');
  const isOwnGoal = /own\s*goal|owngoal/.test(text) || !!event.ownGoal || !!event.isOwnGoal;
  const isPenalty = /penalty|pen\b/.test(text) || !!event.isPenalty;

  let kind = null;
  if (/second\s*yellow|yellow\s*red|double\s*yellow/.test(text) || event.secondYellow || event.yellowRed) kind = 'double-yellow';
  else if (/red/.test(text) || event.redCard) kind = 'red';
  else if (/yellow|card/.test(text) && !/red/.test(text)) kind = 'yellow';
  else if (/goal/.test(text) || event.isGoal) kind = 'goal';
  if (!kind) return null;

  const row = {
    team: eventTeamSide(event, fixture, teams),
    minute: minuteString(event.time ?? event.minute ?? event.min ?? event.matchMinute, event.overloadTime ?? event.addedTime ?? event.addedMinutes),
    player: playerName(event),
    og: kind === 'goal' && isOwnGoal,
    penalty: kind === 'goal' && isPenalty,
    type: kind
  };
  return { kind, row };
}

function eventTeamSide(event, fixture, teams) {
  if (event.isHome === true || event.homeAway === 'home' || event.side === 'home') return 'h';
  if (event.isHome === false || event.homeAway === 'away' || event.side === 'away') return 'a';
  const teamId = event.teamId || event.team?.id || event.team?.teamId || event.participantId || null;
  if (teamId != null) {
    if (teams.homeId != null && String(teamId) === String(teams.homeId)) return 'h';
    if (teams.awayId != null && String(teamId) === String(teams.awayId)) return 'a';
  }
  const team = event.teamName || event.team?.name || event.team || '';
  if (team && fixture) {
    if (sameTeam(team, fixture.h)) return 'h';
    if (sameTeam(team, fixture.a)) return 'a';
  }
  if (team && teams.homeName && sameTeam(team, teams.homeName)) return 'h';
  if (team && teams.awayName && sameTeam(team, teams.awayName)) return 'a';
  return 'h';
}

function playerName(event) {
  return String(
    event.player?.name ||
    event.player?.fullName ||
    event.playerName ||
    event.nameStr ||
    event.name ||
    event.person ||
    event.actor?.name ||
    ''
  ).trim();
}

function extractScore(raw) {
  const scoreStr = raw.status?.scoreStr || raw.header?.status?.scoreStr || raw.scoreStr || '';
  const parsed = parseScoreString(scoreStr);
  return {
    h: numberOrNull(raw.home?.score ?? raw.homeScore ?? raw.scoreHome ?? raw.homeTeam?.score ?? parsed.h),
    a: numberOrNull(raw.away?.score ?? raw.awayScore ?? raw.scoreAway ?? raw.awayTeam?.score ?? parsed.a)
  };
}

function parseScoreString(value) {
  const s = String(value || '').trim();
  const m = s.match(/(\d+)\s*[-–:]\s*(\d+)/);
  if (!m) return { h: null, a: null };
  return { h: Number(m[1]), a: Number(m[2]) };
}

function parseStatus(statusLike) {
  const reason = statusLike?.reason || {};
  const rawStatus = reason.short || reason.long || statusLike?.short || statusLike?.status || statusLike?.statusStr || statusLike?.statusId || statusLike?.phase || '';
  const scoreStr = statusLike?.scoreStr || '';
  let status = String(rawStatus || '').trim() || 'NS';
  const started = !!statusLike?.started || !!statusLike?.ongoing || ['1st half', '2nd half', 'halftime', 'started', 'in play'].includes(status.toLowerCase());
  const finished = !!statusLike?.finished || ['ft', 'full-time', 'full time', 'finished'].includes(status.toLowerCase());
  if (!status || status === '1') status = started ? 'LIVE' : 'NS';
  const minute = statusLike?.minute || statusLike?.liveTime?.short || statusLike?.liveTime?.long || null;
  return { status, started, finished, minute, scoreStr };
}

function parseDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return { date: null, time: null };
  let s = raw;
  if (/^\d{8}T/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}${s.slice(8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s, time: null };
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) {
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
    return { date: null, time: null };
  }
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

function teamName(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return String(obj.name || obj.shortName || obj.longName || obj.localizedName || obj.teamName || '').trim();
}

function minuteString(minute, overload) {
  if (minute == null || minute === '') return null;
  const base = String(minute).replace(/'/g, '').trim();
  if (!base) return null;
  const extra = overload == null || overload === '' || Number(overload) === 0 ? '' : `+${String(overload).replace(/'/g, '').trim()}`;
  return `${base}${extra}'`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreLabel(raw) {
  const h = numberOrNull(raw.h);
  const a = numberOrNull(raw.a);
  if (h == null || a == null) return '---';
  return `${h}-${a}`;
}

function pick(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function dedupe(list = []) {
  return [...new Set(list.filter(Boolean))];
}
