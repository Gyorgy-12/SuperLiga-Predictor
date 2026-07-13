import { json } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { readStoredResults } from '../services/results.service.js';
import { getLiveSnapshot } from '../services/memory-cache.service.js';
import { syncLive } from '../services/sync.service.js';
import { getFixturesPack } from '../services/fixtures.service.js';
import { readOdds } from '../services/odds.service.js';
import { readTeamRatings } from '../services/team-ratings.service.js';

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

/**
 * Public startup bundle, ported from the WC26 optimized worker pattern.
 * B3 fix: do not cache an early empty odds/ratings bundle forever-ish at the edge.
 * Use /bootstrap-light?fresh=1 when smoke-testing after admin refreshes.
 */
export async function bootstrapLightRoute(request, env, ctx) {
  const url = new URL(request.url);
  const fresh = boolParam(url, 'fresh') || boolParam(url, 'nocache') || boolParam(url, 'bust');

  if (!fresh) {
    const cached = await edgeGet(request);
    if (cached) return cached;
  }

  const payload = await bootstrapLightPayload(env, { fresh });
  const auxEmpty = payload.oddsCount === 0 && payload.ratingsCount === 0 && payload.marketValuesCount === 0;
  const ttl = Number(env.BOOTSTRAP_CACHE_SECONDS || 20);
  const res = json(payload, auxEmpty || fresh ? noStoreInit() : {
    headers: { 'cache-control': `public, max-age=${ttl}` }
  }, env);

  if (!auxEmpty && !fresh && ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), ttl));
  return res;
}

export async function bootstrapLightPayload(env, opts = {}) {
  const startedAt = Date.now();
  const livePromise = Promise.race([
    syncLive(env, { force: false, source: 'bootstrap-light' })
      .then(() => getLiveSnapshot())
      .catch(error => ({ results: {}, source: 'bootstrap-live-error', error: error?.message || String(error), degraded: true })),
    new Promise(resolve => setTimeout(() => resolve({ ...getLiveSnapshot(), source: 'bootstrap-live-timeout', fast: true }), Number(env.BOOTSTRAP_LIVE_TIMEOUT_MS || 850)))
  ]);

  const readOpts = opts.fresh ? { skipCoordinatorCache: true } : {};
  const [fixturesPack, resultsPack, livePack, oddsPack, ratingsPack] = await Promise.all([
    getFixturesPack(env, readOpts).catch(error => ({ ok: false, fixtures: [], source: 'fixtures-error', error: error?.message || String(error) })),
    readStoredResults(env).catch(error => ({ results: {}, source: 'results-error', error: error?.message || String(error) })),
    livePromise,
    readOdds(env, readOpts).catch(error => ({ odds: {}, source: 'odds-error', error: error?.message || String(error) })),
    readTeamRatings(env, readOpts).catch(error => ({ ratings: {}, marketValues: {}, source: 'ratings-error', error: error?.message || String(error) }))
  ]);

  const results = resultsPack?.results && typeof resultsPack.results === 'object' ? resultsPack.results : {};
  const live = livePack?.results && typeof livePack.results === 'object' ? livePack.results : {};
  const odds = oddsPack?.odds && typeof oddsPack.odds === 'object' ? oddsPack.odds : {};
  const ratings = ratingsPack?.ratings && typeof ratingsPack.ratings === 'object' ? ratingsPack.ratings : {};
  const marketValues = ratingsPack?.marketValues && typeof ratingsPack.marketValues === 'object' ? ratingsPack.marketValues : {};

  return {
    ok: true,
    kind: 'bootstrap-light',
    source: 'superliga-worker-bootstrap-light',
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    fixtures: fixturesPack.fixtures || [],
    fixturesCount: (fixturesPack.fixtures || []).length,
    fixturesSource: fixturesPack.source || '',
    fixtureCacheUpdatedAt: fixturesPack.updatedAt || null,
    fixturesError: fixturesPack.error || '',
    results,
    resultsCount: Object.keys(results).length,
    resultsSource: resultsPack?.source || '',
    resultsError: resultsPack?.error || '',
    live,
    liveCount: Object.keys(live).length,
    liveSource: livePack?.source || '',
    liveDegraded: !!livePack?.degraded,
    liveError: livePack?.error || '',
    odds,
    oddsCount: Object.keys(odds).length,
    oddsSource: oddsPack?.source || '',
    oddsError: oddsPack?.error || '',
    ratings,
    ratingsCount: Object.keys(ratings).length,
    marketValues,
    marketValuesCount: Object.keys(marketValues).length,
    ratingsSource: ratingsPack?.source || '',
    ratingsError: ratingsPack?.error || ''
  };
}
