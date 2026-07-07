import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchFixtureRefresh } from '../sources/fixture-refresh-source.js';

export async function refreshFixtures(env, opts = {}) {
  const current = await getFixtures(env);
  const pack = await fetchFixtureRefresh(env, current, opts);
  if (!pack.ok) return { ...pack, written: false };

  const merged = mergeFixtures(current, pack.fixtures || []);
  const changed = changedFixtures(current, merged);
  const payload = {
    fixtures: merged,
    updatedAt: new Date().toISOString(),
    source: pack.source,
    sourceUrl: pack.sourceUrl || null,
    sourceCount: pack.count || 0,
    fetched: pack.fetched || 0,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warnings: pack.warnings || []
  };

  const shouldWrite = changed.length > 0 && String(env.FIXTURE_WRITE_TO_FIRESTORE || 'true') === 'true';
  if (shouldWrite) {
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, payload).catch(() => null);
  }

  return {
    ok: true,
    task: 'fixtures',
    source: pack.source,
    sourceUrl: pack.sourceUrl || null,
    fetched: pack.fetched || 0,
    count: merged.length,
    sourceCount: pack.count || 0,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warnings: pack.warnings || [],
    written: shouldWrite,
    fixtures: merged,
    updatedAt: payload.updatedAt
  };
}

function mergeFixtures(current, incoming) {
  const byId = new Map(current.map(f => [f.id, { ...f }]));
  for (const next of incoming || []) {
    if (!next?.id || !byId.has(next.id)) continue;
    byId.set(next.id, { ...byId.get(next.id), ...next });
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

function changedFixtures(before, after) {
  const oldById = Object.fromEntries(before.map(f => [f.id, comparable(f)]));
  return after.filter(f => JSON.stringify(comparable(f)) !== JSON.stringify(oldById[f.id] || null));
}

function comparable(f) {
  return {
    date: f.date || null,
    t: f.t || null,
    label: f.label || null,
    kickoffAt: f.kickoffAt || null,
    livescoreId: f.livescoreId || null,
    sofascoreId: f.sofascoreId || null,
    sourceIds: f.sourceIds || null
  };
}
