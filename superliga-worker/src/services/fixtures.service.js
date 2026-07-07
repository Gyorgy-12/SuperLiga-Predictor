import { STATIC_FIXTURES } from '../data/fixtures.js';
import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { coordinatorFixtureCache } from './coordinator.service.js';

export async function getFixtures(env) {
  const overrides = await readFixtureOverrides(env);
  const byId = Object.fromEntries(overrides.map(f => [f.id, f]));
  return STATIC_FIXTURES.map(f => ({ ...f, ...(byId[f.id] || {}) }));
}

export async function readFixtureOverrides(env) {
  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures).catch(() => null);
  if (Array.isArray(publicDoc?.fixtures)) return publicDoc.fixtures;

  const durableCache = await coordinatorFixtureCache(env).catch(() => null);
  if (Array.isArray(durableCache?.fixtures)) return durableCache.fixtures;

  const docs = await listDocuments(env, COLLECTIONS.fixtures, { pageSize: 320 }).catch(() => []);
  return docs.map(({ _name, _createTime, _updateTime, ...f }) => f).filter(f => f.id);
}

export async function writeFixtureOverride(env, fixture) {
  if (!fixture?.id) throw new Error('fixture.id missing');
  const data = { ...fixture, overridden: true, updatedAt: new Date().toISOString() };
  await patchDocument(env, COLLECTIONS.fixtures, fixture.id, data);
  return data;
}
