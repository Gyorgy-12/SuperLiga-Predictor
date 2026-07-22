function cleanMinute(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return `${s}'`;
  return s;
}

function validScore(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function cleanEventMinute(value) {
  if (value == null || value === '') return null;
  return String(value).replace(/[’'′]+/g, '').trim() || null;
}


function repairPlayerUnicode(value) {
  let text = String(value || '');
  if (!text) return '';
  text = text
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  if (/[ÃÂÄÅ]/.test(text) && typeof TextDecoder !== 'undefined') {
    try {
      const bytes = Uint8Array.from(Array.from(text, ch => ch.charCodeAt(0) & 255));
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (decoded && !decoded.includes(' ')) text = decoded;
    } catch {}
  }
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function playerAsciiKey(value) {
  return repairPlayerUnicode(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[’'`´.-]/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const PLAYER_NAME_EXACT = Object.freeze({
  'birligea d': 'D. Birligea',
  'd birligea': 'D. Birligea',
  'birligea daniel': 'Daniel Birligea',
  'daniel birligea': 'Daniel Birligea',
  'tanase f': 'F. Tanase',
  'f tanase': 'F. Tanase',
  'tanase florin': 'Florin Tanase',
  'florin tanase': 'Florin Tanase',
  's baiaram': 'S. Baiaram',
  'stefan baiaram': 'Stefan Baiaram'
});

const PLAYER_SURNAME_DIACRITICS = Object.freeze({
  birligea: 'Birligea',
  tanase: 'Tanase',
  mitrita: 'Mitrita',
  cicaldau: 'Cicaldau',
  baluta: 'Baluta',
  sut: 'Sut',
  vatajelu: 'Vatajelu',
  rata: 'Rata'
});

function applyPlayerDiacritics(value) {
  let text = repairPlayerUnicode(value);
  if (!text) return '';
  const exact = PLAYER_NAME_EXACT[playerAsciiKey(text)];
  if (exact) text = exact;
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[łŁ]/g, m => m === 'Ł' ? 'L' : 'l')
    .replace(/[đĐ]/g, m => m === 'Đ' ? 'D' : 'd')
    .replace(/[øØ]/g, m => m === 'Ø' ? 'O' : 'o')
    .replace(/ß/g, 'ss').replace(/Æ/g, 'AE').replace(/æ/g, 'ae')
    .replace(/Œ/g, 'OE').replace(/œ/g, 'oe').normalize('NFC');
}

function playerNameScore(name) {
  const text = String(name || '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const initials = (text.match(/\b\p{L}\./gu) || []).length;
  return text.length + (parts.length >= 2 ? 20 : 0) - initials * 12;
}

function bestEventPlayer(event = {}) {
  const candidates = [
    event.fullName, event.displayName, event.playerName, event.PlayerName, event.Pnm,
    event.player?.fullName, event.player?.displayName, event.player?.name,
    event.person?.fullName, event.person?.displayName, event.person?.name,
    event.Player, event.player, event.Pn, event.Nm, event.name, event.person
  ].filter(value => typeof value === 'string' && value.trim()).map(value => repairPlayerUnicode(value));
  if (!candidates.length) return '';
  candidates.sort((a, b) => playerNameScore(b) - playerNameScore(a));
  return candidates[0];
}

function eventTextBlob(event = {}) {
  try { return JSON.stringify(event).toLowerCase(); }
  catch { return ''; }
}

function eventOwnGoal(event = {}) {
  const text = String(event.type || event.kind || event.label || event.detail || event.reason || event.note || event.goalType || event.code || '').toLowerCase();
  const blob = eventTextBlob(event);
  return !!(
    event.og === true || event.ownGoal === true || event.isOwnGoal === true ||
    /\bown[ _-]?goal\b|\bautogol\b|\böngól\b/.test(`${text} ${blob}`)
  );
}

function eventPenalty(event = {}) {
  const text = String(event.type || event.kind || event.label || event.detail || event.reason || event.note || event.goalType || event.code || '').toLowerCase();
  const blob = eventTextBlob(event);
  return !!(
    event.penalty === true || event.pen === true || event.pk === true || event.fromPenalty === true ||
    text === 'p' || text === 'pg' || text === 'pen' || text.includes('penalty') || text.includes('spot kick') ||
    /"(?:penalty|pen|pk|frompenalty)"\s*:\s*true/.test(blob)
  );
}

function initialToken(value) {
  const s = String(value || '').trim().replace(/[’'′]+$/g, '');
  return /^\p{L}\.?$/u.test(s) ? `${s.charAt(0).toUpperCase()}.` : '';
}

function normalizeFlashscorePlayerName(value) {
  let text = repairPlayerUnicode(value);
  let commaNormalized = false;
  if (!text) return '';
  if (text.includes(',')) {
    const chunks = text.split(',').map(x => repairPlayerUnicode(x)).filter(Boolean);
    if (chunks.length >= 2) {
      text = `${chunks.slice(1).join(' ')} ${chunks[0]}`;
      commaNormalized = true;
    }
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return applyPlayerDiacritics(text);
  const firstInitial = initialToken(parts[0]);
  const lastInitial = initialToken(parts[parts.length - 1]);
  if (commaNormalized) return applyPlayerDiacritics(firstInitial ? `${firstInitial} ${parts.slice(1).join(' ')}` : text);
  if (firstInitial) return applyPlayerDiacritics(`${firstInitial} ${parts.slice(1).join(' ')}`);
  if (lastInitial) return applyPlayerDiacritics(`${lastInitial} ${parts.slice(0, -1).join(' ')}`);
  return applyPlayerDiacritics(`${parts.slice(1).join(' ')} ${parts[0]}`);
}

function normalizedEventPlayer(event = {}, sourceHint = '') {
  const rawName = bestEventPlayer(event);
  if (!rawName) return '';
  const order = String(event.playerNameOrder || event.nameOrder || '').toLowerCase();
  const normalized = String(sourceHint || '').toLowerCase().includes('flashscore') && order !== 'given-first'
    ? normalizeFlashscorePlayerName(rawName)
    : rawName;
  return applyPlayerDiacritics(normalized);
}

function normalizeTeamSide(value, fixture) {
  const raw = String(value || '').trim().toLowerCase();
  if (['h', 'home', 'home_team', '1'].includes(raw)) return 'h';
  if (['a', 'away', 'away_team', '2'].includes(raw)) return 'a';
  if (fixture) {
    if (raw && raw === String(fixture.h).toLowerCase()) return 'h';
    if (raw && raw === String(fixture.a).toLowerCase()) return 'a';
  }
  return raw === 'away' ? 'a' : 'h';
}

function normalizeEvent(event, fixture, sourceHint = '') {
  return {
    team: normalizeTeamSide(event.team || event.side || event.teamSide || event.homeAway, fixture),
    minute: cleanEventMinute(event.minute || event.time || event.matchMinute || event.elapsed),
    player: normalizedEventPlayer(event, sourceHint),
    playerNameOrder: 'given-first',
    type: event.type || event.kind || event.goalType || null,
    label: event.label || event.detail || event.reason || event.note || null,
    og: eventOwnGoal(event),
    penalty: eventPenalty(event)
  };
}

function normalizeCard(event, fixture, sourceHint = '') {
  const type = String(event.type || event.card || event.eventType || event.kind || '').toLowerCase();
  return {
    team: normalizeTeamSide(event.team || event.side || event.teamSide || event.homeAway, fixture),
    minute: cleanEventMinute(event.minute || event.time || event.matchMinute || event.elapsed),
    player: normalizedEventPlayer(event, sourceHint),
    playerNameOrder: 'given-first',
    type: event.type || event.card || event.eventType || event.kind || null,
    red: !!(event.red || event.redCard || type.includes('red')),
    yellow: !!(event.yellow || type === 'yc' || type.includes('yellow')),
    yellowRed: !!(event.yellowRed || event.secondYellow || type.includes('second') || type.includes('yellow-red'))
  };
}

export function normalizeLiveMatch(id, raw, fixture = null, sourceMeta = {}) {
  if (!raw) return null;
  const homeScore = raw.h ?? raw.homeScore ?? raw.scoreHome ?? raw.home?.score ?? raw.home?.goals ?? raw.Tr1 ?? raw.tr1 ?? raw.home?.Tr1;
  const awayScore = raw.a ?? raw.awayScore ?? raw.scoreAway ?? raw.away?.score ?? raw.away?.goals ?? raw.Tr2 ?? raw.tr2 ?? raw.away?.Tr2;
  const pH = raw.pH ?? raw.homePenaltyScore ?? raw.penaltiesHome ?? raw.home?.penaltyScore ?? raw.Trp1 ?? raw.trp1;
  const pA = raw.pA ?? raw.awayPenaltyScore ?? raw.penaltiesAway ?? raw.away?.penaltyScore ?? raw.Trp2 ?? raw.trp2;
  const status = raw.status || raw.statusText || raw.matchStatus || raw.state || raw.Eps || raw.EpsL || raw.eventStatus || (raw.finished ? 'FT' : raw.started ? 'LIVE' : 'NS');
  const upper = String(status || '').trim().toUpperCase();
  const flashState = String(raw.flashscoreState || raw.feedState || '').trim().toLowerCase();
  const explicitPrematch = raw.prematch === true || flashState === 'prematch' || ['NS', 'NOT_STARTED', 'NOT STARTED', 'SCHEDULED', 'TIMED', 'PREMATCH', 'PRE_MATCH'].includes(upper);
  const isMinuteStatus = /^\d{1,3}(?:'|\+|$)/.test(String(status || '').trim());
  const finished = !explicitPrematch && (!!raw.finished || ['FT', 'AET', 'PEN', 'FULL_TIME', 'COMPLETE'].includes(upper));
  const started = !explicitPrematch && (
    !!raw.started || finished || isMinuteStatus ||
    ['LIVE', 'IN_PLAY', 'HT', '1H', '2H', 'ET'].includes(upper) ||
    validScore(homeScore) || validScore(awayScore)
  );
  const minute = explicitPrematch ? null : cleanMinute(raw.minute ?? raw.matchMinute ?? raw.elapsed ?? raw.currentMinute ?? raw.timePlayed ?? raw.EpsL ?? (isMinuteStatus ? status : null));
  const eventSourceHint = [raw.eventSource, raw.scoreSource, raw.source, sourceMeta.eventSource, sourceMeta.scoreSource, sourceMeta.source].filter(Boolean).join(' ');

  const scorers = [
    ...(raw.scorers || []),
    ...(raw.goals || []),
    ...(raw.events || []).filter(e => String(e.type || e.kind || '').toLowerCase().includes('goal'))
  ].map(e => normalizeEvent(e, fixture, eventSourceHint)).filter(e => e.player || e.minute);

  const allCards = [
    ...(raw.cards || []),
    ...(raw.redCards || []).map(c => ({ ...c, red: true })),
    ...(raw.yellowCards || []).map(c => ({ ...c, yellow: true })),
    ...(raw.doubleYellowCards || []).map(c => ({ ...c, yellowRed: true, red: true })),
    ...(raw.events || []).filter(e => /card|yellow|red/i.test(String(e.type || e.kind || e.eventType || '')))
  ].map(e => normalizeCard(e, fixture, eventSourceHint));

  const redCards = allCards.filter(c => c.red || c.yellowRed);
  const yellowCards = allCards.filter(c => c.yellow && !c.red && !c.yellowRed);
  const doubleYellowCards = allCards.filter(c => c.yellowRed);

  return {
    id,
    group: fixture?.g || raw.group || 'SL',
    round: fixture?.r ?? raw.round ?? null,
    homeTeam: fixture?.h || raw.homeTeam || raw.home?.name || null,
    awayTeam: fixture?.a || raw.awayTeam || raw.away?.name || null,
    date: fixture?.date || raw.date || null,
    time: fixture?.t || raw.time || null,
    started,
    finished,
    status,
    minute,
    h: !explicitPrematch && validScore(homeScore) ? Number(homeScore) : null,
    a: !explicitPrematch && validScore(awayScore) ? Number(awayScore) : null,
    pH: validScore(pH) ? Number(pH) : null,
    pA: validScore(pA) ? Number(pA) : null,
    scorers,
    redCards,
    yellowCards,
    doubleYellowCards,
    scoreSource: raw.scoreSource || sourceMeta.scoreSource || 'unknown',
    eventSource: raw.eventSource || sourceMeta.eventSource || null,
    source: raw.source || sourceMeta.source || 'superliga-worker',
    prematch: explicitPrematch,
    flashscoreState: raw.flashscoreState || null,
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}
