import '../../../src/core/fixture-time.js';

export function nowIso() {
  return new Date().toISOString();
}

export function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function kickoffMs(fixture, timezone = 'Europe/Bucharest') {
  return globalThis.SuperligaFixtureTime.kickoff(fixture, timezone);
}

export function fixtureKickoffIso(date, time, timezone = 'Europe/Bucharest') {
  return globalThis.SuperligaFixtureTime.isoLocal(date, time, timezone);
}
