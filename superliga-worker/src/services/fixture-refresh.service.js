import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchFixtureRefresh } from '../sources/fixture-refresh-source.js';

export async function refreshFixtures(env, opts = {}) {
  const current = await getFixtures(env, { skipCoordinatorCache: true });
  const pack = await fetchFixtureRefresh(env, current, opts);
  if (!pack.ok) return { ...pack, written: false };

  const merged = mergeFixtures(current, pack.fixtures || []);
  const changed = changedFixtures(current, merged);
  const nowIso = new Date().toISOString();
  const payload = {
    fixtures: merged,
    updatedAt: nowIso,
    source: pack.source,
    sourceUrl: pack.sourceUrl || null,
    sourceCount: pack.count || 0,
    fetched: pack.fetched || 0,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warnings: pack.warnings || []
  };

  const writeEnabled = String(env.FIXTURE_WRITE_TO_FIRESTORE || 'true') === 'true';
  const individualEnabled = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  const writeAllDocs = opts.force || String(env.FIXTURE_WRITE_ALL_DOCS_ON_FORCE || 'true') === 'true';
  let publicCacheWrite = null;
  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;

  if (writeEnabled) {
    // Always refresh the public cache after a successful source fetch. Otherwise
    // the app can stay on seed data forever when the data is identical to the
    // previous in-memory merge but no Firestore doc exists yet.
    publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, payload).catch(error => ({ ok: false, error: error?.message || String(error) }));

    if (individualEnabled) {
      const docsToWrite = writeAllDocs ? merged : changed;
      individualDocsAttempted = docsToWrite.length;
      const stamped = docsToWrite.map(f => ({ ...f, fixtureCacheUpdatedAt: nowIso, fixtureCacheSource: pack.source }));
      const chunks = [];
      for (let i = 0; i < stamped.length; i += 20) chunks.push(stamped.slice(i, i + 20));
      for (const chunk of chunks) {
        const results = await Promise.all(chunk.map(f => patchDocument(env, COLLECTIONS.fixtures, f.id, f).then(() => true).catch(() => false)));
        individualDocsWritten += results.filter(Boolean).length;
      }
    }
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
    written: writeEnabled,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    fixtures: merged,
    updatedAt: payload.updatedAt
  };
}

function mergeFixtures(current, incoming) {
  const byId = new Map(current.map(f => [String(f.id), { ...f }]));
  for (const next of incoming || []) {
    if (!next?.id || !byId.has(String(next.id))) continue;
    byId.set(String(next.id), { ...byId.get(String(next.id)), ...next });
  }
  return [...byId.values()].sort((a, b) => {
    const ad = `${a.date || '9999-99-99'}T${a.t || a.time || '99:99'}|${String(a.id || '')}`;
    const bd = `${b.date || '9999-99-99'}T${b.t || b.time || '99:99'}|${String(b.id || '')}`;
    return ad.localeCompare(bd, undefined, { numeric: true });
  });
}

function changedFixtures(before, after) {
  const oldById = Object.fromEntries(before.map(f => [String(f.id), comparable(f)]));
  return after.filter(f => JSON.stringify(comparable(f)) !== JSON.stringify(oldById[String(f.id)] || null));
}

function comparable(f) {
  return {
    date: f.date || null,
    t: f.t || f.time || null,
    label: f.label || null,
    kickoffAt: f.kickoffAt || null,
    livescoreId: f.livescoreId || null,
    sofascoreId: f.sofascoreId || null,
    sourceIds: f.sourceIds || null
  };
}
