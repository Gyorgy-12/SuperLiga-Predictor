// B33A — CLOUDFLARE WORKER ONLY
// This file contains no browser UI code.
// Expected export:
//   fetchEloFootballRatings(env, fixtures, opts)
//
// Replace exactly:
//   src/sources/elofootball-source.js
//
// Do not append this file to an existing script.

import { uniqueTeamsFromFixtures } from '../core/team-match.js';

const DEFAULT_BASE_URL = 'https://elofootball.com/country.php';
const DEFAULT_COUNTRY_ISO = 'ROU';
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_ELO = 900;
const MAX_ELO = 2500;

const TEAM_ALIASES = {
  'FCSB': [
    'FCSB'
  ],
  'CFR Cluj': [
    'CFR Cluj'
  ],
  'Universitatea Craiova': [
    'CS Universitatea Craiova',
    'Universitatea Craiova',
    'CSU Craiova'
  ],
  'Rapid București': [
    'Rapid Bucuresti',
    'Rapid București'
  ],
  'Farul Constanța': [
    'Farul Constanta',
    'Farul Constanța'
  ],
  'Universitatea Cluj': [
    'Universitatea Cluj',
    'U Cluj'
  ],
  'Sepsi OSK': [
    'Sepsi OSK'
  ],
  'Dinamo': [
    'FC Dinamo Bucuresti',
    'FC Dinamo București',
    'Dinamo Bucuresti',
    'Dinamo București'
  ],
  'Oțelul Galați': [
    'Otelul Galati',
    'Oțelul Galați'
  ],
  'Petrolul Ploiești': [
    'Petrolul Ploiesti',
    'Petrolul Ploiești'
  ],
  'UTA Arad': [
    'UTA Arad'
  ],
  'FC Botoșani': [
    'FC Botosani',
    'FC Botoșani',
    'Botosani',
    'Botoșani'
  ],
  'FC Voluntari': [
    'FC Voluntari',
    'Voluntari'
  ],
  'FC Argeș': [
    'Arges Pitesti',
    'Argeș Pitești',
    'FC Arges',
    'FC Argeș'
  ],
  'Csikszereda': [
    'FK Csikszereda',
    'FK Csíkszereda',
    'Csikszereda'
  ],
  'Corvinul Hunedoara': [
    'Corvinul Hunedoara',
    'FC Corvinul Hunedoara',
    'Corvinul 1921 Hunedoara'
  ]
};

const ALIAS_INDEX = buildAliasIndex();

export async function fetchEloFootballRatings(env, fixtures = [], opts = {}) {
  const knownTeams = uniqueTeamsFromFixtures(fixtures);
  const countryIso = clean(
    opts.countryIso
      || env.ELOFOOTBALL_COUNTRY_ISO
      || DEFAULT_COUNTRY_ISO
  ).toUpperCase();

  const configuredSeason = normalizeSeason(
    opts.season || env.ELOFOOTBALL_SEASON
  );

  const seasons = configuredSeason
    ? [configuredSeason]
    : buildSeasonCandidates(new Date());

  const baseUrl = clean(
    opts.url
      || env.ELOFOOTBALL_BASE_URL
      || DEFAULT_BASE_URL
  );

  const attempts = [];
  let selected = null;

  for (const season of seasons) {
    const url = buildCountryUrl(baseUrl, countryIso, season);
    const response = await fetchPage(env, url, opts);
    const parsed = response.ok
      ? parseEloFootballRows(response.text)
      : { rows: [], noData: false, sectionFound: false };

    const attempt = {
      url,
      season,
      ok: response.ok,
      status: response.status,
      bytes: response.bytes,
      elapsedMs: response.elapsedMs,
      contentType: response.contentType,
      finalUrl: response.finalUrl || url,
      rowCount: parsed.rows.length,
      sectionFound: parsed.sectionFound,
      noData: parsed.noData,
      error: response.error || null
    };

    if (response.ok && !parsed.rows.length) {
      attempt.error = parsed.noData
        ? 'season_has_no_ranking_data'
        : 'no_parseable_ranking_rows';
    }

    attempts.push(attempt);

    if (response.ok && parsed.rows.length) {
      selected = {
        season,
        url: response.finalUrl || url,
        rows: parsed.rows
      };
      break;
    }
  }

  if (!selected) {
    return {
      ok: false,
      source: 'elofootball-country-page-b33',
      ratings: {},
      count: 0,
      fetched: 0,
      coverage: 0,
      countryIso,
      selectedSeason: null,
      attemptedSeasons: seasons,
      attempts,
      missing: knownTeams,
      unmatched: [],
      warnings: [
        'EloFootball did not return a parseable Romania ranking. Existing stored Elo values were preserved.'
      ],
      error: attempts.at(-1)?.error || 'elofootball_unavailable',
      updatedAt: new Date().toISOString()
    };
  }

  const ratings = {};
  const matched = [];
  const unmatched = [];

  for (const row of selected.rows) {
    const canonical = canonicalTeam(row.team, knownTeams);

    if (!canonical) {
      unmatched.push(row);
      continue;
    }

    const elo = normalizeElo(row.elo);
    if (elo == null) {
      unmatched.push(row);
      continue;
    }

    ratings[canonical] = elo;
    matched.push({
      team: canonical,
      sourceTeam: row.team,
      elo,
      rank: row.rank ?? null,
      clubId: row.clubId ?? null
    });
  }

  const missing = knownTeams.filter(team => ratings[team] == null);
  const warnings = [];

  if (selected.season !== seasons[0]) {
    warnings.push(
      `The ${seasons[0]} Romania page has no ranking data yet; Elo values were read from ${selected.season}.`
    );
  }

  if (missing.length) {
    warnings.push(
      `EloFootball has no matched current value for ${missing.length} team(s): ${missing.join(', ')}. ` +
      'Previously stored values are preserved and no rating is fabricated.'
    );
  }

  return {
    ok: Object.keys(ratings).length > 0,
    source: 'elofootball-country-page-b33',
    countryIso,
    selectedSeason: selected.season,
    url: selected.url,
    attemptedSeasons: seasons,
    fetched: selected.rows.length,
    count: Object.keys(ratings).length,
    coverage: knownTeams.length
      ? Number((Object.keys(ratings).length / knownTeams.length).toFixed(3))
      : 0,
    ratings,
    matched,
    unmatched: unmatched.slice(0, 80),
    missing,
    attempts,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

async function fetchPage(env, url, opts = {}) {
  const timeoutMs = clampInt(
    opts.timeoutMs || env.ELOFOOTBALL_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    3000,
    30000
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,ro;q=0.8',
        'cache-control': opts.force ? 'no-cache' : 'max-age=0',
        'user-agent':
          env.ELOFOOTBALL_USER_AGENT
          || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
             '(KHTML, like Gecko) Chrome/125 Safari/537.36'
      },
      signal: controller.signal,
      cf: {
        cacheTtl: opts.force ? 0 : 1800,
        cacheEverything: false
      }
    });

    const text = await response.text();

    return {
      ok: response.ok,
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

export function parseEloFootballRows(html = '') {
  const source = String(html || '');
  if (!source.trim()) {
    return {
      rows: [],
      sectionFound: false,
      noData: false
    };
  }

  const section = extractRankingSection(source);
  const sectionFound = section !== source;
  const plain = cleanHtml(section);
  const noData = /no data available/i.test(plain);

  const rows = parseTableRows(section);
  if (rows.length) {
    return {
      rows: dedupeRows(rows),
      sectionFound,
      noData
    };
  }

  return {
    rows: dedupeRows(parseAnchorBlocks(section)),
    sectionFound,
    noData
  };
}

function extractRankingSection(html) {
  const startPatterns = [
    /Elo ranking for Romania/i,
    /Elo ranking for [A-Za-z ]+/i
  ];

  let start = -1;

  for (const pattern of startPatterns) {
    const match = pattern.exec(html);
    if (match) {
      start = match.index;
      break;
    }
  }

  if (start < 0) return html;

  const tail = html.slice(start);
  const endPatterns = [
    /season:\s*Games and upcoming fixtures/i,
    /Games and upcoming fixtures/i,
    /<footer\b/i
  ];

  let end = tail.length;

  for (const pattern of endPatterns) {
    const match = pattern.exec(tail);
    if (match && match.index > 0) {
      end = Math.min(end, match.index);
    }
  }

  return tail.slice(0, end);
}

function parseTableRows(section) {
  const output = [];
  const rows = section.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rows) {
    const club = extractClubAnchor(rowHtml);
    if (!club) continue;

    const cells = [...rowHtml.matchAll(
      /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi
    )].map(match => cleanHtml(match[1]));

    const teamIndex = cells.findIndex(cell =>
      clubKey(cell) === clubKey(club.team)
      || clubKey(cell).includes(clubKey(club.team))
    );

    const afterTeam = teamIndex >= 0
      ? cells.slice(teamIndex + 1)
      : cells;

    const elo = firstEloValue(afterTeam);
    if (elo == null) continue;

    const rank = firstRankValue(
      teamIndex > 0 ? cells.slice(0, teamIndex) : cells.slice(0, 2)
    );

    output.push({
      team: club.team,
      elo,
      rank,
      clubId: club.clubId
    });
  }

  return output;
}

function parseAnchorBlocks(section) {
  const output = [];
  const anchors = [...section.matchAll(
    /<a\b[^>]*href=["'][^"']*club\.php\?clubid=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi
  )];

  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index];
    const team = cleanHtml(match[2]);
    if (!isPlausibleTeamName(team)) continue;

    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < anchors.length
      ? anchors[index + 1].index
      : Math.min(section.length, start + 2500);

    const chunk = cleanHtml(section.slice(start, end));
    const elo = firstEloValue([chunk]);

    if (elo == null) continue;

    output.push({
      team,
      elo,
      rank: null,
      clubId: Number(match[1])
    });
  }

  return output;
}

function extractClubAnchor(rowHtml) {
  const match = /<a\b[^>]*href=["'][^"']*club\.php\?clubid=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
    .exec(rowHtml);

  if (!match) return null;

  const team = cleanHtml(match[2]);
  if (!isPlausibleTeamName(team)) return null;

  return {
    team,
    clubId: Number(match[1])
  };
}

function firstEloValue(values) {
  for (const value of values) {
    const tokens = String(value || '').match(/\b\d{3,4}\b/g) || [];

    for (const token of tokens) {
      const elo = normalizeElo(token);
      if (elo != null) return elo;
    }
  }

  return null;
}

function firstRankValue(values) {
  for (const value of values) {
    const tokens = String(value || '').match(/\b\d{1,4}\b/g) || [];

    for (const token of tokens) {
      const number = Number(token);
      if (Number.isInteger(number) && number > 0 && number < 5000) {
        return number;
      }
    }
  }

  return null;
}

function canonicalTeam(sourceName, knownTeams) {
  const key = clubKey(sourceName);
  if (!key) return null;

  const alias = ALIAS_INDEX.get(key);
  if (alias && knownTeams.includes(alias)) return alias;

  const exact = knownTeams.find(team => clubKey(team) === key);
  return exact || null;
}

function buildAliasIndex() {
  const output = new Map();

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    for (const alias of [canonical, ...aliases]) {
      const key = clubKey(alias);
      if (key) output.set(key, canonical);
    }
  }

  return output;
}

function clubKey(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeElo(value) {
  const number = Number(String(value ?? '').replace(/[^\d.-]/g, ''));

  if (
    !Number.isFinite(number)
    || number < MIN_ELO
    || number > MAX_ELO
  ) {
    return null;
  }

  return Math.round(number);
}

function buildCountryUrl(baseUrl, countryIso, season) {
  const url = new URL(baseUrl);
  url.searchParams.set('countryiso', countryIso);
  url.searchParams.set('season', season);
  return url.toString();
}

function buildSeasonCandidates(now) {
  const current = seasonForDate(now);
  const [startYear] = current.split('-').map(Number);
  const previous = `${startYear - 1}-${startYear}`;

  return [current, previous];
}

function seasonForDate(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

function normalizeSeason(value) {
  const text = clean(value);
  return /^\d{4}-\d{4}$/.test(text) ? text : null;
}

function isPlausibleTeamName(value) {
  const text = clean(value);
  if (!text || text.length < 2 || text.length > 100) return false;
  if (!/[A-Za-zĂÂÎȘȚăâîșț]/.test(text)) return false;
  return !/^(ranking|statistics|club|rating|record)$/i.test(text);
}

function cleanHtml(value) {
  return decodeEntities(
    String(value || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, number) => {
      const code = Number(number);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows || []) {
    const key = clubKey(row?.team);
    const elo = normalizeElo(row?.elo);

    if (!key || elo == null) continue;

    if (!map.has(key)) {
      map.set(key, {
        team: clean(row.team),
        elo,
        rank: Number.isFinite(Number(row.rank)) ? Number(row.rank) : null,
        clubId: Number.isFinite(Number(row.clubId)) ? Number(row.clubId) : null
      });
    }
  }

  return [...map.values()];
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
