import { json } from '../utils/http.js';
import { readStoredResults } from '../services/results.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function resultsRoute(request, env, ctx) {
  const cached = await edgeGet(request);
  if (cached) return cached;

  const pack = await readStoredResults(env);
  const res = json({
    ok: true,
    source: pack.source,
    count: Object.keys(pack.results || {}).length,
    results: pack.results || {},
    updatedAt: new Date().toISOString()
  }, {
    headers: { 'cache-control': `public, max-age=${Number(env.RESULTS_CACHE_SECONDS || 90)}` }
  }, env);

  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.RESULTS_CACHE_SECONDS || 90)));
  return res;
}
