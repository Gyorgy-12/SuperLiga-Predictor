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

export async function writeFinalIfChanged(env, match) {
  if (!match?.id || !isFinished(match)) return { written: false, reason: 'not_final' };
  const hash = await sha256Hex(liveFingerprint(match));
  const mem = getMemory();
  if (mem.hashes[`final:${match.id}`] === hash) return { written: false, reason: 'same_hash_memory' };

  const old = await getDocument(env, COLLECTIONS.results, match.id).catch(() => null);
  if (old?.hash === hash) {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, old);
    return { written: false, reason: 'same_hash_firestore' };
  }

  if (String(env.FINAL_WRITE_TO_FIRESTORE || 'true') !== 'true') {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, { ...match, hash });
    return { written: false, reason: 'final_write_disabled' };
  }

  const data = { ...match, hash, finalWrittenAt: new Date().toISOString() };
  await patchDocument(env, COLLECTIONS.results, match.id, data);
  mem.hashes[`final:${match.id}`] = hash;
  setFinalResult(match.id, data);
  return { written: true, id: match.id, hash };
}

export async function refreshPublicResultsCache(env, results) {
  const cleanResults = results && typeof results === 'object' ? results : {};
  const payload = { results: cleanResults, updatedAt: new Date().toISOString(), count: Object.keys(cleanResults).length };
  await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results, payload).catch(() => null);
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
