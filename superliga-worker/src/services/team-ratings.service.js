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

  if (publicRatings?.ratings || publicRatings?.marketValues) {
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

  if (publicElo?.ratings || publicMv?.marketValues) {
    return normalizePack(
      { ...(publicElo || {}), ...(publicMv || {}) },
      'firestore-public-cache-split'
    );
  }

  const durable = opts.skipCoordinatorCache
    ? null
    : await coordinatorRatingsCache(env).catch(() => null);

  if (durable?.ratings || durable?.marketValues) {
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
      source: 'current-external-club-elo-b47-unavailable',
      ratings: {},
      count: 0,
      error: error?.message || String(error),
      warnings: []
    }));

  const ratings = {
    ...(previous.ratings || {}),
    ...(eloPack.ratings || {})
  };

  const marketValues = { ...(previous.marketValues || {}) };
  const result = await persistRatingsState(env, previous, {
    ratings,
    marketValues,
    eloPack,
    marketPack: null,
    writeElo: true,
    writeMarketValues: false,
    task: 'elo',
    source: opts.source || 'current-external-elo-refresh-b47'
  });

  return {
    ...result,
    ok: !!eloPack.ok,
    source: eloPack.source || 'current-external-club-elo-b47-unavailable',
    sourceCount: Object.keys(eloPack.ratings || {}).length,
    preservedCount:
      Object.keys(previous.ratings || {}).length
      - Object.keys(eloPack.ratings || {}).filter(
        team => previous.ratings?.[team] != null
      ).length,
    missing: eloPack.missing || [],
    attempts: eloPack.attempts || [],
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
    ok: !!marketPack.ok,
    source: marketPack.source || 'transfermarkt',
    sourceCount: Object.keys(marketPack.marketValues || {}).length,
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
        source: 'current-external-club-elo-b47-unavailable',
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

  const ratings = {
    ...(previous.ratings || {}),
    ...(eloPack.ratings || {})
  };

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
    source: opts.source || 'daily-current-elo-tm-refresh-b47'
  });

  return {
    ...result,
    ok: !!(eloPack.ok || marketPack.ok),
    elo: summarize(eloPack),
    marketValuesSource: summarize(marketPack)
  };
}

async function fetchConfiguredEloRatings(env, fixtures, previous, opts = {}) {
  // Use the first current external club-Elo provider that reaches the configured
  // coverage threshold. Different Elo models are never merged in one run.
  return fetchEloFootballRatings(env, fixtures, opts);
}

async function persistRatingsState(env, previous, config) {
  const updatedAt = new Date().toISOString();
  const ratings = numbersOnly(config.ratings || {});
  const marketValues = numbersOnly(config.marketValues || {});

  const previousSources = previous.sources || {};
  const sources = {
    elo: config.eloPack
      ? summarize(config.eloPack)
      : (previousSources.elo || null),
    marketValues: config.marketPack
      ? summarize(config.marketPack)
      : (previousSources.marketValues || null)
  };

  const warnings = [
    ...(config.eloPack?.warnings || []),
    ...(config.marketPack?.warnings || [])
  ];

  const payload = {
    ratings,
    marketValues,
    hash: await sha256Hex(stableStringify({ ratings, marketValues })),
    updatedAt,
    source: config.source,
    sources,
    warnings
  };

  const oldHash = await sha256Hex(stableStringify({
    ratings: previous.ratings || {},
    marketValues: previous.marketValues || {}
  }));

  const changed = payload.hash !== oldHash;
  const writeEnabled =
    String(env.RATINGS_WRITE_TO_FIRESTORE || 'true') === 'true';

  let writeErrors = [];

  if (changed && writeEnabled) {
    const operations = [
      patchDocument(
        env,
        COLLECTIONS.publicCache,
        PUBLIC_CACHE_DOCS.teamRatings,
        payload
      )
    ];

    if (config.writeElo) {
      operations.push(
        patchDocument(
          env,
          COLLECTIONS.publicCache,
          PUBLIC_CACHE_DOCS.elo,
          {
            ratings,
            updatedAt,
            source: config.eloPack?.source || 'current-external-club-elo-b47-unavailable',
            hash: await sha256Hex(stableStringify(ratings)),
            warnings: config.eloPack?.warnings || []
          }
        )
      );
    }

    if (config.writeMarketValues) {
      operations.push(
        patchDocument(
          env,
          COLLECTIONS.publicCache,
          PUBLIC_CACHE_DOCS.marketValues,
          {
            marketValues,
            updatedAt,
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

    if (config.writeElo) {
      const rows = Object.entries(config.eloPack?.ratings || {});
      const writes = await Promise.allSettled(
        rows.map(([team, elo]) =>
          patchDocument(env, COLLECTIONS.elo, team, {
            elo,
            updatedAt,
            source: config.eloPack?.source || 'current-external-club-elo-b47-unavailable'
          })
        )
      );

      writeErrors.push(
        ...writes
          .filter(result => result.status === 'rejected')
          .map(result => result.reason?.message || String(result.reason))
      );
    }

    if (config.writeMarketValues) {
      const rows = Object.entries(config.marketPack?.marketValues || {});
      const writes = await Promise.allSettled(
        rows.map(([team, valueM]) =>
          patchDocument(env, COLLECTIONS.marketValues, team, {
            valueM,
            updatedAt,
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

  const eloStateWritten = false;

  return {
    ok: true,
    task: config.task,
    changed,
    written: writeEnabled && writeErrors.length === 0 && (changed || eloStateWritten),
    eloStateWritten,
    writeEnabled,
    writeErrors,
    count: Object.keys(ratings).length,
    marketCount: Object.keys(marketValues).length,
    ratings,
    marketValues,
    warnings,
    updatedAt
  };
}

export async function readElo(env, opts = {}) {
  const pack = await readTeamRatings(env, opts);
  return {
    ratings: pack.ratings || {},
    source: pack.source,
    updatedAt: pack.updatedAt || null,
    sources: pack.sources || null,
    warnings: pack.warnings || []
  };
}

export async function readMarketValues(env, opts = {}) {
  const pack = await readTeamRatings(env, opts);
  return {
    marketValues: pack.marketValues || {},
    source: pack.source,
    updatedAt: pack.updatedAt || null,
    sources: pack.sources || null,
    warnings: pack.warnings || []
  };
}

export async function buildMatchContextSnapshot(env, match) {
  const pack = await readTeamRatings(env)
    .catch(() => ({
      ratings: {},
      marketValues: {},
      source: 'ratings-error'
    }));

  const oddsPack = await import('./odds.service.js')
    .then(module => module.readOdds(env))
    .catch(() => ({ odds: {}, source: 'odds-error' }));

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

  return {
    frozenAt: new Date().toISOString(),
    odds: oddsPack.odds?.[match.id] || match.odds || null,
    oddsSource: oddsPack.source || match.oddsSource || null,
    homeElo: home ? pack.ratings?.[home] ?? null : null,
    awayElo: away ? pack.ratings?.[away] ?? null : null,
    homeMarketValueM: home
      ? pack.marketValues?.[home] ?? null
      : null,
    awayMarketValueM: away
      ? pack.marketValues?.[away] ?? null
      : null,
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
    sources: doc.sources || null,
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
