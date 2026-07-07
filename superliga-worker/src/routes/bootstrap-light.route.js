import { json } from '../utils/http.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';
import { readStoredResults } from '../services/results.service.js';
import { getLiveSnapshot } from '../services/memory-cache.service.js';
import { syncLive } from '../services/sync.service.js';
import { getFixturesPack } from '../services/fixtures.service.js';
import { readOdds } from '../services/odds.service.js';
import { readTeamRatings } from '../services/team-ratings.service.js';

/**
 * Public startup bundle, ported from the WC26 optimized worker pattern.
 * Goal: first paint should need one public Worker request, not /results +
 * /fixtures + /live-results + /odds ping-pong. Community/user data stays lazy.
 */
export async function bootstrapLightRoute(request, env, ctx) {
  const cached = await edgeGet(request);
  if (cached) return cached;

  const payload = await bootstrapLightPayload(env);
  const res = json(payload, {
    headers: { 'cache-control': `public, max-age=${Number(env.BOOTSTRAP_CACHE_SECONDS || 20)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.BOOTSTRAP_CACHE_SECONDS || 20)));
  return res;
}

export async function bootstrapLightPayload(env) {
  const startedAt = Date.now();
  const livePromise = Promise.race([
    syncLive(env, { force: false, source: 'bootstrap-light' })
      .then(() => getLiveSnapshot())
      .catch(error => ({ results: {}, source: 'bootstrap-live-error', error: error?.message || String(error), degraded: true })),
    new Promise(resolve => setTimeout(() => resolve({ ...getLiveSnapshot(), source: 'bootstrap-live-timeout', fast: true }), Number(env.BOOTSTRAP_LIVE_TIMEOUT_MS || 850)))
  ]);

  const [fixturesPack, resultsPack, livePack, oddsPack, ratingsPack] = await Promise.all([
    getFixturesPack(env).catch(error => ({ ok: false, fixtures: [], source: 'fixtures-error', error: error?.message || String(error) })),
    readStoredResults(env).catch(error => ({ results: {}, source: 'results-error', error: error?.message || String(error) })),
    livePromise,
    readOdds(env).catch(error => ({ odds: {}, source: 'odds-error', error: error?.message || String(error) })),
    readTeamRatings(env).catch(error => ({ ratings: {}, marketValues: {}, source: 'ratings-error', error: error?.message || String(error) }))
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
