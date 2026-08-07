import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bootstrap = readFileSync(new URL('../src/app/bootstrap.js', import.meta.url), 'utf8');
const liveResults = readFileSync(new URL('../src/services/live-results.js', import.meta.url), 'utf8');

test('every live-data tab requests a fresh live snapshot when opened', () => {
  for (const tab of ['overview', 'matches', 'table', 'knockout', 'baraj', 'stats', 'community']) {
    assert.match(bootstrap, new RegExp(`SUPERLIGA_LIVE_DATA_TABS[^;]*['"]${tab}['"]`));
  }
  assert.match(bootstrap, /SUPERLIGA_LIVE_DATA_TABS\.has\(S\.tab\)\)superligaRefreshLiveForView\(S\.tab\)/);
});

test('tab refresh forces the complete live-results path and reschedules background sync', () => {
  assert.match(liveResults, /syncLiveResults\(\{force:true,forceLive:true\}\)/);
  assert.match(liveResults, /superligaTabLiveRefreshQueued=true/);
  assert.match(liveResults, /scheduleLiveSync\(\);/);
});
