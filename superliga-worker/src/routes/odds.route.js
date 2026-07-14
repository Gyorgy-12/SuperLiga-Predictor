import { json, badRequest, requireAdmin, unauthorized } from '../utils/http.js';
import { readOdds, refreshOdds } from '../services/odds.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

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

export async function oddsRoute(request, env, ctx) {
  if (request.method !== 'GET') return badRequest('method not supported', env);

  const url = new URL(request.url);
  const refresh = boolParam(url, 'refresh');
  const fresh = refresh || boolParam(url, 'fresh') || boolParam(url, 'nocache') || boolParam(url, 'bust');

  // Admin-only one-shot source refresh.
  // Usage: /odds?refresh=1&secret=ADMIN_SECRET
  // No fixture IDs are required: every relevant fixture is selected automatically.
  // Missing Flashscore MIDs are discovered and persisted before odds are fetched.
  if (refresh) {
    if (!requireAdmin(request, env)) return unauthorized(env);
    const result = await refreshOdds(env, {
      force: true,
      date: url.searchParams.get('date') || undefined,
      dateFrom: url.searchParams.get('dateFrom') || undefined,
      dateTo: url.searchParams.get('dateTo') || undefined,
      round: url.searchParams.get('round') || undefined,
      url: url.searchParams.get('url') || undefined,
      source: 'odds-route-refresh-all-relevant',
      resolveMids: !boolParam(url, 'skipMidBackfill'),
      writeMids: !boolParam(url, 'dryMidBackfill'),
      oddsReason: url.searchParams.get('reason') || 'manual_all_relevant_refresh'
    });
    return json({ ok: !!result.ok, refreshed: true, ...result }, noStoreInit(), env);
  }

  // Important: never let an early empty response stick in Cloudflare Cache.
  if (!fresh) {
    const cached = await edgeGet(request);
    if (cached) return cached;
  }

  const pack = await readOdds(env, { skipCoordinatorCache: fresh });
  const count = Object.keys(pack.odds || {}).length;
  const ttl = Number(env.ODDS_CACHE_SECONDS || 300);
  const init = count > 0 && !fresh
    ? { headers: { 'cache-control': `public, max-age=${ttl}` } }
    : noStoreInit();

  const res = json({ ok: true, count, ...pack }, init, env);
  if (count > 0 && !fresh && ctx?.waitUntil) {
    ctx.waitUntil(edgePut(request, res.clone(), ttl));
  }
  return res;
}
