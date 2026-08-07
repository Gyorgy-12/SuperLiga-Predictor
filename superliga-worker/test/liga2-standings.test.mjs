import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiga2StandingsFeedName,
  parseLiga2PageMetadata,
  parseLiga2StandingsFeed
} from '../src/sources/liga2-standings-source.js';

const metadata = {
  tournamentId: 'vFKjUS0N',
  stageId: '65tLGT4l',
  season: '2026/2027',
  sourceUrl: 'https://example.test/liga-2/standings/'
};

function row(position, name, id, played, goals, difference, points) {
  return [
    `TR÷${position}`,
    `TN÷${name}`,
    `TI÷${id}`,
    `TIU÷/team/${name.toLowerCase().replace(/\s+/g, '-')}/${id}/`,
    `TM÷${played}`,
    `TW÷${position === 1 ? 2 : 1}`,
    'TDR÷0',
    `TL÷${position > 2 ? 1 : 0}`,
    `TG÷${goals}`,
    `TPF÷${difference}`,
    `TP÷${points}`,
    `TU÷${position <= 6 ? 'q1' : 'r1'}`
  ].join('¬');
}

test('Liga 2 page parser discovers the current season and feed identifiers', () => {
  const html = `
    <title>Liga 2 2026/2027 standings</title>
    <div class="heading__info">2026/2027</div>
    <script>window.data={tournamentId:"vFKjUS0N",tournamentStageId:"65tLGT4l",tournamentTemplateId:"bgStjEJ1"}</script>
  `;
  const parsed = parseLiga2PageMetadata(html);
  assert.equal(parsed.season, '2026/2027');
  assert.equal(parsed.tournamentId, 'vFKjUS0N');
  assert.equal(parsed.stageId, '65tLGT4l');
  assert.equal(buildLiga2StandingsFeedName(parsed), 'to_vFKjUS0N_65tLGT4l_1');
});

test('Liga 2 compact feed parser returns only normalized table information', () => {
  const feed = [
    'TZ÷Standings¬TZS÷Overall',
    row(1, 'Gloria Bistrita', 'a1', 2, '5:1', 4, 6),
    row(2, 'FC Bacau', 'a2', 1, '3:0', 3, 3),
    row(3, 'Concordia', 'a3', 1, '3:1', 2, 3),
    row(4, 'CSM Resita', 'a4', 1, '2:1', 1, 3),
    row(5, 'Chindia', 'a5', 1, '1:1', 0, 1),
    row(6, 'Steaua', 'a6', 1, '0:0', 0, 1),
    row(7, 'Ceahlaul', 'a7', 1, '0:1', -1, 0),
    'IPI÷a1¬IPU÷gloria.png',
    'IPI÷a2¬IPU÷bacau.png',
    'IPI÷a3¬IPU÷concordia.png',
    'IPI÷a4¬IPU÷resita.png'
  ].join('~');

  const parsed = parseLiga2StandingsFeed(feed, metadata);
  assert.equal(parsed.phase, 'regular');
  assert.equal(parsed.rowCount, 7);
  assert.equal(parsed.standings.length, 4);
  assert.equal(parsed.standings[0].name, 'Gloria Bistrita');
  assert.equal(parsed.standings[0].logo, 'https://static.flashscore.com/res/image/data/gloria.png');
  assert.equal(parsed.standings[0].goalsFor, 5);
  assert.equal(parsed.standings[0].goalsAgainst, 1);
  assert.deepEqual(parsed.baraj.map(team => team.name), ['Concordia', 'CSM Resita']);
});

test('a six-team championship table is identified as the promotion playoff', () => {
  const feed = [
    'TZ÷Standings¬TZS÷Championship Group',
    row(1, 'Team One', 'p1', 4, '8:2', 6, 10),
    row(2, 'Team Two', 'p2', 4, '7:3', 4, 9),
    row(3, 'Team Three', 'p3', 4, '6:4', 2, 7),
    row(4, 'Team Four', 'p4', 4, '5:5', 0, 5),
    row(5, 'Team Five', 'p5', 4, '3:6', -3, 3),
    row(6, 'Team Six', 'p6', 4, '2:8', -6, 1)
  ].join('~');

  const parsed = parseLiga2StandingsFeed(feed, metadata);
  assert.equal(parsed.phase, 'promotion');
  assert.equal(parsed.phaseLabel, 'Feljutási rájátszás');
  assert.equal(parsed.provisional, false);
  assert.deepEqual(parsed.directPromotion.map(team => team.position), [1, 2]);
  assert.deepEqual(parsed.baraj.map(team => team.position), [3, 4]);
});

test('malformed Liga 2 payloads fail closed', () => {
  assert.throws(() => parseLiga2PageMetadata('<html></html>'), /metadata/i);
  assert.throws(() => parseLiga2StandingsFeed('0', metadata), /malformed/i);
});
