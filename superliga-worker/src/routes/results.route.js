import { json } from '../utils/http.js';
import { readStoredResults, refreshPublicResultsCache } from '../services/results.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function resultsRoute(request, env, ctx) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('nocache') === '1';

  if (!fresh) {
    const cached = await edgeGet(request);
    if (cached) return cached;
  }

  // The frontend already asks /results with fresh=1. Honour it by reading the
  // complete Firestore collection instead of a possibly stale/sparse aggregate.
  const pack = await readStoredResults(env, fresh ? {
    forceCollection: true,
    skipMemory: true,
    skipPublicCache: true
  } : {});

  let rebuilt = null;
  if (fresh) {
    rebuilt = await refreshPublicResultsCache(env, pack.results || {}).catch(() => null);
  }

  const res = json({
    ok: true,
    source: pack.source,
    count: Object.keys(pack.results || {}).length,
    results: pack.results || {},
    publicCacheRebuilt: !!rebuilt,
    updatedAt: rebuilt?.updatedAt || new Date().toISOString()
  }, {
    headers: { 'cache-control': fresh ? 'no-store, max-age=0' : `public, max-age=${Number(env.RESULTS_CACHE_SECONDS || 90)}` }
  }, env);

  if (!fresh && ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.RESULTS_CACHE_SECONDS || 90)));
  return res;
}
