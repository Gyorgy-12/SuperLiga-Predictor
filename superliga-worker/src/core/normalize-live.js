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

function normalizeEvent(event, fixture) {
  return {
    team: normalizeTeamSide(event.team || event.side || event.teamSide || event.homeAway, fixture),
    minute: cleanMinute(event.minute || event.time || event.matchMinute || event.elapsed),
    player: event.player || event.playerName || event.name || event.person || '',
    og: !!(event.og || event.ownGoal),
    penalty: !!(event.penalty || event.pen)
  };
}

function normalizeCard(event, fixture) {
  const type = String(event.type || event.card || event.eventType || event.kind || '').toLowerCase();
  return {
    team: normalizeTeamSide(event.team || event.side || event.teamSide || event.homeAway, fixture),
    minute: cleanMinute(event.minute || event.time || event.matchMinute || event.elapsed),
    player: event.player || event.playerName || event.name || event.person || '',
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
  const upper = String(status || '').toUpperCase();
  const isMinuteStatus = /^\d{1,3}(?:'|\+|$)/.test(String(status || '').trim());
  const started = !!raw.started || validScore(homeScore) || isMinuteStatus || ['LIVE', 'IN_PLAY', 'HT', '1H', '2H', 'FT', 'AET', 'PEN', 'FULL_TIME', 'COMPLETE'].includes(upper);
  const finished = !!raw.finished || ['FT', 'AET', 'PEN', 'FULL_TIME', 'COMPLETE'].includes(upper);
  const minute = cleanMinute(raw.minute ?? raw.matchMinute ?? raw.elapsed ?? raw.currentMinute ?? raw.timePlayed ?? raw.EpsL ?? (isMinuteStatus ? status : null));

  const scorers = [
    ...(raw.scorers || []),
    ...(raw.goals || []),
    ...(raw.events || []).filter(e => String(e.type || e.kind || '').toLowerCase().includes('goal'))
  ].map(e => normalizeEvent(e, fixture)).filter(e => e.player || e.minute);

  const allCards = [
    ...(raw.cards || []),
    ...(raw.redCards || []).map(c => ({ ...c, red: true })),
    ...(raw.yellowCards || []).map(c => ({ ...c, yellow: true })),
    ...(raw.doubleYellowCards || []).map(c => ({ ...c, yellowRed: true, red: true })),
    ...(raw.events || []).filter(e => /card|yellow|red/i.test(String(e.type || e.kind || e.eventType || '')))
  ].map(e => normalizeCard(e, fixture));

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
    h: validScore(homeScore) ? Number(homeScore) : null,
    a: validScore(awayScore) ? Number(awayScore) : null,
    pH: validScore(pH) ? Number(pH) : null,
    pA: validScore(pA) ? Number(pA) : null,
    scorers,
    redCards,
    yellowCards,
    doubleYellowCards,
    scoreSource: raw.scoreSource || sourceMeta.scoreSource || 'unknown',
    eventSource: raw.eventSource || sourceMeta.eventSource || null,
    source: raw.source || sourceMeta.source || 'superliga-worker',
    odds: raw.odds || null,
    modelSnapshot: raw.modelSnapshot || null,
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}
