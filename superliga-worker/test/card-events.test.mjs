import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlashscoreSuiFeed } from '../src/sources/flashscore-source.js';
import { normalizeLiveMatch } from '../src/core/normalize-live.js';

const feed = "AC÷2nd Half¬~III÷booking¬IA÷2¬IB÷69'¬IE÷1¬IF÷Vukovic D.¬IK÷Yellow Card¬IM÷player1¬~III÷dismissal¬IA÷2¬IB÷73'¬IE÷1¬IF÷Vukovic D.¬IK÷Yellow Card¬IM÷player1¬IE÷2¬IF÷Vukovic D.¬IK÷Red Card¬IM÷player1";

test('paired Flashscore yellow/red incident becomes one second-yellow dismissal', () => {
  const parsed = parseFlashscoreSuiFeed(feed);
  assert.equal(parsed.yellowCards.length, 2);
  assert.equal(parsed.redCards.length, 1);
  assert.equal(parsed.doubleYellowCards.length, 1);
  assert.equal(parsed.redCards[0].yellowRed, true);
  assert.equal(parsed.redCards[0].eventId, 'dismissal');
});

test('normalizing repeated card categories and the raw timeline does not duplicate cards', () => {
  const parsed = parseFlashscoreSuiFeed(feed);
  let row = normalizeLiveMatch('m90', { ...parsed, h:1, a:1, status:'FT', source:'flashscore' });
  for (let i=0; i<3; i++) row=normalizeLiveMatch('m90', row);
  assert.equal(row.yellowCards.length, 2);
  assert.equal(row.redCards.length, 1);
  assert.equal(row.doubleYellowCards.length, 1);
});

test('an explicit second-yellow label creates its caution followed by one dismissal', () => {
  const cards=globalThis.SuperligaCardEvents.normalize({redCards:[{team:'a',minute:'90+2',player:'A. Player',label:'Red card (2nd yellow)'}]});
  assert.equal(cards.yellowCards.length,1);
  assert.equal(cards.doubleYellowCards.length,1);
  assert.deepEqual(globalThis.SuperligaCardEvents.normalize(cards),cards);
});

test('an earlier booking alone does not turn a direct red into a second yellow', () => {
  const cards=globalThis.SuperligaCardEvents.normalize({
    yellowCards:[{team:'h',minute:'20',player:'A. Player'}],
    redCards:[{team:'h',minute:'70',player:'A. Player'}]
  });
  assert.equal(cards.redCards.length,1);
  assert.equal(cards.doubleYellowCards.length,0);
});

test('legacy rows require two cautions with matching side/player to infer second yellow', () => {
  const cards=globalThis.SuperligaCardEvents.normalize({
    yellowCards:[{team:'a',minute:'58',player:'N. Kukovec'},{team:'a',minute:'77',player:'N. Kukovec'}],
    redCards:[{team:'a',minute:'77',player:'N. Kukovec'}]
  });
  assert.equal(cards.doubleYellowCards.length,1);
});
