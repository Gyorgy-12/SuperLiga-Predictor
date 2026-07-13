const DEFAULT_TIMEOUT_MS = 9000;

const SOURCE_CATALOG = {
  official: [
    {
      id: 'superliga-home',
      family: 'official',
      tier: 'official-finalizer',
      url: 'https://www.superliga.ro/',
      notes: 'Official Superliga root probe.'
    },
    {
      id: 'superliga-fixtures',
      family: 'official',
      tier: 'official-finalizer',
      url: 'https://www.superliga.ro/program',
      notes: 'Possible official fixture/program page.'
    },
    {
      id: 'superliga-botosani-calendar',
      family: 'official',
      tier: 'official-finalizer',
      url: 'https://www.superliga.ro/cluburi/fc-botosani/calendar',
      notes: 'Known official club calendar shape.'
    },
    {
      id: 'superliga-fcsb-calendar',
      family: 'official',
      tier: 'official-finalizer',
      url: 'https://www.superliga.ro/cluburi/fcsb/calendar',
      notes: 'Official club calendar probe.'
    },
    {
      id: 'lpf-home',
      family: 'official',
      tier: 'official-finalizer',
      url: 'https://lpf.ro/',
      notes: 'LPF official site root probe.'
    },
    {
      id: 'lpf-round1-news',
      family: 'official',
      tier: 'official-fixture',
      url: 'https://lpf.ro/noutati/superliga-programul-primei-etape/6595',
      notes: 'LPF round 1 schedule article, useful as fixture validator.'
    }
  ],
  soccerway: [
    {
      id: 'soccerway-main',
      family: 'soccerway',
      tier: 'postmatch',
      url: 'https://www.soccerway.com/romania/superliga/',
      notes: 'Readable league-page text, no detail links yet.'
    },
    {
      id: 'soccerway-uk',
      family: 'soccerway',
      tier: 'postmatch',
      url: 'https://uk.soccerway.com/romania/superliga/',
      notes: 'Regional mirror.'
    },
    {
      id: 'soccerway-ng',
      family: 'soccerway',
      tier: 'postmatch',
      url: 'https://ng.soccerway.com/romania/superliga/',
      notes: 'Regional mirror.'
    }
  ],
  flashscore: [
    {
      id: 'flashscore-superliga',
      family: 'flashscore',
      tier: 'live-incidents-candidate',
      url: 'https://www.flashscore.com/football/romania/superliga/',
      notes: 'League page probe.'
    },
    {
      id: 'flashscore-fixtures',
      family: 'flashscore',
      tier: 'live-incidents-candidate',
      url: 'https://www.flashscore.com/football/romania/superliga/fixtures/',
      notes: 'Fixtures page probe.'
    },
    {
      id: 'flashscore-results',
      family: 'flashscore',
      tier: 'postmatch-candidate',
      url: 'https://www.flashscore.com/football/romania/superliga/results/',
      notes: 'Results page probe.'
    }
  ],
  soccer24: [
    {
      id: 'soccer24-superliga',
      family: 'soccer24',
      tier: 'live-incidents-candidate',
      url: 'https://www.soccer24.com/romania/superliga/',
      notes: 'Flashscore-family mirror probe.'
    },
    {
      id: 'soccer24-fixtures',
      family: 'soccer24',
      tier: 'live-incidents-candidate',
      url: 'https://www.soccer24.com/romania/superliga/fixtures/',
      notes: 'Fixtures mirror probe.'
    }
  ],
  besoccer: [
    {
      id: 'besoccer-liga-i',
      family: 'besoccer',
      tier: 'postmatch-candidate',
      url: 'https://www.besoccer.com/competition/liga_i',
      notes: 'BeSoccer Liga I competition probe.'
    },
    {
      id: 'besoccer-romanian-liga-i',
      family: 'besoccer',
      tier: 'postmatch-candidate',
      url: 'https://www.besoccer.com/competition/romanian_liga_i',
      notes: 'Alternative BeSoccer slug probe.'
    }
  ],
  aiscore: [
    {
      id: 'aiscore-search-superliga',
      family: 'aiscore',
      tier: 'live-incidents-candidate',
      url: 'https://www.aiscore.com/search?q=Romania%20Liga%201',
      notes: 'Search page probe; exact competition slug may differ.'
    },
    {
      id: 'aiscore-search-superliga-ro',
      family: 'aiscore',
      tier: 'live-incidents-candidate',
      url: 'https://www.aiscore.com/search?q=Superliga%20Romania',
      notes: 'Search page probe.'
    }
  ],
  scores365: [
    {
      id: '365scores-search',
      family: '365scores',
      tier: 'live-incidents-candidate',
      url: 'https://www.365scores.com/search/football/superliga%20romania',
      notes: 'Search page probe; exact league id may differ.'
    }
  ],
  worldfootball: [
    {
      id: 'worldfootball-round1',
      family: 'worldfootball',
      tier: 'postmatch-finalizer',
      url: 'https://www.worldfootball.net/schedule/rou-liga-1-2026-2027-spieltag/1/',
      notes: 'Text-heavy schedule/results site; useful post-match.'
    },
    {
      id: 'worldfootball-results',
      family: 'worldfootball',
      tier: 'postmatch-finalizer',
      url: 'https://www.worldfootball.net/competition/rou-liga-1/',
      notes: 'Competition root probe.'
    }
  ],
  fctables: [
    {
      id: 'fctables-liga1',
      family: 'fctables',
      tier: 'postmatch-candidate',
      url: 'https://www.fctables.com/romania/liga-1/',
      notes: 'Alternative stats/results source.'
    }
  ]
};

export async function fetchIncidentDeepCandidates(env, fixtures = [], opts = {}) {
  const active = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length ? opts.activeFixtures : fixtures;
  const group = String(opts.group || opts.candidateGroup || opts.family || 'all').toLowerCase();
  const urlsFromEnv = splitList(env?.INCIDENT_DEEP_SCOUT_URLS).filter(isHttpUrl).map((url, index) => ({
    id: `custom-${index + 1}`,
    family: 'custom',
    tier: 'custom',
    url,
    notes: 'Custom URL from INCIDENT_DEEP_SCOUT_URLS'
  }));
  const urlParam = opts.url && isHttpUrl(opts.url) ? [{
    id: 'url-param',
    family: 'custom',
    tier: 'custom',
    url: opts.url,
    notes: 'Explicit url= query param'
  }] : [];

  let candidates = [];
  if (group === 'all' || group === '*') {
    for (const rows of Object.values(SOURCE_CATALOG)) candidates.push(...rows);
  } else {
    candidates.push(...(SOURCE_CATALOG[group] || []));
  }
  candidates.push(...urlsFromEnv, ...urlParam);
  candidates = dedupeCandidates(candidates);

  const limit = clampNumber(opts.candidateLimit || opts.probeLimit || 30, 1, 80);
  candidates = candidates.slice(0, limit);

  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const sampleChars = clampNumber(opts.sampleChars || opts.sample || 520, 120, 2400);
  const fixtureSignals = buildFixtureSignals(active);

  const results = [];
  for (const candidate of candidates) {
    const report = await probeCandidate(candidate, fixtureSignals, { timeoutMs, sampleChars, showBody: opts.showBody });
    results.push(report);
  }

  const best = [...results]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 12);

  return {
    ok: true,
    source: 'incident-deep-candidates',
    warning: 'Read-only probe only. It does not bypass login, paywalls, CAPTCHAs, cookies, anti-bot systems, or technical restrictions.',
    group,
    candidateCount: candidates.length,
    activeFixtureCount: active.length,
    best: best.map(minifyResult),
    results,
    nextSteps: buildNextSteps(best),
    updatedAt: new Date().toISOString()
  };
}

async function probeCandidate(candidate, fixtureSignals, opts) {
  const started = Date.now();
  let status = null;
  let contentType = null;
  let finalUrl = candidate.url;
  let text = '';
  let error = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), opts.timeoutMs);
    try {
      const response = await fetch(candidate.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: makeHeaders(candidate.url)
      });
      status = response.status;
      contentType = response.headers.get('content-type') || '';
      finalUrl = response.url || candidate.url;
      text = await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    error = e?.message || String(e);
  }

  const normalized = normalizeText(text);
  const signals = detectSignals(normalized, contentType, status, error);
  const fixtureMatches = matchFixtures(fixtureSignals.fixtures, normalized);
  const links = extractInterestingLinks(text, finalUrl).slice(0, 80);
  const linkFixtureMatches = matchLinksToFixtures(links, fixtureSignals.fixtures);
  const score = scoreCandidate(signals, fixtureMatches, linkFixtureMatches, links, text.length);

  return {
    id: candidate.id,
    family: candidate.family,
    tier: candidate.tier,
    url: candidate.url,
    notes: candidate.notes,
    ok: status >= 200 && status < 300 && !signals.hardBlocked,
    status,
    finalUrl,
    contentType,
    elapsedMs: Date.now() - started,
    bytes: text.length,
    score,
    signals,
    matchedFixtures: fixtureMatches.slice(0, 12),
    linkFixtureMatches: linkFixtureMatches.slice(0, 12),
    interestingLinks: links.slice(0, 20),
    sample: makeSample(text, opts.sampleChars),
    body: opts.showBody ? text.slice(0, 20000) : undefined,
    error
  };
}

function makeHeaders(url) {
  const u = new URL(url);
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: `${u.protocol}//${u.host}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  };
}

function detectSignals(normalized, contentType, status, error) {
  const html = String(contentType || '').includes('html') || normalized.includes('<html') || normalized.includes('<!doctype');
  const json = String(contentType || '').includes('json') || normalized.trim().startsWith('{') || normalized.trim().startsWith('[');
  const hardBlocked = /captcha|access denied|forbidden|blocked|cloudflare|attention required|enable javascript|checking your browser|akamai|distil/i.test(normalized);
  return {
    httpOk: status >= 200 && status < 300,
    html,
    json,
    hardBlocked,
    errored: !!error,
    hasRomania: /romania|romanian|superliga|liga i|liga 1|lpf/i.test(normalized),
    hasFixtureWords: /fixtures|results|schedule|program|meciuri|calendar|etapa/i.test(normalized),
    hasMatchDetailWords: /match page|match details|report|raport|line[- ]?ups?|echipe|statistics|summary/i.test(normalized),
    hasGoalWords: /goal|goals|scorer|scorers|marcator|marcatori|goluri/i.test(normalized),
    hasCardWords: /yellow|red card|cards|cartona|cartonas|cartonaș/i.test(normalized),
    hasIncidentWords: /substitution|substitutions|cards|goals|lineups|timeline|commentary|events/i.test(normalized),
    hasOddsWords: /odds|pariuri|cote/i.test(normalized)
  };
}

function scoreCandidate(signals, fixtureMatches, linkFixtureMatches, links, bytes) {
  let score = 0;
  if (signals.httpOk) score += 12;
  if (bytes > 1000) score += 8;
  if (bytes > 50000) score += 8;
  if (signals.hasRomania) score += 12;
  if (signals.hasFixtureWords) score += 10;
  if (signals.hasMatchDetailWords) score += 10;
  if (signals.hasGoalWords) score += 8;
  if (signals.hasCardWords) score += 8;
  if (signals.hasIncidentWords) score += 10;
  score += Math.min(24, fixtureMatches.length * 4);
  score += Math.min(24, linkFixtureMatches.length * 8);
  score += Math.min(12, links.length * 2);
  if (signals.hardBlocked) score -= 15;
  if (signals.errored) score -= 25;
  return Math.max(0, score);
}

function buildFixtureSignals(fixtures) {
  return { fixtures: (fixtures || []).map(f => ({
    id: String(f.id || ''),
    date: String(f.date || '').slice(0, 10),
    h: f.h || f.homeTeam || '',
    a: f.a || f.awayTeam || '',
    homeTokens: teamTokens(f.h || f.homeTeam || ''),
    awayTokens: teamTokens(f.a || f.awayTeam || '')
  })) };
}

function teamTokens(name) {
  const n = normalizeTeam(name);
  const tokens = new Set();
  if (n) tokens.add(n);
  for (const part of n.split(/\s+/).filter(x => x.length >= 3)) tokens.add(part);
  const aliases = {
    'fc botosani': ['botosani'],
    'fc voluntari': ['voluntari'],
    'fc arges': ['arges', 'fc arges', 'arges pitesti'],
    'fcsb': ['fcsb', 'steaua'],
    'otelul galati': ['otelul', 'otelul galati'],
    'cfr cluj': ['cfr', 'cfr cluj', 'cluj'],
    'universitatea craiova': ['univ craiova', 'u craiova', 'craiova'],
    'uta arad': ['uta', 'uta arad', 'arad'],
    'universitatea cluj': ['u cluj', 'universitatea cluj', 'cluj'],
    'farul constanta': ['farul', 'farul constanta', 'constanta'],
    'petrolul ploiesti': ['petrolul', 'petrolul ploiesti'],
    'dinamo': ['dinamo', 'dinamo bucuresti'],
    'corvinul hunedoara': ['corvinul', 'hunedoara'],
    'csikszereda': ['csikszereda', 'miercurea ciuc', 'csikszereda m ciuc'],
    'rapid bucuresti': ['rapid', 'rapid bucuresti', 'fc rapid'],
    'sepsi osk': ['sepsi', 'sepsi osk', 'sepsi sf gheorghe']
  };
  for (const [key, arr] of Object.entries(aliases)) {
    if (n.includes(key) || key.includes(n)) for (const a of arr) tokens.add(normalizeTeam(a));
  }
  return [...tokens].filter(Boolean).sort((a, b) => b.length - a.length);
}

function matchFixtures(fixtures, normalized) {
  const out = [];
  for (const f of fixtures || []) {
    const ht = firstTokenHit(normalized, f.homeTokens);
    const at = firstTokenHit(normalized, f.awayTokens);
    if (ht && at) {
      const distance = Math.abs(normalized.indexOf(ht) - normalized.indexOf(at));
      out.push({ id: f.id, date: f.date, h: f.h, a: f.a, matchedHomeToken: ht, matchedAwayToken: at, distance });
    }
  }
  return out;
}

function matchLinksToFixtures(links, fixtures) {
  const out = [];
  for (const link of links || []) {
    const hay = normalizeText(`${link.text || ''} ${link.url || ''} ${link.context || ''}`);
    for (const f of fixtures || []) {
      const ht = firstTokenHit(hay, f.homeTokens);
      const at = firstTokenHit(hay, f.awayTokens);
      if (ht && at) out.push({ id: f.id, date: f.date, h: f.h, a: f.a, url: link.url, text: link.text, score: link.score || 0 });
    }
  }
  return out;
}

function firstTokenHit(hay, tokens) {
  for (const t of tokens || []) if (t && hay.includes(t)) return t;
  return null;
}

function extractInterestingLinks(html, baseUrl) {
  const body = String(html || '');
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(body))) {
    const href = decodeHtml(m[1]);
    const text = normalizeSpaces(stripTags(decodeHtml(m[2] || '')));
    const url = absolutize(href, baseUrl);
    if (!url) continue;
    const hay = normalizeText(`${url} ${text}`);
    let score = 0;
    if (/match|fixture|result|game|meci|raport|program|event|summary|details|live/.test(hay)) score += 8;
    if (/superliga|romania|liga|botosani|fcsb|arges|voluntari|cfr|cluj|farul|dinamo|rapid|sepsi|craiova|arad|otelul|petrolul|corvinul|csikszereda/.test(hay)) score += 10;
    if (/\/(matches|match|game|event|fixture|meci|raport|summary|live)\//i.test(url)) score += 10;
    if (score <= 0) continue;
    out.push({ url, text, score, context: makeContext(body, m.index, 280) });
  }

  const urlRe = /https?:\/\/[^"'<>\s]+|\/(?:matches|match|game|event|fixture|meci|raport|summary|live)\/[^"'<>\s]+/gi;
  while ((m = urlRe.exec(body))) {
    const url = absolutize(decodeHtml(m[0]), baseUrl);
    if (!url) continue;
    out.push({ url, text: '', score: 6, context: makeContext(body, m.index, 280) });
  }

  const seen = new Set();
  return out.filter(l => {
    const key = l.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function minifyResult(r) {
  return {
    id: r.id,
    family: r.family,
    tier: r.tier,
    url: r.url,
    ok: r.ok,
    status: r.status,
    contentType: r.contentType,
    bytes: r.bytes,
    score: r.score,
    signals: r.signals,
    matchedFixtures: r.matchedFixtures,
    linkFixtureMatches: r.linkFixtureMatches,
    interestingLinks: r.interestingLinks?.slice(0, 8) || [],
    sample: r.sample,
    error: r.error,
    notes: r.notes
  };
}

function buildNextSteps(best) {
  const steps = [];
  for (const r of best.slice(0, 6)) {
    if ((r.linkFixtureMatches || []).length) {
      steps.push(`${r.id}: has fixture-linked URLs. Next: build parser for ${r.family} detail pages.`);
    } else if ((r.matchedFixtures || []).length) {
      steps.push(`${r.id}: fixture text found but no exact detail links. Useful as fixture/final text fallback; try exact team page or post-match URL after kickoff.`);
    } else if (r.score >= 40) {
      steps.push(`${r.id}: readable candidate, but no fixture pair yet. Reprobe after matchday or with url= exact page.`);
    }
  }
  if (!steps.length) steps.push('No strong source found in this group. Try group=official, group=flashscore, group=worldfootball, or url=EXACT_PAGE.');
  return steps;
}

function dedupeCandidates(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const key = String(r.url || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitList(v) {
  return String(v || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

function isHttpUrl(v) {
  return /^https?:\/\//i.test(String(v || ''));
}

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeText(v) {
  return decodeHtml(stripTags(String(v || '')))
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^a-z0-9\-\.\/\s:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeam(v) {
  return normalizeText(v)
    .replace(/\b(fc|sc|afc|acs|csm|osk|cf|cs|universitatea)\b/g, m => m)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpaces(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function stripTags(v) {
  return String(v || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function makeSample(text, chars) {
  return normalizeSpaces(stripTags(decodeHtml(String(text || '').slice(0, chars * 6)))).slice(0, chars);
}

function makeContext(body, index, width) {
  const start = Math.max(0, Number(index || 0) - width);
  const end = Math.min(String(body || '').length, Number(index || 0) + width);
  return makeSample(String(body || '').slice(start, end), width * 2);
}

function absolutize(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) return null;
  try {
    return new URL(raw, baseUrl).toString();
  } catch (_) {
    return null;
  }
}
