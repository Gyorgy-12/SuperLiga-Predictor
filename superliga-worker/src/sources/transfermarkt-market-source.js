import {
  matchTeamName,
  normTeam,
  uniqueTeamsFromFixtures
} from '../core/team-match.js';

const DEFAULT_TM_URL = 'https://www.transfermarkt.com/superliga/marktwerteverein/wettbewerb/RO1';
const ALTERNATE_TM_URLS = [
  'https://www.transfermarkt.be/liga-1/marktwerteverein/wettbewerb/RO1',
  'https://www.transfermarkt.at/liga-1/marktwerteverein/wettbewerb/RO1',
  'https://www.transfermarkt.co.uk/liga-1/marktwerteverein/wettbewerb/RO1',
  'https://www.transfermarkt.ro/liga-1/marktwerteverein/wettbewerb/RO1',
  'https://www.transfermarkt.de/liga-1/marktwerteverein/wettbewerb/RO1'
];
const DEFAULT_TIMEOUT_MS = 22000;
const DEFAULT_MIN_COUNT = 12;

export async function fetchTransfermarktMarketValues(env, fixtures = [], opts = {}) {
  const knownTeams = uniqueTeamsFromFixtures(fixtures);
  const minCount = clampInt(
    opts.minCount || env.TRANSFERMARKT_MIN_COUNT,
    Math.min(DEFAULT_MIN_COUNT, knownTeams.length || DEFAULT_MIN_COUNT),
    1,
    Math.max(1, knownTeams.length || 16)
  );
  const configured = opts.url
    || env.TRANSFERMARKT_MARKET_VALUES_URL
    || env.TRANSFERMARKET_MARKET_VALUES_URL
    || DEFAULT_TM_URL;
  const targets = unique([configured, DEFAULT_TM_URL, ...ALTERNATE_TM_URLS]);
  const attempts = [];

  // 1) Try the current canonical page and regional mirrors directly.
  for (const targetUrl of targets) {
    // Transfermarkt's bot filter rejects otherwise valid table URLs when an
    // arbitrary cache-busting query parameter is appended. `cache: no-store`
    // below already prevents a stale Worker-side response.
    const url = targetUrl;
    const response = await fetchText(env, url, opts, { source: 'transfermarkt-direct' });
    const blocked = looksBlocked(response.text);
    const rows = response.ok && !blocked ? parseTransfermarktRows(response.text) : [];
    const mapped = mapRows(rows, knownTeams);

    attempts.push(makeAttempt(response, {
      source: 'transfermarkt-direct',
      url,
      blocked,
      parsedRows: rows.length,
      mappedCount: Object.keys(mapped.marketValues).length
    }));

    if (Object.keys(mapped.marketValues).length >= minCount) {
      return buildSuccess({
        source: 'transfermarkt-market-values-b43-direct',
        url: response.finalUrl || targetUrl,
        rows,
        mapped,
        knownTeams,
        minCount,
        attempts,
        warnings: []
      });
    }
  }

  // 2) Transfermarkt often returns 405/robot verification to Cloudflare
  // datacenter requests. Reader uses a JS-capable browser and returns a plain
  // markdown table that we parse without needing a paid API.
  const readerTargets = unique(
    targets.slice(0, 2).flatMap(target => [target, target.replace(/^https:/i, 'http:')])
  );
  for (const targetUrl of readerTargets) {
    // Reader honors x-no-cache itself. Adding an arbitrary query parameter to
    // the nested target URL can make the Reader reject an otherwise valid page.
    const readerUrl = buildReaderUrl(env, targetUrl);
    const response = await fetchText(env, readerUrl, opts, {
      source: 'transfermarkt-jina-reader',
      reader: true
    });
    const blocked = looksBlocked(response.text);
    const rows = response.ok && !blocked
      ? parseTransfermarktMarkdownRows(response.text, knownTeams)
      : [];
    const mapped = mapRows(rows, knownTeams);

    attempts.push(makeAttempt(response, {
      source: 'transfermarkt-jina-reader',
      url: readerUrl,
      targetUrl,
      blocked,
      parsedRows: rows.length,
      mappedCount: Object.keys(mapped.marketValues).length
    }));

    if (Object.keys(mapped.marketValues).length >= minCount) {
      return buildSuccess({
        source: 'transfermarkt-market-values-b43-reader',
        url: targetUrl,
        rows,
        mapped,
        knownTeams,
        minCount,
        attempts,
        warnings: [
          'Transfermarkt blocked the direct Worker request, therefore the current club values were read through the browser-rendered Reader fallback.'
        ]
      });
    }
  }

  return {
    ok: false,
    source: 'transfermarkt-market-values-b43-fallback-chain',
    url: configured,
    fetched: 0,
    count: 0,
    coverage: 0,
    minCount,
    marketValues: {},
    raw: [],
    unmatched: [],
    attempts,
    error: attempts.at(-1)?.error || 'transfermarkt_minimum_coverage_not_reached',
    warnings: [
      'Transfermarkt returned no usable current club values through either the direct page or the browser-rendered Reader fallback. Existing stored values were preserved.'
    ],
    updatedAt: new Date().toISOString()
  };
}

async function fetchText(env, url, opts = {}, mode = {}) {
  const timeoutMs = clampInt(
    opts.timeoutMs || env.TRANSFERMARKT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    5000,
    60000
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const startedAt = Date.now();

  const headers = {
    accept: mode.reader
      ? 'text/plain,text/markdown;q=0.9,*/*;q=0.8'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  if (mode.reader) {
    // Keep Reader requests minimal. Browser-specific headers made r.jina.ai
    // classify Worker-to-Worker requests as automated and return HTTP 403.
    headers['x-no-cache'] = 'true';
    if (env.JINA_API_KEY) headers.authorization = `Bearer ${env.JINA_API_KEY}`;
  } else {
    headers['accept-language'] = 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7';
    headers['cache-control'] = 'no-cache';
    headers['user-agent'] =
      env.TRANSFERMARKT_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
         '(KHTML, like Gecko) Chrome/125 Safari/537.36';
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers,
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok && !!text.trim(),
      status: response.status,
      text,
      bytes: text.length,
      contentType: response.headers.get('content-type') || '',
      finalUrl: response.url || url,
      elapsedMs: Date.now() - startedAt,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      bytes: 0,
      contentType: null,
      finalUrl: url,
      elapsedMs: Date.now() - startedAt,
      error:
        error?.name === 'AbortError'
          ? `timeout_after_${timeoutMs}ms`
          : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseTransfermarktRows(html = '') {
  const out = [];
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const value = parseMarketValue(row);
    if (!value || !Number.isFinite(value.valueM) || value.valueM <= 0) continue;
    const team = extractTeamName(row);
    if (!team) continue;
    out.push({ team, ...value, display: formatMarketValue(value.valueM) });
  }

  return dedupeRows(out);
}

export function parseTransfermarktMarkdownRows(text = '', knownTeams = []) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');

  for (const rawLine of lines) {
    const line = cleanMarkdown(rawLine);
    if (!line || !/[€]|\bEUR\b/i.test(line)) continue;
    if (/current value|market value|gesamtmarktwert|cota de piață/i.test(line) && /^\s*[#|]/.test(rawLine)) continue;

    const team = extractKnownTeamFromLine(line, knownTeams);
    if (!team) continue;
    const value = parseMarketValue(line);
    if (!value || !Number.isFinite(value.valueM) || value.valueM <= 0) continue;
    out.push({
      team,
      ...value,
      display: formatMarketValue(value.valueM),
      rawLine: rawLine.slice(0, 600)
    });
  }

  return dedupeRows(out);
}

function mapRows(rows, knownTeams) {
  const marketValues = {};
  const raw = [];
  const unmatched = [];

  for (const row of rows || []) {
    const canonical = matchTeamName(row.team, knownTeams);
    if (!canonical || !knownTeams.includes(canonical)) {
      unmatched.push(row);
      continue;
    }
    marketValues[canonical] = row.valueM;
    raw.push({ ...row, team: canonical, sourceTeam: row.team });
  }

  return { marketValues, raw, unmatched };
}

function buildSuccess(config) {
  const missing = config.knownTeams.filter(team => config.mapped.marketValues[team] == null);
  const warnings = [...(config.warnings || [])];
  if (missing.length) {
    warnings.push(`Missing current Transfermarkt club value for: ${missing.join(', ')}. Previously stored values are preserved for those teams.`);
  }

  return {
    ok: true,
    source: config.source,
    url: config.url,
    fetched: config.rows.length,
    count: Object.keys(config.mapped.marketValues).length,
    coverage: config.knownTeams.length
      ? Number((Object.keys(config.mapped.marketValues).length / config.knownTeams.length).toFixed(3))
      : 0,
    minCount: config.minCount,
    marketValues: config.mapped.marketValues,
    raw: config.mapped.raw,
    unmatched: config.mapped.unmatched.slice(0, 40),
    missing,
    attempts: config.attempts,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

function extractTeamName(row) {
  const links = [...String(row).matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => cleanText(match[1]))
    .filter(Boolean)
    .filter(text => !/^€|^\d|market value|profile|squad/i.test(text));
  const candidates = links.filter(text =>
    /[a-zăâîșț]/i.test(text) && !/superliga|romania|league|club/i.test(text)
  );
  if (candidates.length) return candidates.sort((a, b) => b.length - a.length)[0];

  const text = cleanText(row);
  const beforeValue = text.split(/€|EUR/i)[0] || text;
  return beforeValue.split(/\s{2,}/).find(value => /[a-zăâîșț]/i.test(value)) || '';
}

function extractKnownTeamFromLine(line, knownTeams) {
  const cells = String(line).split('|').map(cleanText).filter(Boolean);
  for (const cell of cells) {
    if (/superliga|liga\s*[12]|romania|current value|market value|%/i.test(cell)) continue;
    const canonical = matchTeamName(cell, knownTeams);
    if (canonical && knownTeams.includes(canonical)) return canonical;
  }

  const normalized = normTeam(line);
  let best = null;
  let bestLength = 0;
  for (const team of knownTeams) {
    const key = normTeam(team);
    if (key && normalized.includes(key) && key.length > bestLength) {
      best = team;
      bestLength = key.length;
    }
  }
  return best;
}

function parseMarketValue(row) {
  const text = cleanText(row).replace(/\s+/g, ' ');
  const tokens = extractMoneyTokens(text);
  if (!tokens.length) return null;

  // Transfermarkt's club-value table contains the historical comparison first
  // and the current value second. Therefore the last valid money token is the
  // current club value.
  const current = tokens[tokens.length - 1];
  return {
    ...current,
    valueColumn: tokens.length > 1 ? 'current-value-last-money-token' : 'only-money-token',
    allSourceValues: tokens.map(value => value.sourceDisplay)
  };
}

function extractMoneyTokens(text) {
  const output = [];
  const units = '(bn|b|m|mil\\.?|mio\\.?|mln\\.?|mld\\.?|k|th\\.?|tsd\\.?|dzd\\.?)';
  const regex = new RegExp(`(?:€|EUR)\\s*([\\d.,]+)\\s*${units}|([\\d.,]+)\\s*${units}\\s*(?:€|EUR)`, 'gi');
  let match;
  while ((match = regex.exec(text))) {
    const numberPart = match[1] || match[3];
    const unitPart = match[2] || match[4];
    const parsed = parsedMarketToken(numberPart, unitPart);
    if (parsed) output.push(parsed);
  }
  return output;
}

function parsedMarketToken(numberPart, unitPart) {
  const unit = String(unitPart || '').toLowerCase();
  const num = parseLocalizedNumber(numberPart);
  if (!Number.isFinite(num)) return null;

  let valueM;
  if (unit.startsWith('b')) valueM = num * 1000;
  else if (unit.startsWith('k') || unit.startsWith('th') || unit.startsWith('tsd') || unit.startsWith('dzd')) valueM = num / 1000;
  else valueM = num;

  return {
    valueM: +valueM.toFixed(3),
    sourceDisplay: `€${numberPart}${unitPart}`,
    unit
  };
}

function parseLocalizedNumber(input) {
  let value = String(input || '').trim();
  if (!value) return NaN;
  const lastDot = value.lastIndexOf('.');
  const lastComma = value.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    value = lastDot > lastComma
      ? value.replace(/,/g, '')
      : value.replace(/\./g, '').replace(',', '.');
    return Number(value);
  }

  const separator = lastDot >= 0 ? '.' : (lastComma >= 0 ? ',' : '');
  if (!separator) return Number(value);
  const [head, tail] = value.split(separator);
  if (!tail) return Number(head);
  if (/^\d{1,2}$/.test(tail)) return Number(head.replace(/[.,]/g, '') + '.' + tail);
  if (/^\d{3}$/.test(tail)) return Number(value.replace(/[.,]/g, ''));
  return Number(value.replace(',', '.'));
}

function cleanText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&euro;/gi, '€')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMarkdown(value) {
  return cleanText(String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#]/g, ' '));
}

function looksBlocked(text) {
  const sample = String(text || '').slice(0, 25000);
  return /verify that you(?:'|’)re not a robot|javascript is disabled|access denied|captcha|cloudflare ray id|temporarily blocked/i.test(sample);
}

function formatMarketValue(valueM) {
  if (valueM >= 1000) return `€${(valueM / 1000).toFixed(2)}bn`;
  if (valueM >= 1) return `€${valueM.toFixed(2)}m`;
  return `€${Math.round(valueM * 1000)}k`;
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    const key = normTeam(row.team);
    if (!key) continue;
    // Same team can appear in navigation or historical tables. Prefer the row
    // with more money columns, then the latest encountered row.
    const previous = seen.get(key);
    const score = (row.allSourceValues?.length || 0) * 1000 + row.valueM;
    const previousScore = previous
      ? (previous.allSourceValues?.length || 0) * 1000 + previous.valueM
      : -1;
    if (!previous || score >= previousScore) seen.set(key, row);
  }
  return [...seen.values()];
}

function buildReaderUrl(env, targetUrl) {
  const base = String(env.JINA_READER_BASE_URL || 'https://r.jina.ai').replace(/\/$/, '');
  return `${base}/${targetUrl}`;
}

function makeAttempt(response, extra) {
  const usable = response.ok && !extra.blocked && Number(extra.mappedCount || 0) > 0;
  return {
    ...extra,
    ok: usable,
    status: response.status,
    bytes: response.bytes,
    elapsedMs: response.elapsedMs,
    contentType: response.contentType,
    finalUrl: response.finalUrl,
    error: response.error
      || (extra.blocked ? 'provider_page_blocked' : null)
      || (response.ok && !extra.parsedRows ? 'no_parseable_market_value_rows' : null)
      || (response.ok && !extra.mappedCount ? 'no_market_values_matched_to_current_teams' : null)
  };
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function unique(values) {
  return [...new Set(values.map(String).map(value => value.trim()).filter(Boolean))];
}
