const DEFAULT_TIMEOUT_MS = 8500;
const DEFAULT_SAMPLE_CHARS = 520;

const SOURCE_CANDIDATES = [
  {
    id: 'official-lpf-league',
    family: 'official',
    tier: 'finalizer',
    url: 'https://lpf.ro/liga-1',
    notes: 'Official LPF league page. Good for fixtures/results; may be useful as post-match verification.'
  },
  {
    id: 'official-superliga-home',
    family: 'official',
    tier: 'finalizer',
    url: 'https://www.superliga.ro/',
    notes: 'Official SuperLiga site. Good for official season stats and final verification.'
  },
  {
    id: 'official-superliga-matches',
    family: 'official',
    tier: 'finalizer',
    url: 'https://www.superliga.ro/meciuri',
    notes: 'Official SuperLiga matches page candidate.'
  },
  {
    id: 'official-superliga-stats',
    family: 'official',
    tier: 'stats',
    url: 'https://www.superliga.ro/statistici',
    notes: 'Official SuperLiga aggregate stats. Not match events, but useful sanity check.'
  },
  {
    id: 'official-superliga-player-stats',
    family: 'official',
    tier: 'stats',
    url: 'https://www.superliga.ro/statistici/jucatori',
    notes: 'Official SuperLiga player stats. Good for post-round scorer/card consistency checks.'
  },

  {
    id: 'soccerway-main',
    family: 'soccerway',
    tier: 'postmatch',
    url: 'https://www.soccerway.com/romania/superliga/',
    notes: 'Soccerway often exposes fixture pages and post-match goals/cards/substitutions in HTML.'
  },
  {
    id: 'soccerway-uk',
    family: 'soccerway',
    tier: 'postmatch',
    url: 'https://uk.soccerway.com/romania/superliga/',
    notes: 'Regional Soccerway mirror; useful if main host blocks or redirects.'
  },
  {
    id: 'soccerway-ng',
    family: 'soccerway',
    tier: 'postmatch',
    url: 'https://ng.soccerway.com/romania/superliga/',
    notes: 'Regional Soccerway mirror; useful if main host blocks or redirects.'
  },
  {
    id: 'soccerway-fc-botosani',
    family: 'soccerway',
    tier: 'postmatch',
    url: 'https://www.soccerway.com/team/fc-botosani/GjY1JjUS/',
    notes: 'Team page probe; search engines expose this for FC Botosani fixtures/results.'
  },

  {
    id: 'flashscore-league',
    family: 'flashscore',
    tier: 'live-or-postmatch',
    url: 'https://www.flashscore.com/football/romania/superliga/',
    notes: 'Flashscore advertises goal scorers/red cards; Worker fetch may be JS-heavy or protected.'
  },
  {
    id: 'flashscore-info-league',
    family: 'flashscore',
    tier: 'live-or-postmatch',
    url: 'https://www.flashscore.info/football/romania/superliga/',
    notes: 'Flashscore mirror candidate.'
  },
  {
    id: 'flashscore-fc-botosani',
    family: 'flashscore',
    tier: 'live-or-postmatch',
    url: 'https://www.flashscore.com/team/fc-botosani/GjY1JjUS/',
    notes: 'Team page probe; can lead to match details if HTML/XHR is accessible.'
  },
  {
    id: 'soccer24-league',
    family: 'flashscore-network',
    tier: 'live-or-postmatch',
    url: 'https://www.soccer24.com/romania/superliga/',
    notes: 'Flashscore-network site; same data family, sometimes easier/harder depending on host.'
  },

  {
    id: 'besoccer-2027',
    family: 'besoccer',
    tier: 'postmatch-or-stats',
    url: 'https://www.besoccer.com/competition/info/liga_i_romania/2027',
    notes: 'BeSoccer season endpoint style; 2027 should map to 2026/27 season if available.'
  },
  {
    id: 'besoccer-table-2027',
    family: 'besoccer',
    tier: 'postmatch-or-stats',
    url: 'https://www.besoccer.com/competition/table/liga_i_romania/2027/groupall',
    notes: 'BeSoccer table/fixtures probe.'
  },

  {
    id: 'aiscore-fc-botosani',
    family: 'aiscore',
    tier: 'live-or-postmatch',
    url: 'https://m.aiscore.com/team-fc-botosani/o17pji0ywns27jw/matches',
    notes: 'Mobile AiScore team matches page; often more static than desktop.'
  },
  {
    id: 'aiscore-yellow-cards',
    family: 'aiscore',
    tier: 'aggregate-stats',
    url: 'https://m.aiscore.com/tournament-1.-liga/9oj7x9izyce7g3y/teamyellowcards',
    notes: 'AiScore aggregate yellow-card stats probe; not per-match, but useful sanity check.'
  },

  {
    id: '365scores-fc-botosani',
    family: '365scores',
    tier: 'live-or-postmatch',
    url: 'https://www.365scores.com/football/team/fc-botosani-12365/matches',
    notes: '365Scores team matches page; may expose fixtures/results in HTML.'
  }
];

export async function fetchIncidentSourceCandidates(env, fixtures = [], opts = {}) {
  const group = String(opts.group || opts.candidateGroup || opts.family || '').trim().toLowerCase();
  const limit = clampNumber(opts.limit || opts.candidateLimit || 0, 0, 50);
  const sampleChars = clampNumber(opts.sampleChars || opts.sample || DEFAULT_SAMPLE_CHARS, 80, 2200);
  const showBody = opts.showBody === true || String(opts.showBody || '') === '1';
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SOURCE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1000, 20000);

  const active = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length ? opts.activeFixtures : fixtures;
  const fixtureSignals = buildFixtureSignals(active || []);
  const envExtraUrls = splitExtraUrls(env?.INCIDENT_SOURCE_CANDIDATE_URLS);
  const explicitUrl = opts.url ? [String(opts.url)] : [];

  let candidates = [...SOURCE_CANDIDATES];
  for (const [idx, url] of [...explicitUrl, ...envExtraUrls].entries()) {
    candidates.unshift({
      id: idx === 0 && explicitUrl.length ? 'explicit-url' : `env-extra-${idx + 1}`,
      family: 'custom',
      tier: 'custom',
      url,
      notes: 'Custom candidate URL from query/env.'
    });
  }

  if (group) {
    candidates = candidates.filter(c => {
      const hay = `${c.id} ${c.family} ${c.tier}`.toLowerCase();
      return hay.includes(group);
    });
  }
  if (limit > 0) candidates = candidates.slice(0, limit);

  const results = [];
  for (const candidate of candidates) {
    const probe = await probeCandidate(candidate, fixtureSignals, { timeoutMs, sampleChars, showBody });
    results.push(probe);
  }

  const ranked = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));
  return {
    ok: true,
    source: 'incidents-source-candidates',
    warning: 'This is a read-only source scout. It does not bypass logins, cookies, paywalls, CAPTCHAs, or anti-bot systems.',
    group: group || null,
    candidateCount: candidates.length,
    fixtureSignalCount: fixtureSignals.tokens.length,
    activeFixtureCount: active.length,
    best: ranked.slice(0, 8).map(compactProbe),
    results,
    nextSteps: buildNextSteps(ranked),
    updatedAt: new Date().toISOString()
  };
}

async function probeCandidate(candidate, fixtureSignals, opts) {
  const started = Date.now();
  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'accept-language': 'en-US,en;q=0.9,ro;q=0.7,hu;q=0.6',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'cache-control': 'no-cache',
    'pragma': 'no-cache'
  };

  const report = {
    ...candidate,
    ok: false,
    status: null,
    finalUrl: candidate.url,
    contentType: null,
    elapsedMs: null,
    bytes: 0,
    score: 0,
    signals: {},
    matchedTokens: [],
    matchedFixtures: [],
    sample: null,
    error: null
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs);
  try {
    const response = await fetch(candidate.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    report.status = response.status;
    report.finalUrl = response.url || candidate.url;
    report.contentType = response.headers.get('content-type') || null;
    const text = await response.text();
    report.bytes = text.length;
    report.sample = makeSample(text, opts.sampleChars);
    const scored = scoreText(text, response, fixtureSignals, candidate);
    report.ok = scored.accessible;
    report.score = scored.score;
    report.signals = scored.signals;
    report.matchedTokens = scored.matchedTokens;
    report.matchedFixtures = scored.matchedFixtures;
    if (!opts.showBody) report.sample = report.sample?.slice(0, 420) || null;
  } catch (error) {
    report.error = error?.message || String(error);
    report.score = 0;
  } finally {
    clearTimeout(timeout);
    report.elapsedMs = Date.now() - started;
  }
  return report;
}

function scoreText(text, response, fixtureSignals, candidate) {
  const body = String(text || '');
  const norm = normalize(body);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const accessible = response.ok && body.length > 200 && !looksBlocked(norm);

  const signals = {
    httpOk: response.ok,
    html: contentType.includes('html'),
    json: contentType.includes('json') || startsJson(body),
    blocked: looksBlocked(norm),
    hasRomania: includesAny(norm, ['romania', 'romanian', 'rumanien', 'superliga', 'liga i', 'liga 1']),
    hasGoalWords: includesAny(norm, ['goal scorers', 'goalscorers', 'goal scorer', 'goals', 'goluri', 'marcatori', 'scorers']),
    hasCardWords: includesAny(norm, ['yellow card', 'red card', 'cards', 'cartonase', 'cartonașe', 'cartonas', 'cartonaş', 'suspensions']),
    hasMatchDetailWords: includesAny(norm, ['match details', 'match report', 'line-ups', 'lineups', 'substitutions', 'statistics', 'odds comparison']),
    hasFixturesWords: includesAny(norm, ['fixtures', 'schedule', 'program', 'meciuri', 'results', 'rezultate']),
    hasStaticFixtureDate: includesAny(norm, fixtureSignals.dates),
    hasAnyTeamToken: false,
    hasAnyFixturePair: false
  };

  const matchedTokens = [];
  for (const token of fixtureSignals.tokens) {
    if (token.length >= 4 && norm.includes(token)) matchedTokens.push(token);
    if (matchedTokens.length >= 20) break;
  }
  signals.hasAnyTeamToken = matchedTokens.length > 0;

  const matchedFixtures = [];
  for (const fx of fixtureSignals.fixtures) {
    const homeHit = fx.homeTokens.some(t => t.length >= 4 && norm.includes(t));
    const awayHit = fx.awayTokens.some(t => t.length >= 4 && norm.includes(t));
    if (homeHit && awayHit) {
      matchedFixtures.push({ id: fx.id, date: fx.date, h: fx.h, a: fx.a });
    }
    if (matchedFixtures.length >= 10) break;
  }
  signals.hasAnyFixturePair = matchedFixtures.length > 0;

  let score = 0;
  if (response.ok) score += 20;
  if (signals.html || signals.json) score += 5;
  if (signals.hasRomania) score += 12;
  if (signals.hasFixturesWords) score += 8;
  if (signals.hasGoalWords) score += 10;
  if (signals.hasCardWords) score += 12;
  if (signals.hasMatchDetailWords) score += 10;
  if (signals.hasAnyTeamToken) score += Math.min(10, matchedTokens.length);
  if (signals.hasAnyFixturePair) score += 18;
  if (signals.hasStaticFixtureDate) score += 6;
  if (signals.blocked) score -= 30;
  if (!response.ok) score -= 10;
  if (body.length < 200) score -= 8;

  if (candidate.family === 'official' && signals.hasRomania) score += 3;
  if (candidate.family === 'soccerway' && (signals.hasMatchDetailWords || signals.hasAnyFixturePair)) score += 5;
  if (candidate.family === 'flashscore' && signals.hasGoalWords && signals.hasCardWords) score += 5;

  return {
    accessible,
    score: Math.max(0, Math.round(score)),
    signals,
    matchedTokens,
    matchedFixtures
  };
}

function buildFixtureSignals(fixtures) {
  const fx = [];
  const tokenSet = new Set();
  const dateSet = new Set();

  for (const f of fixtures || []) {
    const h = f.h || f.homeTeam || '';
    const a = f.a || f.awayTeam || '';
    const date = String(f.date || '').slice(0, 10);
    const homeTokens = teamTokens(h);
    const awayTokens = teamTokens(a);
    for (const token of [...homeTokens, ...awayTokens]) tokenSet.add(token);
    if (date) {
      dateSet.add(date);
      dateSet.add(date.replaceAll('-', '/'));
      const [y, m, d] = date.split('-');
      if (y && m && d) {
        dateSet.add(`${d}.${m}.${y}`);
        dateSet.add(`${d}/${m}/${y}`);
        dateSet.add(`${Number(d)}/${Number(m)}/${y}`);
      }
    }
    fx.push({ id: f.id, date, h, a, homeTokens, awayTokens });
  }

  return {
    fixtures: fx,
    tokens: [...tokenSet].filter(Boolean).slice(0, 80),
    dates: [...dateSet].filter(Boolean).slice(0, 40)
  };
}

function teamTokens(name) {
  const n = normalize(name);
  const cleaned = n
    .replace(/\b(fc|sc|acs|asc|afc|csm|cs|osk|cfr|fk|as)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter(x => x.length >= 3);
  const out = new Set([n, cleaned, ...parts]);
  const aliases = {
    'fc botosani': ['botosani'],
    'fc argeș': ['arges', 'arges pitesti', 'champions fc arges'],
    'fc arges': ['arges', 'arges pitesti', 'champions fc arges'],
    'otelul galati': ['otelul', 'galati'],
    'oțelul galați': ['otelul', 'galati'],
    'universitatea craiova': ['u craiova', 'cs universitatea craiova', 'craiova'],
    'universitatea cluj': ['u cluj', 'cluj'],
    'farul constanta': ['farul', 'constanta', 'fcv farul'],
    'farul constanța': ['farul', 'constanta', 'fcv farul'],
    'petrolul ploiesti': ['petrolul', 'ploiesti'],
    'petrolul ploiești': ['petrolul', 'ploiesti'],
    'dinamo': ['dinamo bucuresti'],
    'csikszereda': ['miercurea ciuc', 'fk csikszereda', 'csikszereda miercurea ciuc'],
    'rapid bucuresti': ['rapid', 'fc rapid 1923'],
    'sepsi osk': ['sepsi', 'sfantu gheorghe', 'sf gheorghe']
  };
  for (const [key, vals] of Object.entries(aliases)) {
    if (n.includes(normalize(key)) || cleaned.includes(normalize(key))) {
      for (const v of vals) out.add(normalize(v));
    }
  }
  return [...out].filter(x => x && x.length >= 3);
}

function buildNextSteps(ranked) {
  const best = ranked.filter(r => r.score >= 45).slice(0, 4);
  if (!best.length) {
    return [
      'No strong Worker-readable candidate yet. Try source=candidates&group=soccerway, source=candidates&group=flashscore, or a specific url=... probe.',
      'If only official aggregate pages work, use them as finalizers while LiveScore remains the live score source.'
    ];
  }
  return best.map(r => `${r.id}: score ${r.score}. Next probe should target exact match-detail URLs from this family.`);
}

function compactProbe(r) {
  return {
    id: r.id,
    family: r.family,
    tier: r.tier,
    url: r.url,
    ok: r.ok,
    status: r.status,
    contentType: r.contentType,
    score: r.score,
    signals: r.signals,
    matchedFixtures: r.matchedFixtures,
    notes: r.notes
  };
}

function splitExtraUrls(value) {
  return String(value || '')
    .split(/[\n|,]+/)
    .map(x => x.trim())
    .filter(x => /^https?:\/\//i.test(x));
}

function makeSample(text, maxChars) {
  const body = String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, maxChars);
}

function looksBlocked(norm) {
  return includesAny(norm, [
    'captcha',
    'access denied',
    'just a moment',
    'cloudflare ray id',
    'enable javascript',
    'checking your browser',
    'blocked',
    'forbidden'
  ]);
}

function includesAny(haystack, needles) {
  return (needles || []).some(n => n && haystack.includes(normalize(n)));
}

function startsJson(text) {
  const t = String(text || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ș/g, 's')
    .replace(/ţ/g, 't')
    .replace(/ț/g, 't')
    .replace(/ă/g, 'a')
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/[^a-z0-9/.: -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
