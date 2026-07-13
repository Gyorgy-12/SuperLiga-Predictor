import { json, badRequest, requireAdmin, unauthorized } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { readTeamRatings, readElo, readMarketValues, refreshTeamRatings, refreshEloRatings, refreshMarketValues } from '../services/team-ratings.service.js';

function boolParam(url, name) {
  const v = url.searchParams.get(name);
  return v === '1' || v === 'true' || v === 'yes';
}

function noStoreInit(extra = {}) {
  return {
    ...extra,
    headers: {
      ...(extra.headers || {}),
      'cache-control': 'no-store, max-age=0'
    }
  };
}

async function maybeRefresh(request, env, url, label) {
  const refresh = boolParam(url, 'refresh');
  if (!refresh) return null;
  if (!requireAdmin(request, env)) return unauthorized(env);

  const options = {
    force: true,
    source: `${label}-route-refresh-b32`,
    url: url.searchParams.get('url') || undefined
  };

  const result = label === 'elo'
    ? await refreshEloRatings(env, options)
    : label === 'market-values'
      ? await refreshMarketValues(env, options)
      : await refreshTeamRatings(env, options);

  return json(
    { ok: !!result.ok, refreshed: true, ...result },
    noStoreInit(),
    env
  );
}

function shouldBypassCache(url) {
  return boolParam(url, 'refresh') || boolParam(url, 'fresh') || boolParam(url, 'nocache') || boolParam(url, 'bust');
}

async function cacheAwareRead(request, env, ctx, url, ttl, readFn, countFn, responseBuilder) {
  const fresh = shouldBypassCache(url);
  if (!fresh) {
    const cached = await edgeGet(request);
    if (cached) return cached;
  }

  const pack = await readFn(env, { skipCoordinatorCache: fresh });
  const count = countFn(pack);
  const init = count > 0 && !fresh
    ? { headers: { 'cache-control': `public, max-age=${ttl}` } }
    : noStoreInit();

  const res = json(responseBuilder(pack, count), init, env);
  if (count > 0 && !fresh && ctx?.waitUntil) {
    ctx.waitUntil(edgePut(request, res.clone(), ttl));
  }
  return res;
}

export async function teamRatingsRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const url = new URL(request.url);
  const refreshed = await maybeRefresh(request, env, url, 'team-ratings');
  if (refreshed) return refreshed;

  const ttl = Number(env.RATINGS_CACHE_SECONDS || 3600);
  return cacheAwareRead(
    request,
    env,
    ctx,
    url,
    ttl,
    readTeamRatings,
    pack => Math.max(Object.keys(pack.ratings || {}).length, Object.keys(pack.marketValues || {}).length),
    (pack, count) => ({
      ok: true,
      count: Object.keys(pack.ratings || {}).length,
      marketCount: Object.keys(pack.marketValues || {}).length,
      ...pack
    })
  );
}

export async function eloRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const url = new URL(request.url);
  const refreshed = await maybeRefresh(request, env, url, 'elo');
  if (refreshed) return refreshed;

  const ttl = Number(env.RATINGS_CACHE_SECONDS || 3600);
  return cacheAwareRead(
    request,
    env,
    ctx,
    url,
    ttl,
    readElo,
    pack => Object.keys(pack.ratings || {}).length,
    (pack, count) => ({ ok: true, count, ...pack })
  );
}

export async function marketValuesRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);
  const url = new URL(request.url);
  const refreshed = await maybeRefresh(request, env, url, 'market-values');
  if (refreshed) return refreshed;

  const ttl = Number(env.RATINGS_CACHE_SECONDS || 3600);
  return cacheAwareRead(
    request,
    env,
    ctx,
    url,
    ttl,
    readMarketValues,
    pack => Object.keys(pack.marketValues || {}).length,
    (pack, count) => ({ ok: true, count, ...pack })
  );
}
