import { json, badRequest, requireAdmin, unauthorized } from '../utils/http.js';
import { syncLive } from '../services/sync.service.js';
import { getFixtures } from '../services/fixtures.service.js';
import { backfillFlashscoreMids } from '../services/flashscore-mid-backfill.service.js';
import { readStoredResults, refreshPublicResultsCache } from '../services/results.service.js';

/**
 * Manual result sync / historical Flashscore backfill.
 *
 * Examples:
 *   /sync?round=1&history=1&secret=...
 *   /sync?date=2026-07-20&history=1&secret=...
 *   /sync?ids=m1,m2&history=1&secret=...
 *
 * Historical mode first discovers and stores missing Flashscore MIDs, then
 * fetches the final score/incidents and refreshes the public results cache.
 */
export async function syncRoute(request, env) {
  const url = new URL(request.url);
  const fromCron = request.headers.get('x-superliga-cron') === '1';
  const manualOk = requireAdmin(request, env);
  if (!fromCron && !manualOk) return unauthorized(env);

  const force = url.searchParams.get('force') === '1';
  const history = url.searchParams.get('history') === '1' || url.searchParams.get('backfill') === '1';
  const date = cleanDate(url.searchParams.get('date'));
  const dateFrom = cleanDate(url.searchParams.get('dateFrom') || url.searchParams.get('from'));
  const dateTo = cleanDate(url.searchParams.get('dateTo') || url.searchParams.get('to'));
  const round = url.searchParams.get('round') || undefined;
  const ids = splitIds(url.searchParams.get('ids'));
  const all = url.searchParams.get('all') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const requestedLimit = positiveInt(url.searchParams.get('limit'));
  const hasFilter = !!(date || dateFrom || dateTo || round || ids.length || all);

  // Preserve the old scheduler behaviour for unfiltered cron/manual live syncs.
  if (!hasFilter && !history) {
    const pack = await syncLive(env, { force, date, source: fromCron ? 'cron-sync' : 'manual-sync' });
    return json(pack, {}, env);
  }

  const fixtures = await getFixtures(env, { skipCoordinatorCache: true });
  let selected = filterFixtures(fixtures, { date, dateFrom, dateTo, round, ids, all });
  const safeLimit = requestedLimit || 16;
  if (selected.length > safeLimit) selected = selected.slice(0, safeLimit);

  if (!selected.length) {
    return badRequest('No fixtures matched the supplied date/round/ids filter.', env);
  }

  // Historical sync defaults to MID discovery. Pass mids=0 only when every
  // selected fixture already has a valid stored Flashscore MID.
  const shouldBackfillMids = history && url.searchParams.get('mids') !== '0';
  let midBackfill = null;
  let effectiveFixtures = fixtures;

  if (shouldBackfillMids) {
    midBackfill = await backfillFlashscoreMids(env, fixtures, {
      write: true,
      overwrite: url.searchParams.get('overwriteMids') === '1',
      activeFixtures: selected,
      maxFeeds: url.searchParams.get('maxFeeds') || undefined,
      ambiguityGap: url.searchParams.get('ambiguityGap') || undefined,
      requestBudgetMode: 'historical-results-backfill'
    });
    if (Array.isArray(midBackfill?.fixtures)) effectiveFixtures = midBackfill.fixtures;
    const selectedIds = new Set(selected.map(f => String(f.id)));
    selected = effectiveFixtures.filter(f => selectedIds.has(String(f.id)));
  }

  const sync = await syncLive(env, {
    force: true,
    debug,
    date,
    round,
    ids,
    all,
    activeFixtures: selected,
    detailLimit: selected.length,
    source: history ? 'historical-flashscore-backfill' : 'filtered-manual-sync'
  });

  // writeFinalIfChanged updates the result documents and in-memory finals.
  // Refresh the public aggregate too, otherwise a new Worker isolate can keep
  // serving the older public-cache document after a successful backfill.
  const stored = await readStoredResults(env);
  const publicCache = await refreshPublicResultsCache(env, stored.results);

  return json({
    ok: !!sync?.ok,
    mode: history ? 'historical-flashscore-backfill' : 'filtered-manual-sync',
    selection: {
      count: selected.length,
      ids: selected.map(f => String(f.id)),
      round: round || null,
      date: date || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      cappedAt: safeLimit
    },
    midBackfill: midBackfill ? {
      ok: !!midBackfill.ok,
      selectedCount: midBackfill.selectedCount || selected.length,
      alreadyStored: midBackfill.alreadyStored || 0,
      matched: midBackfill.matched || 0,
      changedCount: midBackfill.changedCount || 0,
      changedIds: midBackfill.changedIds || [],
      ambiguous: midBackfill.ambiguous || [],
      unmatched: midBackfill.unmatched || []
    } : null,
    sync,
    publicResultsCache: {
      count: publicCache.count,
      updatedAt: publicCache.updatedAt
    }
  }, { headers: { 'cache-control': 'no-store, max-age=0' } }, env);
}

function filterFixtures(fixtures, filters) {
  return (fixtures || []).filter(fixture => {
    const fixtureDate = cleanDate(fixture?.date);
    if (filters.ids.length && !filters.ids.includes(String(fixture?.id))) return false;
    if (filters.round && String(fixture?.r) !== String(filters.round)) return false;
    if (filters.date && fixtureDate !== filters.date) return false;
    if (filters.dateFrom && (!fixtureDate || fixtureDate < filters.dateFrom)) return false;
    if (filters.dateTo && (!fixtureDate || fixtureDate > filters.dateTo)) return false;
    return true;
  });
}

function splitIds(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

function cleanDate(value) {
  const date = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
