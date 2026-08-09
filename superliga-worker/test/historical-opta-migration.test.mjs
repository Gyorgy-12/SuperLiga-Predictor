import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORICAL_OPTA_MIGRATION_REVISION,
  buildHistoricalOptaSnapshot,
  buildMigratedHistoricalOptaResult,
  historicalOptaCheckpointForMatch
} from '../src/services/historical-opta-migration.service.js';
import { normalizeMatchRatingsSnapshot } from '../src/services/results.service.js';

test('the 27-match migration uses the matching pre-round Opta checkpoint', () => {
  const expectedFcsb = [
    ['m1', 78.05, 'round-1'],
    ['m9', 78.63, 'round-2'],
    ['m17', 78.92, 'round-3'],
    ['m28', 76.99, 'round-4']
  ];

  for (const [id, rating, key] of expectedFcsb) {
    const checkpoint = historicalOptaCheckpointForMatch(id);
    assert.equal(checkpoint.key, key);
    assert.equal(checkpoint.ratings.FCSB, rating);
  }

  assert.equal(historicalOptaCheckpointForMatch('m25'), null);
  assert.equal(historicalOptaCheckpointForMatch('m32'), null);
});

test('a legacy Elo snapshot is backed up while its market values are preserved', () => {
  const legacy = {
    schemaVersion: 1,
    frozenAt: '2026-08-03T21:51:48.663Z',
    ratingsUpdatedAt: '2026-08-03T10:00:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'Farul Constanța',
    homeElo: 1427,
    awayElo: 1294,
    homeMarketValueM: 25.8,
    awayMarketValueM: 10.3,
    ratingsSource: 'prediction-game-current-club-elo-b47',
    marketSource: 'transfermarkt-market-values-b43-reader'
  };
  const result = {
    id: 'm17',
    status: 'FT',
    homeTeam: 'FCSB',
    awayTeam: 'Farul Constanța',
    ratingsSnapshot: legacy,
    ratingsSnapshotWrittenAt: '2026-08-03T21:51:48.663Z'
  };

  const migrated = buildMigratedHistoricalOptaResult(result, '2026-08-09T12:00:00.000Z');
  assert.deepEqual(migrated.legacyRatingsSnapshot, legacy);
  assert.equal(migrated.ratingsSnapshot.homeElo, 78.92);
  assert.equal(migrated.ratingsSnapshot.awayElo, 74.48);
  assert.equal(migrated.ratingsSnapshot.homeMarketValueM, 25.8);
  assert.equal(migrated.ratingsSnapshot.awayMarketValueM, 10.3);
  assert.equal(migrated.ratingsSnapshotMigration.legacySnapshotBackedUp, true);
});

test('a match without a legacy snapshot receives deterministic market values', () => {
  const result = {
    id: 'm1',
    status: 'FT',
    finalWrittenAt: '2026-07-17T21:32:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'FC Argeș'
  };
  const checkpoint = historicalOptaCheckpointForMatch(result.id);
  const snapshot = buildHistoricalOptaSnapshot(result, checkpoint);

  assert.equal(snapshot.homeElo, 78.05);
  assert.equal(snapshot.awayElo, 76.07);
  assert.equal(snapshot.homeMarketValueM, 25.8);
  assert.equal(snapshot.awayMarketValueM, 12.03);
  assert.equal(snapshot.frozenAt, result.finalWrittenAt);
  assert.equal(snapshot.migrationRevision, HISTORICAL_OPTA_MIGRATION_REVISION);
});

test('non-target and unfinished matches cannot be migrated', () => {
  const scheduledTarget = {
    id: 'm28',
    status: 'NS',
    homeTeam: 'UTA Arad',
    awayTeam: 'Rapid București'
  };
  const finishedNonTarget = {
    ...scheduledTarget,
    id: 'm25',
    status: 'FT'
  };

  assert.equal(buildMigratedHistoricalOptaResult(scheduledTarget), null);
  assert.equal(buildMigratedHistoricalOptaResult(finishedNonTarget), null);
});

test('historical Opta metadata survives immutable snapshot normalization', () => {
  const result = {
    id: 'm29',
    status: 'FT',
    homeTeam: 'Dinamo',
    awayTeam: 'FC Voluntari'
  };
  const migrated = buildMigratedHistoricalOptaResult(result);
  const normalized = normalizeMatchRatingsSnapshot(migrated.ratingsSnapshot);

  assert.equal(normalized.ratingProvider, 'Opta Power Rankings');
  assert.equal(normalized.ratingScale, '0-100');
  assert.equal(normalized.historicalCheckpoint, 'round-4');
  assert.equal(normalized.migrationRevision, HISTORICAL_OPTA_MIGRATION_REVISION);
});

