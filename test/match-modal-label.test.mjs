import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modalSource = readFileSync(new URL('../src/views/match-modal.view.js', import.meta.url), 'utf8');

test('postseason match modal uses the compact shared stage label', () => {
  assert.match(modalSource, /let phase=isKo\?matchStageText\(m,true\)/);
  assert.doesNotMatch(modalSource, /let phase=isKo\?\(m\.title\|\|postseasonCategory/);
});

test('current Opta ratings are labelled honestly and use the 0-100 model scale', () => {
  assert.match(modalSource, /opta=\/opta\/i\.test\(source\)\|\|value<200/);
  assert.match(modalSource, /rating\.opta\?rating\.value\*20:rating\.value/);
  assert.match(modalSource, /rating\.opta\?rating\.value\.toFixed\(1\)/);
  assert.equal(modalSource.includes("Piaci odds (70%) + '+ratingLabel+' (30%)"), true);
  assert.doesNotMatch(modalSource, /Piaci odds \(70%\) \+ Elo \(30%\)/);
});
