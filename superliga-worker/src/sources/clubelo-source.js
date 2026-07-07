import { matchTeamName, uniqueTeamsFromFixtures } from '../core/team-match.js';

const DEFAULT_CLUBELO_URL = 'https://clubelo.com/ROM';

export async function fetchClubEloRatings(env, fixtures = [], opts = {}) {
  const knownTeams = uniqueTeamsFromFixtures(fixtures);
  const url = opts.url || env.CLUBELO_COUNTRY_URL || DEFAULT_CLUBELO_URL;
  const res = await fetch(url, {
    headers: {
      accept: 'text/html,text/plain,application/json,*/*',
      'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
      'user-agent': env.CLUBELO_USER_AGENT || 'Mozilla/5.0 SuperLigaPredictorWorker/0.1'
    },
    cf: { cacheTtl: opts.force ? 0 : 1800, cacheEverything: false }
  });
  if (!res.ok) return { ok: false, source: 'clubelo', error: `HTTP ${res.status}`, ratings: {}, url };
  const text = await res.text();
  const rows = parseClubEloRows(text);
  const ratings = {};
  const raw = [];
  for (const row of rows) {
    const canonical = matchTeamName(row.team, knownTeams);
    if (!canonical || !knownTeams.includes(canonical)) continue;
    ratings[canonical] = row.elo;
    raw.push({ ...row, team: canonical, sourceTeam: row.team });
  }
  return {
    ok: true,
    source: 'clubelo-country-page',
    url,
    fetched: rows.length,
    count: Object.keys(ratings).length,
    ratings,
    raw,
    updatedAt: new Date().toISOString(),
    warnings: Object.keys(ratings).length ? [] : ['No SuperLiga Elo values parsed from ClubElo country page.']
  };
}

export function parseClubEloRows(input = '') {
  const text = String(input || '');
  if (/^\s*Rank,|^\s*Club,/i.test(text)) return parseClubEloCsv(text);
  const rows = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const row of rows) {
    const plain = cleanText(row);
    const m = plain.match(/(?:ROM\s+)?([A-Za-zĂÂÎȘȚăâîșț0-9 .'-]+?)\s+(1[1-9]\d{2}|2\d{3})\b/);
    if (m) out.push({ team: m[1].trim(), elo: Number(m[2]) });
  }
  if (out.length) return dedupe(out);

  // Very fallback: lines from cached text snippets.
  const lines = cleanText(text).split(/(?=\b\d+\s+ROM\s+)/g);
  for (const line of lines) {
    const m = line.match(/\b\d+\s+ROM\s+(.+?)\s+(1[1-9]\d{2}|2\d{3})\b/);
    if (m) out.push({ team: m[1].trim(), elo: Number(m[2]) });
  }
  return dedupe(out);
}

function parseClubEloCsv(csv) {
  const out = [];
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = lines.shift()?.split(',').map(h => h.trim().toLowerCase()) || [];
  const clubIdx = header.findIndex(h => ['club', 'team'].includes(h));
  const eloIdx = header.findIndex(h => h === 'elo');
  for (const line of lines) {
    const cols = line.split(',');
    const team = cols[clubIdx] || cols[0];
    const elo = Number(cols[eloIdx] || cols.find(c => /^\d{4}$/.test(c)));
    if (team && Number.isFinite(elo)) out.push({ team: team.trim(), elo });
  }
  return dedupe(out);
}

function cleanText(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.team || !Number.isFinite(row.elo)) continue;
    const key = row.team.toLowerCase();
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}
