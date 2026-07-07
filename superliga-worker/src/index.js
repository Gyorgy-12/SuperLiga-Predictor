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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/' || path === '/health') return healthRoute(request, env, ctx);
      if (path === '/fixtures') return fixturesRoute(request, env, ctx);
      if (path === '/results') return resultsRoute(request, env, ctx);
      if (path === '/live-results') return liveResultsRoute(request, env, ctx);
      if (path === '/sync') return syncRoute(request, env, ctx);
      if (path === '/community') return communityRoute(request, env, ctx);
      if (path === '/admin/live') return adminLiveRoute(request, env, ctx);
      if (path === '/debug/state') return json({ ok: true, now: new Date().toISOString(), note: 'Use /live-results?nosync=1 for current memory snapshot.' }, {}, env);

      return notFound(env);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: 'worker_error', message: error.message || String(error) }, { status: 500 }, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncLive(env, { force: false, cron: true }).catch(error => console.error('scheduled sync failed', error)));
  }
};
