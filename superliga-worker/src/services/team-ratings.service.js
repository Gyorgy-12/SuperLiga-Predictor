import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchEloFootballRatings } from '../sources/elofootball-source.js';
import { fetchTransfermarktMarketValues } from '../sources/transfermarkt-market-source.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { coordinatorRatingsCache } from './coordinator.service.js';

export async function readTeamRatings(env, opts = {}) {
  const publicRatings = await getDocument(
    env,
    COLLECTIONS.publicCache,
    PUBLIC_CACHE_DOCS.teamRatings
  ).catch(() => null);

  if (hasUsableRatingsData(publicRatings)) {
    return normalizePack(publicRatings, 'firestore-public-cache');
  }

  const publicElo = await getDocument(
    env,
    COLLECTIONS.publicCache,
    PUBLIC_CACHE_DOCS.elo
  ).catch(() => null);

  const publicMv = await getDocument(
    env,
    COLLECTIONS.publicCache,
    PUBLIC_CACHE_DOCS.marketValues
  ).catch(() => null);

  if (hasUsableRatingsData(publicElo) || hasUsableRatingsData(publicMv)) {
    return normalizePack(
      { ...(publicElo || {}), ...(publicMv || {}) },
      'firestore-public-cache-split'
    );
  }

  const durable = opts.skipCoordinatorCache
    ? null
    : await coordinatorRatingsCache(env).catch(() => null);

  if (hasUsableRatingsData(durable)) {
    return normalizePack(
      durable,
      durable.source || 'durable-object-cache'
    );
  }

  const [eloDocs, mvDocs] = await Promise.all([
    listDocuments(env, COLLECTIONS.elo, { pageSize: 80 }).catch(() => []),
    listDocuments(env, COLLECTIONS.marketValues, { pageSize: 80 }).catch(() => [])
  ]);

  const ratings = {};
  for (const doc of eloDocs) {
    const elo = Number(doc.elo ?? doc.rating);
    if (doc.id && Number.isFinite(elo)) ratings[doc.id] = elo;
  }

  const marketValues = {};
  for (const doc of mvDocs) {
    const valueM = Number(doc.valueM ?? doc.marketValueM);
    if (doc.id && Number.isFinite(valueM)) marketValues[doc.id] = valueM;
  }

  return normalizePack(
    { ratings, marketValues, updatedAt: null },
    eloDocs.length || mvDocs.length
      ? 'firestore-team-collections'
      : 'empty'
  );
}

export async function refreshEloRatings(env, opts = {}) {
  const fixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const previous = await readTeamRatings(
    env,
    { skipCoordinatorCache: true }
  ).catch(() => emptyRatingsPack());

  const eloPack = await fetchConfiguredEloRatings(env, fixtures, previous, opts)
    .catch(error => ({
      ok: false,
      source: 'current-external-team-rating-b48-unavailable',
      ratings: {},
      count: 0,
      error: error?.message || String(error),
      warnings: []
    }));

  const eloSucceeded = sourceSucceeded(eloPack, 'ratings');
  const ratings = eloSucceeded
    ? { ...(eloPack.ratings || {}) }
    : { ...(previous.ratings || {}) };

  const marketValues = { ...(previous.marketValues || {}) };
  const result = await persistRatingsState(env, previous, {
    ratings,
    marketValues,
    eloPack,
    marketPack: null,
    writeElo: true,
    writeMarketValues: false,
    task: 'elo',
    source: opts.source || 'current-external-rating-refresh-b48'
  });

  return {
    ...result,
    ok: !!eloPack.ok && result.persistenceOk,
    source: eloPack.source || 'current-external-team-rating-b48-unavailable',
    sourceCount: Object.keys(eloPack.ratings || {}).length,
    preservedCount:
      Object.keys(previous.ratings || {}).length
      - Object.keys(eloPack.ratings || {}).filter(
        team => previous.ratings?.[team] != null
      ).length,
    missing: eloPack.missing || [],
    attempts: eloPack.attempts || [],
    error: eloPack.ok
      ? (result.persistenceOk ? null : 'elo_persistence_failed')
      : (eloPack.error || 'elo_source_refresh_failed'),
    elo: summarize(eloPack)
  };
}

export async function refreshMarketValues(env, opts = {}) {
  const fixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const previous = await readTeamRatings(
    env,
    { skipCoordinatorCache: true }
  ).catch(() => emptyRatingsPack());

  const marketPack = await fetchTransfermarktMarketValues(env, fixtures, opts)
    .catch(error => ({
      ok: false,
      source: 'transfermarkt',
      marketValues: {},
      count: 0,
      error: error?.message || String(error),
      warnings: []
    }));

  const ratings = { ...(previous.ratings || {}) };
  const marketValues = {
    ...(previous.marketValues || {}),
    ...(marketPack.marketValues || {})
  };

  const result = await persistRatingsState(env, previous, {
    ratings,
    marketValues,
    eloPack: null,
    marketPack,
    writeElo: false,
    writeMarketValues: true,
    task: 'market-values',
    source: opts.source || 'market-values-refresh-b43'
  });

  return {
    ...result,
    ok: !!marketPack.ok && result.persistenceOk,
    source: marketPack.source || 'transfermarkt',
    sourceCount: Object.keys(marketPack.marketValues || {}).length,
    error: marketPack.ok
      ? (result.persistenceOk ? null : 'market_values_persistence_failed')
      : (marketPack.error || 'market_values_source_refresh_failed'),
    marketValuesSource: summarize(marketPack)
  };
}

export async function refreshTeamRatings(env, opts = {}) {
  const fixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const previous = await readTeamRatings(
    env,
    { skipCoordinatorCache: true }
  ).catch(() => emptyRatingsPack());

  const [eloPack, marketPack] = await Promise.all([
    fetchConfiguredEloRatings(env, fixtures, previous, opts)
      .catch(error => ({
        ok: false,
        source: 'current-external-team-rating-b48-unavailable',
        ratings: {},
        count: 0,
        error: error?.message || String(error),
        warnings: []
      })),
    fetchTransfermarktMarketValues(env, fixtures, opts)
      .catch(error => ({
        ok: false,
        source: 'transfermarkt',
        marketValues: {},
        count: 0,
        error: error?.message || String(error),
        warnings: []
      }))
  ]);

  const eloSucceeded = sourceSucceeded(eloPack, 'ratings');
  const ratings = eloSucceeded
    ? { ...(eloPack.ratings || {}) }
    : { ...(previous.ratings || {}) };

  const marketValues = {
    ...(previous.marketValues || {}),
    ...(marketPack.marketValues || {})
  };

  const result = await persistRatingsState(env, previous, {
    ratings,
    marketValues,
    eloPack,
    marketPack,
    writeElo: true,
    writeMarketValues: true,
    task: 'ratings',
    source: opts.source || 'daily-current-rating-tm-refresh-b48'
  });

  const eloOk = !!eloPack.ok && Object.keys(eloPack.ratings || {}).length > 0;
  const marketOk = !!marketPack.ok && Object.keys(marketPack.marketValues || {}).length > 0;
  const refreshOk = eloOk && marketOk && result.persistenceOk;

  return {
    ...result,
    ok: refreshOk,
    partial: eloOk !== marketOk,
    sourceCount: Object.keys(eloPack.ratings || {}).length,
    marketSourceCount: Object.keys(marketPack.marketValues || {}).length,
    successfulSources: [eloOk ? 'elo' : null, marketOk ? 'market-values' : null].filter(Boolean),
    error: refreshOk
      ? null
      : [
          !eloOk ? `elo:${eloPack.error || 'minimum_coverage_not_reached'}` : null,
          !marketOk ? `market-values:${marketPack.error || 'minimum_coverage_not_reached'}` : null,
          !result.persistenceOk ? 'persistence:write_failed' : null
        ].filter(Boolean).join('; '),
    elo: summarize(eloPack),
    marketValuesSource: summarize(marketPack)
  };
}

async function fetchConfiguredEloRatings(env, fixtures, previous, opts = {}) {
  // Use the first current provider that reaches full configured coverage.
  // Whole packs replace each other so a 0-100 Opta scale can never be mixed
  // with a legacy 900-2300 Elo scale.
  return fetchEloFootballRatings(env, fixtures, opts);
}

async function persistRatingsState(env, previous, config) {
  const checkedAt = new Date().toISOString();
  const ratings = numbersOnly(config.ratings || {});
  const marketValues = numbersOnly(config.marketValues || {});

  const previousSources = previous.sources || {};
  const eloAttempt = config.eloPack ? summarize(config.eloPack) : null;
  const marketAttempt = config.marketPack ? summarize(config.marketPack) : null;
  const eloSucceeded = sourceSucceeded(config.eloPack, 'ratings');
  const marketSucceeded = sourceSucceeded(config.marketPack, 'marketValues');
  const attemptedSources = [config.eloPack, config.marketPack].filter(Boolean).length;
  const anySourceSucceeded = eloSucceeded || marketSucceeded;
  const allAttemptedSourcesSucceeded = attemptedSources > 0
    && (!config.eloPack || eloSucceeded)
    && (!config.marketPack || marketSucceeded);
  const sources = {
    elo: eloSucceeded ? eloAttempt : (previousSources.elo || null),
    marketValues: marketSucceeded ? marketAttempt : (previousSources.marketValues || null)
  };
  const lastAttempts = {
    ...(previous.lastAttempts || {}),
    ...(eloAttempt ? { elo: eloAttempt } : {}),
    ...(marketAttempt ? { marketValues: marketAttempt } : {})
  };

  const warnings = [
    ...(config.eloPack?.warnings || []),
    ...(config.marketPack?.warnings || [])
  ];

  const hash = await sha256Hex(stableStringify({ ratings, marketValues }));

  const oldHash = await sha256Hex(stableStringify({
    ratings: previous.ratings || {},
    marketValues: previous.marketValues || {}
  }));

  const changed = hash !== oldHash;
  const updatedAt = changed ? checkedAt : (previous.updatedAt || checkedAt);
  const lastSuccessfulRefreshAt = allAttemptedSourcesSucceeded
    ? checkedAt
    : (previous.lastSuccessfulRefreshAt || null);
  const payload = {
    ratings,
    marketValues,
    hash,
    updatedAt,
    checkedAt,
    lastSuccessfulRefreshAt,
    source: config.source,
    sources,
    lastAttempts,
    warnings
  };
  const writeEnabled =
    String(env.RATINGS_WRITE_TO_FIRESTORE || 'true') === 'true';

  let writeErrors = [];

  if ((changed || anySourceSucceeded) && writeEnabled) {
    const operations = [
      patchDocument(
        env,
        COLLECTIONS.publicCache,
        PUBLIC_CACHE_DOCS.teamRatings,
        payload
      )
    ];

    if (config.writeElo && eloSucceeded) {
      operations.push(
        patchDocument(
          env,
          COLLECTIONS.publicCache,
          PUBLIC_CACHE_DOCS.elo,
          {
            ratings,
            updatedAt: config.eloPack?.updatedAt || checkedAt,
            checkedAt,
            source: config.eloPack?.source || 'current-external-team-rating-b48-unavailable',
            sourceKind: config.eloPack?.sourceKind || null,
            model: config.eloPack?.model || null,
            ratingScale: config.eloPack?.ratingScale || null,
            ratingLabel: config.eloPack?.ratingLabel || null,
            hash: await sha256Hex(stableStringify(ratings)),
            warnings: config.eloPack?.warnings || []
          }
        )
      );
    }

    if (config.writeMarketValues && marketSucceeded) {
      operations.push(
        patchDocument(
          env,
          COLLECTIONS.publicCache,
          PUBLIC_CACHE_DOCS.marketValues,
          {
            marketValues,
            updatedAt: config.marketPack?.updatedAt || checkedAt,
            checkedAt,
            source: config.marketPack?.source || 'transfermarkt',
            hash: await sha256Hex(stableStringify(marketValues)),
            warnings: config.marketPack?.warnings || []
          }
        )
      );
    }

    const publicWrites = await Promise.allSettled(operations);
    writeErrors.push(
      ...publicWrites
        .filter(result => result.status === 'rejected')
        .map(result => result.reason?.message || String(result.reason))
    );

    if (config.writeElo && eloSucceeded) {
      const rows = Object.entries(config.eloPack?.ratings || {})
        .filter(([team, elo]) => Number(previous.ratings?.[team]) !== Number(elo));
      const writes = await Promise.allSettled(
        rows.map(([team, elo]) =>
          patchDocument(env, COLLECTIONS.elo, team, {
            elo,
            updatedAt: config.eloPack?.updatedAt || checkedAt,
            source: config.eloPack?.source || 'current-external-team-rating-b48-unavailable',
            sourceKind: config.eloPack?.sourceKind || null,
            model: config.eloPack?.model || null,
            ratingScale: config.eloPack?.ratingScale || null,
            ratingLabel: config.eloPack?.ratingLabel || null
          })
        )
      );

      writeErrors.push(
        ...writes
          .filter(result => result.status === 'rejected')
          .map(result => result.reason?.message || String(result.reason))
      );
    }

    if (config.writeMarketValues && marketSucceeded) {
      const rows = Object.entries(config.marketPack?.marketValues || {})
        .filter(([team, valueM]) => Number(previous.marketValues?.[team]) !== Number(valueM));
      const writes = await Promise.allSettled(
        rows.map(([team, valueM]) =>
          patchDocument(env, COLLECTIONS.marketValues, team, {
            valueM,
            updatedAt: config.marketPack?.updatedAt || checkedAt,
            source: config.marketPack?.source || 'transfermarkt'
          })
        )
      );

      writeErrors.push(
        ...writes
          .filter(result => result.status === 'rejected')
          .map(result => result.reason?.message || String(result.reason))
      );
    }
  }

  const persistenceOk = writeErrors.length === 0;

  return {
    ok: persistenceOk,
    persistenceOk,
    task: config.task,
    changed,
    written: writeEnabled && persistenceOk && (changed || anySourceSucceeded),
    writeEnabled,
    writeErrors,
    count: Object.keys(ratings).length,
    marketCount: Object.keys(marketValues).length,
    ratings,
    marketValues,
    warnings,
    updatedAt,
    checkedAt,
    lastSuccessfulRefreshAt,
    sources,
    lastAttempts
  };
}

export async function readElo(env, opts = {}) {
  const pack = await readTeamRatings(env, opts);
  return {
    ratings: pack.ratings || {},
    source: pack.source,
    updatedAt: pack.updatedAt || null,
    checkedAt: pack.checkedAt || null,
    lastSuccessfulRefreshAt: pack.lastSuccessfulRefreshAt || null,
    sources: pack.sources || null,
    lastAttempts: pack.lastAttempts || null,
    warnings: pack.warnings || []
  };
}

export async function readMarketValues(env, opts = {}) {
  const pack = await readTeamRatings(env, opts);
  return {
    marketValues: pack.marketValues || {},
    source: pack.source,
    updatedAt: pack.updatedAt || null,
    checkedAt: pack.checkedAt || null,
    lastSuccessfulRefreshAt: pack.lastSuccessfulRefreshAt || null,
    sources: pack.sources || null,
    lastAttempts: pack.lastAttempts || null,
    warnings: pack.warnings || []
  };
}

export function buildMatchRatingsSnapshotFromPack(pack = {}, match = {}, frozenAt = null) {
  const home =
    match.homeTeam
    || match.hTeam
    || match.home
    || match.hName
    || match.h
    || null;

  const away =
    match.awayTeam
    || match.aTeam
    || match.away
    || match.aName
    || match.a
    || null;

  const homeElo = finiteOrNull(home ? pack.ratings?.[home] : null);
  const awayElo = finiteOrNull(away ? pack.ratings?.[away] : null);
  const homeMarketValueM = finiteOrNull(home ? pack.marketValues?.[home] : null);
  const awayMarketValueM = finiteOrNull(away ? pack.marketValues?.[away] : null);
  if (![homeElo, awayElo, homeMarketValueM, awayMarketValueM].every(Number.isFinite)) return null;

  return {
    schemaVersion: 1,
    frozenAt: frozenAt || new Date().toISOString(),
    ratingsUpdatedAt: pack.updatedAt || null,
    homeTeam: home,
    awayTeam: away,
    homeElo,
    awayElo,
    homeMarketValueM,
    awayMarketValueM,
    ratingsSource: pack.sources?.elo?.source || pack.source || null,
    marketSource:
      pack.sources?.marketValues?.source || pack.source || null
  };
}

function normalizePack(doc = {}, source = 'unknown') {
  return {
    ok: true,
    source,
    ratings: numbersOnly(doc.ratings || doc.elo || {}),
    marketValues: numbersOnly(doc.marketValues || doc.values || {}),
    updatedAt: doc.updatedAt || null,
    checkedAt: doc.checkedAt || null,
    lastSuccessfulRefreshAt: doc.lastSuccessfulRefreshAt || null,
    sources: doc.sources || null,
    lastAttempts: doc.lastAttempts || null,
    warnings: doc.warnings || []
  };
}

function emptyRatingsPack() {
  return {
    ratings: {},
    marketValues: {},
    sources: {},
    warnings: []
  };
}

function numbersOnly(object = {}) {
  const output = {};

  for (const [key, value] of Object.entries(object || {})) {
    const number = Number(value);
    if (key && Number.isFinite(number)) output[key] = number;
  }

  return output;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function hasUsableRatingsData(pack = {}) {
  return countFiniteValues(pack.ratings || pack.elo || {}) > 0
    || countFiniteValues(pack.marketValues || pack.values || {}) > 0;
}

function countFiniteValues(object = {}) {
  return Object.entries(object || {}).filter(([key, value]) => {
    return !!key && Number.isFinite(Number(value));
  }).length;
}

function sourceSucceeded(pack, field) {
  return !!pack?.ok && countFiniteValues(pack?.[field] || {}) > 0;
}

function summarize(pack = {}) {
  return {
    ok: !!pack.ok,
    source: pack.source || null,
    sourceKind: pack.sourceKind || null,
    url: pack.url || null,
    selectedSeason: pack.selectedSeason || null,
    seasonKey: pack.seasonKey || null,
    baselineDate: pack.baselineDate || null,
    baselineSource: pack.baselineSource || null,
    seeded: !!pack.seeded,
    appliedCount: pack.appliedCount ?? null,
    model: pack.model || null,
    ratingScale: pack.ratingScale || null,
    ratingLabel: pack.ratingLabel || null,
    count:
      pack.count
      ?? Object.keys(pack.ratings || pack.marketValues || {}).length,
    fetched: pack.fetched ?? null,
    coverage: pack.coverage ?? null,
    error: pack.error || null,
    warnings: pack.warnings || [],
    attempts: Array.isArray(pack.attempts)
      ? pack.attempts.slice(-12).map(attempt => ({
          source: attempt.source || null,
          status: attempt.status ?? null,
          ok: !!attempt.ok,
          url: attempt.url || attempt.targetUrl || null,
          rowCount: attempt.rowCount ?? attempt.parsedRows ?? null,
          mappedCount: attempt.mappedCount ?? null,
          blocked: attempt.blocked ?? null,
          error: attempt.error || null
        }))
      : []
  };
}
