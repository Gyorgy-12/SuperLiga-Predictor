import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getFixtures } from './fixtures.service.js';
import { patchDocument } from './firestore.service.js';
import { discoverFlashscoreMids } from '../sources/flashscore-mid-discovery-source.js';

/**
 * Discover and optionally persist Flashscore match keys for many fixtures.
 * One public-cache write is used for the whole batch; individual fixture docs
 * are then patched in small chunks.
 */
export async function backfillFlashscoreMids(env, fixturesInput = null, opts = {}) {
  const fixtures = Array.isArray(fixturesInput)
    ? fixturesInput
    : await getFixtures(env, { skipCoordinatorCache: true });

  const overwrite = opts.overwrite === true || opts.overwrite === '1';
  const write = opts.write === true || opts.write === '1';
  const activeFixtures = Array.isArray(opts.activeFixtures) && opts.activeFixtures.length
    ? opts.activeFixtures
    : selectWindow(fixtures, opts);

  const activeIds = new Set(activeFixtures.map(f => String(f.id)));
  const alreadyStoredRows = activeFixtures.filter(f => getMid(f));
  const targetFixtures = activeFixtures.filter(f => overwrite || !getMid(f));

  if (!targetFixtures.length) {
    return {
      ok: true,
      source: 'flashscore-mid-auto-backfill-b25',
      write,
      written: false,
      targetCount: 0,
      alreadyStored: alreadyStoredRows.length,
      alreadyStoredIds: alreadyStoredRows.map(f => String(f.id)),
      matched: 0,
      changedCount: 0,
      changedIds: [],
      ambiguous: [],
      unmatched: [],
      fixtures,
      skipped: true,
      reason: 'all_selected_fixtures_already_have_flashscore_mid',
      updatedAt: new Date().toISOString()
    };
  }

  const discovery = await discoverFlashscoreMids(env, targetFixtures, opts);
  const byId = new Map((discovery.matched || []).map(row => [String(row.id), row]));
  const now = new Date().toISOString();
  const changed = [];

  const updatedFixtures = fixtures.map(fixture => {
    if (!activeIds.has(String(fixture.id))) return fixture;
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;

    const currentMid = getMid(fixture);
    if (!overwrite && currentMid) return fixture;
    if (currentMid === found.flashscoreMid && getUrl(fixture)) return fixture;

    const flashscoreUrl = getUrl(fixture) || found.flashscoreUrl || `https://www.flashscore.com/match/${found.flashscoreMid}/`;
    const next = {
      ...fixture,
      flashscoreUrl,
      flashscoreMid: found.flashscoreMid,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        flashscoreUrl,
        flashscoreMid: found.flashscoreMid,
        flashscoreEventId: found.flashscoreMid
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        flashscoreText: `${found.rawHome} - ${found.rawAway}`,
        flashscoreOrigin: found.origin || fixture.liveSourceNames?.flashscoreOrigin || null,
        flashscoreMidOrigin: found.origin || found.feed || 'flashscore-list-feed-b25'
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'flashscore-mid-auto-b25'
    };
    changed.push(next);
    return next;
  });

  let publicCacheWrite = { attempted: false, ok: false };
  let individualDocsAttempted = 0;
  let individualDocsWritten = 0;
  const individualDocErrors = [];

  if (write && changed.length) {
    const payload = {
      fixtures: updatedFixtures,
      updatedAt: now,
      source: 'flashscore-mid-auto-backfill-b25',
      changedCount: changed.length,
      changedIds: changed.map(f => String(f.id)),
      discoveredCount: discovery.count || 0,
      ambiguousCount: discovery.ambiguous?.length || 0,
      unmatchedCount: discovery.unmatched?.length || 0,
      warning: 'Only Flashscore MID/source fields are changed; fixture teams, dates and results are preserved.'
    };

    publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, payload)
      .then(() => ({ attempted: true, ok: true }))
      .catch(error => ({ attempted: true, ok: false, error: error?.message || String(error) }));

    const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
    if (writeIndividualDocs) {
      individualDocsAttempted = changed.length;
      for (let i = 0; i < changed.length; i += 15) {
        const chunk = changed.slice(i, i + 15);
        const results = await Promise.all(chunk.map(async fixture => {
          try {
            await patchDocument(env, COLLECTIONS.fixtures, fixture.id, {
              flashscoreUrl: fixture.flashscoreUrl,
              flashscoreMid: fixture.flashscoreMid,
              sourceIds: fixture.sourceIds,
              liveSourceNames: fixture.liveSourceNames,
              sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
              sourceIdsSource: fixture.sourceIdsSource
            });
            return { ok: true, id: fixture.id };
          } catch (error) {
            return { ok: false, id: fixture.id, error: error?.message || String(error) };
          }
        }));
        individualDocsWritten += results.filter(x => x.ok).length;
        individualDocErrors.push(...results.filter(x => !x.ok));
      }
    }
  }

  return {
    ok: !!discovery.ok && (!write || !changed.length || !!publicCacheWrite.ok),
    source: 'flashscore-mid-auto-backfill-b25',
    write,
    written: write && changed.length > 0 && !!publicCacheWrite.ok,
    overwrite,
    selectedCount: activeFixtures.length,
    targetCount: targetFixtures.length,
    alreadyStored: alreadyStoredRows.length,
    alreadyStoredIds: alreadyStoredRows.map(f => String(f.id)),
    rawEventCount: discovery.rawEventCount || 0,
    matched: discovery.count || 0,
    changedCount: changed.length,
    changedIds: changed.map(f => String(f.id)),
    ids: Object.fromEntries(changed.map(f => [String(f.id), f.flashscoreMid])),
    ambiguous: discovery.ambiguous || [],
    unmatched: discovery.unmatched || [],
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    individualDocErrors,
    feedProbes: discovery.feedProbes || [],
    eventSample: discovery.eventSample || [],
    discoverySettings: discovery.settings || null,
    warning: discovery.warning || null,
    fixtures: updatedFixtures,
    updatedAt: now
  };
}

function selectWindow(fixtures, opts) {
  const before = clampNumber(opts.windowDaysBefore ?? opts.daysBefore ?? -2, -365, 0);
  const after = clampNumber(opts.windowDaysAfter ?? opts.daysAfter ?? 21, 0, 365);
  const today = new Date().toISOString().slice(0, 10);
  return (fixtures || []).filter(fixture => {
    if (!fixture?.date) return false;
    const diff = dayDiff(today, String(fixture.date).slice(0, 10));
    return diff >= before && diff <= after;
  });
}

function getMid(fixture) {
  return fixture?.flashscoreMid || fixture?.sourceIds?.flashscoreMid || fixture?.sourceIds?.flashscoreEventId || null;
}

function getUrl(fixture) {
  return fixture?.flashscoreUrl || fixture?.sourceIds?.flashscoreUrl || null;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

function clampNumber(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}
