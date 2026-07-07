import { json } from '../utils/http.js';
import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments } from '../services/firestore.service.js';
import { edgeGet, edgePut } from '../services/edge-cache.service.js';

export async function communityRoute(request, env, ctx) {
  const cachedEdge = await edgeGet(request);
  if (cachedEdge) return cachedEdge;

  const cached = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.community).catch(() => null);
  if (cached?.leaderboard) {
    const res = json({ ok: true, source: 'public-cache', ...cached }, {
      headers: { 'cache-control': `public, max-age=${Number(env.COMMUNITY_CACHE_SECONDS || 1800)}` }
    }, env);
    if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.COMMUNITY_CACHE_SECONDS || 1800)));
    return res;
  }

  const docs = await listDocuments(env, COLLECTIONS.community, { pageSize: 300 }).catch(() => []);
  const leaderboard = docs.map(d => ({
    userId: d.userId || d.id,
    name: d.name || d.displayName || 'User',
    points: Number(d.points || 0),
    exact: Number(d.exact || 0),
    outcome: Number(d.outcome || 0),
    updatedAt: d.updatedAt || d._updateTime || null
  })).sort((a, b) => b.points - a.points || b.exact - a.exact).slice(0, 100);

  const res = json({ ok: true, source: 'collection', count: leaderboard.length, leaderboard, updatedAt: new Date().toISOString() }, {
    headers: { 'cache-control': `public, max-age=${Number(env.COMMUNITY_CACHE_SECONDS || 1800)}` }
  }, env);
  if (ctx?.waitUntil) ctx.waitUntil(edgePut(request, res.clone(), Number(env.COMMUNITY_CACHE_SECONDS || 1800)));
  return res;
}
