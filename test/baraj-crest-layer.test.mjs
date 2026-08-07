import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const viewSource = readFileSync(new URL('../src/views/matches-postseason-stats.view.js', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../src/styles/layout-integrity.css', import.meta.url), 'utf8');
const barajCss = readFileSync(new URL('../src/styles/baraj-community-profile-wc26.css', import.meta.url), 'utf8');
const parityCss = readFileSync(new URL('../src/styles/parity-lock-mobile-matchcards.css', import.meta.url), 'utf8');

test('baraj team-name styling cannot reveal crest fallback layers', () => {
  assert.match(viewSource, /class="baraj-team-name"/);
  assert.match(layoutCss, /\.baraj-team>\.baraj-team-name/);
  assert.match(layoutCss, /\.crest:not\(\.show-ini\)>\.ini-fb/);
  assert.match(layoutCss, /\.crest:not\(\.show-svg\)>\.svg-fb/);
  assert.doesNotMatch(layoutCss, /\.baraj-team span\s*\{/);
  assert.doesNotMatch(barajCss, /\.baraj-team span\s*\{/);
  assert.doesNotMatch(parityCss, /\.baraj-team span\s*,/);
});
