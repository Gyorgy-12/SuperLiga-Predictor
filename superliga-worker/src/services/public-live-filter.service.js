import { kickoffMs } from '../utils/time.js';

const PREMATURE_LIVE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * A provider can retain yesterday's live flag after a fixture is postponed.
 * Never publish that stale state when the authoritative kickoff is still in
 * the future. Finished results are intentionally retained.
 */
export function filterPrematureLiveResults(results = {}, fixtures = [], now = Date.now()) {
  const fixturesById = new Map((fixtures || []).map(fixture => [String(fixture?.id || ''), fixture]));
  return Object.fromEntries(Object.entries(results || {}).filter(([id, row]) => {
    if (!row?.started || row?.finished) return true;
    const fixture = fixturesById.get(String(id));
    if (!fixture) return true;
    const kickoff = kickoffMs(fixture);
    return !Number.isFinite(kickoff) || kickoff <= now + PREMATURE_LIVE_TOLERANCE_MS;
  }));
}
