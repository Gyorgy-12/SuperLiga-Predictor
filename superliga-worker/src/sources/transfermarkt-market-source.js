import { matchTeamName, normTeam, uniqueTeamsFromFixtures } from '../core/team-match.js';

const DEFAULT_TM_URL = 'https://www.transfermarkt.com/superliga/marktwerteverein/wettbewerb/RO1';

export async function fetchTransfermarktMarketValues(env, fixtures = [], opts = {}) {
  const knownTeams = uniqueTeamsFromFixtures(fixtures);
  const url = opts.url || env.TRANSFERMARKT_MARKET_VALUES_URL || DEFAULT_TM_URL;
  const res = await fetch(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
      'cache-control': 'no-cache',
      'user-agent': env.TRANSFERMARKT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
    },
    cf: { cacheTtl: opts.force ? 0 : 1800, cacheEverything: false }
  });
  if (!res.ok) return { ok: false, source: 'transfermarkt', error: `HTTP ${res.status}`, marketValues: {}, url };
  const html = await res.text();
  const rows = parseTransfermarktRows(html);
  const marketValues = {};
  const raw = [];
  for (const row of rows) {
    const canonical = matchTeamName(row.team, knownTeams);
    if (!canonical || !knownTeams.includes(canonical)) continue;
    marketValues[canonical] = row.valueM;
    raw.push({ ...row, team: canonical, sourceTeam: row.team });
  }
  return {
    ok: true,
    source: 'transfermarkt-market-values',
    url,
    fetched: rows.length,
    count: Object.keys(marketValues).length,
    marketValues,
    raw,
    updatedAt: new Date().toISOString(),
    warnings: Object.keys(marketValues).length ? [] : ['No SuperLiga team market values parsed from Transfermarkt HTML. The page may be blocked or layout changed.']
  };
}

export function parseTransfermarktRows(html = '') {
  const out = [];
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const valueM = parseMarketValue(row);
    if (!Number.isFinite(valueM) || valueM <= 0) continue;
    const team = extractTeamName(row);
    if (!team) continue;
    out.push({ team, valueM, display: formatMarketValue(valueM) });
  }
  return dedupeRows(out);
}

function extractTeamName(row) {
  const links = [...String(row).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => cleanText(m[1]))
    .filter(Boolean)
    .filter(t => !/^€|^\d|market value|profile|squad/i.test(t));
  const candidates = links.filter(t => /[a-zăâîșț]/i.test(t) && !/superliga|romania|league|club/i.test(t));
  if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];
  const text = cleanText(row);
  const beforeValue = text.split(/€|mil\.|mio\.|m\b/i)[0] || text;
  return beforeValue.split(/\s{2,}/).find(x => /[a-zăâîșț]/i.test(x)) || '';
}

function parseMarketValue(row) {
  const text = cleanText(row).replace(/\s+/g, ' ');
  const m = text.match(/(?:€|EUR)\s*([\d.,]+)\s*(bn|b|m|mil\.?|mio\.?|k|th\.?)/i) || text.match(/([\d.,]+)\s*(bn|b|m|mil\.?|mio\.?|k|th\.?)\s*(?:€|EUR)/i);
  if (!m) return null;
  const num = Number(String(m[1]).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(num)) return null;
  const unit = String(m[2] || '').toLowerCase();
  if (unit.startsWith('b')) return +(num * 1000).toFixed(3);
  if (unit.startsWith('k') || unit.startsWith('th')) return +(num / 1000).toFixed(3);
  return +num.toFixed(3);
}

function cleanText(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&euro;/gi, '€')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMarketValue(valueM) {
  if (valueM >= 1000) return `€${(valueM / 1000).toFixed(2)}bn`;
  if (valueM >= 1) return `€${valueM.toFixed(2)}m`;
  return `€${Math.round(valueM * 1000)}k`;
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = normTeam(row.team);
    if (!key) continue;
    if (!seen.has(key) || seen.get(key).valueM < row.valueM) seen.set(key, row);
  }
  return [...seen.values()];
}
