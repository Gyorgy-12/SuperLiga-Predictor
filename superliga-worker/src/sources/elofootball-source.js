import {
  normTeam,
  teamVariants,
  uniqueTeamsFromFixtures
} from '../core/team-match.js';

const DEFAULT_PRIMARY_URL =
  'https://www.prediction-game.com/en/elo-rating-football-teams/';
const DEFAULT_FALLBACK_URL = 'https://clubelo.com/ROM';
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MIN_COUNT = 12;
const MIN_ELO = 900;
const MAX_ELO = 2300;

/**
 * Historical export name kept so the rest of the Worker does not need a broad
 * refactor. B47 no longer insists on EloFootball. It reads one current external
 * club-Elo provider at a time and never mixes two different Elo models.
 */
export async function fetchEloFootballRatings(env, fixtures = [], opts = {}) {
  const startedAt = Date.now();
  const knownTeams = uniqueTeamsFromFixtures(fixtures);
  const minCount = clampInt(
    opts.minCount || env.CURRENT_ELO_MIN_COUNT,
    Math.min(DEFAULT_MIN_COUNT, knownTeams.length || DEFAULT_MIN_COUNT),
    1,
    Math.max(1, knownTeams.length || 16)
  );

  const primaryUrl = clean(
    opts.url
      || env.CURRENT_ELO_PRIMARY_URL
      || env.ELO_PRIMARY_URL
      || DEFAULT_PRIMARY_URL
  );
  const fallbackUrl = clean(
    opts.fallbackUrl
      || env.CURRENT_ELO_FALLBACK_URL
      || env.ELO_FALLBACK_URL
      || DEFAULT_FALLBACK_URL
  );

  const directPlans = unique([
    primaryUrl && {
      id: 'prediction-game-current-club-elo',
      url: primaryUrl,
      parser: parsePredictionGameRatings
    },
    fallbackUrl && {
      id: 'clubelo-romania-current',
      url: fallbackUrl,
      parser: parseClubEloCountryRatings
    }
  ].filter(Boolean), plan => plan.url);

  const results = [];
  for (const plan of directPlans) {
    const result = await runPlan(env, plan, knownTeams, opts);
    results.push(result);
    if (result.count >= minCount) break;
  }

  // Datacenter requests are occasionally rejected by otherwise healthy rating
  // pages. Only pay for the browser-reader fallback when neither direct source
  // reaches the required coverage.
  if (!selectResult(results, minCount) && readerEnabled(env)) {
    const readerTargets = unique([
      primaryUrl,
      primaryUrl?.replace(/^https:/i, 'http:')
    ].filter(Boolean));
    const readerResults = await Promise.all(
      readerTargets.map((target, index) => runPlan(env, {
        id: `prediction-game-reader-${index + 1}`,
        sourceKind: 'prediction-game-current-club-elo',
        url: buildReaderUrl(env, target),
        parser: parsePredictionGameMarkdownRatings,
        reader: true
      }, knownTeams, opts))
    );
    results.push(...readerResults);
  }

  const attempts = results.map(result => result.attempt);

  // Prefer a provider with enough current coverage. If both satisfy the
  // threshold, keep the configured order to avoid changing Elo scale between
  // daily runs without a real outage.
  const selected = selectResult(results, minCount)
    || [...results].sort((a, b) => b.count - a.count)[0]
    || null;

  if (selected && selected.count >= minCount) {
    return buildSuccess({
      ...selected,
      knownTeams,
      attempts,
      minCount,
      elapsedMs: Date.now() - startedAt
    });
  }

  const bestCount = selected?.count || 0;
  return {
    ok: false,
    source: 'current-external-club-elo-b47-unavailable',
    sourceKind: null,
    ratings: {},
    count: 0,
    fetched: bestCount,
    coverage: knownTeams.length
      ? Number((bestCount / knownTeams.length).toFixed(3))
      : 0,
    minCount,
    attempts,
    missing: knownTeams,
    unmatched: selected?.unmatched || [],
    warnings: [
      `No current external Elo provider reached the minimum coverage (${minCount}/${knownTeams.length || 0}). Existing stored Elo values were preserved.`
    ],
    error: attempts.at(-1)?.error || 'current_elo_sources_unavailable',
    elapsedMs: Date.now() - startedAt,
    updatedAt: new Date().toISOString()
  };
}

async function runPlan(env, plan, knownTeams, opts) {
  const response = await fetchText(env, plan.url, opts, { reader: !!plan.reader });
  const parsed = response.ok
    ? plan.parser(response.text, knownTeams)
    : emptyParsed(knownTeams);
  const count = Object.keys(parsed.ratings).length;

  return {
    id: plan.id,
    source: `${plan.id}-b47`,
    sourceKind: plan.sourceKind || plan.id,
    url: response.finalUrl || plan.url,
    ratings: parsed.ratings,
    matched: parsed.matched,
    unmatched: parsed.unmatched,
    missing: parsed.missing,
    warnings: parsed.warnings,
    count,
    fetched: parsed.fetched,
    response,
    attempt: {
      source: plan.id,
      url: plan.url,
      ok: response.ok && count > 0,
      status: response.status,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      contentType: response.contentType,
      finalUrl: response.finalUrl,
      mappedCount: count,
      fetched: parsed.fetched,
      missing: parsed.missing,
      error: response.ok
        ? (count ? null : 'no_parseable_current_elo_rows')
        : response.error
    }
  };
}

function selectResult(results, minCount) {
  return (results || []).find(result => result.count >= minCount) || null;
}

export function parsePredictionGameRatings(html = '', knownTeams = []) {
  const structured = parsePredictionGameStructuredRatings(html, knownTeams);

  // The global page contains many clubs with generic names (for example several
  // clubs containing "Rapid"). Only inspect text segments enclosed by Romanian
  // flag markers, so a foreign club can never be mapped to a SuperLiga team.
  const lines = htmlToText(html)
    .split('\n')
    .map(clean)
    .filter(Boolean);
  const markerIndexes = lines
    .map((line, index) => (/^(romania|rom)$/i.test(line) ? index : -1))
    .filter(index => index >= 0);
  const ratings = { ...structured.ratings };
  const matched = [...structured.matched];
  const unmatched = [];

  for (let marker = 0; marker < markerIndexes.length; marker += 1) {
    const from = markerIndexes[marker] + 1;
    const to = marker + 1 < markerIndexes.length
      ? markerIndexes[marker + 1]
      : Math.min(lines.length, from + 8);
    const segmentLines = lines.slice(from, to).filter(Boolean);
    if (!segmentLines.length) continue;
    const block = segmentLines.join(' ');
    const canonical = findCanonicalTeam(block, knownTeams);
    if (!canonical || ratings[canonical] != null) continue;
    const teamPosition = bestTeamPosition(block, canonical);
    const elo = firstElo(block.slice(teamPosition));
    if (elo == null) continue;
    ratings[canonical] = elo;
    matched.push({ team: canonical, sourceTeam: block.slice(0, 180), elo });
  }

  // Some HTML variants omit flag alt text. In that case use a conservative
  // proximity parser, but ignore one-word aliases that are too ambiguous on a
  // global page.
  if (Object.keys(ratings).length < Math.min(8, knownTeams.length)) {
    const fallback = parseByKnownTeamProximity(html, knownTeams, {
      source: 'prediction-game',
      searchAfterChars: 700,
      minimumVariantWords: 2
    });
    for (const [team, elo] of Object.entries(fallback.ratings)) {
      if (ratings[team] == null) ratings[team] = elo;
    }
    for (const row of fallback.matched) {
      if (!matched.some(item => item.team === row.team)) matched.push(row);
    }
  }

  return finishParsed(ratings, matched, unmatched, knownTeams, matched.length);
}

function parsePredictionGameStructuredRatings(html = '', knownTeams = []) {
  const ratings = {};
  const matched = [];
  const recordRegex = /<img\b[^>]*(?:alt|title)=["']Romania["'][^>]*>[\s\S]*?<span\b[^>]*class=["']team-n["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<div\b[^>]*grid-column\s*:\s*3[^>]*>\s*(\d{3,4}(?:\.\d+)?)\s*<\/div>/gi;
  let match;

  while ((match = recordRegex.exec(String(html || '')))) {
    const sourceTeam = clean(htmlToText(match[1]));
    const canonical = findCanonicalTeam(sourceTeam, knownTeams);
    const elo = firstElo(match[2]);
    if (!canonical || elo == null || ratings[canonical] != null) continue;
    ratings[canonical] = elo;
    matched.push({ team: canonical, sourceTeam, elo, parser: 'structured-html' });
  }

  return { ratings, matched };
}

export function parsePredictionGameMarkdownRatings(markdown = '', knownTeams = []) {
  const lines = String(markdown || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(clean)
    .filter(Boolean);
  const ratings = {};
  const matched = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/!\[[^\]]*Romania[^\]]*\]/i.test(line)) continue;
    const sourceTeam = clean(
      line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    );
    const canonical = findCanonicalTeam(sourceTeam, knownTeams);
    if (!canonical || ratings[canonical] != null) continue;

    let elo = null;
    for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
      elo = firstElo(lines[index + offset]);
      if (elo != null) break;
    }
    if (elo == null) continue;
    ratings[canonical] = elo;
    matched.push({ team: canonical, sourceTeam, elo, parser: 'reader-markdown' });
  }

  return finishParsed(ratings, matched, [], knownTeams, matched.length);
}

export function parseClubEloCountryRatings(html = '', knownTeams = []) {
  // ClubElo's country page is a compact table. Restricting searches to the row
  // around each team prevents dates such as 2026-07-30 being mistaken for Elo.
  const rows = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const ratings = {};
  const matched = [];
  const unmatched = [];

  for (const rowHtml of rows) {
    const rowText = htmlToText(rowHtml);
    const canonical = findCanonicalTeam(rowText, knownTeams);
    if (!canonical || ratings[canonical] != null) continue;

    const teamPosition = bestTeamPosition(rowText, canonical);
    const tail = rowText.slice(Math.max(0, teamPosition));
    const elo = firstElo(tail);
    if (elo == null) continue;

    ratings[canonical] = elo;
    matched.push({ team: canonical, sourceTeam: rowText.slice(0, 180), elo });
  }

  // Some versions of ClubElo are not wrapped in normal table rows.
  if (!Object.keys(ratings).length) {
    return parseByKnownTeamProximity(html, knownTeams, {
      source: 'clubelo',
      searchAfterChars: 500,
      requireRomaniaMarker: false
    });
  }

  return finishParsed(ratings, matched, unmatched, knownTeams, rows.length);
}

function parseByKnownTeamProximity(html, knownTeams, config = {}) {
  const text = htmlToText(html);
  const normalized = normWithOffsets(text);
  const ratings = {};
  const matched = [];
  const unmatched = [];

  for (const team of knownTeams) {
    const variants = teamVariants(team)
      .filter(Boolean)
      .filter(variant => {
        const minimumWords = Number(config.minimumVariantWords) || 1;
        return variant.split(' ').filter(Boolean).length >= minimumWords;
      })
      .sort((a, b) => b.length - a.length);

    let best = null;
    for (const variant of variants) {
      const index = normalized.norm.indexOf(variant);
      if (index < 0) continue;
      const originalIndex = normalized.offsets[index] ?? 0;
      const segment = text.slice(
        originalIndex,
        originalIndex + (config.searchAfterChars || 600)
      );
      const elo = firstElo(segment);
      if (elo == null) continue;
      best = { variant, originalIndex, elo, segment };
      break;
    }

    if (!best) continue;
    ratings[team] = best.elo;
    matched.push({
      team,
      sourceTeam: best.variant,
      elo: best.elo,
      raw: clean(best.segment).slice(0, 260)
    });
  }

  return finishParsed(ratings, matched, unmatched, knownTeams, matched.length);
}

function finishParsed(ratings, matched, unmatched, knownTeams, fetched) {
  const missing = knownTeams.filter(team => ratings[team] == null);
  const warnings = missing.length
    ? [`No current Elo value was matched for: ${missing.join(', ')}. Previously stored values are preserved for those teams.`]
    : [];

  return {
    ratings,
    matched,
    unmatched,
    missing,
    warnings,
    fetched
  };
}

function emptyParsed(knownTeams) {
  return {
    ratings: {},
    matched: [],
    unmatched: [],
    missing: [...knownTeams],
    warnings: [],
    fetched: 0
  };
}

function buildSuccess(config) {
  const count = Object.keys(config.ratings).length;
  return {
    ok: true,
    source: config.source,
    sourceKind: config.sourceKind,
    ratings: config.ratings,
    count,
    fetched: config.fetched,
    coverage: config.knownTeams.length
      ? Number((count / config.knownTeams.length).toFixed(3))
      : 0,
    minCount: config.minCount,
    url: config.url,
    matched: config.matched,
    unmatched: (config.unmatched || []).slice(0, 80),
    missing: config.missing,
    attempts: config.attempts,
    warnings: config.warnings || [],
    elapsedMs: config.elapsedMs,
    updatedAt: new Date().toISOString()
  };
}

async function fetchText(env, url, opts = {}, mode = {}) {
  const timeoutMs = clampInt(
    opts.timeoutMs || env.CURRENT_ELO_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    3000,
    30000
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const startedAt = Date.now();

  try {
    const headers = {
      accept: mode.reader
        ? 'text/plain,text/markdown;q=0.9,*/*;q=0.8'
        : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9,ro;q=0.8',
      'cache-control': 'no-cache',
      'user-agent':
        env.CURRENT_ELO_USER_AGENT
        || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    };
    if (mode.reader) {
      headers['x-no-cache'] = 'true';
      headers['x-engine'] = 'browser';
      headers['x-timeout'] = '30';
      headers['x-retain-links'] = 'text';
      headers['x-retain-images'] = 'none';
      if (env.JINA_API_KEY) headers.authorization = `Bearer ${env.JINA_API_KEY}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers
    });
    const text = await response.text();
    const blocked = /captcha|access denied|service unavailable|site overloaded/i.test(text);
    return {
      ok: response.ok && !!text.trim() && !blocked,
      status: response.status,
      text,
      bytes: text.length,
      contentType: response.headers.get('content-type') || '',
      finalUrl: response.url || url,
      elapsedMs: Date.now() - startedAt,
      error: response.ok
        ? (blocked ? 'provider_page_blocked_or_overloaded' : null)
        : `HTTP ${response.status}`
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

function findCanonicalTeam(text, knownTeams) {
  const normalizedText = normTeam(text);
  let best = null;
  let bestLength = 0;
  for (const team of knownTeams) {
    for (const variant of teamVariants(team)) {
      if (variant && normalizedText.includes(variant) && variant.length > bestLength) {
        best = team;
        bestLength = variant.length;
      }
    }
  }
  return best;
}

function bestTeamPosition(text, team) {
  const normalized = normWithOffsets(text);
  let best = -1;
  for (const variant of teamVariants(team).sort((a, b) => b.length - a.length)) {
    const index = normalized.norm.indexOf(variant);
    if (index >= 0) {
      best = normalized.offsets[index] ?? 0;
      break;
    }
  }
  return best < 0 ? 0 : best;
}

function firstElo(value) {
  const text = String(value || '');
  const tokens = [...text.matchAll(/\b\d{3,4}(?:\.\d+)?\b/g)];
  for (const token of tokens) {
    const number = Number(token[0]);
    if (!Number.isFinite(number)) continue;
    if (number >= MIN_ELO && number <= MAX_ELO) return Math.round(number);
  }
  return null;
}

function normWithOffsets(value) {
  const source = stripDiacritics(String(value || '')).toLowerCase();
  let norm = '';
  const offsets = [];
  let previousSpace = true;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const output = /[a-z0-9]/.test(char) ? char : ' ';
    if (output === ' ') {
      if (previousSpace) continue;
      norm += ' ';
      offsets.push(index);
      previousSpace = true;
    } else {
      norm += output;
      offsets.push(index);
      previousSpace = false;
    }
  }

  return { norm: norm.trim(), offsets };
}

function htmlToText(html) {
  return decodeHtml(
    String(html || '')
      .replace(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi, '\n$1\n')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/td|\/th|\/h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function decodeHtml(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (full, name) => named[name.toLowerCase()] ?? full);
}

function stripDiacritics(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function readerEnabled(env) {
  return String(env.CURRENT_ELO_READER_ENABLED || 'true').toLowerCase() !== 'false';
}

function buildReaderUrl(env, targetUrl) {
  const base = String(env.JINA_READER_BASE_URL || 'https://r.jina.ai').replace(/\/$/, '');
  return `${base}/${targetUrl}`;
}

function unique(items, keyFn = item => item) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
