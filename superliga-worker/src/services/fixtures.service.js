import { STATIC_FIXTURES } from '../data/fixtures.js';
import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { coordinatorFixtureCache } from './coordinator.service.js';

function sortFixtures(rows = []) {
  return rows.slice().sort((a, b) => {
    const ad = `${a.date || '9999-99-99'}T${a.t || a.time || '99:99'}|${String(a.id || '')}`;
    const bd = `${b.date || '9999-99-99'}T${b.t || b.time || '99:99'}|${String(b.id || '')}`;
    return ad.localeCompare(bd, undefined, { numeric: true });
  });
}

function mergeOntoSeed(overrides = []) {
  const byId = Object.fromEntries((overrides || []).filter(f => f?.id).map(f => [String(f.id), f]));
  return sortFixtures(STATIC_FIXTURES.map(f => ({ ...f, ...(byId[String(f.id)] || {}) })));
}

export async function getFixtures(env, opts = {}) {
  return (await getFixturesPack(env, opts)).fixtures;
}

export async function getFixturesPack(env, opts = {}) {
  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures).catch(() => null);
  if (Array.isArray(publicDoc?.fixtures) && publicDoc.fixtures.length) {
    return {
      ok: true,
      source: publicDoc.source || 'firestore-public-cache',
      updatedAt: publicDoc.updatedAt || publicDoc._updateTime || null,
      fixtures: mergeOntoSeed(publicDoc.fixtures),
      meta: publicDoc
    };
  }

  const durableCache = opts.skipCoordinatorCache ? null : await coordinatorFixtureCache(env).catch(() => null);
  if (Array.isArray(durableCache?.fixtures) && durableCache.fixtures.length) {
    return {
      ok: true,
      source: durableCache.source || 'durable-object-cache',
      updatedAt: durableCache.updatedAt || null,
      fixtures: mergeOntoSeed(durableCache.fixtures),
      meta: durableCache
    };
  }

  const docs = await listDocuments(env, COLLECTIONS.fixtures, { pageSize: 320 }).catch(() => []);
  const docFixtures = docs.map(({ _name, _createTime, _updateTime, ...f }) => f).filter(f => f.id);
  if (docFixtures.length) {
    return {
      ok: true,
      source: 'firestore-fixture-docs',
      updatedAt: null,
      fixtures: mergeOntoSeed(docFixtures),
      meta: { sourceCount: docFixtures.length }
    };
  }

  return { ok: true, source: 'static-seed-fallback', updatedAt: null, fixtures: sortFixtures(STATIC_FIXTURES), meta: {} };
}

export async function readFixtureOverrides(env) {
  return (await getFixturesPack(env)).fixtures;
}

export async function writeFixtureOverride(env, fixture) {
  if (!fixture?.id) throw new Error('fixture.id missing');
  const data = { ...fixture, overridden: true, updatedAt: new Date().toISOString() };
  await patchDocument(env, COLLECTIONS.fixtures, fixture.id, data);

  // Keep the public fixture cache in sync after a manual one-off override too.
  const current = await getFixtures(env).catch(() => STATIC_FIXTURES);
  const merged = mergeOntoSeed(current.map(f => String(f.id) === String(data.id) ? { ...f, ...data } : f));
  await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, {
    fixtures: merged,
    updatedAt: data.updatedAt,
    source: 'manual-fixture-override',
    changedCount: 1,
    changedIds: [data.id]
  }).catch(() => null);

  return data;
}
