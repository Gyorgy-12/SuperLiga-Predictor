const DEFAULT_URL = 'https://m.flashscore.ro/';
const DEFAULT_TIMEOUT_MS = 6500;

/**
 * Reads the lightweight official Flashscore mobile page once and extracts the
 * visible football clock (for example 33' or Pauză). This is intentionally a
 * clock-only source: score/event details still come from the existing x/feed
 * pipeline.
 */
export async function fetchFlashscoreMobileClocks(env, fixtures = [], opts = {}) {
  const targets = (fixtures || []).filter(f => f?.id && f?.h && f?.a);
  if (!targets.length) return emptyPack('no_target_fixtures');

  const url = String(opts.url || env?.FLASHSCORE_MOBILE_CLOCK_URL || DEFAULT_URL);
  const timeoutMs = clampNumber(opts.timeoutMs || env?.FLASHSCORE_MOBILE_CLOCK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 15000);
  const referer = String(opts.referer || env?.FLASHSCORE_REFERER || 'https://www.flashscore.com/');
  const userAgent = String(opts.userAgent || env?.FLASHSCORE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');

  const requestUrl = withCacheBust(url);
  const probe = await fetchHtml(requestUrl, { timeoutMs, referer, userAgent });
  if (!probe.ok) {
    return {
      ...emptyPack('fetch_failed'),
      ok: false,
      error: probe.error || `HTTP ${probe.status || 0}`,
      url,
      requestUrl,
      status: probe.status || 0,
      elapsedMs: probe.elapsedMs
    };
  }

  const rows = parseFlashscoreMobileFootballPage(probe.text || '');
  const matched = [];
  const unmatched = [];
  const used = new Set();

  for (const fixture of targets) {
    const ranked = rows
      .map((row, index) => ({ row, index, score: scoreFixtureRow(fixture, row) }))
      .filter(x => x.score >= 55)
      .sort((a, b) => b.score - a.score);
    const best = ranked.find(x => !used.has(x.index)) || null;
    if (!best || best.score < 78) {
      unmatched.push({
        id: fixture.id,
        h: fixture.h,
        a: fixture.a,
        bestScore: best?.score || 0,
        bestHome: best?.row?.home || null,
        bestAway: best?.row?.away || null
      });
      continue;
    }

    used.add(best.index);
    matched.push({
      id: fixture.id,
      date: fixture.date || null,
      h: fixture.h,
      a: fixture.a,
      rawHome: best.row.home,
      rawAway: best.row.away,
      liveMinute: best.row.liveMinute,
      liveStatus: best.row.liveStatus,
      homeScore: best.row.homeScore,
      awayScore: best.row.awayScore,
      minuteSource: best.row.liveMinute ? 'flashscore-mobile-page' : null,
      clockObservedAt: best.row.liveMinute ? new Date().toISOString() : null,
      mobileClockRaw: best.row.clockRaw,
      rawLine: best.row.rawLine,
      score: best.score,
      origin: url
    });
  }

  return {
    ok: true,
    source: 'flashscore-mobile-clock-v2-cache-bust',
    url,
    status: probe.status,
    bytes: probe.text?.length || 0,
    elapsedMs: probe.elapsedMs,
    targetCount: targets.length,
    rawRowCount: rows.length,
    count: matched.length,
    matched,
    unmatched,
    rowSample: rows.slice(0, 24),
    cacheStatus: probe.cacheStatus || null,
    age: probe.age || null,
    updatedAt: new Date().toISOString()
  };
}

function withCacheBust(value) {
  const stamp = Date.now();
  try {
    const u = new URL(String(value || DEFAULT_URL));
    u.searchParams.set('_slclock', String(stamp));
    return u.toString();
  } catch {
    const raw = String(value || DEFAULT_URL);
    return `${raw}${raw.includes('?') ? '&' : '?'}_slclock=${stamp}`;
  }
}

export function parseFlashscoreMobileFootballPage(html) {
  const lines = htmlToLines(html);
  const rows = [];
  for (const line of lines) {
    const parsed = parseMobileLine(line);
    if (parsed) rows.push(parsed);
  }
  return dedupeRows(rows);
}

function parseMobileLine(line) {
  let text = compact(line);
  if (!text || !text.includes(' - ')) return null;

  // Mobile Flashscore exposes live rows as: 33'Home - Away 0-2
  // and the interval as: Pauză Home - Away 1-0.
  const prefix = text.match(/^((?:\d{1,3}(?:\+(?:\d{1,2})?)?)[’'′]|PAUZĂ|PAUZA|HALF\s*TIME|HT|FINAL|FT)\s*/i);
  if (!prefix) return null;

  const clockRaw = prefix[1];
  text = text.slice(prefix[0].length).trim();
  const scoreMatch = text.match(/\s+(\d{1,2})\s*-\s*(\d{1,2})(?:\s|$)/);
  if (!scoreMatch) return null;

  const teamsPart = text.slice(0, scoreMatch.index).trim();
  const separator = teamsPart.lastIndexOf(' - ');
  if (separator < 1) return null;

  const home = teamsPart.slice(0, separator).trim();
  const away = teamsPart.slice(separator + 3).trim();
  if (!home || !away) return null;

  const liveMinute = parseMinute(clockRaw);
  const upper = normalize(clockRaw).toUpperCase();
  let liveStatus = null;
  if (liveMinute) liveStatus = 'LIVE';
  else if (/PAUZA|HALF TIME|^HT$/.test(upper)) liveStatus = 'HT';
  else if (/FINAL|^FT$/.test(upper)) liveStatus = 'FT';

  return {
    clockRaw,
    liveMinute,
    liveStatus,
    home,
    away,
    homeScore: Number(scoreMatch[1]),
    awayScore: Number(scoreMatch[2]),
    rawLine: compact(line)
  };
}

function htmlToLines(html) {
  let text = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:br|\/tr|\/li|\/p|\/div|\/h\d|\/table|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text
    .split(/\r?\n/)
    .map(compact)
    .filter(Boolean);
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCodePoint(parseInt(n, 16)));
}

function safeCodePoint(n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ''; } catch { return ''; }
}

function parseMinute(value) {
  const text = String(value || '').replace(/[’'′]/g, '').trim();
  const m = text.match(/^(\d{1,3})(?:\+(\d{0,2}))?$/);
  if (!m) return null;
  const base = Number(m[1]);
  const hasAddedTime = text.includes('+');
  const extra = m[2] == null || m[2] === '' ? null : Number(m[2]);
  if (!Number.isFinite(base) || base < 1 || base > 130) return null;
  if (extra != null && (!Number.isFinite(extra) || extra < 0 || extra > 30)) return null;
  return hasAddedTime ? (extra == null ? `${base}+` : `${base}+${extra}`) : String(base);
}

function scoreFixtureRow(fixture, row) {
  const home = teamSimilarity(fixture.h, row.home);
  const away = teamSimilarity(fixture.a, row.away);
  const reverse = teamSimilarity(fixture.h, row.away) + teamSimilarity(fixture.a, row.home);
  const direct = home + away;
  if (reverse > direct + 0.15) return 0;
  return Math.min(100, Math.round(home * 48) + Math.round(away * 48) + (home > 0.96 && away > 0.96 ? 4 : 0));
}

function teamSimilarity(a, b) {
  const ca = canonicalTeam(a);
  const cb = canonicalTeam(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.includes(cb) || cb.includes(ca)) return 0.94;
  const ta = new Set(ca.split(' ').filter(Boolean));
  const tb = new Set(cb.split(' ').filter(Boolean));
  const intersection = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const prefix = [...ta].some(x => [...tb].some(y => x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)))) ? 0.18 : 0;
  return Math.min(0.92, intersection / union + prefix);
}

function canonicalTeam(value) {
  let s = normalize(value)
    .replace(/["'`]/g, ' ')
    .replace(/\b(afc|acs|asc|as|cs|csm|fc|fotbal club|clubul sportiv|sc|fk)\b/g, ' ')
    .replace(/\b(sf\.?\s*gheorghe|sfantu gheorghe)\b/g, ' ')
    .replace(/\b(m\.?\s*ciuc|miercurea ciuc)\b/g, ' ')
    .replace(/\b(bucuresti|bucurest|buc)\b/g, ' bucuresti ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases = [
    [/^(acs )?champions? (fc )?arges$|^campionii arges$|^arges$/, 'arges'],
    [/^fcsb$|^steaua bucuresti$/, 'fcsb'],
    [/^universitatea cluj$|^u cluj$|^univ cluj$/, 'universitatea cluj'],
    [/^universitatea craiova$|^univ craiova$|^u craiova$/, 'universitatea craiova'],
    [/^rapid bucuresti$|^rapid$/, 'rapid bucuresti'],
    [/^dinamo bucuresti$|^dinamo$/, 'dinamo bucuresti'],
    [/^sepsi( osk)?$/, 'sepsi'],
    [/^csikszereda$/, 'csikszereda'],
    [/^otelul galati$|^otelul$/, 'otelul galati'],
    [/^petrolul ploiesti$|^petrolul$/, 'petrolul ploiesti'],
    [/^farul constanta$|^farul$/, 'farul constanta'],
    [/^corvinul hunedoara$|^corvinul$/, 'corvinul hunedoara'],
    [/^voluntari$/, 'voluntari'],
    [/^botosani$/, 'botosani'],
    [/^cfr cluj$/, 'cfr cluj'],
    [/^uta arad$|^uta$/, 'uta arad']
  ];
  for (const [pattern, replacement] of aliases) if (pattern.test(s)) return replacement;
  return s;
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dedupeRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${canonicalTeam(row.home)}|${canonicalTeam(row.away)}|${row.clockRaw}|${row.homeScore}-${row.awayScore}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

async function fetchHtml(url, opts) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), opts.timeoutMs);
  try {
    const response = await fetch(url, {
      // Cloudflare Workers rejects cache:'no-store' together with cf.cacheTtl.
      // The unique _slclock query parameter already busts intermediary caches.
      cache: 'no-store',
      headers: {
        accept: 'text/html,application/xhtml+xml,*/*',
        referer: opts.referer,
        'user-agent': opts.userAgent,
        'accept-language': 'ro-RO,ro;q=0.9,en;q=0.7',
        'cache-control': 'no-cache, no-store, max-age=0',
        pragma: 'no-cache'
      },
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      elapsedMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
      cacheStatus: response.headers.get('cf-cache-status'),
      age: response.headers.get('age')
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      elapsedMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

function emptyPack(reason) {
  return {
    ok: true,
    source: 'flashscore-mobile-clock-v2-cache-bust',
    targetCount: 0,
    rawRowCount: 0,
    count: 0,
    matched: [],
    unmatched: [],
    rowSample: [],
    skipped: true,
    reason,
    updatedAt: new Date().toISOString()
  };
}
