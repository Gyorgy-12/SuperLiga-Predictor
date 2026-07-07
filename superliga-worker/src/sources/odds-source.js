import { sameTeam } from '../core/team-match.js';

const DEFAULT_ODDSPEDIA_URLS = [
  'https://oddspedia.com/api/v1/getMaxOddsWithPagination?geoCode=RO&bookmakerGeoState=&bookmakerGeoCode=RO&sport=football&league=liga-1&category=romania&date={date}&language=en',
  'https://oddspedia.com/api/v1/getMatchPoll?geoCode=RO&bookmakerGeoState=&bookmakerGeoCode=RO&sport=football&league=liga-1&category=romania&date={date}&language=en'
];

function extractOddsList(data) {
  const direct = directList(data);
  const deep = [];
  walk(data, obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const teams = extractTeams(obj);
    const odds = extract1x2Odds(obj);
    if ((teams.home || teams.away) && odds) deep.push({ ...obj, __teams: teams, __odds: odds });
  });
  return [...direct, ...deep];
}

function directList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const keys = ['odds', 'matches', 'events', 'results', 'fixtures', 'data', 'items', 'rows'];
  for (const key of keys) {
    const v = data[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = directList(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

function walk(value, fn, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, fn, seen);
    return;
  }
  fn(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, fn, seen);
}

function decimal(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') v = v.decimal ?? v.value ?? v.odd ?? v.price ?? v.odds;
  const n = Number(String(v).replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 1 ? Number(n.toFixed(3)) : null;
}

function normalizeOdds(raw = {}) {
  const teams = raw.__teams || extractTeams(raw);
  const odds = raw.__odds || extract1x2Odds(raw);
  if (!odds) return null;
  const h = decimal(odds.h ?? odds.home ?? odds.homeWin ?? odds['1'] ?? odds.winHome);
  const d = decimal(odds.d ?? odds.draw ?? odds.x ?? odds['X']);
  const a = decimal(odds.a ?? odds.away ?? odds.awayWin ?? odds['2'] ?? odds.winAway);
  if (!h && !d && !a) return null;
  return {
    h,
    d,
    a,
    provider: raw.provider || raw.bookmaker || raw.bookmakerName || odds.provider || odds.bookmaker || odds.bookmakerName || 'Oddspedia',
    sourceMatchId: raw.id || raw.matchId || raw.eventId || raw.fixtureId || raw.mid || raw.match_id || null,
    homeTeam: teams.home || null,
    awayTeam: teams.away || null,
    updatedAt: raw.updatedAt || raw.oddsUpdatedAt || raw.updated_at || new Date().toISOString()
  };
}

function extractTeams(raw = {}) {
  const home = raw.h || raw.home || raw.homeTeam || raw.homeName || raw.home_team || raw.ht || raw.T1?.[0]?.Nm || raw.__home || raw.competitors?.find?.(c => /home/i.test(c.qualifier || c.side || ''))?.name || raw.participants?.find?.(p => /home/i.test(p.qualifier || p.side || p.type || ''))?.name || raw.match?.homeTeam || raw.match?.home || raw.event?.homeTeam;
  const away = raw.a || raw.away || raw.awayTeam || raw.awayName || raw.away_team || raw.at || raw.T2?.[0]?.Nm || raw.__away || raw.competitors?.find?.(c => /away/i.test(c.qualifier || c.side || ''))?.name || raw.participants?.find?.(p => /away/i.test(p.qualifier || p.side || p.type || ''))?.name || raw.match?.awayTeam || raw.match?.away || raw.event?.awayTeam;
  if (home && away) return { home: teamName(home), away: teamName(away) };

  const names = [];
  for (const key of ['teams', 'competitors', 'participants']) {
    const arr = raw[key];
    if (Array.isArray(arr)) for (const x of arr) names.push(teamName(x?.name || x?.Nm || x?.title || x?.participantName || x));
  }
  if (names.length >= 2) return { home: names[0], away: names[1] };
  return { home: null, away: null };
}

function teamName(v) {
  if (v == null) return null;
  if (typeof v === 'object') return teamName(v.name || v.Nm || v.title || v.participantName || v.shortName);
  return String(v).trim() || null;
}

function extract1x2Odds(raw = {}) {
  const direct = raw.odds || raw.market || raw.markets?.['1x2'] || raw.maxOdds || raw.highestOdds || raw.bestOdds || raw.__odds;
  const fromDirect = objectOdds(direct || raw);
  if (fromDirect) return fromDirect;

  const markets = [];
  if (Array.isArray(raw.markets)) markets.push(...raw.markets);
  if (Array.isArray(raw.odds)) markets.push(...raw.odds);
  if (Array.isArray(raw.bookmakers)) for (const b of raw.bookmakers) if (Array.isArray(b.markets)) markets.push(...b.markets.map(m => ({ ...m, bookmaker: b.name || b.title })));
  for (const market of markets) {
    const name = String(market.name || market.marketName || market.label || market.key || '').toLowerCase();
    if (name && !/(1x2|match winner|full time result|winner|regular time|result)/i.test(name)) continue;
    const selections = market.selections || market.outcomes || market.odds || market.values || [];
    if (!Array.isArray(selections)) continue;
    const out = {};
    for (const sel of selections) {
      const label = String(sel.name || sel.label || sel.outcome || sel.key || sel.type || '').toLowerCase();
      const val = decimal(sel.price ?? sel.decimal ?? sel.odd ?? sel.odds ?? sel.value);
      if (!val) continue;
      if (label === '1' || /home/.test(label)) out.h = val;
      else if (label === 'x' || /draw/.test(label)) out.d = val;
      else if (label === '2' || /away/.test(label)) out.a = val;
    }
    if (out.h || out.d || out.a) return out;
  }
  return null;
}

function objectOdds(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const h = decimal(obj.h ?? obj.home ?? obj.homeWin ?? obj.homeOdds ?? obj.homeOdd ?? obj['1'] ?? obj.winHome ?? obj.H);
  const d = decimal(obj.d ?? obj.draw ?? obj.drawOdds ?? obj.drawOdd ?? obj.x ?? obj.X);
  const a = decimal(obj.a ?? obj.away ?? obj.awayWin ?? obj.awayOdds ?? obj.awayOdd ?? obj['2'] ?? obj.winAway ?? obj.A);
  if (h || d || a) return { h, d, a, provider: obj.provider || obj.bookmaker || obj.bookmakerName || null };
  return null;
}

function mapOdds(rawOdds, fixtures) {
  const out = {};
  for (const raw of rawOdds) {
    const o = normalizeOdds(raw);
    if (!o) continue;
    const direct = fixtures.find(f => o.sourceMatchId && String(f.sourceIds?.odds || f.oddsId || f.id) === String(o.sourceMatchId));
    const fuzzy = direct || fixtures.find(f => sameTeam(o.homeTeam, f.h) && sameTeam(o.awayTeam, f.a));
    if (!fuzzy) continue;
    out[fuzzy.id] = {
      id: fuzzy.id,
      h: o.h,
      d: o.d,
      a: o.a,
      provider: o.provider,
      sourceMatchId: o.sourceMatchId,
      updatedAt: o.updatedAt,
      oddsSource: raw.__url?.includes('oddspedia') ? 'oddspedia' : 'external'
    };
  }
  return out;
}

function buildSourceUrl(template, opts = {}) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const str = String(template).replace(/\{date\}/g, date);
  const url = new URL(str);
  if (!str.includes('{date}') && opts.date && !url.searchParams.has('date')) url.searchParams.set('date', opts.date);
  if (opts.force) url.searchParams.set('_force', String(Date.now()));
  return url.toString();
}

function datesForOdds(fixtures = [], opts = {}) {
  if (opts.date) return [opts.date];
  const now = new Date();
  const min = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const maxMs = now.getTime() + Number(opts.daysAhead || 21) * 24 * 60 * 60 * 1000;
  const dates = [...new Set(fixtures.filter(f => {
    const t = Date.parse(`${f.date}T${f.t || '12:00'}:00+03:00`);
    return Number.isFinite(t) && t >= Date.parse(min) && t <= maxMs;
  }).map(f => f.date))].sort();
  return dates.length ? dates : [now.toISOString().slice(0, 10)];
}

export async function fetchOdds(env, fixtures = [], opts = {}) {
  const templates = [];
  if (opts.url) templates.push(opts.url);
  if (env.ODDS_SOURCE_URL) templates.push(env.ODDS_SOURCE_URL);
  if (env.ODDSPEDIA_SOURCE_URL) templates.push(env.ODDSPEDIA_SOURCE_URL);
  templates.push(...DEFAULT_ODDSPEDIA_URLS);

  const dates = datesForOdds(fixtures, opts);
  const allRaw = [];
  const attempted = [];
  const warnings = [];

  for (const date of dates) {
    for (const tpl of templates) {
      const url = buildSourceUrl(tpl, { ...opts, date });
      if (attempted.includes(url)) continue;
      attempted.push(url);
      try {
        const res = await fetch(url, {
          headers: {
            accept: 'application/json,text/plain,*/*',
            'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
            'user-agent': env.ODDS_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
          },
          cf: { cacheTtl: opts.force ? 0 : 120, cacheEverything: false }
        });
        if (!res.ok) { warnings.push(`${url} -> HTTP ${res.status}`); continue; }
        const ctype = res.headers.get('content-type') || '';
        const data = ctype.includes('json') ? await res.json().catch(() => null) : await res.text().then(t => parseJsonFromText(t)).catch(() => null);
        const list = extractOddsList(data).map(x => ({ ...x, __url: url }));
        allRaw.push(...list);
      } catch (error) {
        warnings.push(`${url} -> ${error.message || String(error)}`);
      }
    }
  }

  const odds = mapOdds(allRaw, fixtures);
  return {
    ok: true,
    source: 'odds-source-oddspedia-first',
    odds,
    count: Object.keys(odds).length,
    fetched: allRaw.length,
    attempted,
    warnings: Object.keys(odds).length ? warnings.slice(0, 8) : warnings.concat(['No odds mapped. Check Oddspedia payload shape or team-name mapping.']).slice(0, 12)
  };
}

function parseJsonFromText(text = '') {
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text).match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
  const possible = String(text).match(/\{[\s\S]{100,}\}/);
  if (possible) { try { return JSON.parse(possible[0]); } catch (_) {} }
  return null;
}
