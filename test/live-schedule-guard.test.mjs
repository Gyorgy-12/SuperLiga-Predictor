import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/services/live-results.js', import.meta.url), 'utf8');
const start = source.indexOf('function fixtureKickoff');
const end = source.indexOf('function superligaTerminalStatusText');
assert.ok(start >= 0 && end > start, 'fixture schedule helpers must be present');

const context = { Date, Number, String, Math, Intl };
vm.runInNewContext(source.slice(start, end), context);

test('an explicit corrected kickoff takes precedence over the old date and time', () => {
  const kickoff = context.fixtureKickoff({
    date: '2026-08-09',
    t: '21:30',
    kickoffAt: '2026-08-10T21:30:00+03:00'
  });
  assert.equal(kickoff, Date.parse('2026-08-10T21:30:00+03:00'));
});

test('a stale live row is rejected before a postponed fixture starts', () => {
  const fixture = {
    date: '2026-08-10',
    t: '21:30',
    kickoffAt: '2026-08-10T21:30:00+03:00'
  };
  const live = { started: true, finished: false };
  assert.equal(
    context.superligaLiveMatchesFixtureWindow(live, fixture, Date.parse('2026-08-09T19:00:00.000Z')),
    false
  );
});
