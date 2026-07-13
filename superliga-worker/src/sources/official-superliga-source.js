const DEFAULT_TIMEOUT_MS = 9000;

const DEFAULT_OFFICIAL_URLS = [
  'https://www.superliga.ro/',
  'https://lpf.ro/',
  'https://lpf.ro/noutati/superliga-programul-primei-etape/6595',
  'https://www.superliga.ro/cluburi/fc-botosani/calendar',
  'https://www.superliga.ro/cluburi/fcsb/calendar'
];

const TEAM_CODES = {
  'fc voluntari': 'fcv',
  'fc botosani': 'fcb',
  'fcsb': 'fcsb',
  'fc arges': 'fca',
  'otelul galati': 'ote',
  'cfr cluj': 'cfr',
  'universitatea craiova': 'ucv',
  'uta arad': 'uta',
  'universitatea cluj': 'ucj',
  'farul constanta': 'far',
  'petrolul ploiesti': 'fcp',
  'dinamo': 'din',
  'corvinul hunedoara': 'cor',
  'csikszereda': 'fkcs',
  'rapid bucuresti': 'rap',
  'sepsi osk': 'osk'
};

export async function fetchOfficialSuperligaEvents(env, fixtures = [], opts = {}) {
  const active = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length ? opts.activeFixtures : fixtures;
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const sampleChars = clampNumber(opts.sampleChars || opts.sample || 700, 160, 3600);
  const threshold = clampNumber(opts.officialMatchThreshold || opts.matchThreshold || 62, 30, 120);
  const includeIncidents = !!opts.includeIncidents;
  const detailLimit = clampNumber(opts.detailLimit || opts.matchDetailLimit || 8, 0, 30);

  let urls = splitList(env?.OFFICIAL_SUPERLIGA_URLS).filter(isHttpUrl);
  if (opts.url && isHttpUrl(opts.url)) urls.unshift(opts.url);
  if (!urls.length) urls = DEFAULT_OFFICIAL_URLS;
  urls = dedupe(urls);

  const pageReports = [];
  const allLinks = [];
  const fixtureSnippets = [];
  const pageTexts = [];

  for (const pageUrl of urls) {
    const page = await fetchText(pageUrl, { timeoutMs, referer: opts.referer, userAgent: opts.userAgent });
    const text = htmlToText(page.text || '');
    const compactText = compact(text);
    pageTexts.push({ url: pageUrl, text: compactText, normalized: normalize(compactText), ok: page.ok, status: page.status });

    const links = extractOfficialLinks(page.text || '', pageUrl);
    const snippets = extractFixtureSnippets(compactText, active, 620).map(x => ({ ...x, origin: pageUrl }));
    fixtureSnippets.push(...snippets);

    pageReports.push({
      url: pageUrl,
      finalUrl: page.finalUrl || pageUrl,
      ok: page.ok,
      status: page.status,
      contentType: page.contentType,
      bytes: page.text?.length || 0,
      elapsedMs: page.elapsedMs,
      linkCount: links.length,
      fixtureSnippetCount: snippets.length,
      sample: compactText.slice(0, sampleChars),
      error: page.error || null
    });

    for (const link of links) allLinks.push({ ...link, origin: pageUrl, candidateType: 'extracted' });
  }

  const extractedLinks = dedupeLinks(allLinks)
    .filter(link => !/undefined/i.test(link.url || ''));

  const inferredLinks = buildInferredOfficialLinks(env, active, pageTexts);
  const links = dedupeLinks([...inferredLinks, ...extractedLinks]);

  const matched = [];
  const usedUrls = new Set();
  const unmatched = [];

  for (const fixture of active) {
    let best = null;
    for (const link of links) {
      const score = scoreFixtureLinkStrict(fixture, link);
      if (!best || score > best.score) best = { ...link, score };
    }

    if (best && best.score >= threshold && !usedUrls.has(best.url)) {
      const row = {
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        officialUrl: best.url,
        officialId: extractOfficialId(best.url),
        rawText: best.text,
        score: best.score,
        origin: best.origin,
        candidateType: best.candidateType || 'extracted',
        context: compact(best.context || '').slice(0, 620)
      };
      matched.push(row);
      usedUrls.add(best.url);
    } else {
      unmatched.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        expectedOfficialUrl: buildOfficialMatchUrl(env, fixture),
        bestScore: best?.score || 0,
        bestUrl: best?.url || null,
        bestText: best?.text || null,
        bestType: best?.candidateType || null
      });
    }
  }

  const results = {};
  const incidentDebug = [];
  if (includeIncidents) {
    const detailRows = matched.slice(0, detailLimit || matched.length);
    for (const row of detailRows) {
      const detail = await fetchOfficialSuperligaMatchDetails(env, row.officialUrl, { ...opts, fixture: opts.fixture || row });
      incidentDebug.push({
        id: row.id,
        url: row.officialUrl,
        ok: detail.ok,
        status: detail.status,
        signals: detail.signals,
        eventSamples: detail.eventSamples?.slice(0, 8) || []
      });
      results[row.id] = mergeDetail(row, detail);
    }
  }

  return {
    ok: true,
    source: 'official-superliga-links-b15c-strict-repair',
    warning: 'B15C: strict repair. It rejects single-team official calendar hits and uses deterministic Superliga match URL inference when the fixture is confirmed on official/LPF pages.',
    bases: urls,
    rawPageCount: pageReports.length,
    rawMatchLinkCount: links.length,
    extractedLinkCount: extractedLinks.length,
    inferredLinkCount: inferredLinks.length,
    fixtureSnippetCount: fixtureSnippets.length,
    count: matched.length,
    results,
    matched,
    unmatched,
    pageReports,
    linkSample: links.slice(0, 40),
    fixtureSnippetSample: fixtureSnippets.slice(0, 16),
    incidentDebug,
    nextSteps: matched.length
      ? ['Run source=official&write=1 again. This overwrites the bad B15 officialUrl values while preserving Flashscore sourceIds.']
      : ['No strict official match URL matched. Check team code map or pass url=EXACT_OFFICIAL_PAGE.'],
    updatedAt: new Date().toISOString()
  };
}

export async function fetchOfficialSuperligaMatchDetails(env, input, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const rawUrl = normalizeOfficialUrl(String(input || ''), env);
  if (!rawUrl) return { ok: false, source: 'official-superliga-match-details-b24-primary-match-score', error: 'missing_or_invalid_url' };

  const page = await fetchText(rawUrl, { timeoutMs, referer: opts.referer, userAgent: opts.userAgent });
  const text = htmlToText(page.text || '');
  const eventSamples = extractIncidentSamples(text);
  const fixtureHint = resolveOfficialFixtureHint(opts, rawUrl);
  const scoreScan = parseScoreFromText(text, { fixture: fixtureHint, url: rawUrl });
  const score = scoreScan.score;

  return {
    ok: page.ok,
    source: 'official-superliga-match-details-b24-primary-match-score',
    url: rawUrl,
    finalUrl: page.finalUrl || rawUrl,
    status: page.status,
    contentType: page.contentType,
    bytes: page.text?.length || 0,
    elapsedMs: page.elapsedMs,
    title: extractTitle(page.text || ''),
    score,
    scoreDebug: scoreScan.debug,
    scorers: [],
    yellowCards: [],
    redCards: [],
    doubleYellowCards: [],
    signals: {
      hasReportWords: /\b(raportul meciului|raport|meciului|superliga)\b/i.test(text),
      hasGoalWords: /\b(gol|goluri|marcat|marcator|goal|scorer)\b/i.test(text),
      hasCardWords: /\b(cartonas|cartonaș|galben|rosu|roșu|yellow|red card)\b/i.test(text),
      hasLineupWords: /\b(echipe|lineup|formula|titulari|rezerve)\b/i.test(text),
      hasPlausibleScore: !!score,
      rejectedTimeLikeScore: scoreScan.debug.rejectedTimeLike > 0,
      primaryMatchScopeFound: scoreScan.debug.scopeFound,
      primaryMatchScope: scoreScan.debug.scope
    },
    eventSamples,
    sample: compact(text).slice(0, clampNumber(opts.sampleChars || opts.sample || 1600, 200, 5000)),
    error: page.error || null,
    warning: 'B24 primary-match score guard: only the current fixture header is scanned; real low football scores may use a colon, while HH:MM clocks and H2H scores are rejected.'
  };
}

function buildInferredOfficialLinks(env, active, pageTexts) {
  const out = [];
  for (const fixture of active || []) {
    const url = buildOfficialMatchUrl(env, fixture);
    if (!url) continue;
    const evidence = findOfficialFixtureEvidence(fixture, pageTexts);
    out.push({
      url,
      text: `${fixture.h} - ${fixture.a}`,
      context: evidence?.snippet || `${fixture.date || ''} ${fixture.t || ''} ${fixture.h} - ${fixture.a}`,
      origin: evidence?.origin || 'deterministic-superliga-url-map',
      candidateType: evidence ? 'inferred-official-confirmed' : 'inferred-official-unconfirmed',
      expectedForFixtureId: fixture.id,
      evidenceScore: evidence?.score || 0,
      evidenceDistance: evidence?.distance ?? null
    });
  }
  return out;
}

function buildOfficialMatchUrl(env, fixture) {
  const homeCode = officialTeamCode(fixture?.h);
  const awayCode = officialTeamCode(fixture?.a);
  if (!homeCode || !awayCode) return null;
  const base = String(env?.OFFICIAL_SUPERLIGA_BASE_URL || 'https://www.superliga.ro').replace(/\/+$/, '');
  return `${base}/meci/superliga-26-27-regular-${homeCode}-${awayCode}`;
}

function officialTeamCode(name) {
  const n = normalize(name);
  return TEAM_CODES[n] || null;
}

function findOfficialFixtureEvidence(fixture, pages) {
  const homeAliases = aliasesFor(fixture.h).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
  const awayAliases = aliasesFor(fixture.a).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
  const dateTokens = dateTokensForFixture(fixture);
  let best = null;

  for (const page of pages || []) {
    if (!page?.normalized) continue;
    const hay = page.normalized;
    const homeHit = findFirst(hay, homeAliases);
    const awayHit = findFirst(hay, awayAliases);
    if (homeHit.index < 0 || awayHit.index < 0) continue;
    const distance = Math.abs(homeHit.index - awayHit.index);
    const closeTeams = distance <= 380;
    if (!closeTeams) continue;

    const center = Math.min(homeHit.index, awayHit.index);
    const rawSnippet = page.text.slice(Math.max(0, center - 280), center + 440);
    const normalizedSnippet = normalize(rawSnippet);
    const hasDate = dateTokens.some(token => token && normalizedSnippet.includes(normalize(token)));
    const hasReport = /raportul meciului|programul primei etape|etapa 1|superliga/i.test(rawSnippet);
    const score = 40 + (hasDate ? 22 : 0) + (hasReport ? 12 : 0) + Math.max(0, 20 - Math.floor(distance / 20));

    if (!best || score > best.score) {
      best = {
        origin: page.url,
        snippet: compact(rawSnippet),
        score,
        distance,
        homeToken: homeHit.token,
        awayToken: awayHit.token,
        hasDate,
        hasReport
      };
    }
  }

  return best;
}

function scoreFixtureLinkStrict(fixture, link) {
  const expected = buildOfficialMatchUrl(null, fixture);
  const expectedId = extractOfficialId(expected);
  const linkId = extractOfficialId(link?.url || '');

  if (link?.expectedForFixtureId && String(link.expectedForFixtureId) === String(fixture.id)) {
    return link.candidateType === 'inferred-official-confirmed' ? 96 : 74;
  }

  if (expectedId && linkId && expectedId === linkId) return 100;
  if (/undefined/i.test(link?.url || '')) return 0;
  if (!/\/meci\//i.test(link?.url || '')) return 0;

  const hayLabel = normalize(link?.text || '');
  const hayContext = normalize(`${link?.text || ''} ${link?.context || ''}`);
  const homeAliases = aliasesFor(fixture.h);
  const awayAliases = aliasesFor(fixture.a);
  const homeLabel = bestAliasHit(hayLabel, homeAliases);
  const awayLabel = bestAliasHit(hayLabel, awayAliases);
  const homeAny = homeLabel || bestAliasHit(hayContext, homeAliases);
  const awayAny = awayLabel || bestAliasHit(hayContext, awayAliases);

  // Important B15C fix: one team is not enough. The old B15 allowed this and polluted unrelated officialUrl fields.
  if (!homeAny || !awayAny) return 0;

  let score = 42;
  if (homeLabel && awayLabel) score += 30;
  else score += 14;

  const hi = hayContext.indexOf(homeAny);
  const ai = hayContext.indexOf(awayAny);
  if (hi >= 0 && ai >= 0) {
    const dist = Math.abs(hi - ai);
    if (dist <= 180) score += 14;
    if (hi < ai) score += 6;
  }

  const dateTokens = dateTokensForFixture(fixture).map(normalize).filter(Boolean);
  if (dateTokens.some(token => hayContext.includes(token))) score += 14;

  return score;
}

function mergeDetail(row, detail) {
  return {
    id: row.id,
    group: 'SL',
    homeTeam: row.h,
    awayTeam: row.a,
    date: row.date,
    started: false,
    finished: false,
    status: null,
    minute: null,
    h: detail?.score?.h ?? null,
    a: detail?.score?.a ?? null,
    pH: null,
    pA: null,
    scorers: detail?.scorers || [],
    yellowCards: detail?.yellowCards || [],
    redCards: detail?.redCards || [],
    doubleYellowCards: detail?.doubleYellowCards || [],
    eventSource: 'official-superliga',
    source: 'official-superliga',
    officialUrl: row.officialUrl,
    updatedAt: new Date().toISOString()
  };
}

function extractOfficialLinks(html, baseUrl) {
  const out = [];
  if (!html) return out;
  const re = /<a\b[^>]*href\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1] || '').trim();
    const fullUrl = toAbsoluteUrl(href, baseUrl);
    if (!fullUrl) continue;
    if (!/\/meci\//i.test(fullUrl)) continue;
    if (/undefined/i.test(fullUrl)) continue;
    const inner = m[2] || '';
    const text = compact(htmlToText(inner));
    const around = html.slice(Math.max(0, m.index - 760), Math.min(html.length, re.lastIndex + 760));
    const context = compact(htmlToText(around));
    if (!/(raportul meciului|superliga|calendar|meci)/i.test(`${text} ${context}`)) continue;
    out.push({ url: fullUrl, text, context });
  }
  return out;
}

function extractFixtureSnippets(text, fixtures, radius = 520) {
  const out = [];
  const compactText = compact(text);
  const hay = normalize(compactText);
  for (const fixture of fixtures || []) {
    const home = aliasesFor(fixture.h).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
    const away = aliasesFor(fixture.a).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
    const hi = findFirst(hay, home);
    const ai = findFirst(hay, away);
    if (hi.index < 0 || ai.index < 0) continue;
    const distance = Math.abs(hi.index - ai.index);
    if (distance > 700) continue;
    const center = Math.min(hi.index, ai.index);
    out.push({
      id: fixture.id,
      date: fixture.date,
      h: fixture.h,
      a: fixture.a,
      matchedHomeToken: hi.token,
      matchedAwayToken: ai.token,
      distance,
      snippet: compactText.slice(Math.max(0, center - radius), center + radius)
    });
  }
  return out;
}

function aliasesFor(name) {
  const n = normalize(name);
  const common = {
    'fc voluntari': ['fc voluntari', 'voluntari', 'fcv'],
    'fc botosani': ['fc botosani', 'botosani', 'fcb'],
    'fcsb': ['fcsb'],
    'fc arges': ['fc arges', 'arges', 'fca'],
    'otelul galati': ['otelul galati', 'otelul', 'ote'],
    'cfr cluj': ['cfr cluj', 'cfr', 'fc cfr 1907 cluj'],
    'universitatea craiova': ['universitatea craiova', 'univ craiova', 'ucv', 'craiova'],
    'uta arad': ['uta arad', 'uta'],
    'universitatea cluj': ['universitatea cluj', 'fc universitatea cluj', 'u cluj', 'ucj'],
    'farul constanta': ['farul constanta', 'fc farul constanta', 'farul', 'far'],
    'petrolul ploiesti': ['petrolul ploiesti', 'petrolul', 'fcp'],
    'dinamo': ['dinamo', 'dinamo bucuresti', 'din'],
    'corvinul hunedoara': ['corvinul hunedoara', 'fc corvinul hunedoara', 'corvinul', 'cor'],
    'csikszereda': ['csikszereda', 'fk csikszereda', 'miercurea ciuc', 'fkcs'],
    'rapid bucuresti': ['rapid bucuresti', 'fc rapid bucuresti', 'rapid', 'rap'],
    'sepsi osk': ['sepsi osk', 'sepsi sf gheorghe', 'sepsi', 'osk']
  };
  return dedupe([name, n, ...(common[n] || [])]);
}

function dateTokensForFixture(fixture) {
  if (!fixture?.date) return [];
  const [year, month, day] = String(fixture.date).split('-');
  const dd = String(Number(day || 0));
  const mm = String(Number(month || 0));
  const roMonths = {
    '01': 'ianuarie', '02': 'februarie', '03': 'martie', '04': 'aprilie', '05': 'mai', '06': 'iunie',
    '07': 'iulie', '08': 'august', '09': 'septembrie', '10': 'octombrie', '11': 'noiembrie', '12': 'decembrie'
  };
  return dedupe([
    `${day}.${month}`,
    `${dd}.${mm}`,
    `${day}/${month}`,
    `${dd}/${mm}`,
    `${dd} ${roMonths[month] || ''}`.trim(),
    `${dd} ${roMonths[month] || ''} ${year}`.trim(),
    String(fixture.date)
  ]).filter(Boolean);
}

function bestAliasHit(hay, aliases) {
  let best = '';
  for (const alias of aliases) {
    const n = normalize(alias);
    if (!n || n.length < 3) continue;
    if (hay.includes(n) && n.length > best.length) best = n;
  }
  return best || null;
}

function findFirst(hay, needles) {
  let best = { index: -1, token: null };
  for (const needle of needles) {
    if (!needle || needle.length < 3) continue;
    const idx = hay.indexOf(needle);
    if (idx >= 0 && (best.index < 0 || idx < best.index)) best = { index: idx, token: needle };
  }
  return best;
}

function extractIncidentSamples(text) {
  const out = [];
  const chunks = compact(text).split(/(?<=[.!?])\s+|\s{2,}/).filter(Boolean);
  for (const chunk of chunks) {
    if (/\b(raportul meciului|gol|goluri|marcat|marcator|cartonas|cartonaș|galben|rosu|roșu|schimbare|penalty|lineup|echipe)\b/i.test(chunk)) out.push(chunk.slice(0, 360));
    if (out.length >= 30) break;
  }
  return out;
}

function resolveOfficialFixtureHint(opts = {}, rawUrl = '') {
  if (opts.fixture?.h && opts.fixture?.a) return opts.fixture;

  const targetId = extractOfficialId(rawUrl);
  for (const fixture of opts.activeFixtures || []) {
    if (!fixture?.h || !fixture?.a) continue;
    const fixtureId = fixture.officialId || fixture.sourceIds?.official || extractOfficialId(fixture.officialUrl || fixture.sourceIds?.officialUrl || '');
    if (targetId && fixtureId && String(targetId) === String(fixtureId)) return fixture;
  }

  return inferFixtureHintFromOfficialUrl(rawUrl);
}

function inferFixtureHintFromOfficialUrl(rawUrl) {
  const slug = extractOfficialId(rawUrl) || '';
  const m = slug.match(/(?:regular|playoff|playout)-([a-z0-9]+)-([a-z0-9]+)$/i);
  if (!m) return null;

  const reverseCodes = {};
  for (const [team, code] of Object.entries(TEAM_CODES)) reverseCodes[String(code).toLowerCase()] = team;
  const h = reverseCodes[String(m[1]).toLowerCase()] || null;
  const a = reverseCodes[String(m[2]).toLowerCase()] || null;
  return h && a ? { h, a } : null;
}

function parseScoreFromText(text, context = {}) {
  const full = compact(text);
  const scope = extractPrimaryMatchScope(full, context.fixture);
  const s = scope.text;
  const debug = {
    scanned: 0,
    accepted: 0,
    rejectedTimeLike: 0,
    rejectedOutOfRange: 0,
    rejectedDateLike: 0,
    rejectedOutsideTeamPair: 0,
    scopeFound: scope.found,
    scope: scope.kind,
    scopeChars: s.length,
    fixtureHint: context.fixture ? {
      h: context.fixture.h || null,
      a: context.fixture.a || null,
      date: context.fixture.date || null,
      t: context.fixture.t || null
    } : null,
    scopeSample: s.slice(0, 700),
    candidates: []
  };

  // Only the current match header is scanned. The page's "Ultima întâlnire
  // directă" scores live outside this scope and can never become the current
  // fixture score. A colon is accepted only for plausible low football scores;
  // clock-like values such as 15:30 or 21:00 remain rejected.
  const re = /(^|[^\d./-])(\d{1,2})\s*([:–—-])\s*(\d{1,2})(?![\d./-])/g;
  let match;
  while ((match = re.exec(s))) {
    debug.scanned += 1;
    const prefix = match[1] || '';
    const h = Number(match[2]);
    const separator = match[3];
    const a = Number(match[4]);
    const start = match.index + prefix.length;
    const raw = s.slice(start, re.lastIndex);
    const before = s.slice(Math.max(0, start - 48), start);
    const after = s.slice(re.lastIndex, Math.min(s.length, re.lastIndex + 48));
    const colonClockLike = separator === ':' && (h > 9 || a > 9);
    if (colonClockLike) {
      debug.rejectedTimeLike += 1;
      debug.candidates.push({ raw, accepted: false, reason: 'clock_like_value' });
      continue;
    }

    if (!Number.isInteger(h) || !Number.isInteger(a) || h > 15 || a > 15) {
      debug.rejectedOutOfRange += 1;
      debug.candidates.push({ raw, accepted: false, reason: 'score_out_of_range' });
      continue;
    }

    const dateLike = /(?:\d{2,4}|ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)\s*$/i.test(before) &&
      /^\s*(?:\d{2,4}|ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/i.test(after);
    if (dateLike) {
      debug.rejectedDateLike += 1;
      debug.candidates.push({ raw, accepted: false, reason: 'date_like_context' });
      continue;
    }

    if (scope.scoreZone && (start < scope.scoreZone.start || start > scope.scoreZone.end)) {
      debug.rejectedOutsideTeamPair += 1;
      debug.candidates.push({ raw, accepted: false, reason: 'outside_primary_team_pair' });
      continue;
    }

    debug.accepted += 1;
    debug.candidates.push({ raw, accepted: true, reason: 'primary_match_score' });
    return { score: { h, a, raw }, debug };
  }

  return { score: null, debug };
}

function extractPrimaryMatchScope(text, fixture) {
  const full = compact(text);
  if (!full) return { text: '', found: false, kind: 'empty', scoreZone: null };

  const folded = foldKeepLength(full);
  const homeAliases = fixture?.h ? aliasesFor(fixture.h).map(foldKeepLength).filter(x => x.length >= 3) : [];
  const awayAliases = fixture?.a ? aliasesFor(fixture.a).map(foldKeepLength).filter(x => x.length >= 3) : [];
  const dateTokens = fixture?.date ? dateTokensForFixture(fixture).map(foldKeepLength).filter(Boolean) : [];

  const pair = findBestPrimaryTeamPair(folded, homeAliases, awayAliases, dateTokens);
  if (pair) {
    let start = Math.max(0, pair.start - 240);
    let end = Math.min(full.length, pair.end + 320);

    const boundary = findPrimaryScopeBoundary(folded, pair.end);
    if (boundary >= 0) end = Math.min(end, boundary);

    const slice = full.slice(start, end);
    return {
      text: slice,
      found: true,
      kind: 'fixture_team_pair_window',
      scoreZone: {
        start: Math.max(0, pair.start - start - 120),
        end: Math.min(slice.length, pair.end - start + 160)
      }
    };
  }

  // Conservative fallback for direct detail tests without fixture context:
  // inspect only the page head and stop before squads/statistics/H2H blocks.
  const boundary = findPrimaryScopeBoundary(folded, 0);
  const end = boundary >= 0 ? Math.min(boundary, 1800) : Math.min(full.length, 1200);
  return {
    text: full.slice(0, end),
    found: false,
    kind: 'page_head_fallback',
    scoreZone: null
  };
}

function findBestPrimaryTeamPair(hay, homeAliases, awayAliases, dateTokens) {
  if (!homeAliases.length || !awayAliases.length) return null;
  const homeHits = findAliasOccurrences(hay, homeAliases);
  const awayHits = findAliasOccurrences(hay, awayAliases);
  let best = null;

  for (const h of homeHits) {
    for (const a of awayHits) {
      const start = Math.min(h.index, a.index);
      const end = Math.max(h.index + h.token.length, a.index + a.token.length);
      const distance = end - start;
      if (distance > 520) continue;

      const contextStart = Math.max(0, start - 220);
      const contextEnd = Math.min(hay.length, end + 220);
      const around = hay.slice(contextStart, contextEnd);
      const beforePair = hay.slice(contextStart, start);
      const between = hay.slice(start, end);
      const hasDate = dateTokens.some(token => token && around.includes(token));
      const hasScoreOrTime = /\b\d{1,2}\s*[:–—-]\s*\d{1,2}\b/.test(between);
      // A later H2H/squad section must not penalize the real header pair.
      const h2h = /ultima\s+intalnire\s+directa|ultima\s+intilnire\s+directa/.test(beforePair);
      const squad = /\blotul\b|\bloturi\b/.test(beforePair);
      const score = (hasDate ? 160 : 0) + (hasScoreOrTime ? 90 : 0) - distance - (h2h ? 260 : 0) - (squad ? 80 : 0);

      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { start, end, distance, score };
      }
    }
  }

  return best && best.score > -120 ? best : null;
}

function findAliasOccurrences(hay, aliases) {
  const out = [];
  const seen = new Set();
  for (const token of dedupe(aliases).sort((a, b) => b.length - a.length)) {
    if (!token || token.length < 3) continue;
    let from = 0;
    while (from < hay.length) {
      const index = hay.indexOf(token, from);
      if (index < 0) break;
      const before = index > 0 ? hay[index - 1] : ' ';
      const after = index + token.length < hay.length ? hay[index + token.length] : ' ';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        const key = `${index}:${token}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ index, token });
        }
      }
      from = index + Math.max(1, token.length);
    }
  }
  return out;
}

function findPrimaryScopeBoundary(folded, afterIndex) {
  const tokens = [
    ' loturi ',
    ' lotul ',
    ' statistici ',
    ' ultima intalnire directa ',
    ' ultima intilnire directa '
  ];
  let best = -1;
  for (const token of tokens) {
    const idx = folded.indexOf(token, Math.max(0, afterIndex));
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

function foldKeepLength(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ș/g, 's').replace(/ț/g, 't').replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/[^a-z0-9]/g, ' ');
}

async function fetchText(url, opts = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'referer': opts.referer || 'https://www.google.com/'
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, contentType: res.headers.get('content-type') || '', text, elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, finalUrl: url, contentType: '', text: '', elapsedMs: Date.now() - started, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? compact(decodeHtml(m[1])) : null;
}

function normalizeOfficialUrl(input, env) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (isHttpUrl(s)) return s;
  const base = String(env?.OFFICIAL_SUPERLIGA_BASE_URL || 'https://www.superliga.ro').replace(/\/+$/, '');
  if (s.startsWith('/')) return `${base}${s}`;
  if (/^superliga-26-27-/i.test(s)) return `${base}/meci/${s}`;
  return null;
}

function extractOfficialId(url) {
  const m = String(url || '').match(/\/meci\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function toAbsoluteUrl(href, baseUrl) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return null;
  try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function splitList(value) {
  return String(value || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return compact(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ș/g, 's').replace(/ț/g, 't').replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&icirc;/gi, 'î')
    .replace(/&acirc;/gi, 'â')
    .replace(/&abreve;/gi, 'ă')
    .replace(/&ș|&scedil;/gi, 'ș')
    .replace(/&ț|&tcedil;/gi, 'ț')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function dedupe(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function dedupeLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links || []) {
    const key = String(link.url || '').replace(/\/+$/, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...link, url: key });
  }
  return out;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
