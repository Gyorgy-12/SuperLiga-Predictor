import { json, badRequest, readJson, requireAdmin, unauthorized } from '../utils/http.js';
import { getFixturesPack, writeFixtureOverride } from '../services/fixtures.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function fixturesRoute(request, env, ctx) {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const fresh = url.searchParams.get('fresh') === '1' || url.searchParams.get('noedge') === '1';
    if (!fresh) {
      const cached = await edgeGet(request);
      if (cached) return cached;
    }
    const pack = await getFixturesPack(env);
    const ttl = fresh ? 0 : Number(env.FIXTURES_CACHE_SECONDS || 60);
    const res = json({ ok: true, count: pack.fixtures.length, fixtures: pack.fixtures, source: pack.source, fixtureCacheUpdatedAt: pack.updatedAt || null, generatedAt: new Date().toISOString() }, {
      headers: { 'cache-control': fresh ? 'no-store' : `public, max-age=${ttl}` }
    }, env);
    if (!fresh && ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), ttl));
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
