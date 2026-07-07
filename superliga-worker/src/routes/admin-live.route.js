import { json, badRequest, readJson, requireAdmin, unauthorized } from '../utils/http.js';
import { setManualLive, clearManualLive, getLiveSnapshot } from '../services/memory-cache.service.js';
import { normalizeLiveMatch } from '../core/normalize-live.js';
import { getFixtures } from '../services/fixtures.service.js';

export async function adminLiveRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);

  if (request.method === 'DELETE') {
    clearManualLive();
    return json({ ok: true, results: getLiveSnapshot().results }, {}, env);
  }

  const body = await readJson(request);
  if (!body?.results || typeof body.results !== 'object') return badRequest('Body must be {results:{matchId:{...}}}', env);

  const fixtures = await getFixtures(env);
  const byId = Object.fromEntries(fixtures.map(f => [f.id, f]));
  const normalized = {};
  for (const [id, raw] of Object.entries(body.results)) {
    const item = normalizeLiveMatch(id, { ...raw, source: 'manual', scoreSource: raw.scoreSource || 'manual' }, byId[id], { source: 'manual', scoreSource: 'manual' });
    if (item) normalized[id] = item;
  }
  setManualLive(normalized);
  return json({ ok: true, count: Object.keys(normalized).length, results: getLiveSnapshot().results }, {}, env);
}
