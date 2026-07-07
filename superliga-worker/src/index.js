import { corsHeaders, withCors } from './config/cors.js';
import { json, notFound } from './utils/http.js';
import { healthRoute } from './routes/health.route.js';
import { fixturesRoute } from './routes/fixtures.route.js';
import { resultsRoute } from './routes/results.route.js';
import { liveResultsRoute } from './routes/live-results.route.js';
import { syncRoute } from './routes/sync.route.js';
import { adminLiveRoute } from './routes/admin-live.route.js';
import { communityRoute } from './routes/community.route.js';
import { syncLive } from './services/sync.service.js';
import { oddsRoute } from './routes/odds.route.js';
import { teamRatingsRoute, eloRoute, marketValuesRoute } from './routes/team-ratings.route.js';
import { adminRefreshRoute, coordinatorStateRoute, coordinatorAlarmRoute } from './routes/admin-refresh.route.js';
import { sourceTestRoute } from './routes/source-test.route.js';
import { bootstrapLightRoute } from './routes/bootstrap-light.route.js';
import { UpdateCoordinator } from './durable/update-coordinator.js';
import { runCoordinator } from './services/coordinator.service.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/' || path === '/health') return healthRoute(request, env, ctx);
      if (path === '/bootstrap-light') return bootstrapLightRoute(request, env, ctx);
      if (path === '/fixtures') return fixturesRoute(request, env, ctx);
      if (path === '/results') return resultsRoute(request, env, ctx);
      if (path === '/odds') return oddsRoute(request, env, ctx);
      if (path === '/team-ratings') return teamRatingsRoute(request, env, ctx);
      if (path === '/elo') return eloRoute(request, env, ctx);
      if (path === '/market-values') return marketValuesRoute(request, env, ctx);
      if (path === '/live-results') return liveResultsRoute(request, env, ctx);
      if (path === '/sync') return syncRoute(request, env, ctx);
      if (path === '/community') return communityRoute(request, env, ctx);
      if (path === '/admin/live') return adminLiveRoute(request, env, ctx);
      if (path === '/admin/refresh') return adminRefreshRoute(request, env, ctx);
      if (path === '/admin/coordinator') return coordinatorStateRoute(request, env, ctx);
      if (path === '/admin/coordinator/alarm') return coordinatorAlarmRoute(request, env, ctx);
      if (path === '/admin/source-test') return sourceTestRoute(request, env, ctx);
      if (path === '/debug/state') return json({ ok: true, now: new Date().toISOString(), note: 'Use /live-results?nosync=1 for current memory snapshot.' }, {}, env);

      return notFound(env);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'worker_error', message: error.message || String(error) }, { status: 500 }, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env).catch(error => console.error('scheduled task failed', error)));
  }
};

async function handleScheduled(event, env) {
  const cron = event.cron || '';
  if (cron === '*/15 * * * *') return syncLive(env, { force: false, cron: true });
  if (cron === '0 7 * * 3') return runCoordinator(env, 'weekly', { force: false, cron });
  return runCoordinator(env, 'daily', { force: false, cron });
}

export { UpdateCoordinator };
