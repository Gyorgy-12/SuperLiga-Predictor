import { json, badRequest, requireAdmin, unauthorized } from '../utils/http.js';
import { syncLive } from '../services/sync.service.js';
import { getFixtures } from '../services/fixtures.service.js';
import { backfillFlashscoreMids } from '../services/flashscore-mid-backfill.service.js';
import { readStoredResults, refreshPublicResultsCache, writeFinalIfChanged } from '../services/results.service.js';

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
    historical: history,
    source: history ? 'historical-flashscore-backfill' : 'filtered-manual-sync'
  });

  // Flashscore detail feeds can contain the complete historical score and
  // incidents while still exposing DETAIL_SCORE instead of FT. In historical
  // mode, finalize only fixtures whose scheduled kickoff is safely in the past.
  // PREMATCH rows and future fixtures are never written as results.
  const historicalFinalWrites = [];
  const historicalSkipped = [];
  if (history) {
    const minAgeMinutes = positiveInt(url.searchParams.get('minAgeMinutes')) || 130;
    for (const fixture of selected) {
      const id = String(fixture.id);
      const row = sync?.results?.[id] || null;
      const decision = historicalFinalCandidate(fixture, row, minAgeMinutes);
      if (!decision.ok) {
        historicalSkipped.push({ id, reason: decision.reason });
        continue;
      }

      const finalRow = {
        ...row,
        id,
        started: true,
        finished: true,
        status: preserveFinalStatus(row?.status),
        minute: null,
        prematch: false,
        flashscoreState: row?.flashscoreState === 'prematch' ? 'event_feed' : (row?.flashscoreState || 'event_feed'),
        scoreSource: 'flashscore',
        eventSource: row?.eventSource || 'flashscore',
        source: 'flashscore',
        updatedAt: new Date().toISOString()
      };

      const write = await writeFinalIfChanged(env, finalRow)
        .catch(error => ({ written: false, id, error: error?.message || String(error) }));
      historicalFinalWrites.push({ id, ...write, h: finalRow.h, a: finalRow.a, status: finalRow.status });
    }
  }

  // Read after historical writes so the public aggregate contains the newly
  // finalized Flashscore rows and no stale in-memory live version wins.
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
    historicalFinalWrites,
    historicalSkipped,
    publicResultsCache: {
      count: publicCache.count,
      updatedAt: publicCache.updatedAt
    }
  }, { headers: { 'cache-control': 'no-store, max-age=0' } }, env);
}

function historicalFinalCandidate(fixture, row, minAgeMinutes) {
  if (!row) return { ok: false, reason: 'missing_result_row' };
  const status = String(row.status || '').trim().toUpperCase();
  const state = String(row.flashscoreState || '').trim().toLowerCase();
  if (row.prematch === true || state === 'prematch' || ['NS', 'PREMATCH', 'SCHEDULED', 'TIMED'].includes(status)) {
    return { ok: false, reason: 'prematch' };
  }
  if (!validScore(row.h) || !validScore(row.a)) return { ok: false, reason: 'missing_score' };

  const kickoff = fixtureKickoffMs(fixture);
  if (!Number.isFinite(kickoff)) return { ok: false, reason: 'invalid_kickoff' };
  if (Date.now() < kickoff + Math.max(1, minAgeMinutes) * 60 * 1000) {
    return { ok: false, reason: 'not_old_enough' };
  }

  const hasDetail = state === 'event_feed' ||
    (row.scorers || []).length > 0 ||
    (row.yellowCards || []).length > 0 ||
    (row.redCards || []).length > 0 ||
    (row.substitutions || []).length > 0 ||
    (row.penalties || []).length > 0 ||
    !!row.matchMeta?.attendance ||
    /^(FT|AET|PEN|FULL_TIME|COMPLETE|DETAIL_SCORE)$/i.test(status);
  if (!hasDetail) return { ok: false, reason: 'insufficient_flashscore_detail' };
  return { ok: true };
}

function fixtureKickoffMs(fixture) {
  const date = cleanDate(fixture?.date);
  const time = String(fixture?.t || fixture?.time || '').slice(0, 5);
  if (!date || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  // July dates in the current SuperLiga season use Bucharest summer time.
  return Date.parse(`${date}T${time}:00+03:00`);
}

function preserveFinalStatus(status) {
  const upper = String(status || '').trim().toUpperCase();
  return ['AET', 'PEN'].includes(upper) ? upper : 'FT';
}

function validScore(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
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
