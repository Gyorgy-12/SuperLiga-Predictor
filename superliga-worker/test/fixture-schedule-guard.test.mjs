import test from 'node:test';
import assert from 'node:assert/strict';

import { getFixtures } from '../src/services/fixtures.service.js';
import { filterPrematureLiveResults } from '../src/services/public-live-filter.service.js';

test('official Sepsi OSK - FCSB correction overrides every fixture cache layer', async () => {
  const fixtures = await getFixtures({});
  const fixture = fixtures.find(row => row.id === 'm25');
  assert.equal(fixture.date, '2026-08-10');
  assert.equal(fixture.t, '21:30');
  assert.equal(fixture.kickoffAt, '2026-08-10T21:30:00+03:00');
});

test('a postponed future fixture cannot leak a stale live state', () => {
  const fixtures = [{ id: 'm25', date: '2026-08-10', t: '21:30', kickoffAt: '2026-08-10T21:30:00+03:00' }];
  const results = {
    m25: { started: true, finished: false, h: 0, a: 0 },
    m30: { started: true, finished: true, h: 2, a: 1 }
  };
  const visible = filterPrematureLiveResults(results, fixtures, Date.parse('2026-08-09T19:00:00.000Z'));
  assert.equal(visible.m25, undefined);
  assert.deepEqual(visible.m30, results.m30);
});
