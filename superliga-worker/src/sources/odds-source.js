const DEFAULT_ODDS_API_BASE = 'https://global.ds.lsapp.eu/odds/pq_graphql';
const DEFAULT_BOOKMAKER_IDS = [516, 592, 817, 623, 965];

const BOOKMAKER_NAMES = {
  516: 'Betano.ro',
  592: 'Superbet.ro',
  817: 'MrBitRO',
  623: 'Unibetro',
  965: 'Getsbet'
};

const BET_TYPE = 'HOME_DRAW_AWAY';
const BET_SCOPE = 'FULL_TIME';

function toInt(value, fallback, min = 1, max = 1000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function asText(value) {
  return value == null ? '' : String(value).trim();
}

function decimal(value) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number > 1 && number < 1000
    ? Number(number.toFixed(3))
    : null;
}

function fixtureMid(fixture) {
  return asText(
    fixture?.flashscoreMid
      || fixture?.sourceIds?.flashscoreMid
      || fixture?.sourceIds?.flashscoreEventId
      || fixture?.sourceIds?.flashscore
  );
}

function parseBookmakerIds(value) {
  const raw = Array.isArray(value)
    ? value
    : asText(value).split(',');

  const ids = raw
    .map(item => Number(String(item || '').trim()))
    .filter(id => Number.isInteger(id) && id > 0);

  return [...new Set(ids.length ? ids : DEFAULT_BOOKMAKER_IDS)];
}

function selectionMode() {
  return 'single-bookmaker-priority';
}

function buildOddsUrl(env, eventId, bookmakerId) {
  const base = asText(env.FLASHSCORE_ODDS_API_BASE) || DEFAULT_ODDS_API_BASE;
  const url = new URL(base);
  url.searchParams.set('_hash', 'ope2');
  url.searchParams.set('eventId', eventId);
  url.searchParams.set('bookmakerId', String(bookmakerId));
  url.searchParams.set('betType', BET_TYPE);
  url.searchParams.set('betScope', BET_SCOPE);
  return url.toString();
}

function normalizeOutcome(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const value = decimal(raw.value);
  const opening = decimal(raw.opening);
  const previous = decimal(raw.change?.previous);

  return {
    value,
    opening,
    active: raw.active !== false,
    participantId: raw.eventParticipantId || null,
    change: {
      type: raw.change?.type || null,
      previous
    }
  };
}

function normalizeBookmakerPayload(data, bookmakerId, url) {
  const row = data?.data?.findPrematchOddsForBookmaker;
  if (!row || typeof row !== 'object') {
    return {
      ok: false,
      bookmakerId,
      bookmaker: BOOKMAKER_NAMES[bookmakerId] || `Bookmaker ${bookmakerId}`,
      url,
      error: 'missing_findPrematchOddsForBookmaker'
    };
  }

  const home = normalizeOutcome(row.home);
  const draw = normalizeOutcome(row.draw);
  const away = normalizeOutcome(row.away);
  const complete = !!(
    home?.active && draw?.active && away?.active
      && home.value && draw.value && away.value
  );

  return {
    ok: complete,
    complete,
    bookmakerId: Number(row.bookmakerId || bookmakerId),
    bookmaker: BOOKMAKER_NAMES[Number(row.bookmakerId || bookmakerId)]
      || `Bookmaker ${Number(row.bookmakerId || bookmakerId)}`,
    type: row.type || BET_TYPE,
    scope: BET_SCOPE,
    h: home?.value || null,
    d: draw?.value || null,
    a: away?.value || null,
    opening: {
      h: home?.opening || null,
      d: draw?.opening || null,
      a: away?.opening || null
    },
    active: {
      h: !!home?.active,
      d: !!draw?.active,
      a: !!away?.active
    },
    change: {
      h: home?.change || null,
      d: draw?.change || null,
      a: away?.change || null
    },
    participantIds: {
      home: home?.participantId || null,
      away: away?.participantId || null
    },
    feedTimestamp: Number(data?.extensions?.significantFeedTimestamp || 0) || null,
    url,
    error: complete ? null : 'incomplete_or_inactive_1x2'
  };
}

async function fetchJson(url, opts = {}) {
  const timeoutMs = toInt(opts.timeoutMs, 8000, 1000, 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-language': 'ro-RO,ro;q=0.9,en;q=0.8',
        referer: opts.referer || 'https://www.flashscore.ro/'
      },
      signal: controller.signal,
      cf: {
        cacheTtl: opts.force ? 0 : 60,
        cacheEverything: false
      }
    });

    const text = await response.text();
    let data = null;
    let parseError = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      parseError = error?.message || String(error);
    }

    return {
      ok: response.ok && !!data,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      data,
      textSample: data ? undefined : text.slice(0, 600),
      error: response.ok
        ? (parseError ? `invalid_json: ${parseError}` : null)
        : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      data: null,
      error: error?.name === 'AbortError'
        ? `timeout_after_${timeoutMs}ms`
        : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBookmakerOdds(env, fixture, bookmakerId, opts = {}) {
  const mid = fixtureMid(fixture);
  const url = buildOddsUrl(env, mid, bookmakerId);
  const response = await fetchJson(url, {
    ...opts,
    timeoutMs: opts.timeoutMs || env.FLASHSCORE_ODDS_TIMEOUT_MS,
    referer: fixture?.flashscoreUrl || fixture?.sourceIds?.flashscoreUrl || opts.referer
  });

  if (!response.ok) {
    return {
      ok: false,
      complete: false,
      bookmakerId,
      bookmaker: BOOKMAKER_NAMES[bookmakerId] || `Bookmaker ${bookmakerId}`,
      url,
      status: response.status,
      elapsedMs: response.elapsedMs,
      error: response.error || 'request_failed',
      textSample: response.textSample
    };
  }

  return {
    ...normalizeBookmakerPayload(response.data, bookmakerId, url),
    status: response.status,
    elapsedMs: response.elapsedMs
  };
}

function priorityResult(rows) {
  const chosen = rows.find(row => row?.complete);
  if (!chosen) return null;

  return {
    h: chosen.h,
    d: chosen.d,
    a: chosen.a,
    provider: chosen.bookmaker,
    providerId: chosen.bookmakerId,
    providers: {
      h: { bookmakerId: chosen.bookmakerId, bookmaker: chosen.bookmaker },
      d: { bookmakerId: chosen.bookmakerId, bookmaker: chosen.bookmaker },
      a: { bookmakerId: chosen.bookmakerId, bookmaker: chosen.bookmaker }
    },
    opening: chosen.opening,
    change: chosen.change,
    feedTimestamp: chosen.feedTimestamp
  };
}

async function fetchFixtureOdds(env, fixture, config, opts = {}) {
  const mid = fixtureMid(fixture);
  if (!mid) {
    return {
      ok: false,
      fixtureId: String(fixture?.id || ''),
      mid: null,
      mode: config.mode,
      requestCount: 0,
      rows: [],
      error: 'missing_flashscore_mid'
    };
  }

  const rows = [];

  for (const bookmakerId of config.bookmakerIds) {
    const row = await fetchBookmakerOdds(env, fixture, bookmakerId, opts);
    rows.push(row);

    // Never merge odds from different bookmakers. The first provider in the
    // configured priority list with a complete active 1-X-2 line wins.
    if (row.complete) break;
  }

  const selected = priorityResult(rows);

  if (!selected) {
    return {
      ok: false,
      fixtureId: String(fixture?.id || ''),
      mid,
      mode: config.mode,
      requestCount: rows.length,
      rows,
      error: 'no_complete_active_1x2'
    };
  }

  const updatedAt = new Date().toISOString();
  const books = rows
    .filter(row => row?.complete)
    .map(row => ({
      bookmakerId: row.bookmakerId,
      bookmaker: row.bookmaker,
      h: row.h,
      d: row.d,
      a: row.a,
      opening: row.opening,
      change: row.change,
      feedTimestamp: row.feedTimestamp
    }));

  return {
    ok: true,
    fixtureId: String(fixture.id),
    mid,
    mode: config.mode,
    requestCount: rows.length,
    rows,
    odds: {
      id: String(fixture.id),
      h: selected.h,
      d: selected.d,
      a: selected.a,
      provider: selected.provider,
      providerId: selected.providerId,
      providers: selected.providers,
      sourceMatchId: mid,
      sourceHomeTeam: fixture.h || null,
      sourceAwayTeam: fixture.a || null,
      opening: selected.opening,
      change: selected.change,
      market: {
        type: BET_TYPE,
        scope: BET_SCOPE
      },
      bookmakerCount: books.length,
      books,
      feedTimestamp: selected.feedTimestamp,
      feedUpdatedAt: selected.feedTimestamp
        ? new Date(selected.feedTimestamp * 1000).toISOString()
        : null,
      updatedAt,
      oddsSource: 'flashscore-graphql-single-bookmaker-b31a'
    }
  };
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => worker()
  );

  await Promise.all(workers);
  return output;
}

export async function fetchOdds(env, fixtures = [], opts = {}) {
  const selectedFixtures = Array.isArray(fixtures) ? fixtures.filter(Boolean) : [];
  const mode = selectionMode();
  const bookmakerIds = parseBookmakerIds(
    opts.bookmakerIds
      || env.FLASHSCORE_ODDS_BOOKMAKER_IDS
      || DEFAULT_BOOKMAKER_IDS
  );

  const maxBookmakers = toInt(
    opts.maxBookmakers || env.FLASHSCORE_ODDS_MAX_BOOKMAKERS,
    bookmakerIds.length,
    1,
    bookmakerIds.length
  );

  const maxFixtures = toInt(
    opts.maxFixtures || env.FLASHSCORE_ODDS_MAX_FIXTURES,
    24,
    1,
    80
  );

  const concurrency = toInt(
    opts.concurrency || env.FLASHSCORE_ODDS_CONCURRENCY,
    4,
    1,
    10
  );

  const targetFixtures = selectedFixtures.slice(0, maxFixtures);
  const config = {
    mode,
    bookmakerIds: bookmakerIds.slice(0, maxBookmakers)
  };

  const results = await mapLimit(
    targetFixtures,
    concurrency,
    fixture => fetchFixtureOdds(env, fixture, config, {
      ...opts,
      timeoutMs: opts.timeoutMs || env.FLASHSCORE_ODDS_TIMEOUT_MS
    })
  );

  const odds = {};
  const matched = [];
  const unmatched = [];
  let requestCount = 0;

  for (const result of results) {
    requestCount += Number(result?.requestCount || 0);

    if (result?.ok && result.odds?.id) {
      odds[result.odds.id] = result.odds;
      matched.push({
        fixtureId: result.odds.id,
        flashscoreMid: result.mid,
        mode: result.mode,
        h: result.odds.h,
        d: result.odds.d,
        a: result.odds.a,
        provider: result.odds.provider,
        providers: result.odds.providers,
        bookmakerCount: result.odds.bookmakerCount,
        requestCount: result.requestCount
      });
    } else {
      unmatched.push({
        fixtureId: result?.fixtureId || null,
        flashscoreMid: result?.mid || null,
        error: result?.error || 'unknown_error',
        requestCount: result?.requestCount || 0,
        probes: (result?.rows || []).map(row => ({
          bookmakerId: row.bookmakerId,
          bookmaker: row.bookmaker,
          status: row.status ?? null,
          complete: !!row.complete,
          error: row.error || null
        }))
      });
    }
  }

  const count = Object.keys(odds).length;
  const warnings = [];

  const requestedMode = asText(opts.oddsMode || opts.mode).toLowerCase();
  if (requestedMode === 'best') {
    warnings.push(
      'Best-odds mode is disabled. A complete 1-X-2 row from one bookmaker was used.'
    );
  }

  if (targetFixtures.length < selectedFixtures.length) {
    warnings.push(
      `Fixture limit applied: ${targetFixtures.length}/${selectedFixtures.length}.`
    );
  }

  if (unmatched.some(row => row.error === 'missing_flashscore_mid')) {
    warnings.push('Some fixtures have no flashscoreMid yet, so their odds were skipped.');
  }

  if (!count && targetFixtures.length) {
    warnings.push('No complete active HOME_DRAW_AWAY / FULL_TIME odds were returned.');
  }

  return {
    ok: true,
    source: 'flashscore-graphql-odds-b31a',
    odds,
    count,
    fetched: requestCount,
    matched,
    unmatched,
    warnings,
    mode,
    bookmakerIds: config.bookmakerIds,
    bookmakerNames: Object.fromEntries(
      config.bookmakerIds.map(id => [id, BOOKMAKER_NAMES[id] || `Bookmaker ${id}`])
    ),
    requestBudget: {
      selectedFixtureCount: targetFixtures.length,
      requestedBookmakerCount: config.bookmakerIds.length,
      actualRequestCount: requestCount,
      theoreticalMaximum:
        targetFixtures.length
        * config.bookmakerIds.length,
      concurrency,
      maxFixtures,
      mode
    },
    selection: {
      mode: 'single-bookmaker-priority',
      mixedBookmakers: false,
      rule: 'Use the first complete active 1-X-2 row in bookmaker priority order.'
    },
    endpoint: DEFAULT_ODDS_API_BASE,
    market: {
      type: BET_TYPE,
      scope: BET_SCOPE
    },
    updatedAt: new Date().toISOString()
  };
}
