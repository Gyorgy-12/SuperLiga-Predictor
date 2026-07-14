import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchOdds } from '../sources/odds-source.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { coordinatorOddsCache } from './coordinator.service.js';
import { backfillFlashscoreMids } from './flashscore-mid-backfill.service.js';

export async function readOdds(env, opts = {}) {
  const publicDoc = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds).catch(() => null);
  if (publicDoc?.odds) return { odds: publicDoc.odds, source: 'firestore-public-cache', updatedAt: publicDoc.updatedAt || null };

  const durableCache = opts.skipCoordinatorCache ? null : await coordinatorOddsCache(env).catch(() => null);
  if (durableCache?.odds) return { odds: durableCache.odds, source: durableCache.source || 'durable-object-cache', updatedAt: durableCache.updatedAt || null };

  const docs = await listDocuments(env, COLLECTIONS.odds, { pageSize: 320 }).catch(() => []);
  const odds = {};
  for (const doc of docs) {
    if (!doc.id) continue;
    const { _name, _createTime, _updateTime, ...clean } = doc;
    odds[doc.id] = clean;
  }
  return { odds, source: docs.length ? 'firestore-collection' : 'empty', updatedAt: null };
}

export async function refreshOdds(env, opts = {}) {
  const allFixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const selection = selectTargetFixtures(allFixtures, opts);
  const fixtures = selection.fixtures;

  if (!fixtures.length) {
    return {
      ok: true,
      task: 'odds',
      source: 'automatic-relevant-odds-b35',
      skipped: true,
      reason: 'no_relevant_fixtures'
      ,selectionMode: selection.mode
      ,selectionWindow: selection.window,
      selectedCount: 0,
      selectedIds: [],
      changed: false,
      written: false,
      updatedAt: new Date().toISOString()
    };
  }

  const midResolution = await resolveMissingFlashscoreMids(env, allFixtures, fixtures, opts);
  const resolvedFixtures = midResolution.fixtures;

  const pack = await fetchOdds(env, resolvedFixtures, opts);
  if (!pack.ok) {
    return {
      ...pack,
      task: 'odds',
      selectionMode: selection.mode,
      selectionWindow: selection.window,
      selectedCount: fixtures.length,
      selectedIds: resolvedFixtures.map(f => String(f.id)),
      matchedIds: pack.matched?.map(row => String(row.fixtureId)) || [],
      unmatchedIds: pack.unmatched?.map(row => String(row.fixtureId || '')).filter(Boolean) || [],
      midResolution: publicMidResolution(midResolution),
      oddsReason: opts.oddsReason || null,
      written: false
    };
  }

  const previous = await readOdds(env, { skipCoordinatorCache: true }).catch(() => ({ odds: {} }));
  const odds = { ...(previous.odds || {}), ...(pack.odds || {}) };
  const hash = await sha256Hex(stableStringify(odds));
  const oldHash = await sha256Hex(stableStringify(previous.odds || {}));
  const changed = hash !== oldHash;
  const updatedAt = new Date().toISOString();

  const payload = {
    odds,
    hash,
    updatedAt,
    source: pack.source,
    sourceCount: pack.count || 0,
    lastTargetIds: fixtures.map(f => String(f.id)),
    lastTargetReason: opts.oddsReason || null,
    lastSelectionMode: selection.mode,
    lastSelectionWindow: selection.window,
    lastMidResolution: publicMidResolution(midResolution)
  };

  const writeEnabled = String(env.ODDS_WRITE_TO_FIRESTORE || 'true') === 'true';
  if (changed && writeEnabled) {
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.odds, payload).catch(() => null);
  }

  return {
    ok: true,
    task: 'odds',
    source: pack.source,
    fetched: pack.fetched || 0,
    count: Object.keys(odds).length,
    sourceCount: pack.count || 0,
    selectionMode: selection.mode,
    selectionWindow: selection.window,
    selectedCount: fixtures.length,
    selectedIds: resolvedFixtures.map(f => String(f.id)),
    matchedIds: pack.matched?.map(row => String(row.fixtureId)) || [],
    unmatchedIds: pack.unmatched?.map(row => String(row.fixtureId || '')).filter(Boolean) || [],
    midResolution: publicMidResolution(midResolution),
    oddsReason: opts.oddsReason || null,
    changed,
    warnings: pack.warnings || [],
    written: changed && writeEnabled,
    updatedAt
  };
}


async function resolveMissingFlashscoreMids(env, allFixtures, selectedFixtures, opts = {}) {
  const selected = Array.isArray(selectedFixtures) ? selectedFixtures.filter(Boolean) : [];
  const selectedIds = new Set(selected.map(f => String(f.id)));
  const missingBefore = selected.filter(f => !validFlashscoreMid(fixtureFlashscoreMid(f)));

  const disabled =
    opts.resolveMids === false
    || opts.resolveMids === '0'
    || String(env.FLASHSCORE_MID_AUTO_BACKFILL || 'true') === 'false';

  if (!missingBefore.length || disabled) {
    return {
      attempted: false,
      disabled,
      fixtures: selected,
      selectedCount: selected.length,
      missingBeforeIds: missingBefore.map(f => String(f.id)),
      missingAfterIds: missingBefore.map(f => String(f.id)),
      resolvedIds: [],
      written: false,
      warning: disabled && missingBefore.length
        ? 'Automatic Flashscore MID backfill is disabled.'
        : null
    };
  }

  const writeMids =
    opts.writeMids !== false
    && opts.writeMids !== '0'
    && String(env.FLASHSCORE_MID_AUTO_WRITE || 'true') !== 'false';

  let result;
  try {
    result = await backfillFlashscoreMids(env, allFixtures, {
      ...opts,
      activeFixtures: missingBefore,
      overwrite: true,
      write: writeMids,
      source: 'odds-auto-mid-backfill-b36'
    });
  } catch (error) {
    return {
      attempted: true,
      disabled: false,
      fixtures: selected,
      selectedCount: selected.length,
      missingBeforeIds: missingBefore.map(f => String(f.id)),
      missingAfterIds: missingBefore.map(f => String(f.id)),
      resolvedIds: [],
      written: false,
      error: error?.message || String(error)
    };
  }

  const updatedAll = Array.isArray(result?.fixtures) ? result.fixtures : allFixtures;
  const updatedById = new Map(
    updatedAll
      .filter(f => selectedIds.has(String(f?.id)))
      .map(f => [String(f.id), f])
  );

  const resolvedFixtures = selected.map(f => updatedById.get(String(f.id)) || f);
  const missingAfter = resolvedFixtures.filter(f => !validFlashscoreMid(fixtureFlashscoreMid(f)));
  const missingAfterIds = new Set(missingAfter.map(f => String(f.id)));
  const resolvedIds = missingBefore
    .map(f => String(f.id))
    .filter(id => !missingAfterIds.has(id));

  return {
    attempted: true,
    disabled: false,
    fixtures: resolvedFixtures,
    selectedCount: selected.length,
    targetCount: missingBefore.length,
    missingBeforeIds: missingBefore.map(f => String(f.id)),
    missingAfterIds: [...missingAfterIds],
    resolvedIds,
    changedIds: Array.isArray(result?.changedIds) ? result.changedIds.map(String) : [],
    matched: Number(result?.matched || 0),
    rawEventCount: Number(result?.rawEventCount || 0),
    written: !!result?.written,
    publicCacheWrite: result?.publicCacheWrite || null,
    individualDocsAttempted: Number(result?.individualDocsAttempted || 0),
    individualDocsWritten: Number(result?.individualDocsWritten || 0),
    unmatched: Array.isArray(result?.unmatched)
      ? result.unmatched.slice(0, 40)
      : [],
    ambiguous: Array.isArray(result?.ambiguous)
      ? result.ambiguous.slice(0, 20)
      : [],
    warning: result?.warning || null,
    error: result?.ok === false ? 'flashscore_mid_backfill_incomplete' : null
  };
}

function publicMidResolution(value) {
  if (!value) return null;
  const { fixtures, ...publicValue } = value;
  return publicValue;
}

function fixtureFlashscoreMid(fixture) {
  return fixture?.flashscoreMid
    || fixture?.flashscoreEventId
    || fixture?.sourceIds?.flashscoreMid
    || fixture?.sourceIds?.flashscoreEventId
    || null;
}

function validFlashscoreMid(value) {
  return /^[A-Za-z0-9]{8}$/.test(String(value || '').trim());
}

function selectTargetFixtures(allFixtures, opts = {}) {
  const fixtures = Array.isArray(allFixtures) ? allFixtures.filter(Boolean) : [];

  if (Array.isArray(opts.activeFixtures) && opts.activeFixtures.length) {
    const ids = new Set(opts.activeFixtures.map(f => String(f?.id || '')).filter(Boolean));
    return { fixtures: fixtures.filter(f => ids.has(String(f.id))), mode: 'scheduler-active-window', window: null };
  }

  const date = String(opts.date || '').slice(0, 10);
  const dateFrom = String(opts.dateFrom || '').slice(0, 10);
  const dateTo = String(opts.dateTo || '').slice(0, 10);
  const round = String(opts.round || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { fixtures: fixtures.filter(f => String(f?.date || '').slice(0, 10) === date), mode: 'explicit-date', window: { dateFrom: date, dateTo: date } };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return {
      fixtures: fixtures.filter(f => {
        const d = String(f?.date || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
        if (dateFrom && d < dateFrom) return false;
        if (dateTo && d > dateTo) return false;
        return true;
      }),
      mode: 'explicit-date-window',
      window: { dateFrom: dateFrom || null, dateTo: dateTo || null }
    };
  }

  if (round) return { fixtures: fixtures.filter(f => String(f?.r ?? '') === round), mode: 'explicit-round', window: { round } };

  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const daysAhead = clampInt(opts.windowDays || 21, 21, 1, 60);
  const endDate = new Date(startDate.getTime() + (daysAhead + 1) * 86400000);
  const startKey = startDate.toISOString().slice(0, 10);
  const endKey = endDate.toISOString().slice(0, 10);

  let selected = fixtures.filter(f => {
    const d = String(f?.date || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= startKey && d <= endKey && !isFinalFixture(f);
  });

  if (!selected.length) {
    selected = fixtures.filter(f => !isFinalFixture(f))
      .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(String(f?.date || '').slice(0, 10)))
      .sort((a,b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 48);
  }

  return { fixtures: selected, mode: 'automatic-rolling-window', window: { dateFrom: startKey, dateTo: endKey, daysAhead } };
}

function isFinalFixture(fixture) {
  const status = String(fixture?.status || fixture?.state || '').toUpperCase();
  return ['FT','AET','PEN','FINAL','FINISHED'].includes(status) || fixture?.final === true || fixture?.finished === true;
}

function clampInt(value, fallback, min = 1, max = 320) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
