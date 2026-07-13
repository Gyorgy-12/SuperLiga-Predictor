import { corsHeaders } from './config/cors.js';
import { json, notFound } from './utils/http.js';
import { healthRoute } from './routes/health.route.js';
import { fixturesRoute } from './routes/fixtures.route.js';
import { resultsRoute } from './routes/results.route.js';
import { liveResultsRoute } from './routes/live-results.route.js';
import { syncRoute } from './routes/sync.route.js';
import { adminLiveRoute } from './routes/admin-live.route.js';
import { adminRefreshRoute, coordinatorAlarmRoute, coordinatorStateRoute } from './routes/admin-refresh.route.js';
import { bootstrapLightRoute } from './routes/bootstrap-light.route.js';
import { communityRoute } from './routes/community.route.js';
import { oddsRoute } from './routes/odds.route.js';
import { teamRatingsRoute, eloRoute, marketValuesRoute } from './routes/team-ratings.route.js';
import { sourceTestRoute } from './routes/source-test.route.js';
import { adminFirestoreTestRoute } from './routes/admin-firestore-test.route.js';
import { runCoordinator, coordinatorState, ensureCoordinatorAlarm } from './services/coordinator.service.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      // The daily cron is the primary safety wake-up. Normal app bootstrap also
      // makes sure the Durable Object alarm exists, without running any source
      // fetch unless an actual daily/prematch/live/weekly job is due.
      if (path === '/' || path === '/health' || path === '/bootstrap-light' || path === '/bootstrap' || path === '/admin/coordinator') {
        ctx?.waitUntil?.(ensureCoordinatorAlarm(env).catch(() => null));
      }

      if (path === '/' || path === '/health') return healthRoute(request, env, ctx);
      if (path === '/bootstrap-light' || path === '/bootstrap') return bootstrapLightRoute(request, env, ctx);
      if (path === '/fixtures') return fixturesRoute(request, env, ctx);
      if (path === '/results') return resultsRoute(request, env, ctx);
      if (path === '/live-results') return liveResultsRoute(request, env, ctx);
      if (path === '/sync') return syncRoute(request, env, ctx);
      if (path === '/community') return communityRoute(request, env, ctx);
      if (path === '/odds') return oddsRoute(request, env, ctx);
      if (path === '/team-ratings' || path === '/ratings') return teamRatingsRoute(request, env, ctx);
      if (path === '/elo') return eloRoute(request, env, ctx);
      if (path === '/market-values') return marketValuesRoute(request, env, ctx);
      if (path === '/source-test' || path === '/admin/source-test') return sourceTestRoute(request, env, ctx);
      if (path === '/admin/live') return adminLiveRoute(request, env, ctx);
      if (path === '/admin/refresh') return adminRefreshRoute(request, env, ctx);
      if (path === '/admin/coordinator') return coordinatorStateRoute(request, env, ctx);
      if (path === '/admin/coordinator/alarm') return coordinatorAlarmRoute(request, env, ctx);
      if (path === '/admin/firestore-test') return adminFirestoreTestRoute(request, env, ctx);
      if (path === '/debug/state') {
        return json({
          ok: true,
          now: new Date().toISOString(),
          coordinator: await coordinatorState(env).catch(() => null),
          note: 'B28 uses one daily schedule/odds scan, per-match -30m odds refresh, and 30-second Durable Object live alarms only inside -5m/+120m match windows.'
        }, {}, env);
      }

      return notFound(env);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'worker_error', message: error?.message || String(error) }, { status: 500 }, env);
    }
  },

  async scheduled(event, env, ctx) {
    const cron = event?.cron || '';
    ctx.waitUntil(
      runCoordinator(env, 'wake', { cron })
        .catch(error => {
          console.error('B28 scheduler wake failed', error);
          return null;
        })
    );
  }
};

export { UpdateCoordinator } from './durable/update-coordinator.js';
