import { json, badRequest } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { readTeamRatings, readElo, readMarketValues } from '../services/team-ratings.service.js';

export async function teamRatingsRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const cached = await edgeGet(request);
  if (cached) return cached;
  const pack = await readTeamRatings(env);
  const res = json({ ok: true, count: Object.keys(pack.ratings || {}).length, marketCount: Object.keys(pack.marketValues || {}).length, ...pack }, {
    headers: { 'cache-control': `public, max-age=${Number(env.RATINGS_CACHE_SECONDS || 3600)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.RATINGS_CACHE_SECONDS || 3600)));
  return res;
}

export async function eloRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const cached = await edgeGet(request);
  if (cached) return cached;
  const pack = await readElo(env);
  const res = json({ ok: true, count: Object.keys(pack.ratings || {}).length, ...pack }, {
    headers: { 'cache-control': `public, max-age=${Number(env.RATINGS_CACHE_SECONDS || 3600)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.RATINGS_CACHE_SECONDS || 3600)));
  return res;
}

export async function marketValuesRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const cached = await edgeGet(request);
  if (cached) return cached;
  const pack = await readMarketValues(env);
  const res = json({ ok: true, count: Object.keys(pack.marketValues || {}).length, ...pack }, {
    headers: { 'cache-control': `public, max-age=${Number(env.RATINGS_CACHE_SECONDS || 3600)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.RATINGS_CACHE_SECONDS || 3600)));
  return res;
}
