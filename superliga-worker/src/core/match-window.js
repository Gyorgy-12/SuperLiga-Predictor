import { SOURCE_POLICY } from '../config/source-policy.js';
import { kickoffMs } from '../utils/time.js';

export function isFinished(result) {
  const status = String(result?.status || '').toUpperCase();
  return result?.finished === true || ['FT', 'AET', 'PEN', 'FULL_TIME', 'COMPLETE'].includes(status);
}

export function isLive(result) {
  const status = String(result?.status || '').toUpperCase();
  return result?.started === true && !isFinished(result) || ['LIVE', 'IN_PLAY', 'HT', '1H', '2H'].includes(status);
}

export function interestingFixtures(fixtures, results = {}, now = Date.now()) {
  return fixtures.filter(fixture => {
    const existing = results[fixture.id];
    if (isFinished(existing)) return false;
    const ko = kickoffMs(fixture);
    return now >= ko - SOURCE_POLICY.syncBeforeMs && now <= ko + SOURCE_POLICY.syncAfterMs;
  });
}

export function nextSuggestedDelayMs(fixtures, results = {}, now = Date.now()) {
  const active = interestingFixtures(fixtures, results, now);
  if (active.length) return SOURCE_POLICY.livePollMs;
  const next = fixtures
    .map(kickoffMs)
    .filter(t => t > now)
    .sort((a, b) => a - b)[0];
  if (!next) return SOURCE_POLICY.idlePollMs;
  return Math.max(60 * 1000, Math.min(SOURCE_POLICY.idlePollMs, next - now - SOURCE_POLICY.syncBeforeMs));
}
