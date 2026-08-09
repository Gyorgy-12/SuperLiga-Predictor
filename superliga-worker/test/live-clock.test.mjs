import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeLiveMatch } from '../src/core/normalize-live.js';
import { parseFlashscoreListFeed } from '../src/sources/flashscore-mid-discovery-source.js';
import { parseFlashscoreMobileFootballPage } from '../src/sources/flashscore-mobile-clock-source.js';
import { deriveFlashscoreLiveState, deriveFlashscorePeriodClock } from '../src/sources/flashscore-source.js';

test('Flashscore list feed keeps a bare first-half added-time clock', () => {
  const raw = '~AA÷clockA1¬AD÷1786132800¬AE÷Home FC¬AF÷Away FC¬AG÷1¬AH÷0¬BX÷45+';
  const rows = parseFlashscoreListFeed(raw, 'Europe/Bucharest');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].liveMinute, '45+');
  assert.equal(rows[0].liveStatus, 'LIVE');
});

test('Flashscore mobile page keeps a bare second-half added-time clock', () => {
  const rows = parseFlashscoreMobileFootballPage("<div>90+' Home FC - Away FC 2 - 1</div>");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].liveMinute, '90+');
  assert.equal(rows[0].liveStatus, 'LIVE');
});

test('Flashscore live state exposes a bare added-time clock to clients', () => {
  const state = deriveFlashscoreLiveState({
    listClock: {
      liveMinute: '45+',
      minuteSource: 'flashscore-list-bx',
      clockObservedAt: '2026-08-08T18:45:00.000Z'
    },
    score: { h: 1, a: 0 }
  }, 'event_feed');

  assert.equal(state.started, true);
  assert.equal(state.providerMinute, '45+');
  assert.equal(state.minute, '45+');
  assert.equal(state.status, '45+');
});

test('Flashscore live state prefers a numbered added-time clock over a bare one', () => {
  const state = deriveFlashscoreLiveState({
    listClock: {
      liveMinute: '90+',
      minuteSource: 'flashscore-list-bx',
      clockObservedAt: '2026-08-08T19:45:00.000Z'
    },
    providerMinute: '90+4',
    minuteSource: 'provider-detail',
    clockObservedAt: '2026-08-08T19:48:00.000Z',
    score: { h: 2, a: 1 }
  }, 'event_feed');

  assert.equal(state.providerMinute, '90+4');
  assert.equal(state.minuteSource, 'provider-detail');
  assert.equal(state.clockObservedAt, '2026-08-08T19:48:00.000Z');
});

test('Flashscore live state corrects a nominal mobile clock from the actual period start', () => {
  const now = Date.parse('2026-08-09T18:47:10.000Z');
  const clock = deriveFlashscorePeriodClock({
    liveCode: '1',
    periodStartedAt: '2026-08-09T18:32:26.000Z'
  }, { currentPeriod: '1st Half' }, now);
  assert.equal(clock.value, '15');

  const state = deriveFlashscoreLiveState({
    now,
    dc: { liveCode: '1', periodStartedAt: '2026-08-09T18:32:26.000Z' },
    meta: { currentPeriod: '1st Half' },
    listClock: {
      liveMinute: '16',
      minuteSource: 'flashscore-mobile-page',
      clockObservedAt: '2026-08-09T18:47:10.000Z'
    },
    score: { h: 0, a: 1 }
  }, 'event_feed');

  assert.equal(state.providerMinute, '15');
  assert.equal(state.minuteSource, 'provider-flashscore-period-anchor');
});

test('public live normalization does not strip a bare added-time clock', () => {
  const row = normalizeLiveMatch('SL-1', {
    started: true,
    status: '90+',
    h: 2,
    a: 1,
    minute: '90+',
    providerMinute: '90+',
    minuteSource: 'flashscore-list-bx',
    clockObservedAt: '2026-08-08T19:45:00.000Z'
  });

  assert.equal(row.providerMinute, '90+');
  assert.equal(row.minute, '90+');
  assert.equal(row.addedTimeStartedAt, '2026-08-08T19:45:00.000Z');
});

test('public normalization infers the added-time start from an exact provider minute', () => {
  const row = normalizeLiveMatch('SL-2', {
    started: true,
    status: "90+4'",
    h: 2,
    a: 1,
    minute: '90+4',
    providerMinute: '90+4',
    minuteSource: 'provider-detail',
    clockObservedAt: '2026-08-08T19:48:00.000Z'
  });

  assert.equal(row.addedTimeStartedAt, '2026-08-08T19:45:00.000Z');
});
