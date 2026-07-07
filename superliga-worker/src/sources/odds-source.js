function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cs|osk|afc|as|sc)\b/g, '')
    .trim();
}

function sameTeam(a, b) {
  const na = norm(a);
  const nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

function extractOddsList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.odds)) return data.odds;
  if (Array.isArray(data.matches)) return data.matches;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.results)) return data.results;
  if (data.data) return extractOddsList(data.data);
  return [];
}

function decimal(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 1 ? Number(n.toFixed(3)) : null;
}

function normalizeOdds(raw = {}) {
  const odds = raw.odds || raw.markets?.['1x2'] || raw.market || raw;
  const h = decimal(odds.h ?? odds.home ?? odds.homeWin ?? odds['1'] ?? odds.winHome);
  const d = decimal(odds.d ?? odds.draw ?? odds.x ?? odds['X']);
  const a = decimal(odds.a ?? odds.away ?? odds.awayWin ?? odds['2'] ?? odds.winAway);
  if (!h && !d && !a) return null;
  return {
    h,
    d,
    a,
    provider: raw.provider || raw.bookmaker || odds.provider || odds.bookmaker || 'external',
    sourceMatchId: raw.id || raw.matchId || raw.eventId || raw.fixtureId || null,
    homeTeam: raw.h || raw.home || raw.homeTeam || raw.homeName || raw.T1?.[0]?.Nm || null,
    awayTeam: raw.a || raw.away || raw.awayTeam || raw.awayName || raw.T2?.[0]?.Nm || null,
    updatedAt: raw.updatedAt || raw.oddsUpdatedAt || new Date().toISOString()
  };
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
      oddsSource: 'external'
    };
  }
  return out;
}

function buildSourceUrl(base, opts = {}) {
  const url = new URL(base);
  if (opts.date) url.searchParams.set('date', opts.date);
  if (opts.force) url.searchParams.set('force', '1');
  return url.toString();
}

export async function fetchOdds(env, fixtures = [], opts = {}) {
  if (!env.ODDS_SOURCE_URL) {
    return { ok: true, source: 'odds-source-disabled', odds: {}, count: 0, warnings: ['ODDS_SOURCE_URL is empty'] };
  }

  const url = buildSourceUrl(env.ODDS_SOURCE_URL, opts);
  const res = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0 SuperLigaPredictorWorker/0.1'
    },
    cf: { cacheTtl: 120, cacheEverything: false }
  });
  if (!res.ok) return { ok: false, source: 'odds-source', odds: {}, count: 0, error: `HTTP ${res.status}` };

  const data = await res.json().catch(() => null);
  const list = extractOddsList(data);
  const odds = mapOdds(list, fixtures);
  return { ok: true, source: 'odds-source', odds, count: Object.keys(odds).length, fetched: list.length, url };
}
