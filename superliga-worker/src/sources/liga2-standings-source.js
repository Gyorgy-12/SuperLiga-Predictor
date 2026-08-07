const DEFAULT_PAGE_URL = 'https://www.flashscore.com/football/romania/liga-2/standings/';
const DEFAULT_FEED_BASES = [
  'https://2.flashscore.ninja/2/x/feed',
  'https://d.flashscore.com/x/feed'
];

function numberOrZero(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function compactCells(block) {
  const cells = {};
  String(block || '').split('¬').forEach(cell => {
    const separator = cell.indexOf('÷');
    if (separator < 1) return;
    const key = cell.slice(0, separator).trim();
    const value = cell.slice(separator + 1).trim();
    if (key) cells[key] = value;
  });
  return cells;
}

function sectionLooksLikePromotion(label) {
  return /championship|promotion|play[ -]?off|promov|feljut/i.test(String(label || ''));
}

export function parseLiga2PageMetadata(html, sourceUrl = DEFAULT_PAGE_URL) {
  const body = String(html || '');
  const tournamentId = body.match(/tournamentId\s*:\s*["']([^"']+)["']/i)?.[1] || '';
  const stageId = body.match(/tournamentStageId\s*:\s*["']([^"']+)["']/i)?.[1] || '';
  const templateId = body.match(/tournamentTemplateId\s*:\s*["']([^"']+)["']/i)?.[1] || '';
  const headingSeason = body.match(/<div[^>]*class=["'][^"']*heading__info[^"']*["'][^>]*>([^<]+)<\/div>/i)?.[1];
  const titleSeason = body.match(/Liga\s*2[^<\n]{0,80}?((?:20\d{2})\s*\/\s*(?:20\d{2}))/i)?.[1];
  const season = decodeHtml(headingSeason || titleSeason || '').replace(/\s+/g, '');

  if (!tournamentId || !stageId) {
    throw new Error('Liga 2 tournament metadata is missing');
  }

  return { tournamentId, stageId, templateId, season, sourceUrl };
}

export function buildLiga2StandingsFeedName(metadata) {
  if (!metadata?.tournamentId || !metadata?.stageId) {
    throw new Error('Liga 2 tournament and stage identifiers are required');
  }
  return `to_${metadata.tournamentId}_${metadata.stageId}_1`;
}

export function parseLiga2StandingsFeed(raw, metadata = {}) {
  const body = String(raw || '').trim();
  if (!body || body === '0' || !body.includes('TR÷') || !body.includes('TN÷')) {
    throw new Error('Liga 2 standings feed is empty or malformed');
  }

  const logoByTeamId = {};
  const sections = [];
  const blocks = body.split('~');
  let current = { label: '', rows: [] };

  // Logo pairs share one compact block and can arrive after the table rows.
  const logoPattern = /IPI÷([^¬~]+)¬IPU÷([^¬~]+)/g;
  let logoMatch;
  while ((logoMatch = logoPattern.exec(body)) !== null) {
    logoByTeamId[logoMatch[1]] = logoMatch[2];
  }

  function finishSection() {
    if (current.rows.length) sections.push(current);
    current = { label: '', rows: [] };
  }

  blocks.forEach(block => {
    const cells = compactCells(block);

    if ((cells.TZ || cells.TZS) && current.rows.length) finishSection();
    if (cells.TZ || cells.TZS) {
      current.label = [cells.TZ, cells.TZS].filter(Boolean).join(' · ');
    }

    if (!cells.TR || !cells.TN || !cells.TI) return;
    const [goalsFor, goalsAgainst] = String(cells.TG || '0:0').split(':').map(numberOrZero);
    const logoFile = logoByTeamId[cells.TI] || '';
    current.rows.push({
      position: numberOrZero(cells.TR),
      name: decodeHtml(cells.TN),
      teamId: cells.TI,
      teamUrl: cells.TIU ? new URL(cells.TIU, 'https://www.flashscore.com').href : '',
      logo: logoFile ? `https://static.flashscore.com/res/image/data/${logoFile}` : '',
      played: numberOrZero(cells.TM),
      won: numberOrZero(cells.TW),
      drawn: numberOrZero(cells.TDR),
      lost: numberOrZero(cells.TL),
      goalsFor,
      goalsAgainst,
      goalDifference: numberOrZero(cells.TPF),
      points: numberOrZero(cells.TP),
      zone: cells.TU || ''
    });
  });
  finishSection();

  if (!sections.length) throw new Error('Liga 2 standings rows are missing');
  const selected = sections.find(section => sectionLooksLikePromotion(section.label) && section.rows.length >= 4)
    || sections.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
  const standings = selected.rows
    .filter(row => row.position > 0 && row.name)
    .sort((a, b) => a.position - b.position);
  if (standings.length < 4) throw new Error('Liga 2 standings do not contain four teams');

  const phase = sectionLooksLikePromotion(selected.label) || standings.length <= 6 ? 'promotion' : 'regular';
  const topFour = standings.slice(0, 4);
  return {
    ok: true,
    competition: 'Liga 2',
    season: metadata.season || '',
    phase,
    phaseLabel: phase === 'promotion' ? 'Feljutási rájátszás' : 'Alapszakasz',
    provisional: phase !== 'promotion',
    source: 'flashscore-standings',
    sourceUrl: metadata.sourceUrl || DEFAULT_PAGE_URL,
    tournamentId: metadata.tournamentId || '',
    stageId: metadata.stageId || '',
    rowCount: standings.length,
    standings: topFour,
    directPromotion: topFour.slice(0, 2),
    baraj: topFour.slice(2, 4)
  };
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function fetchLiga2Standings(env = {}) {
  const pageUrl = env.LIGA2_STANDINGS_PAGE_URL || DEFAULT_PAGE_URL;
  const timeoutMs = Math.max(2000, Number(env.LIGA2_STANDINGS_TIMEOUT_MS || 12000));
  const pageResponse = await fetchWithTimeout(pageUrl, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (compatible; SuperLigaPredictor/1.0)'
    }
  }, timeoutMs);
  if (!pageResponse.ok) throw new Error(`Liga 2 page HTTP ${pageResponse.status}`);

  const metadata = parseLiga2PageMetadata(await pageResponse.text(), pageUrl);
  const feedName = buildLiga2StandingsFeedName(metadata);
  const bases = [env.LIGA2_FLASHSCORE_FEED_BASE_URL, ...DEFAULT_FEED_BASES]
    .filter(Boolean)
    .map(value => String(value).replace(/\/$/, ''));
  let lastError = null;

  for (const base of [...new Set(bases)]) {
    try {
      const response = await fetchWithTimeout(`${base}/${feedName}`, {
        headers: {
          accept: 'text/plain,*/*',
          origin: 'https://www.flashscore.com',
          referer: pageUrl,
          'user-agent': 'Mozilla/5.0 (compatible; SuperLigaPredictor/1.0)',
          'x-fsign': 'SW9D1eZo'
        }
      }, timeoutMs);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseLiga2StandingsFeed(await response.text(), metadata);
      return { ...parsed, updatedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Liga 2 standings unavailable: ${lastError?.message || 'all feeds failed'}`);
}
