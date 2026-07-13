import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchOdds } from '../sources/odds-source.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { coordinatorOddsCache } from './coordinator.service.js';

export async function readOdds(env, opts = {}) {
  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds).catch(() => null);
  if (publicDoc?.odds) return { odds: publicDoc.odds, source: 'firestore-public-cache', updatedAt: publicDoc.updatedAt || null };

  const durableCache = opts.skipCoordinatorCache ? null : await coordinatorOddsCache(env).catch(() => null);
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
  const allFixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const fixtures = selectTargetFixtures(allFixtures, opts);

  if (!fixtures.length) {
    return {
      ok: true,
      task: 'odds',
      source: 'targeted-odds-b28',
      skipped: true,
      reason: 'no_target_fixtures',
      selectedCount: 0,
      selectedIds: [],
      changed: false,
      written: false,
      updatedAt: new Date().toISOString()
    };
  }

  const pack = await fetchOdds(env, fixtures, opts);
  if (!pack.ok) {
    return {
      ...pack,
      task: 'odds',
      selectedCount: fixtures.length,
      selectedIds: fixtures.map(f => String(f.id)),
      oddsReason: opts.oddsReason || null,
      written: false
    };
  }

  const previous = await readOdds(env, { skipCoordinatorCache: true }).catch(() => ({ odds: {} }));
  const odds = { ...(previous.odds || {}), ...(pack.odds || {}) };
  const hash = await sha256Hex(stableStringify(odds));
  const oldHash = await sha256Hex(stableStringify(previous.odds || {}));
  const changed = hash !== oldHash;
  const updatedAt = new Date().toISOString();

  const payload = {
    odds,
    hash,
    updatedAt,
    source: pack.source,
    sourceCount: pack.count || 0,
    lastTargetIds: fixtures.map(f => String(f.id)),
    lastTargetReason: opts.oddsReason || null
  };

  const writeEnabled = String(env.ODDS_WRITE_TO_FIRESTORE || 'true') === 'true';
  if (changed && writeEnabled) {
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds, payload).catch(() => null);
  }

  return {
    ok: true,
    task: 'odds',
    source: pack.source,
    fetched: pack.fetched || 0,
    count: Object.keys(odds).length,
    sourceCount: pack.count || 0,
    selectedCount: fixtures.length,
    selectedIds: fixtures.map(f => String(f.id)),
    oddsReason: opts.oddsReason || null,
    changed,
    warnings: pack.warnings || [],
    written: changed && writeEnabled,
    updatedAt
  };
}

function selectTargetFixtures(allFixtures, opts = {}) {
  if (Array.isArray(opts.activeFixtures)) {
    const ids = new Set(opts.activeFixtures.map(f => String(f?.id || '')).filter(Boolean));
    return allFixtures.filter(f => ids.has(String(f.id)));
  }

  const rawIds = Array.isArray(opts.fixtureIds)
    ? opts.fixtureIds
    : String(opts.fixtureIds || opts.ids || '').split(',');
  const ids = new Set(rawIds.map(x => String(x || '').trim()).filter(Boolean));
  if (ids.size) return allFixtures.filter(f => ids.has(String(f.id)));

  const dateFrom = String(opts.dateFrom || '').slice(0, 10);
  const dateTo = String(opts.dateTo || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return allFixtures.filter(f => {
      const date = String(f?.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      if (dateFrom && date < dateFrom) return false;
      if (dateTo && date > dateTo) return false;
      return true;
    });
  }

  return allFixtures;
}
