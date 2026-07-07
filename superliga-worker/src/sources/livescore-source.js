import { normalizeLiveMatch } from '../core/normalize-live.js';

const LIVESCORE_APP_BASE = 'https://prod-public-api.livescore.com/v1/api/app';
const DEFAULT_LIVESCORE_WEB_PAGE = 'https://www.livescore.com/en/football/romania/liga-1/';
const LIVESCORE_HEADERS = {
  'x-fsign': 'SW9D1eZo',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'accept': 'application/json,text/plain,*/*',
  'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
  'cache-control': 'no-cache'
};

/**
 * Score-master adapter.
 *
 * Ported from the optimized WC26 worker idea: prefer LiveScore's app JSON
 * endpoints with x-fsign, then fall back to the public league page parser.
 * The rest of the worker only sees normalized results keyed by our own ids.
 */
export async function fetchLiveScoreResults(env, fixtures = [], opts = {}) {
  const warnings = [];
  let rawList = [];
  let source = 'livescore-empty';
  let urls = [];

  if (!opts.url || isLiveScoreAppUrl(opts.url)) {
    const appPack = await fetchLiveScoreAppEvents(env, fixtures, opts).catch(error => ({ ok: false, raw: [], urls: [], warnings: [error?.message || String(error)] }));
    rawList = rawList.concat(appPack.raw || []);
    urls = urls.concat(appPack.urls || []);
    warnings.push(...(appPack.warnings || []));
    if ((appPack.raw || []).length) source = appPack.source || 'livescore-app';
  }

  if (!rawList.length) {
    const fallbackUrl = opts.url && !isLiveScoreAppUrl(opts.url) ? opts.url : resolveWebUrl(env, opts);
    const fetchPack = await fetchSource(fallbackUrl, opts);
    urls.push(fallbackUrl);
    if (!fetchPack.ok) return { ok: false, source: 'livescore', urls, url: fallbackUrl, results: {}, error: fetchPack.error, warnings };
    const parsed = await parseSourceBody(fetchPack);
    rawList = extractMatchList(parsed.data, parsed.text);
    source = parsed.source || 'livescore-web';
    warnings.push(...(parsed.warnings || []));
  }

  const mapped = await mapRawMatchesToResults(env, rawList, fixtures, opts);
  const unmatched = [];
  for (const raw of rawList) {
    const rawId = raw.id || raw.matchId || raw.eventId || raw.Eid || raw.Id;
    const home = readHomeName(raw);
    const away = readAwayName(raw);
    const fixture = findMappedFixture(raw, fixtures);
    if (!fixture) unmatched.push({ rawId, home, away, status: raw.status || raw.Eps || raw.EpsL || raw.state || null });
  }

  return {
    ok: true,
    source,
    urls,
    contentType: 'mixed',
    rawCount: rawList.length,
    count: Object.keys(mapped).length,
    results: mapped,
    unmatched: unmatched.slice(0, 12),
    warnings
  };
}

function isLiveScoreAppUrl(url = '') {
  return String(url || '').includes('prod-public-api.livescore.com') || String(url || '') === '';
}

function resolveWebUrl(env, opts = {}) {
  if (opts.url) return opts.url;
  return env.LIVE_SCORE_WEB_URL || env.LIVESCORE_WEB_URL || DEFAULT_LIVESCORE_WEB_PAGE;
}

function resolveAppBase(env, opts = {}) {
  if (opts.url && isLiveScoreAppUrl(opts.url)) return opts.url.replace(/\/$/, '');
  return (env.LIVE_SCORE_APP_BASE_URL || env.LIVESCORE_APP_BASE_URL || LIVESCORE_APP_BASE).replace(/\/$/, '');
}

function candidateDateStrings(fixtures = [], opts = {}) {
  const dates = new Set();
  if (opts.date) dates.add(String(opts.date).replace(/-/g, '').slice(0, 8));
  for (const f of fixtures || []) {
    const d = String(f?.date || '').replace(/-/g, '').slice(0, 8);
    if (/^\d{8}$/.test(d)) dates.add(d);
  }
  if (!dates.size) {
    const now = new Date();
    dates.add(ymd(now));
    dates.add(ymd(new Date(now.getTime() + 24 * 60 * 60 * 1000)));
  }
  return [...dates].filter(Boolean).slice(0, Number(opts.maxDates || 6));
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
        const res = await fetch(url, { headers: LIVESCORE_HEADERS, cf: { cacheTtl: Number(opts.force ? 0 : 15), cacheEverything: false } });
        if (!res.ok) { warnings.push(`${url} HTTP ${res.status}`); continue; }
        const data = await res.json().catch(() => null);
        const list = parseLiveScoreEvents(data);
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

function parseLiveScoreEvents(json) {
  const out = [];
  const stages = json?.Stages || json?.data?.Stages || [];
  for (const stage of stages) {
    const events = stage?.Events || stage?.events || [];
    for (const ev of events) {
      const t1 = (ev.T1 || ev.t1 || [])[0] || {};
      const t2 = (ev.T2 || ev.t2 || [])[0] || {};
      const homeTeam = String(t1.Nm || t1.name || t1.Snm || '').trim();
      const awayTeam = String(t2.Nm || t2.name || t2.Snm || '').trim();
      if (!homeTeam || !awayTeam) continue;
      const status = String(ev.Eps || ev.EpsL || ev.Epr || ev.Status || '').trim().toUpperCase();
      const statusText = String(ev.EpsL || ev.EtTx || ev.Epr || ev.Eps || '').trim().toUpperCase();
      const pH = firstInt(ev.Tr1P, ev.tr1p, ev.Trp1, ev.trp1, ev.PenaltyHome, ev.penaltyHome);
      const pA = firstInt(ev.Tr2P, ev.tr2p, ev.Trp2, ev.trp2, ev.PenaltyAway, ev.penaltyAway);
      out.push({
        eventId: ev.Eid != null ? String(ev.Eid) : (ev.ID != null ? String(ev.ID) : null),
        id: ev.Eid != null ? String(ev.Eid) : (ev.ID != null ? String(ev.ID) : null),
        homeTeam,
        awayTeam,
        h: firstInt(ev.Tr1, ev.tr1, ev.Score1, ev.score1),
        a: firstInt(ev.Tr2, ev.tr2, ev.Score2, ev.score2),
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
        rawLiveScoreEvent: ev
      });
    }
  }
  return out;
}

async function mapRawMatchesToResults(env, rawMatches, fixtures, opts = {}) {
  const results = {};
  for (const fixture of fixtures || []) {
    const raw = rawMatches.find(item => findMappedFixture(item, [fixture]));
    if (!raw) continue;

    let enriched = raw;
    const eventId = raw.eventId || raw.Eid || raw.id;
    if (eventId && (raw.started || raw.finished || raw.h != null || raw.a != null) && opts.incidents !== '0') {
      const extras = await fetchLiveScoreIncidentExtras(env, eventId).catch(() => null);
      if (extras) {
        enriched = {
          ...raw,
          scorers: extras.scorers?.length ? extras.scorers : raw.scorers || [],
          redCards: extras.redCards?.length ? extras.redCards : raw.redCards || [],
          yellowCards: extras.yellowCards?.length ? extras.yellowCards : raw.yellowCards || [],
          doubleYellowCards: extras.doubleYellowCards?.length ? extras.doubleYellowCards : raw.doubleYellowCards || []
        };
      }
    }

    const normalized = normalizeLiveMatch(
      fixture.id,
      { ...enriched, scoreSource: 'livescore', source: 'livescore' },
      fixture,
      { scoreSource: 'livescore', source: 'livescore' }
    );
    if (normalized && shouldExposeLiveScore(normalized, opts)) results[fixture.id] = normalized;
  }
  return results;
}

async function fetchLiveScoreIncidentExtras(env, eventId) {
  if (!eventId) return { scorers: [], redCards: [], yellowCards: [], doubleYellowCards: [] };
  const base = (env.LIVE_SCORE_APP_BASE_URL || env.LIVESCORE_APP_BASE_URL || LIVESCORE_APP_BASE).replace(/\/$/, '');
  const urls = [
    `${base}/event/detail/${eventId}/1?MD=1&Ccd=3&Lang=en`,
    `${base}/event/detail/${eventId}/1?MD=1&Lang=en`,
    `${base}/event/${eventId}/1?MD=1&Ccd=3&Lang=en`,
    `${base}/event/${eventId}/1?MD=1&Lang=en`,
    `${base}/event/incidents/${eventId}/1?MD=1&Lang=en`,
    `${base}/event/incidents/${eventId}?MD=1&Lang=en`,
    `${base}/event/detail/incidents/${eventId}?MD=1&Lang=en`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: LIVESCORE_HEADERS, cf: { cacheTtl: 15, cacheEverything: false } });
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      if (!data) continue;
      const scorers = extractGoalScorers(data);
      const cards = extractCards(data);
      if (scorers.length || cards.length) {
        return {
          scorers,
          redCards: cards.filter(c => c.red || c.yellowRed),
          yellowCards: cards.filter(c => c.yellow && !c.red && !c.yellowRed),
          doubleYellowCards: cards.filter(c => c.yellowRed)
        };
      }
    } catch (_) {}
  }
  return { scorers: [], redCards: [], yellowCards: [], doubleYellowCards: [] };
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
  const candidates = [ev.Eps, ev.EpsL, ev.Epr, ev.Ecov, ev.Min, ev.Minute, ev.Mi, ev.Emin].filter(x => x !== undefined && x !== null);
  for (const candidate of candidates) {
    const value = String(candidate).trim();
    const up = value.toUpperCase();
    if (up === 'HT' || up.includes('HALF TIME') || up.includes('HALFTIME') || up.includes('INTERVAL')) return 'HT';
    const plus = value.match(/(\d{1,3})\s*\+\s*(\d{1,2})/);
    if (plus) return `${plus[1]}+${plus[2]}'`;
    const clock = value.match(/^(\d{1,3})\s*:\s*\d{2}$/);
    if (clock) {
      const minute = Number(clock[1]);
      if (minute > 0 && minute <= 130) return `${minute}'`;
    }
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
  return ['FT', 'AET', 'AP', 'PEN', 'FINISHED', 'FULL TIME', 'AFTER PEN'].some(x => s.includes(x));
}

function isStartedStatus(status, statusText) {
  const s = `${status} ${statusText}`.toUpperCase();
  if (!s.trim()) return false;
  if (['NS', 'TBD', 'POSTP', 'CANC', 'CANCL'].some(x => s.includes(x))) return false;
  return ['LIVE', 'HT', '1H', '2H', 'ET', 'PEN', 'IN PLAY', "'"].some(x => s.includes(x)) || /\b\d{1,3}\b/.test(s);
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

function extractGoalScorers(root) {
  const lists = [root?.Incs, root?.incs, root?.Eve, root?.eve, root?.Events, root?.events, root?.Incidents, root?.incidents, ...collectIncidentLists(root)];
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const inc of list) {
      const type = String(inc.Type || inc.type || inc.Tp || inc.IT || inc.Cd || inc.code || inc.incidentType || '').toUpperCase();
      const detail = String(inc.Detail || inc.detail || inc.Info || inc.info || inc.Txt || inc.text || inc.Comment || inc.comment || inc.Name || inc.name || inc.Desc || inc.description || inc.incidentClass || '').toUpperCase();
      const blob = JSON.stringify(inc).toUpperCase();
      const isGoal = ['G', 'GOAL', 'OG', 'OWN GOAL', 'P', 'PG', 'PEN', 'PENALTY'].some(x => type === x || type.includes(x)) || /\bGOAL\b/.test(detail) || /\bGOAL\b/.test(blob);
      if (!isGoal) continue;
      const player = String(inc.Player || inc.player || inc.Pn || inc.Nm || inc.name || inc.playerName || inc.player?.name || '').trim();
      const minuteRaw = inc.Min ?? inc.min ?? inc.Mi ?? inc.Minute ?? inc.minute ?? inc.time;
      const minute = minuteRaw != null ? String(minuteRaw).replace(/'/g, '') : null;
      const teamRaw = inc.T ?? inc.Tn ?? inc.Team ?? inc.team ?? (inc.isHome === false ? '2' : '1');
      const team = String(teamRaw).toLowerCase() === 'a' || String(teamRaw) === '2' || String(teamRaw).toLowerCase().includes('away') ? 'a' : 'h';
      const og = type.includes('OG') || type.includes('OWN') || detail.includes('OWN GOAL') || inc.ownGoal === true;
      const penalty = inc.penalty === true || inc.pen === true || inc.pk === true || inc.fromPenalty === true || type === 'P' || type === 'PG' || type === 'PEN' || type === 'PENALTY' || type.includes('PEN_GOAL') || detail.includes('PENALTY') || detail.includes('PEN.') || detail.includes('SPOT KICK') || /"(PENALTY|PEN|PK|FROMPENALTY)"\s*:\s*TRUE/.test(blob) || /\b11M\b/.test(blob);
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
      const type = String(inc.Type || inc.type || inc.Tp || inc.IT || inc.Card || inc.card || inc.CardType || inc.cardType || inc.Crd || inc.Event || inc.event || inc.incidentType || inc.incidentClass || '').toUpperCase();
      const detail = String(inc.Detail || inc.detail || inc.Info || inc.info || inc.Txt || inc.text || inc.Comment || inc.comment || inc.Name || inc.name || inc.Desc || inc.description || '').toUpperCase();
      const blob = JSON.stringify(inc).toUpperCase();
      const isYellow = (type === 'YC' || type === 'YELLOW' || type === 'Y' || detail.includes('YELLOW CARD') || blob.includes('YELLOW CARD')) && !type.includes('RED') && !type.includes('2Y') && !type.includes('YRC') && !detail.includes('SECOND');
      const isYellowRed = type.includes('2Y') || type.includes('YRC') || type.includes('Y2') || detail.includes('SECOND YELLOW') || detail.includes('DOUBLE YELLOW') || blob.includes('SECOND YELLOW') || blob.includes('YELLOW-RED') || blob.includes('YELLOW RED') || blob.includes('SECONDYELLOW') || inc.yellowRed === true || inc.secondYellow === true;
      const isDirectRed = !isYellowRed && (type.includes('RC') || type.includes('RED') || detail.includes('RED CARD') || blob.includes('RED CARD') || inc.Red === true || inc.red === true || inc.IsRed === true || inc.isRed === true || inc.redCard === true);
      if (!isYellow && !isYellowRed && !isDirectRed) continue;
      const player = String(inc.Player || inc.player || inc.Pn || inc.Nm || inc.name || inc.playerName || inc.player?.name || '').trim();
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

function dedupeEvents(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = [item.team, item.minute, item.player, item.type, item.og ? 'og' : '', item.penalty ? 'p' : '', item.red ? 'r' : '', item.yellow ? 'y' : '', item.yellowRed ? 'yr' : ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSource(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,text/html,*/*',
      'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
      'user-agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36 SuperLigaPredictorWorker/0.3'
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
  if (embedded.length) {
    const combined = { Stages: [] };
    for (const item of embedded) {
      const stages = item?.Stages || item?.data?.Stages || item?.props?.pageProps?.data?.Stages;
      if (Array.isArray(stages)) combined.Stages.push(...stages);
    }
    if (combined.Stages.length) return { source: 'livescore-embedded-json', data: combined, text, warnings };
  }
  return { source: 'livescore-html-text', data: parseLiveScoreHtmlText(text), text, warnings };
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
    if (!/(Stages|Events|Eid|T1|T2)/.test(body)) continue;
    const jsons = extractBalancedJson(body);
    for (const raw of jsons) { try { out.push(JSON.parse(raw)); } catch {} }
  }
  return out;
}

function extractBalancedJson(text) {
  const out = [];
  const starts = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '{' || text[i] === '[') starts.push(i);
  for (const start of starts.slice(0, 80)) {
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
        if (candidate.length > 40 && /(Stages|Events|Eid|T1|T2)/.test(candidate)) out.push(candidate);
        break;
      }
    }
  }
  return out;
}

function extractMatchList(data, htmlText = '') {
  if (!data) return [];
  if (Array.isArray(data)) return data;
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
      out.push({ ...event, stageName: stage.Snm || stage.name || stage.Nm, competition: stage.Cnm || stage.countryName });
    }
  }
  return out;
}

function findMappedFixture(raw, fixtures) {
  const rawId = raw.id || raw.matchId || raw.eventId || raw.Eid || raw.Id;
  const home = readHomeName(raw);
  const away = readAwayName(raw);
  return fixtures.find(f => rawId && String(f.sourceId || f.livescoreId || f.sourceIds?.livescore || f.id) === String(rawId))
    || fixtures.find(f => sameTeam(home, f.h) && sameTeam(away, f.a));
}

function readHomeName(raw) {
  return raw.homeTeam || raw.home?.name || raw.T1?.[0]?.Nm || raw.T1?.[0]?.Name || raw.HomeTeam || raw.homeName || raw.home;
}

function readAwayName(raw) {
  return raw.awayTeam || raw.away?.name || raw.T2?.[0]?.Nm || raw.T2?.[0]?.Name || raw.AwayTeam || raw.awayName || raw.away;
}

function shouldExposeLiveScore(match, opts = {}) {
  if (opts.includeScheduled) return true;
  return match.started || match.finished || match.h != null || match.a != null;
}

function parseLiveScoreHtmlText(html) {
  const text = textFromHtml(html);
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const timeMatch = line.match(/\b(\d{1,2}:\d{2}|FT|HT|LIVE|\d{1,3}'(?:\+\d+)?)\b/i);
    if (!timeMatch) continue;
    const window = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 8)).join(' ');
    const score = window.match(/\b(\d{1,2})\s*[-–:]\s*(\d{1,2})\b/);
    const teams = guessTwoTeams(window);
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
  const n = norm(text);
  for (const team of ROMANIA_TEAMS) {
    const nt = norm(team);
    if (nt && n.includes(nt) && !found.some(x => sameTeam(x, team))) found.push(team);
  }
  return found.length >= 2 ? found.slice(0, 2) : null;
}

function sameTeam(a, b) {
  const na = norm(a);
  const nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&[a-z0-9#]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cs|osk|afc|as|sc|clubul|fotbal|1907|bucuresti|constanta|ploiesti|galati)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
