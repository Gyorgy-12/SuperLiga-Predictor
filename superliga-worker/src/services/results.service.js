import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getMemory, setFinalResult, setFinalResultsHydrated } from './memory-cache.service.js';
import { sha256Hex, liveFingerprint } from '../core/hash.js';
import { isFinished } from '../core/match-window.js';

export async function readStoredResults(env, opts = {}) {
  const mem = getMemory();
  const forceCollection = !!opts.forceCollection;
  const skipMemory = forceCollection || !!opts.skipMemory;
  const skipPublicCache = forceCollection || !!opts.skipPublicCache;

  // Only a fully hydrated aggregate may satisfy /results from memory. A lone
  // final write creates a sparse map, which previously made older completed
  // matches disappear after a Worker cold start.
  if (!skipMemory && mem.finalResultsHydrated) {
    return { results: mem.finalResults, source: 'memory-hydrated' };
  }

  if (!skipPublicCache) {
    const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results).catch(() => null);
    if (publicDoc?.results && typeof publicDoc.results === 'object') {
      // Preserve any finals written in this isolate after the public aggregate
      // was last rebuilt.
      mem.finalResults = { ...publicDoc.results, ...mem.finalResults };
      setFinalResultsHydrated(true);
      return { results: mem.finalResults, source: 'firestore-public-cache' };
    }
  }

  const docs = await listDocuments(env, COLLECTIONS.results, { pageSize: 320 }).catch(() => []);
  const results = {};
  for (const doc of docs) {
    if (doc.id) results[doc.id] = stripMeta(doc);
  }
  mem.finalResults = results;
  setFinalResultsHydrated(true);
  return { results, source: docs.length ? 'firestore-collection' : 'empty' };
}

export async function writeFinalIfChanged(env, match, opts = {}) {
  if (!match?.id || !isFinished(match)) return { written: false, reason: 'not_final' };
  const hash = await sha256Hex(liveFingerprint(match));
  const mem = getMemory();
  const incomingSnapshot = normalizeMatchRatingsSnapshot(
    opts.ratingsSnapshot || match.ratingsSnapshot
  );
  const memorySnapshot = normalizeMatchRatingsSnapshot(
    mem.finalResults?.[match.id]?.ratingsSnapshot
  );
  if (
    mem.hashes[`final:${match.id}`] === hash
    && (!incomingSnapshot || memorySnapshot)
  ) {
    return { written: false, reason: 'same_hash_memory' };
  }

  const old = await getDocument(env, COLLECTIONS.results, match.id).catch(() => null);
  const oldSnapshot = normalizeMatchRatingsSnapshot(old?.ratingsSnapshot);
  const ratingsSnapshot = selectImmutableRatingsSnapshot(
    oldSnapshot || memorySnapshot,
    incomingSnapshot
  );
  const snapshotAdded = !!ratingsSnapshot && !oldSnapshot;
  if (old?.hash === hash && !snapshotAdded) {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, old);
    return { written: false, reason: 'same_hash_firestore' };
  }

  const writtenAt = new Date().toISOString();
  const base = old?.hash === hash ? stripMeta(old) : match;
  const data = {
    ...base,
    // A later score/status correction may rebuild `base` from the live match.
    // Keep migration audit data and the pre-migration backup in that case.
    ...(old?.legacyRatingsSnapshot
      ? { legacyRatingsSnapshot: old.legacyRatingsSnapshot }
      : {}),
    ...(old?.ratingsSnapshotMigration
      ? { ratingsSnapshotMigration: old.ratingsSnapshotMigration }
      : {}),
    ...(ratingsSnapshot ? { ratingsSnapshot } : {}),
    hash,
    finalWrittenAt: old?.finalWrittenAt || writtenAt,
    ...(snapshotAdded
      ? { ratingsSnapshotWrittenAt: writtenAt }
      : (old?.ratingsSnapshotWrittenAt
          ? { ratingsSnapshotWrittenAt: old.ratingsSnapshotWrittenAt }
          : {}))
  };

  if (String(env.FINAL_WRITE_TO_FIRESTORE || 'true') !== 'true') {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, data);
    return { written: false, reason: 'final_write_disabled' };
  }

  await patchDocument(env, COLLECTIONS.results, match.id, data);
  mem.hashes[`final:${match.id}`] = hash;
  setFinalResult(match.id, data);
  return {
    written: true,
    id: match.id,
    hash,
    snapshotWritten: snapshotAdded,
    reason: snapshotAdded && old?.hash === hash
      ? 'ratings_snapshot_added'
      : 'final_changed'
  };
}

export function selectImmutableRatingsSnapshot(existing, incoming) {
  return normalizeMatchRatingsSnapshot(existing)
    || normalizeMatchRatingsSnapshot(incoming)
    || null;
}

export function normalizeMatchRatingsSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {
    schemaVersion: Number(value.schemaVersion) || 1,
    frozenAt: value.frozenAt || null,
    ratingsUpdatedAt: value.ratingsUpdatedAt || null,
    homeTeam: value.homeTeam || null,
    awayTeam: value.awayTeam || null,
    homeElo: finiteOrNull(value.homeElo),
    awayElo: finiteOrNull(value.awayElo),
    homeMarketValueM: finiteOrNull(value.homeMarketValueM),
    awayMarketValueM: finiteOrNull(value.awayMarketValueM),
    ratingsSource: value.ratingsSource || null,
    marketSource: value.marketSource || null,
    ...optionalSnapshotMetadata(value)
  };
  return [
    normalized.homeElo,
    normalized.awayElo,
    normalized.homeMarketValueM,
    normalized.awayMarketValueM
  ].every(Number.isFinite) ? normalized : null;
}

export async function refreshPublicResultsCache(env, results, opts = {}) {
  const cleanResults = results && typeof results === 'object' ? results : {};
  const payload = { results: cleanResults, updatedAt: new Date().toISOString(), count: Object.keys(cleanResults).length };
  if (opts.strict) await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results, payload);
  else await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results, payload).catch(() => null);
  const mem = getMemory();
  mem.finalResults = { ...cleanResults };
  setFinalResultsHydrated(true);
  mem.updatedAt = payload.updatedAt;
  return payload;
}

function stripMeta(doc) {
  const { _name, _createTime, _updateTime, ...clean } = doc;
  return clean;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalSnapshotMetadata(value) {
  const keys = [
    'ratingProvider',
    'ratingScale',
    'historicalCheckpoint',
    'historicalArchiveAt',
    'historicalArchiveSnapshot',
    'historicalArchiveField',
    'migrationRevision'
  ];
  return Object.fromEntries(keys
    .filter(key => value[key] !== undefined && value[key] !== null && value[key] !== '')
    .map(key => [key, value[key]]));
}
