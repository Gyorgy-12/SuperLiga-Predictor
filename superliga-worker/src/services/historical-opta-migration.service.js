import { COLLECTIONS } from '../config/collections.js';
import { isFinished } from '../core/match-window.js';
import { patchDocument } from './firestore.service.js';
import { readStoredResults, refreshPublicResultsCache } from './results.service.js';

export const HISTORICAL_OPTA_MIGRATION_REVISION = 'b53-historical-opta-27-v1';

const MARKET_SOURCE = 'transfermarkt-market-values-b43-reader@2026-08-03';
const TARGET_MATCH_IDS = Object.freeze([
  'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8',
  'm9', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16',
  'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24',
  'm28', 'm29', 'm31'
]);

const TARGET_CHECKPOINT_BY_ID = Object.freeze(Object.fromEntries([
  ...['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'].map(id => [id, 'round-1']),
  ...['m9', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16'].map(id => [id, 'round-2']),
  ...['m17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24'].map(id => [id, 'round-3']),
  ...['m28', 'm29', 'm31'].map(id => [id, 'round-4'])
]));

const CHECKPOINTS = Object.freeze({
  'round-1': checkpoint({
    round: 1,
    effectiveAt: '2026-07-13T00:00:00.000Z',
    archivedAt: '2026-07-20T13:12:28.000Z',
    archiveSnapshot: '20260720131228',
    field: 'lastWeekRating',
    ratings: {
      'Universitatea Craiova': 82.32, 'Universitatea Cluj': 80.75, 'CFR Cluj': 80.65,
      FCSB: 78.05, Dinamo: 78.09, 'Rapid București': 76.84, 'Oțelul Galați': 75.72,
      'FC Argeș': 76.07, 'UTA Arad': 75.79, Csikszereda: 74.34,
      'FC Botoșani': 73.70, 'FC Voluntari': 73.81, 'Corvinul Hunedoara': 73.67,
      'Sepsi OSK': 73.41, 'Farul Constanța': 73.43, 'Petrolul Ploiești': 72.68
    }
  }),
  'round-2': checkpoint({
    round: 2,
    effectiveAt: '2026-07-20T13:12:28.000Z',
    archivedAt: '2026-07-20T13:12:28.000Z',
    archiveSnapshot: '20260720131228',
    field: 'currentRating',
    ratings: {
      'Universitatea Craiova': 82.81, 'Universitatea Cluj': 80.94, 'CFR Cluj': 80.43,
      FCSB: 78.63, Dinamo: 77.88, 'Rapid București': 77.10, 'Oțelul Galați': 76.44,
      'FC Argeș': 76.01, 'UTA Arad': 75.85, Csikszereda: 74.64,
      'FC Botoșani': 74.11, 'FC Voluntari': 73.99, 'Corvinul Hunedoara': 73.97,
      'Sepsi OSK': 73.72, 'Farul Constanța': 73.62, 'Petrolul Ploiești': 73.45
    }
  }),
  'round-3': checkpoint({
    round: 3,
    effectiveAt: '2026-07-27T00:00:00.000Z',
    archivedAt: '2026-08-03T16:33:09.000Z',
    archiveSnapshot: '20260803163309',
    field: 'lastWeekRating',
    ratings: {
      'Universitatea Craiova': 82.20, 'CFR Cluj': 80.27, 'Universitatea Cluj': 80.22,
      Dinamo: 79.68, FCSB: 78.92, 'Rapid București': 77.62, 'Oțelul Galați': 76.75,
      'FC Argeș': 76.02, 'UTA Arad': 76.00, 'Farul Constanța': 74.48,
      'FC Botoșani': 74.24, 'Sepsi OSK': 74.14, 'Corvinul Hunedoara': 74.04,
      'FC Voluntari': 74.05, 'Petrolul Ploiești': 73.43, Csikszereda: 72.94
    }
  }),
  'round-4': checkpoint({
    round: 4,
    effectiveAt: '2026-08-03T16:33:09.000Z',
    archivedAt: '2026-08-03T16:33:09.000Z',
    archiveSnapshot: '20260803163309',
    field: 'currentRating',
    ratings: {
      'Universitatea Craiova': 81.40, 'CFR Cluj': 79.31, 'Universitatea Cluj': 78.89,
      Dinamo: 78.76, FCSB: 76.99, 'Rapid București': 76.95, 'Oțelul Galați': 75.57,
      'FC Argeș': 75.22, 'UTA Arad': 74.77, 'Farul Constanța': 73.36,
      'FC Botoșani': 73.13, 'Sepsi OSK': 73.09, 'Corvinul Hunedoara': 72.82,
      'FC Voluntari': 72.79, 'Petrolul Ploiești': 72.06, Csikszereda: 71.48
    }
  })
});

const HISTORICAL_MARKET_VALUES = Object.freeze({
  'CFR Cluj': 17.98,
  'Corvinul Hunedoara': 6.95,
  Csikszereda: 6.49,
  Dinamo: 19.5,
  'Farul Constanța': 10.3,
  'FC Argeș': 12.03,
  'FC Botoșani': 8.95,
  'FC Voluntari': 5.55,
  FCSB: 25.8,
  'Oțelul Galați': 7.03,
  'Petrolul Ploiești': 6.7,
  'Rapid București': 24.55,
  'Sepsi OSK': 6.1,
  'Universitatea Cluj': 18.14,
  'Universitatea Craiova': 37.25,
  'UTA Arad': 8.08
});

function checkpoint(value) {
  return Object.freeze({
    ...value,
    source: `opta-power-rankings-wayback-${value.archiveSnapshot}-${value.field}-b53`
  });
}

export function historicalOptaCheckpointForMatch(matchId) {
  const key = TARGET_CHECKPOINT_BY_ID[String(matchId || '')];
  return key ? { key, ...CHECKPOINTS[key] } : null;
}

export function buildHistoricalOptaSnapshot(result, checkpointValue) {
  if (!result || !checkpointValue) return null;
  const homeTeam = result.homeTeam;
  const awayTeam = result.awayTeam;
  const existing = result.ratingsSnapshot && typeof result.ratingsSnapshot === 'object'
    ? result.ratingsSnapshot
    : null;
  const homeElo = checkpointValue.ratings?.[homeTeam];
  const awayElo = checkpointValue.ratings?.[awayTeam];
  const homeMarketValueM = finite(existing?.homeMarketValueM) ?? finite(HISTORICAL_MARKET_VALUES[homeTeam]);
  const awayMarketValueM = finite(existing?.awayMarketValueM) ?? finite(HISTORICAL_MARKET_VALUES[awayTeam]);

  if (![homeElo, awayElo, homeMarketValueM, awayMarketValueM].every(Number.isFinite)) return null;

  return {
    schemaVersion: 1,
    frozenAt: existing?.frozenAt || result.finalWrittenAt || result.updatedAt || checkpointValue.archivedAt,
    ratingsUpdatedAt: checkpointValue.effectiveAt,
    homeTeam,
    awayTeam,
    homeElo,
    awayElo,
    homeMarketValueM,
    awayMarketValueM,
    ratingsSource: checkpointValue.source,
    marketSource: existing?.marketSource || MARKET_SOURCE,
    ratingProvider: 'Opta Power Rankings',
    ratingScale: '0-100',
    historicalCheckpoint: checkpointValue.key,
    historicalArchiveAt: checkpointValue.archivedAt,
    historicalArchiveSnapshot: checkpointValue.archiveSnapshot,
    historicalArchiveField: checkpointValue.field,
    migrationRevision: HISTORICAL_OPTA_MIGRATION_REVISION
  };
}

export function buildMigratedHistoricalOptaResult(result, migratedAt = new Date().toISOString()) {
  const checkpointValue = historicalOptaCheckpointForMatch(result?.id);
  if (!checkpointValue || !isFinished(result)) return null;
  const ratingsSnapshot = buildHistoricalOptaSnapshot(result, checkpointValue);
  if (!ratingsSnapshot) return null;

  const alreadyBackedUp = result.legacyRatingsSnapshot && typeof result.legacyRatingsSnapshot === 'object';
  const hasLegacySnapshot = result.ratingsSnapshot && typeof result.ratingsSnapshot === 'object'
    && result.ratingsSnapshot.migrationRevision !== HISTORICAL_OPTA_MIGRATION_REVISION;

  return {
    ...result,
    ...(alreadyBackedUp
      ? { legacyRatingsSnapshot: result.legacyRatingsSnapshot }
      : (hasLegacySnapshot ? { legacyRatingsSnapshot: result.ratingsSnapshot } : {})),
    ratingsSnapshot,
    ratingsSnapshotWrittenAt: migratedAt,
    ratingsSnapshotMigration: {
      revision: HISTORICAL_OPTA_MIGRATION_REVISION,
      migratedAt,
      checkpoint: checkpointValue.key,
      archiveSnapshot: checkpointValue.archiveSnapshot,
      archiveField: checkpointValue.field,
      legacySnapshotBackedUp: alreadyBackedUp || !!hasLegacySnapshot,
      previousRatingsSnapshotWrittenAt: result.ratingsSnapshotWrittenAt || null
    }
  };
}

export async function runHistoricalOptaMigration(env) {
  const migratedAt = new Date().toISOString();
  const stored = await readStoredResults(env, { forceCollection: true });
  const results = stored.results || {};
  const missingIds = TARGET_MATCH_IDS.filter(id => !results[id]);
  const unfinishedIds = TARGET_MATCH_IDS.filter(id => results[id] && !isFinished(results[id]));

  if (missingIds.length || unfinishedIds.length) {
    return {
      ok: false,
      error: 'historical_opta_target_guard_failed',
      expectedCount: TARGET_MATCH_IDS.length,
      foundCount: TARGET_MATCH_IDS.length - missingIds.length,
      missingIds,
      unfinishedIds,
      revision: HISTORICAL_OPTA_MIGRATION_REVISION
    };
  }

  const updates = [];
  const invalidIds = [];
  let alreadyMigratedCount = 0;
  for (const id of TARGET_MATCH_IDS) {
    const result = results[id];
    if (result.ratingsSnapshotMigration?.revision === HISTORICAL_OPTA_MIGRATION_REVISION) {
      alreadyMigratedCount += 1;
      continue;
    }
    const migrated = buildMigratedHistoricalOptaResult(result, migratedAt);
    if (!migrated) invalidIds.push(id);
    else updates.push([id, migrated]);
  }

  if (invalidIds.length) {
    return {
      ok: false,
      error: 'historical_opta_snapshot_validation_failed',
      invalidIds,
      revision: HISTORICAL_OPTA_MIGRATION_REVISION
    };
  }

  const failures = [];
  for (let offset = 0; offset < updates.length; offset += 6) {
    const batch = updates.slice(offset, offset + 6);
    const settled = await Promise.allSettled(batch.map(async ([id, data]) => {
      const written = await patchDocument(env, COLLECTIONS.results, id, data);
      if (written?.skipped) throw new Error(written.reason || 'firestore_write_skipped');
      return id;
    }));
    settled.forEach((entry, index) => {
      if (entry.status === 'rejected') {
        failures.push({
          id: batch[index][0],
          error: entry.reason?.message || String(entry.reason)
        });
      }
    });
  }

  if (failures.length) {
    return {
      ok: false,
      error: 'historical_opta_partial_write_failed',
      revision: HISTORICAL_OPTA_MIGRATION_REVISION,
      expectedCount: TARGET_MATCH_IDS.length,
      writtenCount: updates.length - failures.length,
      alreadyMigratedCount,
      failures
    };
  }

  const mergedResults = { ...results, ...Object.fromEntries(updates) };
  await refreshPublicResultsCache(env, mergedResults, { strict: true });

  return {
    ok: true,
    task: 'historical-opta-migration',
    revision: HISTORICAL_OPTA_MIGRATION_REVISION,
    expectedCount: TARGET_MATCH_IDS.length,
    migratedCount: updates.length,
    alreadyMigratedCount,
    totalMigratedCount: updates.length + alreadyMigratedCount,
    legacyBackupCount: TARGET_MATCH_IDS.filter(id => !!mergedResults[id]?.legacyRatingsSnapshot).length,
    checkpointCounts: Object.fromEntries(Object.keys(CHECKPOINTS).map(key => [
      key,
      TARGET_MATCH_IDS.filter(id => TARGET_CHECKPOINT_BY_ID[id] === key).length
    ])),
    migratedAt
  };
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

