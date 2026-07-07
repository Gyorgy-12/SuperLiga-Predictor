import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getMemory, setFinalResult } from './memory-cache.service.js';
import { sha256Hex, liveFingerprint } from '../core/hash.js';
import { isFinished } from '../core/match-window.js';
import { buildMatchContextSnapshot } from './team-ratings.service.js';

export async function readStoredResults(env) {
  const mem = getMemory();
  if (Object.keys(mem.finalResults).length) return { results: mem.finalResults, source: 'memory' };

  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results).catch(() => null);
  if (publicDoc?.results) {
    mem.finalResults = publicDoc.results;
    return { results: mem.finalResults, source: 'firestore-public-cache' };
  }

  const docs = await listDocuments(env, COLLECTIONS.results, { pageSize: 320 }).catch(() => []);
  const results = {};
  for (const doc of docs) {
    if (doc.id) results[doc.id] = stripMeta(doc);
  }
  mem.finalResults = results;
  return { results, source: docs.length ? 'firestore-collection' : 'empty' };
}

export async function writeFinalIfChanged(env, match) {
  if (!match?.id || !isFinished(match)) return { written: false, reason: 'not_final' };
  const hash = await sha256Hex(liveFingerprint(match));
  const mem = getMemory();
  if (mem.hashes[`final:${match.id}`] === hash) return { written: false, reason: 'same_hash_memory' };

  const old = await getDocument(env, COLLECTIONS.results, match.id).catch(() => null);
  if (old?.hash === hash && old?.modelSnapshot) {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, old);
    return { written: false, reason: 'same_hash_firestore' };
  }

  const modelSnapshot = old?.modelSnapshot || match.modelSnapshot || await buildMatchContextSnapshot(env, { ...match, ...(old || {}) }).catch(() => null);

  if (String(env.FINAL_WRITE_TO_FIRESTORE || 'true') !== 'true') {
    mem.hashes[`final:${match.id}`] = hash;
    setFinalResult(match.id, { ...match, hash, modelSnapshot });
    return { written: false, reason: 'final_write_disabled' };
  }

  const data = { ...(old || {}), ...match, hash, modelSnapshot, finalWrittenAt: old?.finalWrittenAt || new Date().toISOString(), finalUpdatedAt: new Date().toISOString() };
  await patchDocument(env, COLLECTIONS.results, match.id, data);
  mem.hashes[`final:${match.id}`] = hash;
  setFinalResult(match.id, data);
  return { written: true, id: match.id, hash };
}

export async function refreshPublicResultsCache(env, results) {
  const payload = { results, updatedAt: new Date().toISOString(), count: Object.keys(results || {}).length };
  await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.results, payload).catch(() => null);
  return payload;
}

function stripMeta(doc) {
  const { _name, _createTime, _updateTime, ...clean } = doc;
  return clean;
}
