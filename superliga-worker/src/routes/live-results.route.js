import { json } from '../utils/http.js';
import { withCors } from '../config/cors.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { syncLive } from '../services/sync.service.js';
import { getLiveSnapshot } from '../services/memory-cache.service.js';
import { nextSuggestedDelayMs } from '../core/match-window.js';
import { getFixtures } from '../services/fixtures.service.js';
import { readStoredResults } from '../services/results.service.js';
import {
  coordinatorLiveResultsCache,
  ensureCoordinatorAlarm,
  runCoordinator
} from '../services/coordinator.service.js';

const COORDINATOR_CACHE_STALE_MS = 45_000;
const EMPTY_CACHE_WAIT_MS = 6_000;

export async function liveResultsRoute(request, env, ctx) {
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const noSync = url.searchParams.get('nosync') === '1';
  const fast = url.searchParams.get('fast') === '1' || url.searchParams.get('quick') === '1';
  const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('nocache') === '1' || url.searchParams.get('live') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const clientPoll = url.searchParams.get('live') === '1' && !force && !debug;
  const hasFilter = !!(url.searchParams.get('date') || url.searchParams.get('ids') || url.searchParams.get('round') || url.searchParams.get('all'));

  // Public browser polling must never fan out to all providers inside every
  // request. The Durable Object owns the provider sync and persists a compact
  // shared live cache. This avoids provider stampedes and Cloudflare-generated
  // 503 pages which cannot carry our CORS headers.
  if (fast || clientPoll) {
    let coordinatorCache = await coordinatorLiveResultsCache(env).catch(() => null);
    const cacheCount = Object.keys(coordinatorCache?.results || {}).length;
    const cacheAgeMs = coordinatorCache?.updatedAt
      ? Math.max(0, Date.now() - Date.parse(coordinatorCache.updatedAt))
      : Infinity;
    const stale = !Number.isFinite(cacheAgeMs) || cacheAgeMs > COORDINATOR_CACHE_STALE_MS;

    ctx?.waitUntil?.(ensureCoordinatorAlarm(env).catch(() => null));

    if (clientPoll && !noSync && (stale || cacheCount === 0)) {
      const refreshPromise = runCoordinator(env, 'live', { force: false }).catch(error => ({
        ok: false,
        error: error?.message || String(error),
        source: 'coordinator-live-error'
      }));

      // On a cold cache, wait briefly for the central sync. If it takes longer,
      // return the last known snapshot and let waitUntil finish it safely.
      if (cacheCount === 0) {
        const refresh = await Promise.race([
          refreshPromise,
          delay(EMPTY_CACHE_WAIT_MS).then(() => null)
        ]);
        if (refresh?.results) {
          coordinatorCache = compactCoordinatorResult(refresh, 'coordinator-cold-refresh');
        } else {
          ctx?.waitUntil?.(refreshPromise);
        }
      } else {
        ctx?.waitUntil?.(refreshPromise);
      }
    }

    const payload = await livePayload({
      env,
      sync: clientPoll ? {
        ok: true,
        queued: clientPoll && !noSync && (stale || cacheCount === 0),
        source: 'coordinator-shared-live-cache',
        cacheAgeMs: Number.isFinite(cacheAgeMs) ? cacheAgeMs : null
      } : null,
      coordinatorCache,
      source: fast ? 'worker-live-coordinator-fast' : 'worker-live-coordinator-poll',
      fast
    });

    return json(payload, {
      headers: {
        'cache-control': 'no-store, max-age=0',
        'x-worker-cache': fast ? 'coordinator-live-fast' : 'coordinator-live-poll'
      }
    }, env);
  }

  if (!fresh && !noSync && !force && !debug && !hasFilter) {
    const cached = await edgeGet(request);
    if (cached) return withCors(cached, env);
  }

  let sync = null;
  if (!noSync) {
    sync = await syncLive(env, {
      force,
      debug,
      date: url.searchParams.get('date') || undefined,
      ids: url.searchParams.get('ids') || undefined,
      round: url.searchParams.get('round') || undefined,
      all: url.searchParams.get('all') === '1',
      scheduled: url.searchParams.get('scheduled') === '1',
      includeScheduled: url.searchParams.get('scheduled') === '1',
      limit: url.searchParams.get('limit') || undefined,
      maxDates: url.searchParams.get('maxDates') || undefined,
      source: fresh ? 'live-results-fresh' : 'live-results'
    }).catch(error => ({ ok: false, error: error?.message || String(error), source: 'sync-live-error' }));
  }

  const payload = await livePayload({ env, sync, source: fresh ? 'worker-live-direct-fresh' : 'worker-live-results', debug });
  const cacheable = !fresh && !force && !debug && !hasFilter && !noSync;
  const res = json(payload, {
    headers: {
      'cache-control': cacheable ? `public, max-age=${Number(env.LIVE_CACHE_SECONDS || 10)}` : 'no-store, max-age=0',
      'x-worker-cache': cacheable ? 'live-edge-candidate' : 'live-direct'
    }
  }, env);

  if (cacheable && ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.LIVE_CACHE_SECONDS || 10)));
  return res;
}

async function livePayload(meta = {}) {
  const snapshot = getLiveSnapshot();
  const syncResults = meta.sync?.results && typeof meta.sync.results === 'object' ? meta.sync.results : {};
  const coordinatorResults = meta.coordinatorCache?.results && typeof meta.coordinatorCache.results === 'object'
    ? meta.coordinatorCache.results
    : {};

  let fixtures = [];
  let stored = { results: {}, source: 'empty' };
  let nextDelayMs = 30_000;
  try {
    [fixtures, stored] = await Promise.all([
      getFixtures(meta.env || {}).catch(() => []),
      readStoredResults(meta.env || {}).catch(() => ({ results: {}, source: 'empty' }))
    ]);
    nextDelayMs = nextSuggestedDelayMs(fixtures, stored.results || {});
  } catch (_) {}

  const visibleResults = {
    ...(stored.results || {}),
    ...(snapshot.results || {}),
    ...coordinatorResults,
    ...syncResults
  };

  return {
    ok: true,
    sync: meta.sync || null,
    count: Object.keys(visibleResults).length,
    results: visibleResults,
    pipelineVersion: 'b39-mobile-flashscore-live-clock',
    nextDelayMs,
    source: meta.source || meta.coordinatorCache?.source || snapshot.source || stored.source || 'memory',
    fast: !!meta.fast,
    coordinatorCache: meta.coordinatorCache ? {
      source: meta.coordinatorCache.source || null,
      activeIds: Array.isArray(meta.coordinatorCache.activeIds) ? meta.coordinatorCache.activeIds : [],
      count: Object.keys(coordinatorResults).length,
      updatedAt: meta.coordinatorCache.updatedAt || null
    } : null,
    updatedAt: meta.sync?.updatedAt || meta.coordinatorCache?.updatedAt || snapshot.updatedAt || stored.updatedAt || new Date().toISOString()
  };
}

function compactCoordinatorResult(result, source) {
  const activeIds = Array.isArray(result?.active)
    ? result.active.map(row => String(row?.id || '')).filter(Boolean)
    : [];
  const allResults = result?.results && typeof result.results === 'object' ? result.results : {};
  const results = {};
  for (const id of activeIds) {
    if (allResults[id]) results[id] = allResults[id];
  }
  return {
    ok: result?.ok !== false,
    results,
    activeIds,
    active: Array.isArray(result?.active) ? result.active : [],
    source,
    updatedAt: result?.updatedAt || new Date().toISOString()
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
