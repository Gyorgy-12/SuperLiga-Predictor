import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const liveResults = readFileSync(new URL('../src/services/live-results.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../src/app/bootstrap.js', import.meta.url), 'utf8');
const workerConfig = readFileSync(new URL('../superliga-worker/wrangler.toml', import.meta.url), 'utf8');

test('Liga 2 standings are checked every two hours while the app is visible', () => {
  assert.match(liveResults, /const SUPERLIGA_LIGA2_POLL_MS=2\*60\*60\*1000;/);
  assert.match(liveResults, /setInterval\(\(\)=>\{if\(!document\.hidden\)applyLiga2Standings\(\)\},SUPERLIGA_LIGA2_POLL_MS\);/);
});

test('Liga 2 standings load at startup and after returning to the app', () => {
  assert.match(bootstrap, /async function startSuperligaApp\(\)[\s\S]*?applyLiga2Standings\(\);/);
  assert.match(bootstrap, /visibilityState==='visible'[\s\S]*?applyLiga2Standings\(\)/);
});

test('the Worker standings cache stays much shorter than the browser poll', () => {
  assert.match(workerConfig, /LIGA2_STANDINGS_CACHE_SECONDS = "300"/);
  assert.match(workerConfig, /LIGA2_LOGO_CACHE_SECONDS = "2592000"/);
});
