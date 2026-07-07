import { json, badRequest } from '../utils/http.js';
import { readOdds } from '../services/odds.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function oddsRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const cached = await edgeGet(request);
  if (cached) return cached;
  const pack = await readOdds(env);
  const res = json({ ok: true, count: Object.keys(pack.odds || {}).length, ...pack }, {
    headers: { 'cache-control': `public, max-age=${Number(env.ODDS_CACHE_SECONDS || 300)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.ODDS_CACHE_SECONDS || 300)));
  return res;
}
