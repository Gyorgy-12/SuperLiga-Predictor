const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_X_FSIGN = 'SW9D1eZo';

const DEFAULT_BASES = [
  'https://2.flashscore.ninja/2',
  'https://d.flashscore.com'
];

const DEFAULT_TOKEN_TEMPLATES = [
  'df_od_1_{mid}',
  'df_od_1_{mid}_',
  'df_od_1_{mid}_1',
  'df_od_1_{mid}_1_1',
  'df_dos_1_{mid}',
  'df_dos_1_{mid}_',
  'df_mh_1_{mid}',
  'df_mh_1_{mid}_',
  'df_hh_1_{mid}',
  'df_hh_1_{mid}_',
  'df_br_1_{mid}',
  'df_bm_1_{mid}',
  'df_ou_1_{mid}',
  'df_ah_1_{mid}',
  'df_pv_1_{mid}',
  'df_ps_1_{mid}',
  'df_psn_1_{mid}',
  'df_psp_1_{mid}'
];

/**
 * B29 diagnostic-only Flashscore odds endpoint scout.
 *
 * It never writes to Firestore. It probes a bounded set of x/feed candidates,
 * returns raw field/block diagnostics and attempts a conservative 1-X-2 parse.
 */
export async function fetchFlashscoreOddsProbe(env, input, opts = {}) {
  const mid = resolveMatchKey(input, opts);
  if (!mid) {
    return {
      ok: false,
      source: 'flashscore-odds-probe-b29',
      error: 'missing_or_invalid_flashscore_mid',
      example: 'source=flashscore-odds-probe&mid=hMOCvYkB&debug=1'
    };
  }

  const timeoutMs = clampNumber(opts.timeoutMs || env?.FLASHSCORE_ODDS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const maxProbes = clampNumber(opts.oddsProbeLimit || opts.maxProbes || opts.probeLimit || env?.FLASHSCORE_ODDS_PROBE_LIMIT || 18, 1, 36);
  const rawChars = clampNumber(opts.rawChars || opts.maxFeedChars || opts.sampleChars || 7000, 500, 30000);
  const blockLimit = clampNumber(opts.blockLimit || 28, 4, 100);
  const pairLimit = clampNumber(opts.pairLimit || 80, 10, 250);
  const showRaw = opts.showRaw === true || opts.showRaw === '1' || opts.showBody === true || opts.showBody === '1';

  const referer = firstNonEmpty(
    opts.feedReferer,
    opts.referer,
    opts.flashscoreUrl,
    opts.url,
    opts.fixture?.flashscoreUrl,
    opts.fixture?.sourceIds?.flashscoreUrl,
    `https://www.flashscore.com/?mid=${mid}`
  );

  const bases = normalizeBases([
    ...splitList(opts.oddsBases || opts.feedBases || opts.feedBase || env?.FLASHSCORE_ODDS_FEED_BASES),
    ...DEFAULT_BASES
  ]);

  const templates = dedupe([
    ...splitList(opts.oddsTokens || opts.tokens || opts.feedTokens || env?.FLASHSCORE_ODDS_FEED_TOKENS),
    ...DEFAULT_TOKEN_TEMPLATES
  ]);

  const candidates = buildCandidates(mid, bases, templates).slice(0, maxProbes);
  const probes = [];

  for (const candidate of candidates) {
    const response = await fetchFeed(candidate.url, {
      timeoutMs,
      referer,
      userAgent: opts.userAgent || env?.FLASHSCORE_USER_AGENT,
      xFsign: opts.xFsign || opts.xfsign || env?.FLASHSCORE_X_FSIGN || DEFAULT_X_FSIGN
    });

    const raw = String(response.text || '');
    const analysis = analyzeOddsFeed(raw, { blockLimit, pairLimit });
    probes.push({
      label: candidate.label,
      token: candidate.token,
      base: candidate.base,
      url: candidate.url,
      ok: response.ok,
      status: response.status,
      contentType: response.contentType,
      bytes: raw.length,
      elapsedMs: response.elapsedMs,
      useful: analysis.useful,
      analysis,
      sample: compact(raw).slice(0, rawChars),
      ...(showRaw ? { raw: raw.slice(0, rawChars) } : {}),
      error: response.error || null
    });
  }

  const useful = probes.filter(row => row.useful);
  const best = useful
    .slice()
    .sort((a, b) => scoreAnalysis(b.analysis) - scoreAnalysis(a.analysis))[0] || null;

  const parsedMarkets = dedupeMarkets(
    useful.flatMap(row => (row.analysis?.markets || []).map(market => ({
      ...market,
      feedLabel: row.label,
      feedUrl: row.url
    })))
  );

  const best1X2 = parsedMarkets.find(m => m.market === '1X2' && isValidTriple(m.home, m.draw, m.away)) || null;

  return {
    ok: useful.length > 0,
    source: 'flashscore-odds-probe-b29',
    diagnosticOnly: true,
    writeSafe: true,
    matchKey: mid,
    flashscoreMid: mid,
    fixture: opts.fixture ? {
      id: opts.fixture.id || null,
      date: opts.fixture.date || null,
      t: opts.fixture.t || null,
      h: opts.fixture.h || null,
      a: opts.fixture.a || null,
      flashscoreUrl: opts.fixture.flashscoreUrl || opts.fixture.sourceIds?.flashscoreUrl || null
    } : null,
    referer,
    requestBudget: {
      maxProbes,
      attempted: probes.length,
      bases: bases.length,
      templateCount: templates.length
    },
    candidateCount: candidates.length,
    usefulCount: useful.length,
    bestFeed: best ? {
      label: best.label,
      url: best.url,
      bytes: best.bytes,
      analysis: best.analysis
    } : null,
    best1X2,
    markets: parsedMarkets.slice(0, 40),
    probes,
    error: useful.length ? null : 'no_useful_flashscore_odds_feed_found',
    nextStep: useful.length
      ? 'Inspect bestFeed/markets. Once the exact 1X2 field layout is confirmed, promote that feed token into the production odds source.'
      : 'Paste the full probe JSON. B29 will show which candidate returned 0/empty/structured data so the next token/header variant can be targeted.'
  };
}

function resolveMatchKey(input, opts = {}) {
  const values = [
    opts.flashscoreMid,
    opts.mid,
    opts.matchKey,
    input,
    opts.fixture?.flashscoreMid,
    opts.fixture?.sourceIds?.flashscoreMid,
    opts.fixture?.sourceIds?.flashscoreEventId
  ];
  for (const value of values) {
    const text = String(value || '').trim();
    if (/^[A-Za-z0-9]{6,20}$/.test(text)) return text;
    const fromUrl = text.match(/[?&](?:mid|matchKey)=([A-Za-z0-9]{6,20})/i)?.[1];
    if (fromUrl) return fromUrl;
  }
  return null;
}

function normalizeBases(values) {
  return dedupe(values)
    .map(value => String(value || '').trim().replace(/\/$/, ''))
    .filter(value => /^https:\/\//i.test(value));
}

function buildCandidates(mid, bases, templates) {
  const out = [];
  const seen = new Set();
  for (const templateValue of templates) {
    const template = String(templateValue || '').trim();
    if (!template) continue;

    if (/^https?:\/\//i.test(template)) {
      const url = template.replaceAll('{mid}', mid);
      if (!seen.has(url)) {
        seen.add(url);
        out.push({ label: `custom-url:${template}`, token: null, base: null, url });
      }
      continue;
    }

    const token = normalizeToken(template, mid);
    for (const base of bases) {
      const url = `${base}/x/feed/${token}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ label: token, token, base, url });
    }
  }
  return out;
}

function normalizeToken(template, mid) {
  let token = String(template || '').trim()
    .replace(/^\/x\/feed\//i, '')
    .replace(/^x\/feed\//i, '')
    .replaceAll('{mid}', mid);
  if (token.includes(mid)) return token;
  if (token.endsWith('_')) return `${token}1_${mid}`;
  if (/^df_[a-z0-9]+$/i.test(token)) return `${token}_1_${mid}`;
  return token;
}

async function fetchFeed(url, opts = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: opts.referer || 'https://www.flashscore.com/',
        origin: 'https://www.flashscore.com',
        'user-agent': opts.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        'sec-ch-ua-platform': '"iOS"',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?1',
        'x-fsign': opts.xFsign || DEFAULT_X_FSIGN,
        'x-requested-with': 'XMLHttpRequest'
      }
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get('content-type') || '',
      text,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: '',
      text: '',
      elapsedMs: Date.now() - started,
      error: error?.message || String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeOddsFeed(raw, limits = {}) {
  const text = String(raw || '');
  const trimmed = text.trim();
  const htmlish = /^\s*</.test(text) || /<html|<!doctype/i.test(text);
  const livesportDelimited = /[¬÷~]/.test(text);
  const zeroBody = trimmed === '0';
  const blocks = parseBlocks(text, limits.blockLimit || 28, limits.pairLimit || 80);
  const keyFrequency = countKeys(blocks);
  const decimalValues = extractDecimalValues(text);
  const oddsKeywordHits = keywordHits(text);
  const bookmakers = detectBookmakers(text, blocks);
  const markets = detectMarkets(text, blocks);
  const pairCount = blocks.reduce((sum, block) => sum + block.pairs.length, 0);

  const useful = !htmlish && !zeroBody && trimmed.length > 8 && (
    markets.length > 0
    || (livesportDelimited && decimalValues.length >= 2)
    || oddsKeywordHits.total >= 2
  );

  return {
    useful,
    htmlish,
    zeroBody,
    nonEmpty: trimmed.length > 0,
    livesportDelimited,
    charCount: text.length,
    blockCount: blocks.length,
    pairCount,
    keyFrequency,
    decimalValues: decimalValues.slice(0, 80),
    oddsKeywordHits,
    bookmakers,
    markets,
    blocks: blocks.slice(0, limits.blockLimit || 28)
  };
}

function parseBlocks(raw, blockLimit, pairLimit) {
  const source = String(raw || '');
  const rawBlocks = source.split(/¬~|~(?=[A-Z0-9]{1,8}÷)/).map(v => v.trim()).filter(Boolean);
  const out = [];
  for (const rawBlock of rawBlocks.slice(0, blockLimit)) {
    const pairs = [];
    const fields = rawBlock.split('¬');
    for (const field of fields) {
      const index = field.indexOf('÷');
      if (index <= 0) continue;
      const key = field.slice(0, index).replace(/^~+/, '').trim();
      const value = field.slice(index + 1).trim();
      if (!key) continue;
      pairs.push({ key, value: value.slice(0, 500) });
      if (pairs.length >= pairLimit) break;
    }
    out.push({
      pairCount: pairs.length,
      pairs,
      sample: compact(rawBlock).slice(0, 1400)
    });
  }
  return out;
}

function countKeys(blocks) {
  const counts = {};
  for (const block of blocks) {
    for (const pair of block.pairs) counts[pair.key] = (counts[pair.key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 100));
}

function extractDecimalValues(text) {
  const out = [];
  const seen = new Set();
  const regex = /(?:^|[^\d])([1-9]\d{0,2}(?:[.,]\d{1,3}))(?!\d)/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    const raw = match[1];
    const value = Number(raw.replace(',', '.'));
    if (!Number.isFinite(value) || value < 1.001 || value > 1000) continue;
    const key = `${raw}|${match.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, value, index: match.index });
    if (out.length >= 200) break;
  }
  return out;
}

function keywordHits(text) {
  const source = String(text || '').toLowerCase();
  const keywords = [
    'odds', 'bookmaker', 'bet365', '1xbet', 'home', 'draw', 'away',
    'match winner', 'full time result', '1x2', 'opening odds', 'live odds'
  ];
  const hits = {};
  let total = 0;
  for (const keyword of keywords) {
    const present = source.includes(keyword);
    hits[keyword] = present;
    if (present) total += 1;
  }
  return { total, hits };
}

function detectBookmakers(text, blocks) {
  const known = [
    'bet365', '1xbet', 'unibet', 'betano', 'betfair', 'william hill', 'bwin',
    'pinnacle', 'betway', 'marathonbet', '888sport', 'sportingbet', 'superbet'
  ];
  const haystack = `${String(text || '')} ${blocks.flatMap(block => block.pairs.map(pair => pair.value)).join(' ')}`.toLowerCase();
  return known.filter(name => haystack.includes(name));
}

function detectMarkets(text, blocks) {
  const markets = [];

  // Human-readable variants occasionally appear in diagnostic or translated feeds.
  const readablePatterns = [
    /(?:1x2|full\s*time\s*result|match\s*winner)[\s\S]{0,500}?(?:home|\b1\b)\D{0,30}(\d{1,3}[.,]\d{1,3})[\s\S]{0,100}?(?:draw|\bx\b)\D{0,30}(\d{1,3}[.,]\d{1,3})[\s\S]{0,100}?(?:away|\b2\b)\D{0,30}(\d{1,3}[.,]\d{1,3})/i,
    /(?:home|\b1\b)\D{0,20}(\d{1,3}[.,]\d{1,3})\D{0,80}(?:draw|\bx\b)\D{0,20}(\d{1,3}[.,]\d{1,3})\D{0,80}(?:away|\b2\b)\D{0,20}(\d{1,3}[.,]\d{1,3})/i
  ];
  for (const pattern of readablePatterns) {
    const match = String(text || '').match(pattern);
    if (!match) continue;
    const triple = makeTriple(match[1], match[2], match[3], 'readable_pattern');
    if (triple) markets.push(triple);
  }

  // Generic block heuristic: a single structured block with labels 1/X/2 and nearby decimal prices.
  for (const block of blocks) {
    const labels = block.pairs.map(pair => String(pair.value || '').trim().toLowerCase());
    const hasOne = labels.some(v => v === '1' || v === 'home');
    const hasX = labels.some(v => v === 'x' || v === 'draw');
    const hasTwo = labels.some(v => v === '2' || v === 'away');
    if (!(hasOne && hasX && hasTwo)) continue;

    const decimals = block.pairs
      .map(pair => parseOdd(pair.value))
      .filter(Number.isFinite)
      .filter(value => value >= 1.001 && value <= 1000);
    if (decimals.length >= 3) {
      const triple = {
        market: '1X2',
        home: decimals[0],
        draw: decimals[1],
        away: decimals[2],
        confidence: 'block_labels_and_prices',
        blockSample: block.sample
      };
      if (isValidTriple(triple.home, triple.draw, triple.away)) markets.push(triple);
    }
  }

  return dedupeMarkets(markets);
}

function makeTriple(homeRaw, drawRaw, awayRaw, confidence) {
  const home = parseOdd(homeRaw);
  const draw = parseOdd(drawRaw);
  const away = parseOdd(awayRaw);
  if (!isValidTriple(home, draw, away)) return null;
  return { market: '1X2', home, draw, away, confidence };
}

function parseOdd(value) {
  const number = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function isValidTriple(home, draw, away) {
  return [home, draw, away].every(value => Number.isFinite(value) && value >= 1.001 && value <= 1000);
}

function scoreAnalysis(analysis) {
  if (!analysis) return 0;
  return (analysis.markets?.length || 0) * 100
    + (analysis.bookmakers?.length || 0) * 20
    + Math.min(analysis.decimalValues?.length || 0, 30)
    + Math.min(analysis.pairCount || 0, 30)
    + (analysis.livesportDelimited ? 10 : 0);
}

function dedupeMarkets(markets) {
  const out = [];
  const seen = new Set();
  for (const market of markets || []) {
    if (!market) continue;
    const key = `${market.market}|${market.home}|${market.draw}|${market.away}|${market.feedLabel || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(market);
  }
  return out;
}

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value || '')
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function dedupe(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
