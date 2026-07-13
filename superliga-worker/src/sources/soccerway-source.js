const DEFAULT_BASES = [
  'https://www.soccerway.com',
  'https://uk.soccerway.com',
  'https://ng.soccerway.com'
];

const DEFAULT_LEAGUE_PATH = '/romania/superliga/';
const DEFAULT_TIMEOUT_MS = 9000;

export async function fetchSoccerwayEvents(env, fixtures = [], opts = {}) {
  const bases = unique([
    opts.baseUrl,
    env?.SOCCERWAY_BASE_URL,
    ...splitList(env?.SOCCERWAY_BASE_URLS),
    ...DEFAULT_BASES
  ].filter(Boolean).map(normalizeBase));

  const explicitUrls = unique([
    opts.url,
    opts.soccerwayUrl,
    ...splitList(env?.SOCCERWAY_URLS),
    ...splitList(env?.INCIDENT_SOURCE_CANDIDATE_URLS)
  ].filter(Boolean).filter(isHttpUrl));

  const urls = explicitUrls.length
    ? explicitUrls
    : buildSoccerwayUrls(bases, env, opts);

  const timeoutMs = clampNumber(opts.timeoutMs || env?.SOCCERWAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1200, 20000);
  const active = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length ? opts.activeFixtures : fixtures;
  const fixtureSignals = buildFixtureSignals(active);

  const pageReports = [];
  const allLinks = [];
  const allFixtureSnippets = [];

  for (const url of urls) {
    const page = await fetchSoccerwayPage(url, { timeoutMs, userAgent: opts.userAgent || env?.SOCCERWAY_USER_AGENT });
    const readable = page.readable || (Number(page.status || 0) >= 200 && Number(page.status || 0) < 300 && Number(page.bytes || 0) > 1000);
    const links = readable ? extractMatchLinks(page.text, page.finalUrl || url) : [];
    const fixtureSnippets = readable ? extractFixtureSnippets(page.text, fixtureSignals) : [];
    pageReports.push({
      url,
      finalUrl: page.finalUrl || url,
      ok: page.ok,
      readable,
      hardBlocked: !!page.hardBlocked,
      status: page.status,
      contentType: page.contentType,
      bytes: page.bytes,
      elapsedMs: page.elapsedMs,
      linkCount: links.length,
      fixtureSnippetCount: fixtureSnippets.length,
      sample: page.sample,
      error: page.error
    });
    for (const link of links) {
      allLinks.push({ ...link, origin: page.finalUrl || url });
    }
    for (const snippet of fixtureSnippets) {
      allFixtureSnippets.push({ ...snippet, origin: page.finalUrl || url });
    }
  }

  const uniqueLinks = dedupeLinks(allLinks);
  const matches = matchFixturesToLinks(active, uniqueLinks, fixtureSignals, opts);
  const matched = matches.filter(m => m.soccerwayUrl);
  const unmatched = matches.filter(m => !m.soccerwayUrl).map(m => ({
    id: m.id,
    date: m.date,
    h: m.h,
    a: m.a,
    bestScore: m.bestScore || 0,
    bestUrl: m.bestUrl || null,
    bestContext: m.bestContext || null
  }));

  const results = {};
  const includeIncidents = opts.includeIncidents === true || String(opts.incidents || '') === '1';
  const incidentDebug = [];

  if (includeIncidents) {
    const detailLimit = clampNumber(opts.detailLimit || opts.matchDetailLimit || env?.SOCCERWAY_DETAIL_LIMIT || 12, 0, 30);
    for (const row of matched.slice(0, detailLimit)) {
      const detail = await fetchSoccerwayMatchDetails(env, row.soccerwayUrl, opts);
      incidentDebug.push({
        id: row.id,
        soccerwayUrl: row.soccerwayUrl,
        ok: detail.ok,
        status: detail.status,
        incidentCount: detail.incidentCount || 0,
        scorerCount: detail.scorers?.length || 0,
        yellowCount: detail.yellowCards?.length || 0,
        redCount: detail.redCards?.length || 0,
        sample: detail.sample || null,
        warnings: detail.warnings || []
      });
      results[row.id] = normalizeSoccerwayLiveMatch(row.fixture, detail, row);
    }
  }

  for (const row of matched) {
    if (!results[row.id]) {
      results[row.id] = normalizeSoccerwayLiveMatch(row.fixture, null, row);
    }
  }

  return {
    ok: true,
    source: includeIncidents ? 'soccerway-incidents' : 'soccerway-fixture-links',
    bases,
    urls,
    rawPageCount: pageReports.length,
    rawMatchLinkCount: uniqueLinks.length,
    count: matched.length,
    results,
    matched: matched.map(row => ({
      id: row.id,
      date: row.date,
      h: row.h,
      a: row.a,
      soccerwayUrl: row.soccerwayUrl,
      soccerwayId: row.soccerwayId,
      origin: row.origin,
      score: row.score,
      rawText: row.rawText,
      rawContext: row.rawContext
    })),
    unmatched,
    pageReports,
    linkSample: uniqueLinks.slice(0, 30).map(l => ({ url: l.url, origin: l.origin, text: l.text, context: l.context.slice(0, 220) })),
    fixtureSnippetSample: allFixtureSnippets.slice(0, 20),
    incidentDebug,
    nextSteps: buildNextSteps(matched, uniqueLinks, pageReports, allFixtureSnippets),
    updatedAt: new Date().toISOString()
  };
}

export async function fetchSoccerwayMatchDetails(env, input, opts = {}) {
  const url = resolveSoccerwayDetailUrl(input, env, opts);
  if (!url) {
    return { ok: false, source: 'soccerway-match-details', error: 'missing soccerway match detail URL. Use soccerwayUrl=... or source=soccerway first.' };
  }

  const timeoutMs = clampNumber(opts.timeoutMs || env?.SOCCERWAY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1200, 20000);
  const page = await fetchSoccerwayPage(url, { timeoutMs, userAgent: opts.userAgent || env?.SOCCERWAY_USER_AGENT });
  if (!page.ok) {
    return {
      ok: false,
      source: 'soccerway-match-details',
      url,
      finalUrl: page.finalUrl || url,
      status: page.status,
      contentType: page.contentType,
      bytes: page.bytes,
      sample: page.sample,
      error: page.error,
      warnings: [`Soccerway detail page fetch failed with status ${page.status || 'unknown'}`]
    };
  }

  const parsed = parseSoccerwayDetail(page.text, page.finalUrl || url, opts);
  return {
    ok: true,
    source: 'soccerway-match-details',
    url,
    finalUrl: page.finalUrl || url,
    status: page.status,
    contentType: page.contentType,
    bytes: page.bytes,
    title: parsed.title,
    score: parsed.score,
    statusText: parsed.statusText,
    scorers: parsed.scorers,
    yellowCards: parsed.yellowCards,
    redCards: parsed.redCards,
    doubleYellowCards: parsed.doubleYellowCards,
    substitutions: parsed.substitutions,
    rawIncidents: parsed.rawIncidents,
    incidentCount: parsed.rawIncidents.length,
    sample: parsed.sample || page.sample,
    warnings: parsed.warnings,
    updatedAt: new Date().toISOString()
  };
}

function buildSoccerwayUrls(bases, env, opts) {
  const leaguePath = opts.leaguePath || env?.SOCCERWAY_LEAGUE_PATH || DEFAULT_LEAGUE_PATH;
  const out = [];
  for (const base of bases) out.push(joinUrl(base, leaguePath));
  const teamUrls = splitList(env?.SOCCERWAY_TEAM_URLS).filter(isHttpUrl);
  out.push(...teamUrls);
  return unique(out);
}

async function fetchSoccerwayPage(url, opts = {}) {
  const started = Date.now();
  const headers = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'user-agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    const hardBlocked = looksHardBlocked(text);
    const readable = response.ok && text.length > 400;
    const ok = readable && !hardBlocked;
    return {
      ok,
      readable,
      hardBlocked,
      status: response.status,
      finalUrl: response.url || url,
      contentType,
      bytes: text.length,
      text,
      sample: makeSample(text, 520),
      elapsedMs: Date.now() - started,
      error: ok ? null : (hardBlocked ? 'blocked_markers_present_but_body_readable' : null)
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      contentType: null,
      bytes: 0,
      text: '',
      sample: null,
      elapsedMs: Date.now() - started,
      error: error?.message || String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractMatchLinks(html, baseUrl) {
  const body = String(html || '');
  const links = [];
  const patterns = [
    /href=["']([^"']*\/matches\/[^"']+)["']/gi,
    /(?:data-href|data-url|url)=["']([^"']*\/matches\/[^"']+)["']/gi,
    /(?:href|url|path)\?":\?"([^"]*\?\/matches\?\/[^"]+)\?"/gi,
    /((?:https?:)?\?\/\?\/(?:www\.|uk\.|ng\.)?soccerway\.com\?\/[^"'<>\s]*?\?\/matches\?\/[^"'<>\s]+)/gi,
    /((?:\?\/|\/)matches(?:\?\/|\/)[^"'<>\s]+)/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body))) {
      pushMatchLink(links, m[1], m.index, body, baseUrl);
    }
  }
  return links;
}

function pushMatchLink(links, rawHref, index, body, baseUrl) {
  let href = decodeHtml(String(rawHref || ''))
    .replace(/\\\//g, '/')
    .replace(/\\//g, '/')
    .replace(/^https?:\/\/[^/]*soccerway\.com/i, '')
    .trim();
  if (!href || !href.includes('/matches/')) return;
  href = href.replace(/[),.;]+$/g, '');
  const url = absolutizeUrl(href, baseUrl);
  if (!url || !url.includes('/matches/')) return;
  const start = Math.max(0, Number(index || 0) - 2200);
  const end = Math.min(body.length, Number(index || 0) + 2600);
  const contextHtml = body.slice(start, end);
  const text = makeSample(contextHtml, 560);
  links.push({
    url,
    soccerwayId: deriveSoccerwayId(url),
    origin: baseUrl,
    text,
    context: text,
    norm: normalize(`${url} ${text}`)
  });
}

function extractFixtureSnippets(html, fixtureSignals = []) {
  const signals = Array.isArray(fixtureSignals)
    ? fixtureSignals
    : (Array.isArray(fixtureSignals?.fixtures) ? fixtureSignals.fixtures : []);

  const rawText = decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  const normText = normalize(rawText);
  const snippets = [];

  for (const sig of signals) {
    if (!sig) continue;
    const hTokens = Array.isArray(sig.homeTokens) ? sig.homeTokens : [];
    const aTokens = Array.isArray(sig.awayTokens) ? sig.awayTokens : [];
    let best = null;
    for (const ht of hTokens) {
      const hi = normText.indexOf(ht);
      if (hi < 0) continue;
      for (const at of aTokens) {
        const ai = normText.indexOf(at, Math.max(0, hi - 900));
        if (ai < 0) continue;
        const distance = Math.abs(ai - hi);
        if (distance > 1400) continue;
        if (!best || distance < best.distance) best = { hi, ai, ht, at, distance };
      }
    }
    if (best) {
      const at = Math.max(0, Math.min(best.hi, best.ai) - 260);
      snippets.push({
        id: sig.id,
        date: sig.date,
        h: sig.h,
        a: sig.a,
        matchedHomeToken: best.ht,
        matchedAwayToken: best.at,
        distance: best.distance,
        snippet: rawText.slice(at, at + 720)
      });
    }
  }
  return snippets;
}

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links || []) {
    const key = normalizeUrlForDedupe(link.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function matchFixturesToLinks(fixtures, links, fixtureSignals, opts) {
  const threshold = clampNumber(opts.matchThreshold || opts.soccerwayMatchThreshold || 34, 10, 100);
  const out = [];
  const fxSignalsById = new Map(fixtureSignals.fixtures.map(f => [String(f.id), f]));

  for (const fixture of fixtures || []) {
    const signal = fxSignalsById.get(String(fixture.id)) || buildSingleFixtureSignal(fixture);
    let best = null;
    for (const link of links || []) {
      const scored = scoreLinkForFixture(link, signal);
      if (!best || scored.score > best.score) best = { ...scored, link };
    }

    const h = fixture.h || fixture.homeTeam || '';
    const a = fixture.a || fixture.awayTeam || '';
    const date = String(fixture.date || '').slice(0, 10);

    if (best && best.score >= threshold) {
      out.push({
        id: fixture.id,
        fixture,
        date,
        h,
        a,
        soccerwayUrl: best.link.url,
        soccerwayId: best.link.soccerwayId,
        origin: best.link.origin,
        score: best.score,
        rawText: best.link.text,
        rawContext: best.link.context
      });
    } else {
      out.push({
        id: fixture.id,
        fixture,
        date,
        h,
        a,
        soccerwayUrl: null,
        soccerwayId: null,
        bestScore: best?.score || 0,
        bestUrl: best?.link?.url || null,
        bestContext: best?.link?.context?.slice(0, 220) || null
      });
    }
  }
  return out;
}

function scoreLinkForFixture(link, fixtureSignal) {
  const hay = link.norm || normalize(`${link.url} ${link.context || ''}`);
  let score = 0;
  const homeHits = fixtureSignal.homeTokens.filter(t => t.length >= 4 && hay.includes(t));
  const awayHits = fixtureSignal.awayTokens.filter(t => t.length >= 4 && hay.includes(t));
  if (homeHits.length) score += 18 + Math.min(12, homeHits.length * 3);
  if (awayHits.length) score += 18 + Math.min(12, awayHits.length * 3);
  if (homeHits.length && awayHits.length) score += 20;
  for (const d of fixtureSignal.dateTokens) {
    if (d && hay.includes(normalize(d))) { score += 10; break; }
  }
  const date = fixtureSignal.date || '';
  if (date) {
    const [y, m, d] = date.split('-');
    if (y && m && d && link.url.includes(`/${y}/${m}/${d}/`)) score += 18;
    if (y && link.url.includes(`/${y}/`)) score += 4;
  }
  if (hay.includes('romania') || hay.includes('superliga') || hay.includes('liga i')) score += 5;
  return { score, homeHits, awayHits };
}

function normalizeSoccerwayLiveMatch(fixture, detail, row) {
  return {
    id: fixture.id,
    group: fixture.group || fixture.g || 'SL',
    round: fixture.r || fixture.round || null,
    homeTeam: fixture.h || fixture.homeTeam || row?.h || null,
    awayTeam: fixture.a || fixture.awayTeam || row?.a || null,
    date: fixture.date || null,
    time: fixture.t || fixture.time || null,
    started: false,
    finished: !!detail?.score,
    status: detail?.statusText || null,
    minute: null,
    h: detail?.score?.h ?? null,
    a: detail?.score?.a ?? null,
    pH: null,
    pA: null,
    scorers: detail?.scorers || [],
    yellowCards: detail?.yellowCards || [],
    redCards: detail?.redCards || [],
    doubleYellowCards: detail?.doubleYellowCards || [],
    substitutions: detail?.substitutions || [],
    soccerwayUrl: row?.soccerwayUrl || detail?.url || null,
    soccerwayId: row?.soccerwayId || null,
    scoreSource: detail?.score ? 'soccerway' : null,
    eventSource: 'soccerway',
    source: 'soccerway',
    updatedAt: new Date().toISOString()
  };
}

function parseSoccerwayDetail(html, url, opts = {}) {
  const body = String(html || '');
  const stripped = makeSample(body, 2000);
  const title = extractTitle(body);
  const score = extractLikelyScore(body, title, stripped);
  const statusText = extractStatusText(stripped);

  const fragments = extractIncidentFragments(body);
  const rawIncidents = [];
  const seen = new Set();
  for (const frag of fragments) {
    const parsed = parseIncidentFragment(frag);
    if (!parsed || !parsed.kind) continue;
    const key = `${parsed.kind}|${parsed.minute || ''}|${parsed.player || ''}|${parsed.raw.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rawIncidents.push(parsed);
  }

  const scorers = rawIncidents.filter(x => x.kind === 'goal' || x.kind === 'own-goal' || x.kind === 'penalty').map(toCardOrGoal);
  const yellowCards = rawIncidents.filter(x => x.kind === 'yellow-card').map(toCardOrGoal);
  const redCards = rawIncidents.filter(x => x.kind === 'red-card').map(toCardOrGoal);
  const doubleYellowCards = rawIncidents.filter(x => x.kind === 'second-yellow' || x.kind === 'double-yellow').map(toCardOrGoal);
  const substitutions = rawIncidents.filter(x => x.kind === 'substitution').map(toCardOrGoal);

  return {
    title,
    score,
    statusText,
    scorers,
    yellowCards,
    redCards,
    doubleYellowCards,
    substitutions,
    rawIncidents: rawIncidents.slice(0, 80),
    sample: stripped.slice(0, 700),
    warnings: rawIncidents.length
      ? []
      : ['No incident fragments parsed yet. This can be normal before kickoff, or the detail page may use JS/hidden markup.']
  };
}

function extractIncidentFragments(html) {
  const body = String(html || '');
  const fragments = [];

  const tagRe = /<(tr|li|div|span)[^>]*(?:class|title|alt)=["'][^"']*(?:goal|yellow|red|card|substitution|event|incident)[^"']*["'][^>]*>[\s\S]{0,2200}?(?:<\/\1>|$)/gi;
  let m;
  while ((m = tagRe.exec(body))) fragments.push(m[0]);

  const lower = body.toLowerCase();
  const words = ['yellow card', 'red card', 'second yellow', 'own goal', 'penalty', 'substitution', 'goal'];
  for (const word of words) {
    let idx = 0;
    while ((idx = lower.indexOf(word, idx)) >= 0) {
      fragments.push(body.slice(Math.max(0, idx - 650), Math.min(body.length, idx + 900)));
      idx += word.length;
      if (fragments.length > 220) break;
    }
  }

  return fragments.slice(0, 260);
}

function parseIncidentFragment(fragment) {
  const html = String(fragment || '');
  const text = makeSample(html, 520);
  const norm = normalize(`${html} ${text}`);
  let kind = null;
  if (includesAny(norm, ['second yellow', '2nd yellow', 'double yellow'])) kind = 'second-yellow';
  else if (includesAny(norm, ['red card', 'icon red', 'red-card', 'dismissal'])) kind = 'red-card';
  else if (includesAny(norm, ['yellow card', 'icon yellow', 'yellow-card'])) kind = 'yellow-card';
  else if (includesAny(norm, ['own goal', 'og'])) kind = 'own-goal';
  else if (includesAny(norm, ['penalty']) && includesAny(norm, ['goal', 'scored'])) kind = 'penalty';
  else if (includesAny(norm, ['substitution', 'substitute'])) kind = 'substitution';
  else if (includesAny(norm, ['goal', 'goalscorer', 'scored'])) kind = 'goal';
  if (!kind) return null;

  const minute = extractMinute(text) || extractMinute(html);
  const player = extractLikelyPlayer(text, kind);
  const team = inferSide(html, text);
  return {
    kind,
    minute,
    team,
    player,
    raw: text.slice(0, 360)
  };
}

function toCardOrGoal(item) {
  return {
    team: item.team || null,
    player: item.player || null,
    minute: item.minute || null,
    type: item.kind,
    raw: item.raw || null
  };
}

function extractMinute(text) {
  const t = decodeHtml(String(text || ''));
  const m = t.match(/(?:^|\D)(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*(?:'|′|’|&prime;|&#039;|min\b)/i);
  if (!m) return null;
  return m[2] ? `${Number(m[1])}+${Number(m[2])}` : Number(m[1]);
}

function extractLikelyPlayer(text, kind) {
  let t = decodeHtml(stripTags(String(text || '')))
    .replace(/\b(?:goal|own goal|penalty|yellow card|red card|second yellow|substitution|substitute|in|out|assist|scored|minute|min)\b/gi, ' ')
    .replace(/\b\d{1,3}(?:\+\d{1,2})?\s*(?:'|′|’|min)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chunks = t.split(/\s{2,}| - | \| |, /).map(x => x.trim()).filter(Boolean);
  const best = chunks.find(x => /[A-Za-zÀ-ž]{3,}\s+[A-Za-zÀ-ž]{2,}/.test(x)) || chunks.find(x => /[A-Za-zÀ-ž]{3,}/.test(x));
  return best ? best.slice(0, 90) : null;
}

function inferSide(html, text) {
  const n = normalize(`${html} ${text}`);
  if (includesAny(n, ['team-a', 'home team', 'localteam', 'home'])) return 'home';
  if (includesAny(n, ['team-b', 'away team', 'visitorteam', 'away'])) return 'away';
  return null;
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(stripTags(m[1])).replace(/\s+/g, ' ').trim() : null;
}

function extractStatusText(sample) {
  const n = normalize(sample);
  if (includesAny(n, ['full-time', 'full time', 'ft'])) return 'FT';
  if (includesAny(n, ['half-time', 'half time', 'ht'])) return 'HT';
  if (includesAny(n, ['postponed'])) return 'Postponed';
  if (includesAny(n, ['scheduled', 'not started'])) return 'NS';
  return null;
}

function extractLikelyScore(html, title, sample) {
  const hay = decodeHtml(stripTags(`${title || ''} ${sample || ''}`)).replace(/\s+/g, ' ');
  const m = hay.match(/(?:^|\s)(\d{1,2})\s*[-–:]\s*(\d{1,2})(?:\s|$)/);
  if (!m) return null;
  return { h: Number(m[1]), a: Number(m[2]) };
}

function buildFixtureSignals(fixtures) {
  const fx = [];
  for (const fixture of fixtures || []) fx.push(buildSingleFixtureSignal(fixture));
  return { fixtures: fx };
}

function buildSingleFixtureSignal(fixture) {
  const h = fixture.h || fixture.homeTeam || '';
  const a = fixture.a || fixture.awayTeam || '';
  const date = String(fixture.date || '').slice(0, 10);
  return {
    id: String(fixture.id || ''),
    date,
    h,
    a,
    homeTokens: teamTokens(h),
    awayTokens: teamTokens(a),
    dateTokens: dateTokens(date)
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
    'fc voluntari': ['voluntari'],
    'fc botosani': ['botosani'],
    'fcsb': ['steaua bucuresti'],
    'fc arges': ['arges', 'arges pitesti', 'champions fc arges', 'acs champions fc arges'],
    'otelul galati': ['otelul', 'galati'],
    'cfr cluj': ['cfr', 'cluj'],
    'universitatea craiova': ['u craiova', 'cs universitatea craiova', 'craiova'],
    'universitatea cluj': ['u cluj', 'cluj'],
    'uta arad': ['uta', 'arad'],
    'farul constanta': ['farul', 'constanta', 'fcv farul'],
    'petrolul ploiesti': ['petrolul', 'ploiesti'],
    'dinamo': ['dinamo bucuresti'],
    'corvinul hunedoara': ['corvinul', 'hunedoara'],
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

function dateTokens(date) {
  const d = String(date || '').slice(0, 10);
  if (!d) return [];
  const [y, m, day] = d.split('-');
  return [
    d,
    d.replaceAll('-', '/'),
    `${day}.${m}.${y}`,
    `${day}/${m}/${y}`,
    `${Number(day)}/${Number(m)}/${y}`,
    `${y}/${m}/${day}`
  ].filter(Boolean);
}

function resolveSoccerwayDetailUrl(input, env, opts = {}) {
  const raw = String(input || opts.url || opts.soccerwayUrl || '').trim();
  if (isHttpUrl(raw)) return raw;
  if (raw && raw.includes('/matches/')) return absolutizeUrl(raw, env?.SOCCERWAY_BASE_URL || DEFAULT_BASES[0]);
  return null;
}

function buildNextSteps(matched, links, pageReports, fixtureSnippets = []) {
  if (matched.length) {
    return [
      `Found ${matched.length} Soccerway match detail link(s). Next: run source=soccerway&incidents=1 after kickoff/full-time.`,
      'Use write=1 to backfill soccerwayUrl/sourceIds, then later merge detail incidents into live-results finalizer.'
    ];
  }
  if (links.length) {
    return [
      `Fetched ${links.length} /matches/ link(s), but none crossed the match threshold. Retry with matchThreshold=18 or showBody=1.`,
      'Try group=soccerway with date/round narrowed to one day and inspect linkSample.'
    ];
  }
  const readablePages = pageReports.filter(p => p.readable || p.ok).length;
  if (fixtureSnippets.length) {
    return [
      `No /matches/ URLs extracted, but ${fixtureSnippets.length} fixture text snippet(s) were found. Next: run B13C text-row parser or provide one exact Soccerway match URL after kickoff/full-time.`,
      'This means Soccerway is usable as a league-page text source, but detail links may be rendered by client-side JS or hidden behind another row endpoint.'
    ];
  }
  return readablePages
    ? ['League page body is readable, but no /matches/ links or reliable fixture snippets were extracted. Try a team page URL or a Soccerway regional mirror with sourceUrl=.']
    : ['Soccerway pages were not readable enough from Worker. Try uk/ng mirror or a specific team/fixture URL.'];
}

function deriveSoccerwayId(url) {
  const nums = String(url || '').match(/\/(\d{5,})(?:\/)?(?:[?#].*)?$/);
  if (nums) return nums[1];
  const all = String(url || '').match(/\d{5,}/g);
  return all?.length ? all[all.length - 1] : null;
}

function normalizeUrlForDedupe(url) {
  return String(url || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
}

function absolutizeUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function unique(values) {
  return [...new Set((values || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function splitList(value) {
  return String(value || '').split(/[\n|,]+/).map(x => x.trim()).filter(Boolean);
}

function looksHardBlocked(text) {
  const n = normalize(text);
  return includesAny(n, ['captcha', 'access denied', 'just a moment', 'cloudflare ray id', 'checking your browser']);
}

function includesAny(haystack, needles) {
  const h = normalize(haystack);
  return (needles || []).some(n => n && h.includes(normalize(n)));
}

function makeSample(text, maxChars = 520) {
  return decodeHtml(String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, maxChars);
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&prime;/g, "'");
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
