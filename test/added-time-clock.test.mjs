import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/services/live-results.js', import.meta.url), 'utf8');
const start = source.indexOf('function superligaAddedTimeParts');
const end = source.indexOf('function superligaIsEffectivelyFinished');
assert.ok(start >= 0 && end > start, 'added-time clock helpers must be present');

const context = { Date, Number, String, Math };
vm.runInNewContext(source.slice(start, end), context);

test('bare first-half added time starts at the first numbered minute', () => {
  const observed = Date.parse('2026-08-08T18:45:00.000Z');
  assert.equal(
    context.superligaAddedTimeLabel('45+', { _addedTimeStartedAt: observed }, observed),
    "45+1'"
  );
});

test('bare second-half added time advances to the current added-time minute', () => {
  const observed = Date.parse('2026-08-08T19:45:00.000Z');
  assert.equal(
    context.superligaAddedTimeLabel('90+', { _addedTimeStartedAt: observed }, observed + 3 * 60_000 + 5_000),
    "90+4'"
  );
});

test('an exact provider added-time clock is displayed unchanged', () => {
  assert.equal(context.superligaAddedTimeLabel('90+6', {}, Date.now()), "90+6'");
});
