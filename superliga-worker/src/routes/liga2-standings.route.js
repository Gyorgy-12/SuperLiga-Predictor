import { badRequest, json } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { fetchLiga2Standings } from '../sources/liga2-standings-source.js';

function enabledParam(url, name) {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true' || value === 'yes';
}

function bypassCache(url) {
  return ['fresh', 'nocache', 'bust'].some(name => enabledParam(url, name));
}

export async function liga2StandingsRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const url = new URL(request.url);
  const fresh = bypassCache(url);
  const ttl = Math.max(30, Number(env.LIGA2_STANDINGS_CACHE_SECONDS || 300));

  if (!fresh) {
    const cached = await edgeGet(request);
    if (cached) return cached;
  }

  try {
    const pack = await fetchLiga2Standings(env);
    const response = json(pack, {
      headers: {
        'cache-control': fresh ? 'no-store, max-age=0' : `public, max-age=${ttl}`
      }
    }, env);
    if (!fresh && ctx?.waitUntil) ctx.waitUntil(edgePut(request, response.clone(), ttl));
    return response;
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Liga 2 standings refresh failed',
      error: error?.message || String(error),
      path: url.pathname
    }));
    return json({ ok: false, error: 'liga2_standings_unavailable' }, {
      status: 503,
      headers: { 'cache-control': 'no-store, max-age=0' }
    }, env);
  }
}

