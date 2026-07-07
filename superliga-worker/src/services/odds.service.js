import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchOdds } from '../sources/odds-source.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { coordinatorOddsCache } from './coordinator.service.js';

export async function readOdds(env) {
  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds).catch(() => null);
  if (publicDoc?.odds) return { odds: publicDoc.odds, source: 'firestore-public-cache', updatedAt: publicDoc.updatedAt || null };

  const durableCache = await coordinatorOddsCache(env).catch(() => null);
  if (durableCache?.odds) return { odds: durableCache.odds, source: durableCache.source || 'durable-object-cache', updatedAt: durableCache.updatedAt || null };

  const docs = await listDocuments(env, COLLECTIONS.odds, { pageSize: 320 }).catch(() => []);
  const odds = {};
  for (const doc of docs) {
    if (!doc.id) continue;
    const { _name, _createTime, _updateTime, ...clean } = doc;
    odds[doc.id] = clean;
  }
  return { odds, source: docs.length ? 'firestore-collection' : 'empty', updatedAt: null };
}

export async function refreshOdds(env, opts = {}) {
  const fixtures = await getFixtures(env);
  const pack = await fetchOdds(env, fixtures, opts);
  if (!pack.ok) return { ...pack, written: false };

  const previous = await readOdds(env).catch(() => ({ odds: {} }));
  const odds = { ...(previous.odds || {}), ...(pack.odds || {}) };
  const hash = await sha256Hex(stableStringify(odds));
  const oldHash = await sha256Hex(stableStringify(previous.odds || {}));
  const changed = hash !== oldHash;

  const payload = {
    odds,
    hash,
    updatedAt: new Date().toISOString(),
    source: pack.source,
    sourceCount: pack.count || 0
  };

  if (changed && String(env.ODDS_WRITE_TO_FIRESTORE || 'true') === 'true') {
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds, payload).catch(() => null);
  }

  return {
    ok: true,
    task: 'odds',
    source: pack.source,
    fetched: pack.fetched || 0,
    count: Object.keys(odds).length,
    sourceCount: pack.count || 0,
    changed,
    warnings: pack.warnings || [],
    written: changed && String(env.ODDS_WRITE_TO_FIRESTORE || 'true') === 'true',
    updatedAt: payload.updatedAt
  };
}
