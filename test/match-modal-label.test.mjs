import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const modalSource = readFileSync(new URL('../src/views/match-modal.view.js', import.meta.url), 'utf8');

test('postseason match modal uses the compact shared stage label', () => {
  assert.match(modalSource, /let phase=isKo\?matchStageText\(m,true\)/);
  assert.doesNotMatch(modalSource, /let phase=isKo\?\(m\.title\|\|postseasonCategory/);
});
