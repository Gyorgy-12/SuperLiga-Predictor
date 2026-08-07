import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/ui/dom-utils.js', import.meta.url), 'utf8');
const defaultLogo = 'https://images.fotmob.com/image_resources/logo/teamlogo/123.png';
const liga2Logo = 'https://static.flashscore.com/res/image/data/liga2-high-resolution.png';
const botosaniLogo = 'https://fkjablonec.esports.cz/files/logos/FC_Botosani_2022_logo.png';

function browserSandbox(cachedLogo = '') {
  const writes = [];
  const image = { src: liga2Logo, complete: false, naturalWidth: 0 };
  const crestElement = {
    dataset: {
      n: 'FCSB',
      i: '0',
      u: encodeURIComponent(JSON.stringify([liga2Logo]))
    },
    querySelector: () => image,
    classList: { add() {}, remove() {} }
  };
  return {
    TEAM_IDS: { FCSB: '123' },
    window: { __SUPERLIGA_LIGA2_LOGOS__: { FCSB: liga2Logo } },
    sessionStorage: {
      getItem: () => cachedLogo ? JSON.stringify({ FCSB: cachedLogo }) : null,
      setItem: (key, value) => writes.push([key, value])
    },
    document: { querySelectorAll: () => [crestElement] },
    __image: image,
    __writes: writes
  };
}

test('Liga 2 crest overrides a default team crest with the same name', () => {
  const sandbox = browserSandbox();
  vm.runInNewContext(`${source}\nglobalThis.__candidates = logo('FCSB');`, sandbox);
  assert.deepEqual(Array.from(sandbox.__candidates), [liga2Logo]);
});

test('a stale cached default crest cannot overwrite the current Liga 2 crest', () => {
  const sandbox = browserSandbox(defaultLogo);
  vm.runInNewContext(`${source}\nactivateCrests();`, sandbox);
  assert.equal(sandbox.__image.src, liga2Logo);
  assert.equal(JSON.parse(sandbox.__writes.at(-1)[1]).FCSB, undefined);
});

test('Botoșani uses the high-resolution crest before the generic fallback', () => {
  const sandbox = browserSandbox();
  sandbox.TEAM_IDS['FC Botoșani'] = '188191';
  vm.runInNewContext(`${source}\nglobalThis.__candidates = logo('FC Botoșani');`, sandbox);
  assert.equal(sandbox.__candidates[0], botosaniLogo);
  assert.equal(sandbox.__candidates.at(-3), 'https://images.fotmob.com/image_resources/logo/teamlogo/188191.png');
});
