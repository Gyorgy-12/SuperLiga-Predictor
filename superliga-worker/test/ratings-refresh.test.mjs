import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePredictionGameMarkdownRatings,
  parsePredictionGameRatings
} from '../src/sources/elofootball-source.js';
import {
  parseTransfermarktMarkdownRows,
  parseTransfermarktRows
} from '../src/sources/transfermarkt-market-source.js';
import {
  buildMatchRatingsSnapshotFromPack,
  hasUsableRatingsData
} from '../src/services/team-ratings.service.js';
import { selectImmutableRatingsSnapshot } from '../src/services/results.service.js';

const TEAMS = ['FCSB', 'CFR Cluj', 'Universitatea Craiova'];

test('prediction-game HTML parser reads short team names such as FCSB', () => {
  const html = `
    <div style="grid-column:2">
      <img alt="Romania">
      <span class="team-n">FCSB</span><span class="team-s">FCSB</span>
    </div>
    <div style="grid-column:3;text-align:center">1427</div>
    <div style="grid-column:2">
      <img title="Romania">
      <span class="team-n">CFR Cluj</span>
    </div>
    <div style="grid-column:3">1438</div>
  `;

  const parsed = parsePredictionGameRatings(html, TEAMS);
  assert.deepEqual(parsed.ratings, { FCSB: 1427, 'CFR Cluj': 1438 });
});

test('prediction-game Reader markdown is a complete ELO fallback', () => {
  const markdown = `
![Image 1: Romania](https://example.test/flag.png)FCSB FCSB

1427

![Image 2: Romania](https://example.test/flag.png)Universitatea Craiova U Craiova

1459
  `;

  const parsed = parsePredictionGameMarkdownRatings(markdown, TEAMS);
  assert.equal(parsed.ratings.FCSB, 1427);
  assert.equal(parsed.ratings['Universitatea Craiova'], 1459);
});

test('Transfermarkt HTML parser uses the current value column', () => {
  const html = `
    <table><tr>
      <td><a>Universitatea Craiova</a></td>
      <td><a>€38.60m</a></td>
      <td><a>€38.10m</a></td>
    </tr></table>
  `;

  const rows = parseTransfermarktRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team, 'Universitatea Craiova');
  assert.equal(rows[0].valueM, 38.1);
});

test('Transfermarkt Reader markdown maps source aliases to app team names', () => {
  const markdown = `
| Club | Previous value | Current value |
| --- | ---: | ---: |
| FC Rapid 1923 | €29.85m | €24.55m |
  `;

  const rows = parseTransfermarktMarkdownRows(markdown, ['Rapid București']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team, 'Rapid București');
  assert.equal(rows[0].valueM, 24.55);
});

test('Transfermarkt Reader parses localized values with the currency after the amount', () => {
  const markdown = `
| 1 | CS Universitatea Craiova | SuperLiga | 38,60 mln. € | 38,10 mln. € | -1,3 % |
| 2 | FCSB | SuperLiga | 25,08 mln. € | 25,80 mln. € | 2,9 % |
  `;

  const rows = parseTransfermarktMarkdownRows(markdown, TEAMS);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.team === 'Universitatea Craiova')?.valueM, 38.1);
  assert.equal(rows.find(row => row.team === 'FCSB')?.valueM, 25.8);
});

test('empty rating objects are not accepted as a usable cache hit', () => {
  assert.equal(hasUsableRatingsData({ ratings: {}, marketValues: {} }), false);
  assert.equal(hasUsableRatingsData({ ratings: { FCSB: 1427 } }), true);
  assert.equal(hasUsableRatingsData({ marketValues: { FCSB: 25.8 } }), true);
});

test('a final match snapshot captures both teams current Elo and market values', () => {
  const frozenAt = '2026-08-04T19:30:00.000Z';
  const snapshot = buildMatchRatingsSnapshotFromPack({
    ratings: { FCSB: 1427, 'CFR Cluj': 1438 },
    marketValues: { FCSB: 25.8, 'CFR Cluj': 17.98 },
    updatedAt: '2026-08-04T07:00:00.000Z',
    sources: {
      elo: { source: 'current-elo' },
      marketValues: { source: 'transfermarkt' }
    }
  }, {
    homeTeam: 'FCSB',
    awayTeam: 'CFR Cluj'
  }, frozenAt);

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    frozenAt,
    ratingsUpdatedAt: '2026-08-04T07:00:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'CFR Cluj',
    homeElo: 1427,
    awayElo: 1438,
    homeMarketValueM: 25.8,
    awayMarketValueM: 17.98,
    ratingsSource: 'current-elo',
    marketSource: 'transfermarkt'
  });
});

test('an existing final match snapshot always wins over later values', () => {
  const existing = {
    frozenAt: '2026-08-04T19:30:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'CFR Cluj',
    homeElo: 1427,
    awayElo: 1438,
    homeMarketValueM: 25.8,
    awayMarketValueM: 17.98
  };
  const later = {
    frozenAt: '2026-08-10T07:00:00.000Z',
    homeTeam: 'FCSB',
    awayTeam: 'CFR Cluj',
    homeElo: 1500,
    awayElo: 1300,
    homeMarketValueM: 40,
    awayMarketValueM: 10
  };

  const selected = selectImmutableRatingsSnapshot(existing, later);
  assert.equal(selected.frozenAt, existing.frozenAt);
  assert.equal(selected.homeElo, 1427);
  assert.equal(selected.awayMarketValueM, 17.98);
});

test('an incomplete final match snapshot is retried instead of frozen', () => {
  const snapshot = buildMatchRatingsSnapshotFromPack({
    ratings: { FCSB: 1427, 'CFR Cluj': 1438 },
    marketValues: { FCSB: 25.8 }
  }, {
    homeTeam: 'FCSB',
    awayTeam: 'CFR Cluj'
  });

  assert.equal(snapshot, null);
});
