import { json } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { syncLive } from '../services/sync.service.js';
import { getLiveSnapshot } from '../services/memory-cache.service.js';
import { nextSuggestedDelayMs } from '../core/match-window.js';
import { getFixtures } from '../services/fixtures.service.js';
import { readStoredResults } from '../services/results.service.js';

export async function liveResultsRoute(request, env, ctx) {
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const noSync = url.searchParams.get('nosync') === '1';
  const fast = url.searchParams.get('fast') === '1' || url.searchParams.get('quick') === '1';
  const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('nocache') === '1' || url.searchParams.get('live') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const hasFilter = !!(url.searchParams.get('date') || url.searchParams.get('ids') || url.searchParams.get('round') || url.searchParams.get('all'));

  if (fast) {
    return json(await livePayload({ env, sync: null, source: 'worker-live-memory-fast', fast: true }), {
      headers: { 'cache-control': 'no-store, max-age=0', 'x-worker-cache': 'live-memory-fast' }
    }, env);
  }

  if (!fresh && !noSync && !force && !debug && !hasFilter) {
    const cached = await edgeGet(request);
    if (cached) return cached;
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
  const syncResults = meta.sync?.results && typeof meta.sync.results === 'object' ? meta.sync.results : null;
  // B26: the current sync response contains provider metadata that an older
  // compact memory normalizer may omit. Prefer it for this HTTP response while
  // retaining all other snapshot rows.
  const visibleResults = syncResults ? { ...(snapshot.results || {}), ...syncResults } : (snapshot.results || {});
  let nextDelayMs = 30000;
  if (!meta.fast) {
    try {
      const fixtures = await getFixtures(meta.env || {});
      const stored = await readStoredResults(meta.env || {});
      nextDelayMs = nextSuggestedDelayMs(fixtures, stored.results);
    } catch (_) {}
  }
  return {
    ok: true,
    sync: meta.sync || null,
    count: Object.keys(visibleResults).length,
    results: visibleResults,
    pipelineVersion: 'b26-request-budget-guard',
    nextDelayMs,
    source: meta.source || snapshot.source || 'memory',
    fast: !!meta.fast,
    updatedAt: snapshot.updatedAt || new Date().toISOString()
  };
}
