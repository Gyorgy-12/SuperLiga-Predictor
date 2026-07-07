import { json, requireAdmin, unauthorized } from '../utils/http.js';
import { getFixtures } from '../services/fixtures.service.js';
import { fetchLiveScoreResults } from '../sources/livescore-source.js';
import { fetchSofaScoreEvents } from '../sources/sofascore-events-source.js';
import { interestingFixtures } from '../core/match-window.js';
import { readStoredResults } from '../services/results.service.js';

export async function sourceTestRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);
  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'livescore').toLowerCase();
  const force = url.searchParams.get('force') === '1';
  const date = url.searchParams.get('date') || undefined;
  const includeAll = url.searchParams.get('all') === '1';
  const sourceUrl = url.searchParams.get('url') || undefined;
  const round = url.searchParams.get('round');
  const ids = (url.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(Boolean);

  const fixtures = await getFixtures(env);
  const stored = await readStoredResults(env).catch(() => ({ results: {} }));
  let active = includeAll || force ? fixtures : interestingFixtures(fixtures, stored.results);
  if (round) active = active.filter(f => String(f.r) === String(round));
  if (date) active = active.filter(f => String(f.date || '').slice(0, 10) === String(date).slice(0, 10));
  if (ids.length) active = active.filter(f => ids.includes(String(f.id)));
  const limit = Number(url.searchParams.get('limit') || 0);
  if (limit > 0) active = active.slice(0, limit);

  let pack;
  if (source === 'sofascore') pack = await fetchSofaScoreEvents(env, active, { force, date, url: sourceUrl, includeScheduled: url.searchParams.get('scheduled') === '1', maxDates: url.searchParams.get('maxDates') || undefined });
  else pack = await fetchLiveScoreResults(env, active, { force, date, url: sourceUrl, includeScheduled: url.searchParams.get('scheduled') === '1' });

  return json({
    ok: !!pack.ok,
    source,
    activeCount: active.length,
    active: active.map(f => ({ id: f.id, r: f.r, date: f.date, t: f.t, h: f.h, a: f.a, livescoreId: f.livescoreId || f.sourceIds?.livescore || null, sofascoreId: f.sofascoreId || f.sourceIds?.sofascore || null })),
    pack
  }, {}, env);
}
