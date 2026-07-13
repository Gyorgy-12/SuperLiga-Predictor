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

  if (!res.ok) {
    return { ok: false, source: 'transfermarkt-market-values', error: `HTTP ${res.status}`, marketValues: {}, url };
  }

  const html = await res.text();
  const rows = parseTransfermarktRows(html);
  const marketValues = {};
  const raw = [];
  const unmatched = [];

  for (const row of rows) {
    const canonical = matchTeamName(row.team, knownTeams);
    if (!canonical || !knownTeams.includes(canonical)) {
      unmatched.push(row);
      continue;
    }
    marketValues[canonical] = row.valueM;
    raw.push({ ...row, team: canonical, sourceTeam: row.team });
  }

  const warnings = [];
  if (!Object.keys(marketValues).length) {
    warnings.push('No SuperLiga team market values parsed from Transfermarkt HTML. The page may be blocked or layout changed.');
  }
  if (knownTeams.length && Object.keys(marketValues).length && Object.keys(marketValues).length < knownTeams.length) {
    const missing = knownTeams.filter(team => marketValues[team] == null);
    warnings.push(`Missing market values for: ${missing.join(', ')}`);
  }

  return {
    ok: true,
    source: 'transfermarkt-market-values',
    url,
    fetched: rows.length,
    count: Object.keys(marketValues).length,
    marketValues,
    raw,
    unmatched: unmatched.slice(0, 24),
    updatedAt: new Date().toISOString(),
    warnings
  };
}

export function parseTransfermarktRows(html = '') {
  const out = [];
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const value = parseMarketValue(row);
    if (!value || !Number.isFinite(value.valueM) || value.valueM <= 0) continue;

    const team = extractTeamName(row);
    if (!team) continue;

    out.push({
      team,
      valueM: value.valueM,
      display: formatMarketValue(value.valueM),
      sourceDisplay: value.sourceDisplay,
      unit: value.unit,
      valueColumn: value.valueColumn,
      allSourceValues: value.allSourceValues
    });
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

  // Transfermarkt's /marktwerteverein page has two money columns:
  // "Value <cut-off date>" followed by "Current value".
  // The old parser took the first money token, which made the data look outdated.
  // We intentionally use the LAST parsed money token in the row, because that is the current value column.
  const matches = [...text.matchAll(/(?:€|EUR)\s*([\d.,]+)\s*(bn|b|m|mil\.?|mio\.?|k|th\.?)\b/gi)];
  if (!matches.length) return null;

  const parsed = matches
    .map(match => parsedMarketToken(match[1], match[2]))
    .filter(v => v && Number.isFinite(v.valueM) && v.valueM > 0);

  if (!parsed.length) return null;

  const current = parsed[parsed.length - 1];
  return {
    ...current,
    valueColumn: parsed.length > 1 ? 'current-value-last-money-token' : 'only-money-token',
    allSourceValues: parsed.map(v => v.sourceDisplay)
  };
}

function parsedMarketToken(numberPart, unitPart) {
  const unit = String(unitPart || '').toLowerCase();
  const num = parseLocalizedNumber(numberPart);
  if (!Number.isFinite(num)) return null;

  let valueM;
  if (unit.startsWith('b')) valueM = num * 1000;
  else if (unit.startsWith('k') || unit.startsWith('th')) valueM = num / 1000;
  else valueM = num;

  return {
    valueM: +valueM.toFixed(3),
    sourceDisplay: `€${numberPart}${unitPart}`,
    unit
  };
}

function parseLocalizedNumber(input) {
  let s = String(input || '').trim();
  if (!s) return NaN;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  // If both exist, the last separator is decimal and the other is thousands.
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastDot > lastComma) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    return Number(s);
  }

  // Single separator: Transfermarkt market values usually use decimals like 31.30m or 9,48m.
  const sep = lastDot >= 0 ? '.' : (lastComma >= 0 ? ',' : '');
  if (!sep) return Number(s);

  const [head, tail] = s.split(sep);
  if (!tail) return Number(head);

  // 1-2 digits after the separator means decimal value, not thousands.
  if (/^\d{1,2}$/.test(tail)) {
    return Number(head.replace(/[.,]/g, '') + '.' + tail);
  }

  // 3 digits after the separator is usually thousands grouping.
  if (/^\d{3}$/.test(tail)) {
    return Number(s.replace(/[.,]/g, ''));
  }

  return Number(s.replace(',', '.'));
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
  if (valueM >= 100) return `€${valueM.toFixed(1)}m`;
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
