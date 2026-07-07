import { normalizeLiveMatch } from '../core/normalize-live.js';
import { interestingFixtures } from '../core/match-window.js';
import { mergeLiveResults, getLiveSnapshot } from './memory-cache.service.js';
import { readStoredResults, writeFinalIfChanged } from './results.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchLiveScoreResults } from '../sources/livescore-source.js';
import { fetchSofaScoreEvents } from '../sources/sofascore-events-source.js';

export async function syncLive(env, opts = {}) {
  const fixtures = await getFixtures(env);
  const stored = await readStoredResults(env);
  const active = opts.force ? fixtures : interestingFixtures(fixtures, stored.results);
  if (!active.length && !opts.force) {
    return { ok: true, skipped: true, reason: 'no_interesting_fixtures', results: getLiveSnapshot().results, active: [] };
  }

  const scorePack = await fetchLiveScoreResults(env, active, opts).catch(error => ({ ok: false, source: 'livescore', results: {}, error: error.message }));
  const eventPack = await fetchSofaScoreEvents(env, active, opts).catch(error => ({ ok: false, source: 'sofascore', results: {}, error: error.message }));
  const merged = mergeScoreAndEvents(active, scorePack.results || {}, eventPack.results || {});

  mergeLiveResults(merged, 'sync-live');

  const finalWrites = [];
  for (const match of Object.values(merged)) {
    const write = await writeFinalIfChanged(env, match).catch(error => ({ written: false, id: match.id, error: error.message }));
    if (write.written || write.error) finalWrites.push(write);
  }

  return {
    ok: true,
    active: active.map(f => f.id),
    count: Object.keys(merged).length,
    scoreSource: summarizeSource(scorePack),
    eventSource: summarizeSource(eventPack),
    finalWrites,
    results: getLiveSnapshot().results,
    updatedAt: new Date().toISOString()
  };
}

function mergeScoreAndEvents(fixtures, scoreResults, eventResults) {
  const merged = {};
  for (const fixture of fixtures) {
    const score = scoreResults[fixture.id];
    const events = eventResults[fixture.id];
    if (!score && !events) continue;
    const raw = {
      ...(score || {}),
      scorers: events?.scorers?.length ? events.scorers : score?.scorers || [],
      redCards: events?.redCards?.length ? events.redCards : score?.redCards || [],
      yellowCards: events?.yellowCards?.length ? events.yellowCards : score?.yellowCards || [],
      doubleYellowCards: events?.doubleYellowCards?.length ? events.doubleYellowCards : score?.doubleYellowCards || [],
      eventSource: events?.eventSource || score?.eventSource || null,
      scoreSource: score?.scoreSource || 'livescore'
    };
    const normalized = normalizeLiveMatch(fixture.id, raw, fixture, { source: 'merged', scoreSource: raw.scoreSource, eventSource: raw.eventSource });
    if (normalized) merged[fixture.id] = normalized;
  }
  return merged;
}

function summarizeSource(pack) {
  return {
    ok: !!pack.ok,
    source: pack.source,
    count: pack.count ?? Object.keys(pack.results || {}).length,
    error: pack.error || null,
    warnings: pack.warnings || []
  };
}
