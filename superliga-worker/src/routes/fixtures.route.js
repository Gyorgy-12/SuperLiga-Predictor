import { json, badRequest, readJson, requireAdmin, unauthorized } from '../utils/http.js';
import { getFixtures, writeFixtureOverride } from '../services/fixtures.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function fixturesRoute(request, env, ctx) {
  if (request.method === 'GET') {
    const cached = await edgeGet(request);
    if (cached) return cached;
    const fixtures = await getFixtures(env);
    const res = json({ ok: true, count: fixtures.length, fixtures, updatedAt: new Date().toISOString() }, {
      headers: { 'cache-control': `public, max-age=${Number(env.FIXTURES_CACHE_SECONDS || 900)}` }
    }, env);
    if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.FIXTURES_CACHE_SECONDS || 900)));
    return res;
  }
  if (request.method === 'POST') {
    if (!requireAdmin(request, env)) return unauthorized(env);
    const body = await readJson(request);
    if (!body?.id) return badRequest('fixture id missing', env);
    const fixture = await writeFixtureOverride(env, body);
    return json({ ok: true, fixture }, {}, env);
  }
  return badRequest('method not supported', env);
}
