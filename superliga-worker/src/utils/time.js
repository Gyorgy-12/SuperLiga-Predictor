export function nowIso() {
  return new Date().toISOString();
}

export function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function kickoffMs(fixture, timezone = 'Europe/Bucharest') {
  // Fixture dates are local Romania dates. Worker stores simple RFC-ish strings.
  // Romania is EET/EEST; for this prototype use browser-safe local offset hint.
  // Exact kickoff overrides can later store kickoffAt ISO and bypass this.
  if (fixture.kickoffAt) return Date.parse(fixture.kickoffAt);
  const time = fixture.t || fixture.time || '21:00';
  const iso = `${fixture.date}T${time}:00+03:00`;
  return Date.parse(iso);
}
