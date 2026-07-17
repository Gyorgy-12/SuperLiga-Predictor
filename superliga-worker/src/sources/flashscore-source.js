const DEFAULT_TIMEOUT_MS = 9000;

const DEFAULT_FLASHSCORE_URLS = [
  'https://www.flashscore.com/football/romania/superliga/',
  'https://www.flashscore.com/football/romania/superliga/fixtures/',
  'https://www.flashscore.com/football/romania/superliga/results/',
  'https://www.soccer24.com/romania/superliga/',
  'https://www.soccer24.com/romania/superliga/fixtures/'
];

export async function fetchFlashscoreEvents(env, fixtures = [], opts = {}) {
  const active = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length ? opts.activeFixtures : fixtures;
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const sampleChars = clampNumber(opts.sampleChars || opts.sample || 700, 160, 3600);
  const threshold = clampNumber(opts.flashscoreMatchThreshold || opts.matchThreshold || 24, 8, 80);
  const includeIncidents = !!opts.includeIncidents;
  const detailLimit = clampNumber(opts.detailLimit || opts.matchDetailLimit || 8, 0, 30);

  let urls = splitList(env?.FLASHSCORE_SUPERLIGA_URLS).filter(isHttpUrl);
  if (opts.url && isHttpUrl(opts.url)) urls.unshift(opts.url);
  if (!urls.length) urls = DEFAULT_FLASHSCORE_URLS;
  urls = dedupe(urls);

  const pageReports = [];
  const allLinks = [];

  for (const pageUrl of urls) {
    const page = await fetchText(pageUrl, { timeoutMs, referer: opts.referer, userAgent: opts.userAgent });
    const text = htmlToText(page.text || '');
    const links = extractMatchLinks(page.text || '', pageUrl);
    const fixtureSnippets = extractFixtureSnippets(text, active, 520);
    pageReports.push({
      url: pageUrl,
      finalUrl: page.finalUrl || pageUrl,
      ok: page.ok,
      status: page.status,
      contentType: page.contentType,
      bytes: page.text?.length || 0,
      elapsedMs: page.elapsedMs,
      linkCount: links.length,
      fixtureSnippetCount: fixtureSnippets.length,
      sample: compact(text).slice(0, sampleChars),
      error: page.error || null
    });
    for (const link of links) allLinks.push({ ...link, origin: pageUrl });
  }

  const links = dedupeLinks(allLinks);
  const matched = [];
  const usedUrls = new Set();
  const unmatched = [];

  for (const fixture of active) {
    let best = null;
    for (const link of links) {
      const score = scoreFixtureLink(fixture, link.text, link.context || '');
      if (!best || score > best.score) best = { ...link, score };
    }
    if (best && best.score >= threshold && !usedUrls.has(best.url)) {
      const flashscoreId = extractFlashscoreId(best.url);
      const row = {
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        flashscoreUrl: best.url,
        flashscoreId,
        rawText: best.text,
        score: best.score,
        origin: best.origin,
        context: compact(best.context || '').slice(0, 480)
      };
      matched.push(row);
      usedUrls.add(best.url);
    } else {
      unmatched.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        bestScore: best?.score || 0,
        bestUrl: best?.url || null,
        bestText: best?.text || null
      });
    }
  }

  const results = {};
  const incidentDebug = [];
  if (includeIncidents) {
    const detailRows = matched.slice(0, detailLimit || matched.length);
    for (const row of detailRows) {
      const detail = await fetchFlashscoreMatchDetails(env, row.flashscoreUrl, opts);
      incidentDebug.push({ id: row.id, url: row.flashscoreUrl, ok: detail.ok, status: detail.status, signals: detail.signals, eventSamples: detail.eventSamples?.slice(0, 8) || [] });
      results[row.id] = mergeDetail(row, detail);
    }
  }

  return {
    ok: true,
    source: 'flashscore-fixture-links',
    bases: urls,
    rawPageCount: pageReports.length,
    rawMatchLinkCount: links.length,
    count: matched.length,
    results,
    matched,
    unmatched,
    pageReports,
    linkSample: links.slice(0, 30),
    incidentDebug,
    nextSteps: matched.length
      ? ['Flashscore-family match URLs found. Use write=1 to backfill flashscoreUrl/sourceIds, then test source=flashscore-details on a concrete URL after kickoff/full-time.']
      : ['No Flashscore links matched. Try group=soccer24 in deep scout or pass url=EXACT_LEAGUE_PAGE.'],
    updatedAt: new Date().toISOString()
  };
}

export async function fetchFlashscoreMatchDetails(env, input, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const rawInput = String(input || '').trim();

  // B21F fix:
  // Flashscore match keys are not guaranteed to contain digits (example: QqzwxwWH).
  // The old B21 guard required at least one digit, so a valid explicit mid was dropped
  // before opts.flashscoreMid could be considered, producing missing_or_invalid_url_or_mid.
  const explicitInputKey = isFlashscoreMatchKey(rawInput) ? rawInput : null;
  const explicitMatchKey = firstNonEmpty(
    opts.flashscoreMid,
    opts.mid,
    opts.matchKey,
    explicitInputKey
  );

  const rawUrl = explicitMatchKey
    ? (opts.flashscoreUrl || opts.url || opts.refererUrl || `https://www.flashscore.com/?mid=${explicitMatchKey}`)
    : normalizeFlashscoreUrl(rawInput);
  if (!rawUrl && !explicitMatchKey) return { ok: false, source: 'flashscore-match-details-b26', error: 'missing_or_invalid_url_or_mid', debug: { rawInput, hasFlashscoreMid: !!opts.flashscoreMid, mid: opts.mid || null, matchKey: opts.matchKey || null } };

  const skipHtml = !!explicitMatchKey || opts.skipHtml === '1' || opts.skipHtml === true;
  const htmlPage = skipHtml
    ? { ok: true, status: 0, finalUrl: rawUrl, contentType: '', text: '', elapsedMs: 0 }
    : await fetchText(rawUrl, { timeoutMs, referer: opts.referer, userAgent: opts.userAgent });
  const html = htmlPage.text || '';
  const text = htmlToText(html);
  const htmlMatchKey = explicitMatchKey ? null : extractFlashscoreMatchKeyFromHtml(html);
  const provisionalMatchKey = explicitMatchKey || htmlMatchKey;

  const shouldResolveViaMc = !explicitMatchKey && (!provisionalMatchKey || looksLikeBadFlashscoreMatchKey(provisionalMatchKey, html));
  const resolverPack = shouldResolveViaMc
    ? await resolveFlashscoreMatchKeyFromMc(env, rawUrl, { ...opts, refererUrl: rawUrl, timeoutMs }).catch(error => ({ ok: false, error: error?.message || String(error) }))
    : null;

  const matchKey = resolverPack?.matchKey || provisionalMatchKey;

  const feedProbe = matchKey
    ? await fetchFlashscoreXFeedDetails(env, matchKey, { ...opts, refererUrl: rawUrl, timeoutMs })
    : { ok: false, error: 'missing_match_key' };

  if (feedProbe.ok && feedProbe.validFeed) {
    const feedState = feedProbe.state || (feedProbe.events?.length || feedProbe.score ? 'event_feed' : 'prematch');
    const isPrematch = feedState === 'prematch';
    return {
      ok: true,
      source: 'flashscore-xfeed-details-b26-budgeted-prematch',
      url: rawUrl,
      finalUrl: htmlPage.finalUrl || rawUrl,
      status: feedProbe.status,
      contentType: feedProbe.contentType,
      bytes: feedProbe.raw?.length || 0,
      elapsedMs: (htmlPage.elapsedMs || 0) + (feedProbe.elapsedMs || 0),
      title: extractTitle(html),
      matchKey,
      feedUrl: feedProbe.feedUrl,
      feedLabel: feedProbe.feedLabel,
      resolver: resolverPack ? summarizeFlashscoreMcResolver(resolverPack) : null,
      state: feedState,
      prematch: isPrematch,
      started: !isPrematch && !!(feedProbe.score || feedProbe.events?.length),
      finished: false,
      score: feedProbe.score,
      h: feedProbe.score?.h ?? null,
      a: feedProbe.score?.a ?? null,
      events: feedProbe.events || [],
      scorers: feedProbe.scorers || [],
      yellowCards: feedProbe.yellowCards || [],
      redCards: feedProbe.redCards || [],
      doubleYellowCards: feedProbe.doubleYellowCards || [],
      substitutions: feedProbe.substitutions || [],
      penalties: feedProbe.penalties || [],
      meta: feedProbe.meta || {},
      dc: feedProbe.dc || null,
      signals: {
        loadingShell: /Loading\.\.\./i.test(text),
        hasXFeed: true,
        hasLivesportDelimiters: /[¬÷~]/.test(feedProbe.raw || ''),
        hasGoalWords: /\b(goal|penalty)\b/i.test(feedProbe.raw || ''),
        hasCardWords: /\b(yellow|red card|card)\b/i.test(feedProbe.raw || ''),
        hasLineupWords: /\bsubstitution|lineup\b/i.test(feedProbe.raw || ''),
        hasPrematchMeta: Object.keys(feedProbe.meta || {}).length > 0 || !!feedProbe.dc,
        feedState,
        feedUseful: true
      },
      eventSamples: (feedProbe.events || []).slice(0, 20).map(e => `${e.minute || ''} ${e.teamSide || ''} ${e.type || ''} ${e.player || ''}`.trim()),
      sample: compact(feedProbe.raw || '').slice(0, clampNumber(opts.sampleChars || opts.sample || 2400, 300, 10000)),
      feedProbes: feedProbe.probes,
      error: null,
      warning: isPrematch
        ? 'B22 valid prematch x/feed: metadata accepted without events; no HTML fallback and no event-array wipe.'
        : 'B22 live/event x/feed: browser-confirmed Flashscore feed parsed from stored flashscoreMid.'
    };
  }

  // B26: a stored, valid MID whose detail feed has not been published yet is
  // a normal prematch state, not a reason to fan out into expensive HTML/API fallbacks.
  // Keep the fixture attached to Flashscore and retry on the next sync tick.
  if (explicitMatchKey && (opts.pendingOnEmpty === true || opts.pendingOnEmpty === '1') && feedProbe?.error === 'no_useful_xfeed_body') {
    return {
      ok: true,
      source: 'flashscore-xfeed-details-b26-pending-feed',
      url: rawUrl,
      finalUrl: rawUrl,
      status: firstSuccessfulProbeStatus(feedProbe?.probes),
      contentType: firstSuccessfulProbeContentType(feedProbe?.probes),
      bytes: 0,
      elapsedMs: sumProbeElapsedMs(feedProbe?.probes),
      title: null,
      matchKey: explicitMatchKey,
      feedUrl: null,
      feedLabel: null,
      resolver: null,
      state: 'pending_feed',
      prematch: true,
      started: false,
      finished: false,
      score: null,
      h: null,
      a: null,
      events: [],
      scorers: [],
      yellowCards: [],
      redCards: [],
      doubleYellowCards: [],
      substitutions: [],
      penalties: [],
      meta: {},
      dc: null,
      signals: {
        loadingShell: false,
        hasXFeed: false,
        hasLivesportDelimiters: false,
        hasGoalWords: false,
        hasCardWords: false,
        hasLineupWords: false,
        hasPrematchMeta: false,
        feedState: 'pending_feed',
        feedUseful: false,
        feedPending: true,
        requestBudgetGuard: true
      },
      eventSamples: [],
      sample: '',
      feedProbes: feedProbe?.probes || [],
      error: null,
      warning: 'B26 pending_feed: stored Flashscore MID is valid, but df_sui/dc is not published yet; no HTML, ESPN or SofaScore request fan-out.'
    };
  }

  const eventSamples = extractIncidentSamples(text);
  const signals = buildFlashscoreDetailSignals(text, html);
  const score = parseScoreFromTextSafely(text, signals);

  return {
    ok: htmlPage.ok,
    source: 'flashscore-match-details-b26-html-fallback',
    url: rawUrl,
    finalUrl: htmlPage.finalUrl || rawUrl,
    status: htmlPage.status,
    contentType: htmlPage.contentType,
    bytes: htmlPage.text?.length || 0,
    elapsedMs: htmlPage.elapsedMs,
    title: extractTitle(htmlPage.text || ''),
    matchKey,
    resolver: resolverPack ? summarizeFlashscoreMcResolver(resolverPack) : null,
    score,
    scorers: [],
    yellowCards: [],
    redCards: [],
    doubleYellowCards: [],
    substitutions: [],
    penalties: [],
    signals,
    eventSamples,
    feedProbes: feedProbe?.probes || [],
    sample: compact(text).slice(0, clampNumber(opts.sampleChars || opts.sample || 1600, 200, 5000)),
    error: htmlPage.error || feedProbe?.error || null,
    warning: score ? 'B19 HTML fallback: score accepted only after real match-detail signals.' : 'B19 HTML fallback: x/feed did not return useful data; HTML score extraction remains guarded against phone-number false positives.'
  };
}


export async function resolveFlashscoreMatchKeyFromMc(env, input, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const rawInput = String(input || '').trim();
  const rawUrl = normalizeFlashscoreUrl(rawInput) || rawInput;
  const signals = extractFlashscoreUrlSignals(rawUrl);

  const feedNames = dedupeStrings(splitList(opts.mcFeed || opts.matchCenterFeed || env?.FLASHSCORE_MC_FEEDS || 'mc_3')).filter(Boolean);
  if (!feedNames.length) feedNames.push('mc_3');

  const bases = dedupeStrings([
    opts.mcBase || env?.FLASHSCORE_MC_BASE || '',
    'https://2.flashscore.ninja/2',
    'https://d.flashscore.com'
  ].filter(Boolean));

  const probes = [];
  const candidates = [];

  for (const feedName of feedNames.slice(0, clampNumber(opts.mcFeedLimit || 4, 1, 10))) {
    for (const base of bases.slice(0, clampNumber(opts.mcBaseLimit || 2, 1, 4))) {
      const feedUrl = `${base.replace(/\/$/, '')}/x/feed/${feedName.replace(/^\/x\/feed\//, '')}`;
      const probe = await fetchFlashscoreFeedB19(feedUrl, {
        timeoutMs,
        referer: opts.feedReferer || opts.referer || 'https://www.flashscore.com/',
        userAgent: opts.userAgent || env?.FLASHSCORE_USER_AGENT,
        xFsign: opts.xFsign || opts.xfsign || env?.FLASHSCORE_X_FSIGN || 'SW9D1eZo'
      });
      const raw = probe.text || '';
      const parsedCandidates = parseFlashscoreMcCandidates(raw, signals, feedUrl, opts);
      candidates.push(...parsedCandidates);
      probes.push({
        label: feedName,
        url: feedUrl,
        ok: probe.ok,
        status: probe.status,
        contentType: probe.contentType,
        bytes: raw.length,
        elapsedMs: probe.elapsedMs,
        candidateCount: parsedCandidates.length,
        bestCandidate: parsedCandidates[0] ? compactCandidate(parsedCandidates[0]) : null,
        hasTargetUrlTokens: hasAnyTargetToken(raw, signals),
        sample: compact(raw).slice(0, clampNumber(opts.sampleChars || opts.sample || 1800, 300, 10000)),
        error: probe.error || null
      });
    }
  }

  const ranked = candidates
    .filter(c => c.matchKey && /^[A-Za-z0-9]{6,20}$/.test(c.matchKey))
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  const best = ranked[0] || null;

  return {
    ok: !!(best && best.score >= clampNumber(opts.mcThreshold || opts.matchKeyThreshold || 32, 8, 140)),
    source: 'flashscore-mc-resolver-b20',
    url: rawUrl,
    matchKey: best?.matchKey || null,
    score: best?.score || 0,
    candidate: best ? compactCandidate(best) : null,
    candidates: ranked.slice(0, clampNumber(opts.mcCandidateLimit || 12, 1, 40)).map(compactCandidate),
    probes,
    signals,
    error: best ? null : 'no_match_key_candidate_from_mc_feed',
    warning: 'B20 resolver: uses browser-confirmed mc_3 feed shape to recover the real Flashscore match key when the public match URL has no ?mid=... parameter.'
  };
}

export async function fetchFlashscoreXFeedDetails(env, matchKeyOrUrl, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  let matchKey = String(matchKeyOrUrl || '').trim();
  if (/^https?:\/\//i.test(matchKey)) matchKey = extractFlashscoreMatchKey(matchKey, '');
  if (!matchKey || !/^[A-Za-z0-9]{6,20}$/.test(matchKey)) {
    return { ok: false, source: 'flashscore-xfeed-details-b26', error: 'missing_or_invalid_match_key', validFeed: false, events: [], probes: [] };
  }

  const budgetedPrimaryOnly = opts.primaryFeedOnly === true || opts.primaryFeedOnly === '1' || opts.requestBudgetMode === 'strict';
  const primaryBaseOnly = opts.primaryBaseOnly === true || opts.primaryBaseOnly === '1' || budgetedPrimaryOnly;
  const tokenParam = opts.feedToken || opts.token || 'df_sui_';
  const tokens = budgetedPrimaryOnly
    ? ['df_sui_', 'dc_']
    : dedupeStrings([
        tokenParam,
        'df_sui_',
        'dc_',
        'df_dos_',
        'df_hi_',
        'df_scr_',
        'df_st_'
      ].filter(Boolean));

  const configuredBase = opts.feedBase || env?.FLASHSCORE_FEED_BASE || 'https://2.flashscore.ninja/2';
  const bases = primaryBaseOnly
    ? [String(configuredBase).replace(/\/$/, '')]
    : dedupeStrings([
        configuredBase,
        'https://2.flashscore.ninja/2',
        'https://d.flashscore.com'
      ].filter(Boolean));

  const candidates = [];
  for (const token of tokens) {
    const feedToken = normalizeFlashscoreFeedToken(token, matchKey);
    for (const base of bases) {
      candidates.push({ label: feedToken, url: `${base.replace(/\/$/, '')}/x/feed/${feedToken}` });
      if (!budgetedPrimaryOnly && (/^df_dos_/.test(feedToken) || /^dc_/.test(feedToken))) {
        candidates.push({ label: `${feedToken}_`, url: `${base.replace(/\/$/, '')}/x/feed/${feedToken}_` });
      }
    }
  }

  const probes = [];
  let prematchPack = null;
  let dcPack = null;

  const probeLimit = budgetedPrimaryOnly
    ? clampNumber(opts.feedProbeLimit || opts.probeLimit || 2, 1, 2)
    : clampNumber(opts.feedProbeLimit || opts.probeLimit || 12, 1, 30);

  for (const candidate of dedupeFeedCandidates(candidates).slice(0, probeLimit)) {
    const probe = await fetchFlashscoreFeedB19(candidate.url, {
      timeoutMs,
      referer: opts.feedReferer || opts.referer || 'https://www.flashscore.com/',
      userAgent: opts.userAgent || env?.FLASHSCORE_USER_AGENT,
      xFsign: opts.xFsign || opts.xfsign || env?.FLASHSCORE_X_FSIGN || 'SW9D1eZo'
    });
    const raw = probe.text || '';
    const analysis = analyzeFlashscoreFeedText(raw);
    probes.push({
      label: candidate.label,
      url: candidate.url,
      ok: probe.ok,
      status: probe.status,
      contentType: probe.contentType,
      bytes: raw.length,
      elapsedMs: probe.elapsedMs,
      analysis,
      sample: compact(raw).slice(0, clampNumber(opts.maxFeedChars || 2400, 500, 12000)),
      error: probe.error || null
    });

    if (!probe.ok || !analysis.looksUseful) continue;

    if (/^dc_/.test(candidate.label)) {
      const dc = parseFlashscoreDcFeed(raw);
      if (hasMeaningfulDcData(dc)) {
        dcPack = {
          dc,
          raw,
          feedUrl: candidate.url,
          feedLabel: candidate.label,
          status: probe.status,
          contentType: probe.contentType,
          elapsedMs: probe.elapsedMs
        };
      }
      continue;
    }

    const parsed = parseFlashscoreSuiFeed(raw);
    const hasEvents = parsed.events.length || parsed.scorers.length || parsed.yellowCards.length || parsed.redCards.length || parsed.doubleYellowCards.length;
    if (hasEvents || parsed.score) {
      return {
        ok: true,
        validFeed: true,
        state: 'event_feed',
        source: 'flashscore-xfeed-details-b26',
        matchKey,
        feedUrl: candidate.url,
        feedLabel: candidate.label,
        status: probe.status,
        contentType: probe.contentType,
        elapsedMs: probe.elapsedMs,
        raw,
        dc: dcPack?.dc || null,
        ...parsed,
        meta: mergeFlashscoreMeta(parsed.meta, dcPack?.dc),
        probes
      };
    }

    if (hasMeaningfulPrematchMeta(parsed.meta)) {
      prematchPack = {
        parsed,
        raw,
        feedUrl: candidate.url,
        feedLabel: candidate.label,
        status: probe.status,
        contentType: probe.contentType,
        elapsedMs: probe.elapsedMs
      };
    }
  }

  if (prematchPack || dcPack) {
    const parsed = prematchPack?.parsed || emptyFlashscoreParsedFeed();
    return {
      ok: true,
      validFeed: true,
      state: 'prematch',
      source: 'flashscore-xfeed-details-b26',
      matchKey,
      feedUrl: prematchPack?.feedUrl || dcPack?.feedUrl || null,
      feedLabel: prematchPack?.feedLabel || dcPack?.feedLabel || null,
      status: prematchPack?.status || dcPack?.status || 200,
      contentType: prematchPack?.contentType || dcPack?.contentType || 'text/plain; charset=utf-8',
      elapsedMs: (prematchPack?.elapsedMs || 0) + (dcPack?.elapsedMs || 0),
      raw: prematchPack?.raw || dcPack?.raw || '',
      ...parsed,
      meta: mergeFlashscoreMeta(parsed.meta, dcPack?.dc),
      dc: dcPack?.dc || null,
      probes
    };
  }

  return {
    ok: false,
    validFeed: false,
    state: 'unknown',
    source: 'flashscore-xfeed-details-b26',
    matchKey,
    error: 'no_useful_xfeed_body',
    events: [],
    scorers: [],
    yellowCards: [],
    redCards: [],
    doubleYellowCards: [],
    substitutions: [],
    penalties: [],
    meta: {},
    dc: null,
    score: null,
    probes
  };
}

function firstSuccessfulProbeStatus(probes = []) {
  const row = (probes || []).find(p => p && p.ok && Number(p.status) > 0);
  return row ? Number(row.status) : null;
}

function firstSuccessfulProbeContentType(probes = []) {
  const row = (probes || []).find(p => p && p.ok && p.contentType);
  return row?.contentType || null;
}

function sumProbeElapsedMs(probes = []) {
  return (probes || []).reduce((sum, row) => sum + (Number(row?.elapsedMs) || 0), 0);
}

export async function fetchFlashscoreEndpointScout(env, input, opts = {}) {
  const timeoutMs = clampNumber(opts.timeoutMs || env?.INCIDENT_SCOUT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const sampleChars = clampNumber(opts.sampleChars || opts.sample || 1800, 300, 8000);
  const scriptLimit = clampNumber(opts.scriptLimit || env?.FLASHSCORE_SCOUT_SCRIPT_LIMIT || 8, 0, 24);
  const feedLimit = clampNumber(opts.feedLimit || opts.candidateLimit || opts.probeLimit || env?.FLASHSCORE_SCOUT_FEED_LIMIT || 18, 0, 48);
  const maxScriptChars = clampNumber(opts.maxScriptChars || env?.FLASHSCORE_SCOUT_MAX_SCRIPT_CHARS || 180000, 20000, 900000);
  const maxFeedChars = clampNumber(opts.maxFeedChars || env?.FLASHSCORE_SCOUT_MAX_FEED_CHARS || 5000, 800, 50000);
  const probeFeed = opts.probeFeed !== false && opts.probeFeed !== '0' && opts.probe !== '0';
  const fetchScripts = opts.fetchScripts !== false && opts.fetchScripts !== '0';

  const rawUrl = normalizeFlashscoreUrl(String(input || ''));
  if (!rawUrl) return { ok: false, source: 'flashscore-endpoint-scout-b19-xfeed-parser', error: 'missing_or_invalid_url' };

  const page = await fetchText(rawUrl, { timeoutMs, referer: opts.referer, userAgent: opts.userAgent });
  const html = page.text || '';
  const text = htmlToText(html);
  const title = extractTitle(html);
  const matchKey = extractFlashscoreMatchKey(rawUrl, html);
  const scriptSources = extractScriptSources(html, rawUrl);
  const inlineScripts = extractInlineScripts(html);
  const htmlCandidates = extractEndpointCandidates(html, rawUrl);
  const htmlFeedTokens = extractFeedTokens(html);

  const scriptReports = [];
  const scriptEndpointCandidates = [];
  const scriptFeedTokens = [];

  if (fetchScripts && scriptLimit > 0) {
    for (const scriptUrl of scriptSources.slice(0, scriptLimit)) {
      const script = await fetchText(scriptUrl, {
        timeoutMs,
        referer: rawUrl,
        userAgent: opts.userAgent,
        accept: '*/*'
      });
      const scriptText = String(script.text || '').slice(0, maxScriptChars);
      const endpointCandidates = extractEndpointCandidates(scriptText, scriptUrl);
      const feedTokens = extractFeedTokens(scriptText);
      scriptEndpointCandidates.push(...endpointCandidates);
      scriptFeedTokens.push(...feedTokens);
      scriptReports.push({
        url: scriptUrl,
        ok: script.ok,
        status: script.status,
        contentType: script.contentType,
        bytes: script.text?.length || 0,
        scannedChars: scriptText.length,
        elapsedMs: script.elapsedMs,
        endpointCandidateCount: endpointCandidates.length,
        feedTokenCount: feedTokens.length,
        keywordHits: keywordHits(scriptText),
        sampleCandidates: endpointCandidates.slice(0, 20),
        sampleFeedTokens: feedTokens.slice(0, 20),
        error: script.error || null
      });
    }
  }

  const discoveredEndpointCandidates = dedupeStrings([...htmlCandidates, ...scriptEndpointCandidates]).slice(0, 220);
  const discoveredFeedTokens = dedupeStrings([...htmlFeedTokens, ...scriptFeedTokens]).slice(0, 220);
  const feedCandidates = buildFlashscoreFeedCandidates(matchKey, discoveredEndpointCandidates, discoveredFeedTokens, rawUrl, opts).slice(0, feedLimit);
  const feedProbes = [];

  if (probeFeed && feedLimit > 0) {
    for (const candidate of feedCandidates) {
      const probe = await fetchFlashscoreFeed(candidate.url, {
        timeoutMs,
        referer: rawUrl,
        userAgent: opts.userAgent,
        xFsign: opts.xFsign || opts.xfsign || env?.FLASHSCORE_X_FSIGN || 'SW9D1eZo'
      });
      const feedText = String(probe.text || '');
      const analysis = analyzeFlashscoreFeedText(feedText);
      feedProbes.push({
        label: candidate.label,
        url: candidate.url,
        reason: candidate.reason,
        ok: probe.ok,
        status: probe.status,
        contentType: probe.contentType,
        bytes: feedText.length,
        elapsedMs: probe.elapsedMs,
        analysis,
        sample: compact(feedText).slice(0, maxFeedChars),
        error: probe.error || null
      });
    }
  }

  const usefulFeeds = feedProbes.filter(p => p.analysis?.looksUseful || p.analysis?.hasLivesportDelimiters || p.analysis?.hasGoalWords || p.analysis?.hasCardWords);

  return {
    ok: !!page.ok,
    source: 'flashscore-endpoint-scout-b19-xfeed-parser',
    url: rawUrl,
    finalUrl: page.finalUrl || rawUrl,
    status: page.status,
    contentType: page.contentType,
    bytes: html.length,
    elapsedMs: page.elapsedMs,
    title,
    matchKey,
    pageSignals: {
      loadingShell: /Loading\.\.\./i.test(text),
      hasGoalWords: /\b(goal|goalscorer|scorer|marcat|gol)\b/i.test(text),
      hasCardWords: /\b(yellow card|red card|card|cartonas|galben|rosu)\b/i.test(text),
      hasLineupWords: /\b(lineup|line-up|formation|starting)\b/i.test(text),
      hasFeedKeyword: /x\/feed|d\.flashscore|x-fsign|SW9D1eZo/i.test(html),
      hasMatchKeyInHtml: !!(matchKey && html.includes(matchKey))
    },
    scripts: {
      count: scriptSources.length,
      fetched: scriptReports.length,
      sources: scriptSources.slice(0, 80),
      reports: scriptReports
    },
    inlineScripts: {
      count: inlineScripts.length,
      samples: inlineScripts.slice(0, 10).map(s => ({ chars: s.length, keywordHits: keywordHits(s), sample: compact(s).slice(0, 800) }))
    },
    discovered: {
      htmlEndpointCandidateCount: htmlCandidates.length,
      scriptEndpointCandidateCount: scriptEndpointCandidates.length,
      endpointCandidates: discoveredEndpointCandidates.slice(0, 120),
      feedTokenCount: discoveredFeedTokens.length,
      feedTokens: discoveredFeedTokens.slice(0, 120)
    },
    feed: {
      probed: !!(probeFeed && feedLimit > 0),
      candidateCount: feedCandidates.length,
      candidates: feedCandidates.slice(0, 80),
      probes: feedProbes,
      usefulFeeds: usefulFeeds.slice(0, 20)
    },
    sample: compact(text).slice(0, sampleChars),
    error: page.error || null,
    nextSteps: usefulFeeds.length
      ? ['Useful x/feed candidate(s) found. Send the feed probe output back; B19 can parse the compact Livesport feed tokens into score/events/cards.']
      : ['B19 can use browser-confirmed 2.flashscore.ninja/2/x/feed shape. If usefulFeeds is empty, test source=flashscore-details because B19 exact parser may still use df_sui directly.']
  };
}


function extractFlashscoreMidParam(url) {
  try {
    const u = new URL(url);
    const mid = u.searchParams.get('mid');
    if (mid && /^[A-Za-z0-9]{6,20}$/.test(mid)) return mid;
  } catch {}
  return null;
}

function extractFlashscoreMatchKeyFromHtml(html = '') {
  const raw = String(html || '');
  const midMatch = raw.match(/[?&]mid=([A-Za-z0-9]{6,20})\b/i);
  if (midMatch) return midMatch[1];
  const idLike = raw.match(/\b(?:eventId|matchId|match_id|id)\s*[:=]\s*["']?([A-Za-z0-9]{6,20})["']?/i);
  if (idLike) return idLike[1];
  return null;
}

function looksLikeBadFlashscoreMatchKey(key, html = '') {
  const s = String(key || '').trim();
  if (!s) return true;
  // Real Flashscore match ids used by x/feed are usually short mixed alpha-numeric keys (e.g. QqzwxwWH).
  // Numeric-only ids are common in the static shell and often resolve to empty feeds like A1÷¬~.
  if (/^\d{6,20}$/.test(s)) return true;
  const raw = String(html || '');
  if (raw && /Loading\.\.\./i.test(htmlToText(raw)) && /^\d+$/.test(s)) return true;
  return false;
}

function summarizeFlashscoreMcResolver(pack) {
  if (!pack) return null;
  return {
    ok: !!pack.ok,
    source: pack.source || 'flashscore-mc-resolver-b20',
    matchKey: pack.matchKey || null,
    score: pack.score || 0,
    candidate: pack.candidate || null,
    error: pack.error || null
  };
}

function extractFlashscoreUrlSignals(input) {
  const raw = String(input || '');
  let path = raw;
  try { path = new URL(raw).pathname; } catch {}
  const parts = path.split('/').map(x => decodeURIComponentSafe(x)).filter(Boolean);
  const matchIdx = parts.findIndex(p => p === 'match' || p === 'game');
  const afterMatch = matchIdx >= 0 ? parts.slice(matchIdx + 1) : parts;
  const teamSegments = afterMatch.filter(p => p && p !== 'football' && !/^(match|game)$/i.test(p)).slice(0, 4);
  const teamIds = [];
  const nameTerms = [];
  const slugTerms = [];
  for (const seg of teamSegments) {
    const tokens = seg.split('-').filter(Boolean);
    const maybeId = tokens[tokens.length - 1] || '';
    if (/^[A-Za-z0-9]{6,12}$/.test(maybeId)) teamIds.push(maybeId);
    const name = tokens.slice(0, /^[A-Za-z0-9]{6,12}$/.test(maybeId) ? -1 : tokens.length).join(' ');
    if (name) nameTerms.push(name);
    if (seg) slugTerms.push(seg);
  }
  return {
    raw,
    path,
    teamSegments,
    teamIds: dedupeStrings(teamIds),
    nameTerms: dedupeStrings(nameTerms.map(normalize).filter(Boolean)),
    slugTerms: dedupeStrings(slugTerms.map(normalize).filter(Boolean)),
    queryMid: extractFlashscoreMidParam(raw)
  };
}

function parseFlashscoreMcCandidates(raw, signals, feedUrl, opts = {}) {
  const text = String(raw || '');
  if (!text || text === '0') return [];
  const chunks = splitFlashscoreMcRecords(text);
  const candidates = [];
  for (const chunk of chunks) {
    const pairs = parseLivesportPairs(chunk);
    const matchKey = valueFor(pairs, 'AA') || valueFor(pairs, 'AB') || guessMatchKeyFromChunk(chunk);
    if (!matchKey || !/^[A-Za-z0-9]{6,20}$/.test(matchKey)) continue;
    const score = scoreMcCandidate(chunk, signals);
    candidates.push({
      matchKey,
      score,
      feedUrl,
      text: compact(chunk).slice(0, clampNumber(opts.mcCandidateChars || 900, 200, 3000)),
      fields: Object.fromEntries(pairs.slice(0, 80))
    });
  }
  // Some mc feeds may not use AA blocks; fall back to a raw-window match around URL tokens.
  if (!candidates.length && hasAnyTargetToken(text, signals)) {
    const keys = Array.from(new Set((text.match(/\b[A-Za-z]{1,4}[A-Za-z0-9]{5,16}\b/g) || []).filter(k => /[A-Za-z]/.test(k) && /[0-9]/.test(k))));
    for (const key of keys.slice(0, 20)) {
      candidates.push({ matchKey: key, score: scoreMcCandidate(text, signals) - 8, feedUrl, text: compact(windowAround(text, key, 500)), fields: {} });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function splitFlashscoreMcRecords(raw) {
  const s = String(raw || '').replace(/\r?\n/g, '');
  const out = [];
  const re = /(?:^|[¬~])AA÷([A-Za-z0-9]{6,20})([\s\S]*?)(?=(?:[¬~]AA÷[A-Za-z0-9]{6,20})|$)/g;
  let m;
  while ((m = re.exec(s))) {
    out.push(`AA÷${m[1]}${m[2] || ''}`);
  }
  if (out.length) return out;
  return s.split('¬~').map(x => x.trim()).filter(x => x.includes('÷'));
}

function scoreMcCandidate(chunk, signals = {}) {
  const raw = String(chunk || '');
  const hayRaw = raw.toLowerCase();
  const hay = normalize(raw);
  let score = 0;
  const ids = signals.teamIds || [];
  const names = signals.nameTerms || [];
  const slugs = signals.slugTerms || [];
  let idHits = 0;
  for (const id of ids) {
    if (id && hayRaw.includes(String(id).toLowerCase())) { score += 32; idHits += 1; }
  }
  if (idHits >= 2) score += 36;
  let nameHits = 0;
  for (const term of names) {
    if (term && term.length >= 3 && hay.includes(term)) { score += 18; nameHits += 1; }
  }
  if (nameHits >= 2) score += 30;
  for (const slug of slugs) {
    if (slug && slug.length >= 6 && hay.includes(slug.replace(/-/g, ' '))) score += 10;
  }
  if (/\bAA÷[A-Za-z0-9]{6,20}/.test(raw)) score += 6;
  if (/\b(?:AD|AE|AF|AG|AH|AJ|AK|CX|AX|BX|WM|WU|WN|AF)÷/i.test(raw)) score += 4;
  return score;
}

function hasAnyTargetToken(raw, signals = {}) {
  const s = String(raw || '').toLowerCase();
  for (const id of signals.teamIds || []) if (id && s.includes(String(id).toLowerCase())) return true;
  const n = normalize(raw || '');
  for (const term of signals.nameTerms || []) if (term && term.length >= 3 && n.includes(term)) return true;
  return false;
}

function compactCandidate(c) {
  return {
    matchKey: c.matchKey,
    score: c.score,
    feedUrl: c.feedUrl,
    text: compact(c.text || '').slice(0, 900),
    fields: c.fields || {}
  };
}

function guessMatchKeyFromChunk(chunk) {
  const m = String(chunk || '').match(/\b[A-Za-z]{1,4}[A-Za-z0-9]{5,16}\b/);
  return m ? m[0] : null;
}

function windowAround(text, needle, radius = 400) {
  const s = String(text || '');
  const i = s.indexOf(String(needle || ''));
  if (i < 0) return s.slice(0, radius * 2);
  return s.slice(Math.max(0, i - radius), Math.min(s.length, i + String(needle).length + radius));
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function normalizeFlashscoreFeedToken(token, matchKey) {
  let t = String(token || '').trim();
  if (!t) t = 'df_sui_';
  if (t.includes(matchKey)) return t;
  t = t.replace(/^\/x\/feed\//i, '').replace(/^x\/feed\//i, '');
  if (t.endsWith('_')) return `${t}1_${matchKey}`;
  if (/^(?:dc|di|dm|ds|du|h|g|tr|lf|lb|le|lm)$/i.test(t)) return `${t}_1_${matchKey}`;
  if (/^df_[a-z0-9]+$/i.test(t)) return `${t}_1_${matchKey}`;
  return `${t}_1_${matchKey}`;
}

function dedupeFeedCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const url = String(c?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(c);
  }
  return out;
}

async function fetchFlashscoreFeedB19(url, opts = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
        'referer': opts.referer || 'https://www.flashscore.com/',
        'user-agent': opts.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        'sec-ch-ua-platform': '"iOS"',
        'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        'sec-ch-ua-mobile': '?1',
        'x-fsign': opts.xFsign || 'SW9D1eZo'
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

function flashscoreInitialToken(value) {
  const s = String(value || '').trim().replace(/[’'′]+$/g, '');
  return /^\p{L}\.?$/u.test(s) ? `${s.charAt(0).toUpperCase()}.` : '';
}

function normalizeFlashscorePlayerName(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  let commaNormalized = false;
  if (!text) return '';
  if (text.includes(',')) {
    const chunks = text.split(',').map(x => x.trim()).filter(Boolean);
    if (chunks.length >= 2) {
      text = `${chunks.slice(1).join(' ')} ${chunks[0]}`;
      commaNormalized = true;
    }
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return text;
  const firstInitial = flashscoreInitialToken(parts[0]);
  const lastInitial = flashscoreInitialToken(parts[parts.length - 1]);
  if (commaNormalized) return firstInitial ? `${firstInitial} ${parts.slice(1).join(' ')}` : text;
  if (firstInitial) return `${firstInitial} ${parts.slice(1).join(' ')}`;
  if (lastInitial) return `${lastInitial} ${parts.slice(0, -1).join(' ')}`;
  // Flashscore/Livesport event feeds use surname-first player labels.
  return `${parts.slice(1).join(' ')} ${parts[0]}`;
}

function flashscoreOwnGoal(item = {}) {
  const text = `${item.type || ''} ${item.label || ''} ${item.reason || ''}`.toLowerCase();
  return !!(item.og === true || item.ownGoal === true || item.isOwnGoal === true || /own[ _-]?goal|autogol|öngól/.test(text));
}

function flashscorePenaltyGoal(item = {}) {
  const text = `${item.type || ''} ${item.label || ''} ${item.reason || ''}`.toLowerCase();
  return !!(item.penalty === true || item.pen === true || item.pk === true || item.fromPenalty === true || item.code === 10 || /penalty|spot kick|11m/.test(text));
}

function parseFlashscoreSuiFeed(raw) {
  const text = String(raw || '');
  const events = [];
  const scorers = [];
  const yellowCards = [];
  const redCards = [];
  const doubleYellowCards = [];
  const substitutions = [];
  const penalties = [];
  const meta = {};
  let currentPeriod = null;

  const blocks = text.split('¬~').map(x => x.trim()).filter(Boolean);
  for (const block of blocks) {
    if (block.startsWith('AC÷')) {
      const pairs = parseLivesportPairs(block);
      currentPeriod = valueFor(pairs, 'AC') || currentPeriod;
      continue;
    }
    if (block.replace(/^~+/, '').startsWith('MIT÷') || block.includes('¬MIT÷') || block.includes('¬~MIT÷')) {
      parseFlashscoreMeta(block, meta);
      continue;
    }
    if (!block.startsWith('III÷')) continue;
    const parsed = parseFlashscoreEventBlock(block, currentPeriod);
    if (!parsed) continue;
    events.push(...parsed.timeline);
    scorers.push(...parsed.goals);
    yellowCards.push(...parsed.yellowCards);
    redCards.push(...parsed.redCards);
    doubleYellowCards.push(...parsed.doubleYellowCards);
    substitutions.push(...parsed.substitutions);
    penalties.push(...parsed.penalties);
  }

  parseFlashscorePrematchFields(text, meta);
  const lastGoal = [...scorers].reverse().find(g => Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore));
  const score = lastGoal ? { h: lastGoal.homeScore, a: lastGoal.awayScore, raw: `${lastGoal.homeScore}-${lastGoal.awayScore}` } : null;
  return { events, scorers, yellowCards, redCards, doubleYellowCards, substitutions, penalties, meta, score };
}

function parseFlashscoreEventBlock(block, period) {
  const pairs = parseLivesportPairs(block);
  if (!pairs.length) return null;
  const eventId = valueFor(pairs, 'III');
  const sideRaw = valueFor(pairs, 'IA');
  const minute = normalizeMinute(valueFor(pairs, 'IB'));
  const side = sideRaw === '1' ? 'home' : sideRaw === '2' ? 'away' : null;
  const base = { eventId, side, sideRaw, teamSide: side, minute, period, raw: block };
  const items = [];
  let current = null;
  let scoreAfter = {};

  for (const [key, value] of pairs) {
    if (key === 'IE') {
      current = { ...base, code: Number(value), codeRaw: value, type: eventCodeLabel(value) };
      items.push(current);
      continue;
    }
    if (key === 'INX') {
      scoreAfter.homeScore = toIntOrNull(value);
      if (current) current.homeScore = scoreAfter.homeScore;
      continue;
    }
    if (key === 'IOX') {
      scoreAfter.awayScore = toIntOrNull(value);
      if (current) current.awayScore = scoreAfter.awayScore;
      continue;
    }
    if (!current) continue;
    if (key === 'IF') { current.player = normalizeFlashscorePlayerName(value); current.playerNameOrder = 'given-first'; }
    else if (key === 'IU') current.playerUrl = value;
    else if (key === 'IM') current.playerId = value;
    else if (key === 'IK') current.label = value;
    else if (key === 'ICT') current.context = value;
    else if (key === 'IJ') current.reasonCode = value;
    else if (key === 'IL') current.reason = value;
    else if (key === 'ID') current.detailId = value;
  }

  for (const item of items) {
    if (item.homeScore == null && scoreAfter.homeScore != null && isGoalItem(item)) item.homeScore = scoreAfter.homeScore;
    if (item.awayScore == null && scoreAfter.awayScore != null && isGoalItem(item)) item.awayScore = scoreAfter.awayScore;
  }

  const timeline = [];
  const goals = [];
  const yellowCards = [];
  const redCards = [];
  const doubleYellowCards = [];
  const substitutions = [];
  const penalties = [];
  let lastGoal = null;
  let pendingSubOut = null;

  for (const item of items) {
    const clean = cleanEventItem(item);
    timeline.push(clean);
    if (isGoalItem(clean)) {
      const penalty = flashscorePenaltyGoal(clean);
      const goal = { ...clean, type: penalty ? 'penalty_goal' : 'goal', penalty, og: flashscoreOwnGoal(clean), playerNameOrder: 'given-first' };
      goals.push(goal);
      lastGoal = goal;
      if (goal.type === 'penalty_goal') penalties.push({ ...goal, type: 'penalty_scored' });
    } else if (clean.code === 8 || /assist/i.test(clean.label || '')) {
      if (lastGoal) {
        lastGoal.assist = {
          player: clean.player || null,
          playerUrl: clean.playerUrl || null,
          playerId: clean.playerId || null
        };
      }
    } else if (clean.code === 1 || /yellow card/i.test(clean.label || '')) {
      yellowCards.push(clean);
    } else if (clean.code === 2 || /red card/i.test(clean.label || '')) {
      redCards.push(clean);
    } else if (/second yellow|double yellow/i.test(clean.label || '')) {
      doubleYellowCards.push(clean);
    } else if (clean.code === 5 || /penalty awarded/i.test(clean.label || '')) {
      penalties.push({ ...clean, type: 'penalty_awarded' });
    } else if (clean.code === 6 || /substitution - out/i.test(clean.label || '')) {
      pendingSubOut = clean;
    } else if (clean.code === 7 || /substitution - in/i.test(clean.label || '')) {
      substitutions.push({
        eventId,
        side,
        sideRaw,
        teamSide: side,
        minute,
        period,
        type: 'substitution',
        out: pendingSubOut ? pickPlayer(pendingSubOut) : null,
        in: pickPlayer(clean),
        reason: pendingSubOut?.reason || clean.reason || null,
        reasonCode: pendingSubOut?.reasonCode || clean.reasonCode || null
      });
      pendingSubOut = null;
    } else if (clean.code === 47 || /not on pitch/i.test(clean.label || '')) {
      const lastCard = yellowCards[yellowCards.length - 1] || redCards[redCards.length - 1];
      if (lastCard && lastCard.eventId === clean.eventId) lastCard.notOnPitch = true;
    }
  }

  return { timeline, goals, yellowCards, redCards, doubleYellowCards, substitutions, penalties };
}

function parseLivesportPairs(block) {
  const out = [];
  for (const raw of String(block || '').split('¬')) {
    if (!raw.includes('÷')) continue;
    const idx = raw.indexOf('÷');
    const key = raw.slice(0, idx).replace(/^~+/, '').trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out.push([key, value]);
  }
  return out;
}

function parseFlashscoreMeta(block, meta) {
  const pairs = parseLivesportPairs(block);
  let currentKey = null;
  for (const [key, value] of pairs) {
    if (key === 'MIT') currentKey = value;
    else if (key === 'MIV' && currentKey) {
      meta[flashscoreMetaKey(currentKey)] = value;
      currentKey = null;
    }
  }
}

function parseFlashscorePrematchFields(raw, meta) {
  const pairs = parseLivesportPairs(raw);
  const broadcastRaw = lastValueFor(pairs, 'TVT') || lastValueFor(pairs, 'TA');
  const fallbackBroadcastRaw = lastValueFor(pairs, 'TA');
  const bookmakerRaw = lastValueFor(pairs, 'TVB');
  if (broadcastRaw) {
    meta.broadcastRaw = broadcastRaw;
    meta.tvChannels = splitFlashscoreList(broadcastRaw);
  } else if (fallbackBroadcastRaw) {
    meta.broadcastRaw = fallbackBroadcastRaw;
    meta.tvChannels = splitFlashscoreList(fallbackBroadcastRaw);
  }
  if (bookmakerRaw) meta.bookmakers = splitFlashscoreList(bookmakerRaw);
}

function parseFlashscoreDcFeed(raw) {
  const pairs = parseLivesportPairs(raw);
  const scheduledRaw = lastValueFor(pairs, 'DD') || lastValueFor(pairs, 'DC');
  const scheduledAtUnix = toIntOrNull(scheduledRaw);
  const availableSectionsRaw = lastValueFor(pairs, 'DX');
  return {
    scheduledAtUnix: Number.isFinite(scheduledAtUnix) ? scheduledAtUnix : null,
    scheduledAt: Number.isFinite(scheduledAtUnix) ? new Date(scheduledAtUnix * 1000).toISOString() : null,
    statusCode: lastValueFor(pairs, 'DS'),
    phaseCode: lastValueFor(pairs, 'DI'),
    liveCode: lastValueFor(pairs, 'DL'),
    availableSections: availableSectionsRaw ? availableSectionsRaw.split(',').map(x => x.trim()).filter(Boolean) : [],
    imageUrl: lastValueFor(pairs, 'DEI') || null
  };
}

function mergeFlashscoreMeta(meta = {}, dc = null) {
  const out = { ...(meta || {}) };
  if (dc?.scheduledAt) out.scheduledAt = dc.scheduledAt;
  if (dc?.scheduledAtUnix != null) out.scheduledAtUnix = dc.scheduledAtUnix;
  if (dc?.availableSections?.length) out.availableSections = dc.availableSections;
  if (dc?.imageUrl) out.imageUrl = dc.imageUrl;
  if (dc?.statusCode != null) out.statusCode = dc.statusCode;
  if (dc?.phaseCode != null) out.phaseCode = dc.phaseCode;
  if (dc?.liveCode != null) out.liveCode = dc.liveCode;
  return out;
}

function hasMeaningfulPrematchMeta(meta = {}) {
  return !!(
    meta.venue || meta.town || meta.capacity || meta.attendance || meta.referee ||
    meta.broadcastRaw || (meta.tvChannels || []).length || (meta.bookmakers || []).length
  );
}

function hasMeaningfulDcData(dc = {}) {
  return !!(
    dc.scheduledAt || dc.imageUrl || (dc.availableSections || []).length ||
    dc.statusCode != null || dc.phaseCode != null || dc.liveCode != null
  );
}

function emptyFlashscoreParsedFeed() {
  return {
    events: [],
    scorers: [],
    yellowCards: [],
    redCards: [],
    doubleYellowCards: [],
    substitutions: [],
    penalties: [],
    meta: {},
    score: null
  };
}

function splitFlashscoreList(value) {
  return dedupeStrings(String(value || '').split(',').map(x => x.trim()).filter(Boolean));
}

function lastValueFor(pairs, key) {
  for (let i = (pairs || []).length - 1; i >= 0; i -= 1) {
    if (pairs[i]?.[0] === key) return pairs[i][1];
  }
  return null;
}

function flashscoreMetaKey(key) {
  const map = {
    REF: 'referee',
    RCO: 'refereeCountryId',
    RTY: 'refereeType',
    RCC: 'refereeCountryCode',
    VEN: 'venue',
    TWN: 'town',
    ATT: 'attendance',
    CAP: 'capacity'
  };
  return map[key] || key;
}

function valueFor(pairs, key) {
  const found = pairs.find(([k]) => k === key);
  return found ? found[1] : null;
}

function eventCodeLabel(codeRaw) {
  const code = Number(codeRaw);
  const map = {
    1: 'yellow_card',
    2: 'red_card',
    3: 'goal',
    5: 'penalty_awarded',
    6: 'substitution_out',
    7: 'substitution_in',
    8: 'assist',
    10: 'penalty_goal',
    47: 'not_on_pitch'
  };
  return map[code] || `event_${codeRaw}`;
}

function isGoalItem(item) {
  return item?.code === 3 || item?.code === 10 || /\bgoal\b|\bpenalty\b/i.test(item?.label || '') && !/awarded/i.test(item?.label || '');
}

function cleanEventItem(item) {
  return {
    eventId: item.eventId || null,
    side: item.side || null,
    sideRaw: item.sideRaw || null,
    teamSide: item.teamSide || item.side || null,
    minute: item.minute || null,
    period: item.period || null,
    code: Number.isFinite(item.code) ? item.code : null,
    type: item.type || null,
    label: item.label || item.type || null,
    player: item.player || null,
    playerNameOrder: item.playerNameOrder || (item.player ? 'given-first' : null),
    playerUrl: item.playerUrl || null,
    playerId: item.playerId || null,
    homeScore: item.homeScore ?? null,
    awayScore: item.awayScore ?? null,
    og: flashscoreOwnGoal(item),
    penalty: flashscorePenaltyGoal(item),
    reason: item.reason || null,
    reasonCode: item.reasonCode || null
  };
}

function pickPlayer(item) {
  return item ? { player: item.player || null, playerUrl: item.playerUrl || null, playerId: item.playerId || null } : null;
}

function normalizeMinute(value) {
  return String(value || '').replace(/'/g, '').trim() || null;
}

function toIntOrNull(value) {
  const n = Number(String(value || '').replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function mergeDetail(row, detail) {
  const state = detail?.state || (detail?.score ? 'event_feed' : (detail?.meta && Object.keys(detail.meta).length ? 'prematch' : 'unknown'));
  return {
    id: row.id,
    group: 'SL',
    round: row.r || null,
    homeTeam: row.h,
    awayTeam: row.a,
    date: row.date,
    started: state !== 'prematch' && !!(detail?.score || detail?.events?.length),
    finished: false,
    status: state === 'prematch' ? 'PREMATCH' : (detail?.score ? 'DETAIL_SCORE' : null),
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
    penalties: detail?.penalties || [],
    matchMeta: detail?.meta || {},
    flashscoreState: state,
    prematch: state === 'prematch',
    eventSource: 'flashscore',
    scoreSource: detail?.score ? 'flashscore' : null,
    source: 'flashscore',
    flashscoreUrl: row.flashscoreUrl,
    updatedAt: new Date().toISOString()
  };
}

function extractMatchLinks(html, baseUrl) {
  const out = [];
  if (!html) return out;
  const re = /<a\b[^>]*href\s*=\s*['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = decodeHtml(m[1] || '').trim();
    const fullUrl = toAbsoluteUrl(href, baseUrl);
    if (!fullUrl) continue;
    if (!/\/(match|game)\//i.test(fullUrl)) continue;
    const inner = m[2] || '';
    const text = compact(htmlToText(inner));
    const around = html.slice(Math.max(0, m.index - 420), Math.min(html.length, re.lastIndex + 420));
    const context = compact(htmlToText(around));
    const label = text || context.slice(0, 120);
    if (!/[-–— v ]/i.test(label) && !/[-–— v ]/i.test(context)) continue;
    out.push({ url: fullUrl, text: label, context });
  }
  return out;
}

function scoreFixtureLink(fixture, label, context = '') {
  const hayLabel = normalize(label);
  const hayContext = normalize(`${label} ${context}`);
  const homeAliases = aliasesFor(fixture.h);
  const awayAliases = aliasesFor(fixture.a);
  const homeLabel = bestAliasHit(hayLabel, homeAliases);
  const awayLabel = bestAliasHit(hayLabel, awayAliases);
  const homeAny = homeLabel || bestAliasHit(hayContext, homeAliases);
  const awayAny = awayLabel || bestAliasHit(hayContext, awayAliases);
  let score = 0;
  if (homeLabel) score += 18;
  if (awayLabel) score += 18;
  if (!homeLabel && homeAny) score += 8;
  if (!awayLabel && awayAny) score += 8;
  if (homeAny && awayAny) {
    const hi = hayContext.indexOf(homeAny);
    const ai = hayContext.indexOf(awayAny);
    const dist = Math.abs(hi - ai);
    if (dist <= 80) score += 12;
    if (hi >= 0 && ai >= 0 && hi < ai) score += 4;
  }
  const d = fixture.date ? String(fixture.date).slice(5, 10).split('-').reverse().join('.') : '';
  const d2 = fixture.date ? String(fixture.date).slice(5, 10).split('-').reverse().join('/') : '';
  if (d && (hayContext.includes(d) || hayContext.includes(d2))) score += 4;
  return score;
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

function aliasesFor(name) {
  const n = normalize(name);
  const common = {
    'fc voluntari': ['fc voluntari', 'voluntari'],
    'fc botosani': ['fc botosani', 'botosani'],
    'fcsb': ['fcsb', 'steaua bucuresti'],
    'fc arges': ['fc arges', 'arges', 'campionii arges', 'acs champions fc arges', 'arges pitesti'],
    'otelul galati': ['otelul galati', 'otelul', 'otelul galati'],
    'cfr cluj': ['cfr cluj', 'cluj'],
    'universitatea craiova': ['universitatea craiova', 'univ craiova', 'u craiova', 'craiova', 'cs universitatea craiova'],
    'uta arad': ['uta arad', 'fc uta arad', 'uta'],
    'universitatea cluj': ['universitatea cluj', 'u cluj', 'univ cluj', 'cluj'],
    'farul constanta': ['farul constanta', 'farul', 'fcv farul constanta'],
    'petrolul ploiesti': ['petrolul ploiesti', 'petrolul'],
    'dinamo': ['dinamo', 'dinamo bucuresti'],
    'corvinul hunedoara': ['corvinul hunedoara', 'corvinul'],
    'csikszereda': ['csikszereda', 'miercurea ciuc', 'csikszereda m ciuc'],
    'rapid bucuresti': ['rapid bucuresti', 'fc rapid 1923', 'rapid'],
    'sepsi osk': ['sepsi osk', 'sepsi', 'sepsi sf gheorghe']
  };
  const extra = common[n] || [];
  return dedupe([name, n, ...extra]);
}


function buildFlashscoreDetailSignals(text, html = '') {
  const body = compact(text);
  const raw = String(html || '');
  return {
    loadingShell: /Loading\.\.\./i.test(body),
    hasGoalWords: /\b(goal|goalscorer|scorer|marcat|gol)\b/i.test(body),
    hasCardWords: /\b(yellow card|red card|card|cartonas|galben|rosu)\b/i.test(body),
    hasLineupWords: /\b(lineup|line-up|formation|starting)\b/i.test(body),
    hasSummaryWords: /\b(summary|match summary|match report|details|incidents)\b/i.test(body),
    hasFlashscoreFeedHints: /x\/feed|d\.flashscore|x-fsign|SW9D1eZo/i.test(raw),
    gamblingPhoneTextPresent: /09\s*[- ]\s*74\s*[- ]\s*75\s*[- ]\s*13\s*[- ]\s*13/.test(body)
  };
}

function parseScoreFromTextSafely(text, signals = {}) {
  // Flashscore static HTML often contains phone numbers like 09-74-75-13-13.
  // Never accept a score from a shell page unless real match-detail signals exist.
  const hasRealMatchSignals = !!(signals.hasGoalWords || signals.hasCardWords || signals.hasSummaryWords || signals.hasLineupWords);
  if (!hasRealMatchSignals || signals.loadingShell) return null;
  const s = compact(text);
  const candidates = [];
  const re = /\b(\d{1,2})\s*[-:–]\s*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(s))) {
    const raw = m[0];
    const before = s.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    const after = s.slice(re.lastIndex, re.lastIndex + 60).toLowerCase();
    if (looksLikePhoneOrAdScoreFalsePositive(raw, before, after)) continue;
    const h = Number(m[1]);
    const a = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    if (h > 25 || a > 25) continue;
    candidates.push({ h, a, raw, context: compact(`${before} ${raw} ${after}`).slice(0, 160) });
  }
  return candidates[0] || null;
}

function looksLikePhoneOrAdScoreFalsePositive(raw, before, after) {
  const around = `${before} ${raw} ${after}`.toLowerCase();
  if (/joueurs-info-service|responsabil|gambl|pari|wett|appel non surtax|18\+/.test(around)) return true;
  if (/\b09\s*[-:]\s*74\b/.test(raw) || /09\s*[- ]\s*74\s*[- ]\s*75\s*[- ]\s*13/.test(around)) return true;
  if (/\b\d{2}\s*[- ]\s*\d{2}\s*[- ]\s*\d{2}\s*[- ]\s*\d{2}\b/.test(around)) return true;
  return false;
}

function isFlashscoreMatchKey(value) {
  const s = String(value || '').trim();
  // Flashscore/Livesport match keys can be letters-only too (e.g. QqzwxwWH).
  // Keep it conservative enough to avoid URLs/query strings.
  return /^[A-Za-z0-9]{6,20}$/.test(s) && /[A-Za-z]/.test(s) && !/[\/?#:&=]/.test(s);
}

function extractFlashscoreMatchKey(url, html = '') {
  return extractFlashscoreMidParam(url) || extractFlashscoreMatchKeyFromHtml(html);
}

function extractScriptSources(html, baseUrl) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const full = toAbsoluteUrl(decodeHtml(m[1] || ''), baseUrl);
    if (!full) continue;
    out.push(full);
  }
  return dedupeStrings(out);
}

function extractInlineScripts(html) {
  const out = [];
  const re = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const s = String(m[1] || '').trim();
    if (s) out.push(s);
  }
  return out;
}

function extractEndpointCandidates(raw, baseUrl) {
  const out = [];
  const s = String(raw || '');
  const urlRe = /(?:https?:)?\/\/[^\s"'<>\\)]+/gi;
  let m;
  while ((m = urlRe.exec(s))) {
    const cleaned = cleanupCandidateUrl(m[0], baseUrl);
    if (cleaned && isInterestingEndpoint(cleaned)) out.push(cleaned);
  }
  const pathRe = /\/(?:x\/feed|api|ajax|feed|match|event|events|incidents|lineups|summary|detail|df|sport|football)[^\s"'<>\\)]{0,180}/gi;
  while ((m = pathRe.exec(s))) {
    const cleaned = cleanupCandidateUrl(m[0], baseUrl);
    if (cleaned && isInterestingEndpoint(cleaned)) out.push(cleaned);
  }
  return dedupeStrings(out).slice(0, 400);
}

function cleanupCandidateUrl(value, baseUrl) {
  let v = decodeHtml(String(value || '')).trim();
  if (!v) return null;
  v = v.replace(/[),.;]+$/g, '');
  if (v.startsWith('//')) v = `https:${v}`;
  if (v.startsWith('/')) v = toAbsoluteUrl(v, baseUrl);
  if (!v) return null;
  if (/\$\{|__webpack|chunk|\.map$/.test(v)) return null;
  return v;
}

function isInterestingEndpoint(url) {
  const s = String(url || '').toLowerCase();
  return /flashscore|livesport|\/x\/feed|\/api|\/ajax|event|incident|summary|lineup|match|football|df_/.test(s);
}

function extractFeedTokens(raw) {
  const out = [];
  const s = String(raw || '');
  const patterns = [
    /\b(?:dc|di|df|dg|dh|dl|dm|ds|du|h|g|tr|lf|lb|le|lm|li|st)(?:_[a-z0-9]+){0,5}_[A-Za-z0-9]{6,16}\b/g,
    /x\/feed\/([A-Za-z0-9_\-]{6,80})/g,
    /\bdf_[a-z0-9_]{2,40}\b/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s))) out.push(m[1] || m[0]);
  }
  return dedupeStrings(out).slice(0, 400);
}

function buildFlashscoreFeedCandidates(matchKey, endpointCandidates = [], feedTokens = [], refererUrl = '', opts = {}) {
  const out = [];
  const seen = new Set();
  const hosts = dedupeStrings([
    opts.feedHost || '',
    'https://2.flashscore.ninja/2',
    'https://d.flashscore.com',
    'https://2.flashscore.ninja'
  ].filter(Boolean));

  const add = (label, tokenOrUrl, reason, priority = 50) => {
    if (!tokenOrUrl) return;
    const raw = String(tokenOrUrl).trim();
    const urls = [];
    if (/^https?:\/\//i.test(raw)) {
      urls.push(raw);
    } else {
      const token = raw.replace(/^\/x\/feed\//i, '').replace(/^x\/feed\//i, '');
      if (!token || /\.(js|css|png|jpg|jpeg|svg|webp|woff2?)(\?|$)/i.test(token)) return;
      for (const host of hosts) urls.push(`${host.replace(/\/$/, '')}/x/feed/${token}`);
    }
    for (const url of urls) {
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ label, url, reason, priority });
    }
  };

  const cleanTokens = dedupeStrings(feedTokens)
    .map(t => String(t || '').trim())
    .filter(t => /^[A-Za-z0-9_\-]{4,140}$/.test(t))
    .filter(t => !/\.(js|css|png|jpg|jpeg|svg|webp|woff2?)(\?|$)/i.test(t));

  if (matchKey) {
    // Real match feeds are token + sportId + eventId. Prioritize those over bare discovered tokens.
    const discoveredPrefixes = [];
    for (const token of cleanTokens) {
      if (token.includes(matchKey)) {
        discoveredPrefixes.push(token);
      } else if (token.endsWith('_')) {
        discoveredPrefixes.push(`${token}1_${matchKey}`);
      } else if (/^df_[a-z0-9]+_$/i.test(token)) {
        discoveredPrefixes.push(`${token}1_${matchKey}`);
      }
    }

    const knownPrefixes = [
      'df_sui_', 'df_dos_', 'df_scr_', 'df_st_', 'df_li_', 'df_lu_', 'df_mh_', 'df_hh_', 'df_od_',
      'df_pv_', 'df_si_', 'df_br_', 'df_to_', 'df_tt_', 'df_tl_', 'df_psn_', 'df_psp_', 'df_nf_',
      'df_sur_', 'df_mhsn_', 'df_mhs_', 'df_hi_', 'df_mhn_', 'df_lc_', 'df_lcpo_', 'df_pi_', 'df_stn_', 'df_stp_', 'df_mr_',
      'dc_', 'di_', 'dm_', 'ds_', 'du_', 'h_', 'g_', 'tr_', 'lf_', 'lb_', 'le_', 'lm_'
    ];
    for (const token of dedupeStrings([...discoveredPrefixes, ...knownPrefixes.map(p => `${p}1_${matchKey}`)])) {
      add(`priority:${token}`, token, 'B19 priority token+footballSportId+matchKey probe', 1);
    }
  }

  for (const endpoint of endpointCandidates) {
    if (/\/x\/feed\//i.test(endpoint)) add('discovered-x-feed-url', endpoint, 'found in HTML/JS', 40);
  }

  // Bare tokens are last. They usually answer "0", but keep a few for diagnostics.
  for (const token of cleanTokens) {
    add(`bare-token:${token.slice(0, 36)}`, token, 'bare x/feed-like token found in HTML/JS; diagnostic only', 90);
  }

  return out
    .filter(x => !/\.(js|css|png|jpg|jpeg|svg|webp|woff2?)(\?|$)/i.test(x.url))
    .sort((a, b) => (a.priority || 50) - (b.priority || 50));
}

async function fetchFlashscoreFeed(url, opts = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const referer = opts.referer || 'https://www.flashscore.com/';
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'referer': referer,
        'origin': 'https://www.flashscore.com',
        'x-fsign': opts.xFsign || 'SW9D1eZo',
        'x-requested-with': 'XMLHttpRequest'
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

function analyzeFlashscoreFeedText(text) {
  const s = String(text || '');
  const compacted = compact(s);
  const htmlish = /^\s*</.test(s) || /<html|<!doctype/i.test(s);
  const counts = {
    aa: countOccurrences(s, '¬AA÷'),
    ab: countOccurrences(s, '¬AB÷'),
    ac: countOccurrences(s, '¬AC÷'),
    ad: countOccurrences(s, '¬AD÷'),
    ae: countOccurrences(s, '¬AE÷'),
    af: countOccurrences(s, '¬AF÷'),
    ag: countOccurrences(s, '¬AG÷'),
    ba: countOccurrences(s, '¬BA÷'),
    bb: countOccurrences(s, '¬BB÷'),
    abPlain: countOccurrences(s, 'AB÷'),
    acPlain: countOccurrences(s, 'AC÷'),
    incidentLike: countOccurrences(compacted.toLowerCase(), 'goal') + countOccurrences(compacted.toLowerCase(), 'card') + countOccurrences(compacted.toLowerCase(), 'substitution')
  };
  const hasLivesportDelimiters = /[¬÷~]/.test(s);
  const hasGoalWords = /\b(goal|goalscorer|scorer|penalty|own goal|marcat|gol)\b/i.test(compacted);
  const hasCardWords = /\b(yellow|red card|card|cartonas|galben|rosu)\b/i.test(compacted);
  const hasScoreish = /\b\d{1,2}\s*[-:–]\s*\d{1,2}\b/.test(compacted) || /(?:AG|AH|BA|BB|BC)÷\d/.test(s);
  return {
    htmlish,
    hasLivesportDelimiters,
    hasGoalWords,
    hasCardWords,
    hasScoreish,
    counts,
    nonEmpty: compacted.length > 0,
    looksUseful: !htmlish && compacted.length > 20 && (hasLivesportDelimiters || hasGoalWords || hasCardWords || hasScoreish)
  };
}

function keywordHits(text) {
  const s = String(text || '');
  const keys = ['x/feed', 'x-fsign', 'SW9D1eZo', 'incident', 'event', 'lineup', 'summary', 'matchId', 'eventId', 'goal', 'card', 'df_sui', 'df_dos', 'df_scr'];
  const out = {};
  for (const key of keys) out[key] = s.toLowerCase().includes(key.toLowerCase());
  return out;
}

function countOccurrences(s, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = String(s || '').indexOf(needle, idx)) >= 0) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function dedupeStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr || []) {
    const s = String(item || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function extractIncidentSamples(text) {
  const out = [];
  const chunks = compact(text).split(/(?<=[.!?])\s+|\s{2,}/).filter(Boolean);
  for (const chunk of chunks) {
    if (/\b(goal|scorer|yellow|red card|card|lineup|substitution|penalty|cartonas|galben|rosu|gol|marcat)\b/i.test(chunk)) {
      out.push(chunk.slice(0, 320));
    }
    if (out.length >= 30) break;
  }
  return out;
}

function parseScoreFromText(text) {
  const s = compact(text);
  const m = s.match(/\b(\d{1,2})\s*[-:–]\s*(\d{1,2})\b/);
  if (!m) return null;
  return { h: Number(m[1]), a: Number(m[2]), raw: m[0] };
}

function extractFlashscoreId(url) {
  const parts = String(url || '').split('/').filter(Boolean);
  const idx = parts.findIndex(p => p === 'match');
  if (idx >= 0) return parts.slice(idx + 1).join('/').replace(/\/$/, '');
  return null;
}

function normalizeFlashscoreUrl(input) {
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (input.startsWith('/')) return `https://www.flashscore.com${input}`;
  if (input.includes('/')) return `https://www.flashscore.com/match/${input}`;
  return null;
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
        'accept-language': 'en-US,en;q=0.9,ro;q=0.8,hu;q=0.7',
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

function extractFixtureSnippets(text, fixtures, radius = 360) {
  const out = [];
  const hay = normalize(text);
  for (const fixture of fixtures || []) {
    const home = aliasesFor(fixture.h).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
    const away = aliasesFor(fixture.a).map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
    const hi = findFirst(hay, home);
    const ai = findFirst(hay, away);
    if (hi.index < 0 || ai.index < 0) continue;
    const center = Math.min(hi.index, ai.index);
    out.push({ id: fixture.id, date: fixture.date, h: fixture.h, a: fixture.a, matchedHomeToken: hi.token, matchedAwayToken: ai.token, distance: Math.abs(hi.index - ai.index), snippet: compact(text).slice(Math.max(0, center - radius), center + radius) });
  }
  return out;
}

function findFirst(hay, needles) {
  let best = { index: -1, token: null };
  for (const needle of needles) {
    const idx = hay.indexOf(needle);
    if (idx >= 0 && (best.index < 0 || idx < best.index)) best = { index: idx, token: needle };
  }
  return best;
}

function htmlToText(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? compact(decodeHtml(m[1].replace(/<[^>]+>/g, ' '))) : null;
}

function toAbsoluteUrl(href, base) {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[șş]/g, 's').replace(/[țţ]/g, 't').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compact(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function firstNonEmpty(...values) {
  for (const value of values) {
    const s = String(value || '').trim();
    if (s) return s;
  }
  return '';
}

function splitList(value) { return String(value || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean); }
function isHttpUrl(value) { return /^https?:\/\//i.test(String(value || '')); }
function dedupe(arr) { return [...new Set((arr || []).filter(Boolean))]; }
function dedupeLinks(links) { const map = new Map(); for (const l of links || []) if (l?.url && !map.has(l.url)) map.set(l.url, l); return [...map.values()]; }
function clampNumber(value, min, max) { const n = Number(value); if (!Number.isFinite(n)) return min; return Math.max(min, Math.min(max, n)); }
