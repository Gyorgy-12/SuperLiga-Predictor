import test from 'node:test';
import assert from 'node:assert/strict';

import { getFixtures } from '../src/services/fixtures.service.js';
import { filterPrematureLiveResults } from '../src/services/public-live-filter.service.js';
import { parseLpfRoundHtml } from '../src/sources/fixture-refresh-source.js';
import { kickoffMs, fixtureKickoffIso } from '../src/utils/time.js';
import { liveFingerprint } from '../src/core/hash.js';
import { nextSuggestedDelayMs } from '../src/core/match-window.js';

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

test('CFR Cluj - Universitatea Cluj is corrected to the official LPF kickoff everywhere', async () => {
  const fixtures = await getFixtures({});
  const fixture = fixtures.find(row => row.id === 'm27');
  assert.equal(fixture.date, '2026-10-08');
  assert.equal(fixture.t, '20:30');
  assert.equal(fixture.kickoffAt, '2026-10-08T20:30:00+03:00');
  assert.equal(fixture.fixtureSource, 'lpf-official-correction-20261009');
});

test('a corrected fixture time changes the final-result fingerprint', () => {
  const base = {
    id: 'm27', date: '2026-10-08', status: 'FT', minute: 90,
    h: 1, a: 3, pH: null, pA: null
  };
  assert.notEqual(
    liveFingerprint({ ...base, time: '-' }),
    liveFingerprint({ ...base, time: '20:30' })
  );
});

test('LPF November dates stay with their own fixture across the October boundary', () => {
  const fixtures = [
    {id:'a',r:14,date:'2026-10-31',t:'-',h:'Petrolul Ploiești',a:'CFR Cluj'},
    {id:'b',r:14,date:'2026-10-31',t:'18:00',h:'FC Voluntari',a:'Farul Constanța'},
    {id:'c',r:14,date:'2026-10-31',t:'19:00',h:'Universitatea Craiova',a:'FC Botoșani'}
  ];
  const html = '<div>31 oct 2026, 19:00 FC PETROLUL FCP - FC CFR 1907 Cluj CFR</div>'+
    '<div>1 nov 2026, 17:30 Universitatea Craiova UCV - FC Botosani FCB</div>'+
    '<div>2 nov 2026, 17:30 FC Voluntari FCV - FC FARUL Constanta FAR</div>';
  const parsed = parseLpfRoundHtml(html, fixtures, 14);
  assert.equal(parsed.fixtures.length,3);
  const byId=Object.fromEntries(parsed.fixtures.map(f=>[f.id,f]));
  assert.equal(byId.a.date,'2026-10-31');
  assert.equal(byId.a.t,'19:00');
  assert.equal(byId.c.date,'2026-11-01');
  assert.equal(byId.b.date,'2026-11-02');
  assert.equal(byId.b.kickoffAt,'2026-11-02T17:30:00+02:00');
  assert.deepEqual(parsed.warnings,[]);
});

test('LPF recognizes all November spellings and optional month punctuation', () => {
  const fixtures=[{id:'a',r:14,date:'2026-10-31',t:'-',h:'Universitatea Cluj',a:'FCSB'}];
  for(const month of ['nov','nov.','noi','noiembrie']){
    const parsed=parseLpfRoundHtml(`<div>2 ${month} 2026, 20:30 FC Universitatea Cluj UCJ - FCSB</div>`,fixtures,14);
    assert.equal(parsed.fixtures[0].date,'2026-11-02');
    assert.equal(parsed.fixtures[0].t,'20:30');
  }
});

test('Bucharest kickoff conversion follows the October and March clock changes', () => {
  for(const [date,time,offset] of [
    ['2026-10-24','21:00','+03:00'],['2026-10-25','16:00','+02:00'],
    ['2026-11-01','20:30','+02:00'],['2027-03-27','20:30','+02:00'],['2027-03-28','20:30','+03:00']
  ]){
    assert.equal(fixtureKickoffIso(date,time),`${date}T${time}:00${offset}`);
    assert.equal(kickoffMs({date,t:time}),Date.parse(`${date}T${time}:00${offset}`));
  }
});

test('an incomplete LPF parse reports missing fixtures instead of silently succeeding', () => {
  const fixtures=[{id:'a',h:'Universitatea Cluj',a:'FCSB'},{id:'b',h:'Dinamo',a:'UTA Arad'}];
  const parsed=parseLpfRoundHtml('<div>2 nov 2026, 20:30 FC Universitatea Cluj - FCSB</div>',fixtures,14);
  assert.match(parsed.warnings.join(' '),/incomplete fixture coverage: 1\/2/);
});

test('the next-match scheduler handles a winter fixture without an explicit kickoff timestamp', () => {
  assert.equal(nextSuggestedDelayMs([{date:'2026-11-01',t:'20:30'}],{},Date.parse('2026-11-01T18:20:00Z')),5*60*1000);
});
