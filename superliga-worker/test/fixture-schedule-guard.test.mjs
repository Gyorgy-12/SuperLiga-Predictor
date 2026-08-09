import test from 'node:test';
import assert from 'node:assert/strict';

import { getFixtures } from '../src/services/fixtures.service.js';
import { filterPrematureLiveResults } from '../src/services/public-live-filter.service.js';
import { parseLpfRoundHtml } from '../src/sources/fixture-refresh-source.js';
import { kickoffMs } from '../src/utils/time.js';

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

test('LPF date-only rows override the old date without inventing a kickoff time', () => {
  const current = [{
    id: 'm27', g: 'SL', r: 4,
    date: '2026-08-10', t: '21:30',
    kickoffAt: '2026-08-10T21:30:00+03:00',
    h: 'CFR Cluj', a: 'Universitatea Cluj'
  }];
  const html = '<div>8 oct 2026, - FC CFR 1907 Cluj CFR - FC Universitatea Cluj UCJ</div>';
  const parsed = parseLpfRoundHtml(html, current, 4);
  assert.equal(parsed.fixtures.length, 1);
  assert.equal(parsed.fixtures[0].date, '2026-10-08');
  assert.equal(parsed.fixtures[0].t, '-');
  assert.equal(parsed.fixtures[0].kickoffAt, null);
  assert.equal(parsed.fixtures[0].fixtureSource, 'lpf');
});

test('unknown LPF kickoff uses a neutral scheduling anchor instead of an invalid date', () => {
  assert.equal(
    kickoffMs({ date: '2026-10-08', t: '-', kickoffAt: null }),
    Date.parse('2026-10-08T12:00:00+03:00')
  );
});

test('CFR Cluj - Universitatea Cluj is corrected to the LPF date everywhere', async () => {
  const fixtures = await getFixtures({});
  const fixture = fixtures.find(row => row.id === 'm27');
  assert.equal(fixture.date, '2026-10-08');
  assert.equal(fixture.t, '-');
  assert.equal(fixture.kickoffAt, null);
  assert.equal(fixture.fixtureSource, 'lpf-round-pages-date-only');
});
