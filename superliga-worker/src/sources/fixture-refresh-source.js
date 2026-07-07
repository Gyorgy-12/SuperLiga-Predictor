const DEFAULT_LPF_ROUND_URL = 'https://lpf.ro/etape-liga-1/{round}';
const ROUND_COUNT = 30;

const MONTHS = {
  ian: '01', ianuarie: '01',
  feb: '02', februarie: '02',
  mar: '03', martie: '03',
  apr: '04', aprilie: '04',
  mai: '05',
  iun: '06', iunie: '06',
  iul: '07', iulie: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', septembrie: '09',
  oct: '10', octombrie: '10',
  noi: '11', noiembrie: '11',
  dec: '12', decembrie: '12'
};

const TEAM_ALIASES = {
  'FCSB': ['FCSB'],
  'FC Argeș': ['FC Argeș', 'FC Arges'],
  'Corvinul Hunedoara': ['Corvinul Hunedoara', 'CORVINUL HUNEDOARA', 'Corvinul'],
  'Csikszereda': ['Csikszereda', 'FK CSIKSZEREDA MIERCUREA CIUC', 'FKCS'],
  'Universitatea Cluj': ['FC Universitatea Cluj', 'Universitatea Cluj', 'U Cluj', 'UCJ'],
  'Farul Constanța': ['FC FARUL Constanta', 'Farul Constanta', 'Farul Constanța', 'Farul', 'FAR'],
  'Rapid București': ['FC RAPID', 'Rapid Bucuresti', 'Rapid București', 'Rapid', 'RAP'],
  'Sepsi OSK': ['SEPSI OSK', 'Sepsi', 'OSK'],
  'FC Voluntari': ['FC Voluntari', 'Voluntari', 'FCV'],
  'FC Botoșani': ['FC Botosani', 'FC Botoșani', 'Botosani', 'Botoșani', 'FCB'],
  'Oțelul Galați': ['SC OTELUL Galati', 'Otelul Galati', 'Oțelul Galați', 'Oțelul', 'OGL'],
  'CFR Cluj': ['FC CFR 1907 Cluj', 'CFR Cluj', 'CFR'],
  'Universitatea Craiova': ['Universitatea Craiova', 'Univ Craiova', 'UCV'],
  'UTA Arad': ['UTA Arad', 'UTA'],
  'Petrolul Ploiești': ['FC PETROLUL', 'Petrolul Ploiesti', 'Petrolul Ploiești', 'Petrolul', 'FCP'],
  'Dinamo': ['DINAMO Bucuresti', 'Dinamo Bucuresti', 'Dinamo București', 'Dinamo', 'DIN']
};

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&[a-z0-9#]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cs|osk|afc|as|sc|clubul|fotbal|1907)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameTeam(a, b) {
  const na = norm(a);
  const nb = norm(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function textFromHtml(html) {
  return htmlDecode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:tr|td|th|div|p|li|h\d|section)>/gi, '\n')
    .replace(/<(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function cleanFixture(raw = {}) {
  const id = raw.id || raw.matchId || raw.eventId || raw.fixtureId || raw.mid;
  const h = raw.h || raw.home || raw.homeTeam || raw.homeName || raw.T1?.[0]?.Nm;
  const a = raw.a || raw.away || raw.awayTeam || raw.awayName || raw.T2?.[0]?.Nm;
  const date = raw.date || raw.matchDate || raw.kickoffDate || raw.Dt?.slice?.(0, 10);
  const t = raw.t || raw.time || raw.kickoffTime || raw.hour || raw.kickoffAt?.slice?.(11, 16);
  const r = raw.r ?? raw.round ?? raw.roundNumber ?? raw.stageRound;
  const g = raw.g || raw.group || raw.competition || raw.stage || 'SL';
  const label = raw.label || raw.roundLabel || raw.dateLabel || null;
  const sourceIds = raw.sourceIds || {};
  const out = { id: id ? String(id) : null, g, r: r == null ? null : Number(r), date, t, label, h, a, sourceIds };
  if (raw.livescoreId || raw.Eid || raw.Id) out.livescoreId = String(raw.livescoreId || raw.Eid || raw.Id);
  if (raw.sofascoreId) out.sofascoreId = String(raw.sofascoreId);
  if (raw.kickoffAt) out.kickoffAt = raw.kickoffAt;
  return out;
}

function extractFixtureList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.fixtures)) return data.fixtures;
  if (Array.isArray(data.matches)) return data.matches;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.results)) return data.results;
  if (data.data) return extractFixtureList(data.data);
  if (data.Stages) return (data.Stages || []).flatMap(stage => stage.Events || stage.events || []);
  return [];
}

function mapToExisting(rawFixtures, existingFixtures) {
  const mapped = [];
  for (const raw of rawFixtures) {
    const clean = cleanFixture(raw);
    if (!clean.h || !clean.a) continue;
    const direct = clean.id && existingFixtures.find(f => String(f.id) === String(clean.id));
    const fuzzy = direct || existingFixtures.find(f => sameTeam(clean.h, f.h) && sameTeam(clean.a, f.a));
    if (!fuzzy) continue;
    mapped.push(mergeFixture(fuzzy, clean, 'external'));
  }
  return mapped;
}

function mergeFixture(base, clean, source) {
  const date = clean.date || base.date;
  const t = clean.t || base.t;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null && v !== undefined && v !== '')),
    id: base.id,
    h: base.h,
    a: base.a,
    date,
    t,
    label: clean.label || (date ? labelFromDate(date) : base.label),
    kickoffAt: clean.kickoffAt || (date && t ? `${date}T${t}:00+03:00` : base.kickoffAt),
    sourceIds: { ...(base.sourceIds || {}), ...(clean.sourceIds || {}) },
    fixtureSource: source,
    fixtureUpdatedAt: new Date().toISOString()
  };
}

function buildSourceUrl(base, opts = {}) {
  const rawBase = base || DEFAULT_LPF_ROUND_URL;
  if (rawBase.includes('{round}')) return rawBase.replaceAll('{round}', encodeURIComponent(opts.round || 1));
  const url = new URL(rawBase);
  if (opts.round) url.searchParams.set('round', String(opts.round));
  if (opts.date) url.searchParams.set('date', opts.date);
  if (opts.force) url.searchParams.set('force', '1');
  return url.toString();
}

function roundsToFetch(existingFixtures, opts = {}) {
  if (opts.round) return [Number(opts.round)].filter(Boolean);
  const rounds = [...new Set(existingFixtures.map(f => Number(f.r)).filter(r => r >= 1 && r <= ROUND_COUNT))];
  return rounds.length ? rounds.sort((a, b) => a - b) : Array.from({ length: ROUND_COUNT }, (_, i) => i + 1);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'text/html,application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0 SuperLigaPredictorWorker/0.1 (+fixture-refresh)'
    },
    cf: { cacheTtl: 60, cacheEverything: false }
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, text: '', contentType: res.headers.get('content-type') || '' };
  return { ok: true, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

export async function fetchFixtureRefresh(env, existingFixtures = [], opts = {}) {
  const sourceUrl = env.FIXTURE_SOURCE_URL || DEFAULT_LPF_ROUND_URL;
  const rounds = roundsToFetch(existingFixtures, opts);
  const all = [];
  const warnings = [];
  let fetched = 0;
  let source = sourceUrl.includes('lpf.ro') || !env.FIXTURE_SOURCE_URL ? 'lpf-round-pages' : 'fixture-source';

  for (const round of rounds) {
    const url = buildSourceUrl(sourceUrl, { ...opts, round });
    const pack = await fetchText(url);
    if (!pack.ok) {
      warnings.push(`round ${round}: ${pack.error}`);
      continue;
    }

    const roundFixtures = existingFixtures.filter(f => Number(f.r) === Number(round));
    let mapped = [];
    if (pack.contentType.includes('application/json') || /^[\s\r\n]*[\[{]/.test(pack.text)) {
      const data = JSON.parse(pack.text);
      const list = extractFixtureList(data);
      fetched += list.length;
      mapped = mapToExisting(list, roundFixtures.length ? roundFixtures : existingFixtures);
    } else {
      const parsed = parseLpfRoundHtml(pack.text, roundFixtures, round);
      fetched += parsed.segments;
      mapped = parsed.fixtures;
      if (parsed.warnings.length) warnings.push(...parsed.warnings.map(w => `round ${round}: ${w}`));
    }
    all.push(...mapped.map(f => ({ ...f, sourceIds: { ...(f.sourceIds || {}), lpfRound: round } })));
  }

  const byId = new Map();
  for (const f of all) if (f?.id) byId.set(f.id, f);
  const fixtures = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return { ok: true, source, fixtures, count: fixtures.length, fetched, warnings, sourceUrl };
}

export function parseLpfRoundHtml(html, roundFixtures = [], round = null) {
  const text = textFromHtml(html);
  const dateRe = /\b(\d{1,2})\s+(ianuarie|ian|februarie|feb|martie|mar|aprilie|apr|mai|iunie|iun|iulie|iul|august|aug|septembrie|sept|sep|octombrie|oct|noiembrie|noi|decembrie|dec)\s+(20\d{2}),\s*(\d{1,2}:\d{2})\b/giu;
  const hits = [...text.matchAll(dateRe)].map(m => ({
    index: m.index,
    end: m.index + m[0].length,
    raw: m[0],
    date: `${m[3]}-${MONTHS[norm(m[2])] || MONTHS[String(m[2]).toLowerCase()] || '01'}-${String(m[1]).padStart(2, '0')}`,
    t: m[4]
  }));

  const mapped = [];
  const warnings = [];
  const used = new Set();
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i];
    const next = hits[i + 1]?.index || Math.min(text.length, hit.end + 900);
    const segment = text.slice(hit.end, next);
    const fixture = bestFixtureForSegment(segment, roundFixtures, used);
    if (!fixture) continue;
    used.add(fixture.id);
    mapped.push(mergeFixture(fixture, {
      id: fixture.id,
      r: round ?? fixture.r,
      g: fixture.g || 'SL',
      h: fixture.h,
      a: fixture.a,
      date: hit.date,
      t: hit.t,
      label: labelFromDate(hit.date),
      kickoffAt: `${hit.date}T${hit.t}:00+03:00`
    }, 'lpf'));
  }
  if (!mapped.length && hits.length) warnings.push(`date blocks found (${hits.length}) but no fixture matched`);
  return { fixtures: mapped, segments: hits.length, warnings };
}

function bestFixtureForSegment(segment, candidates, used) {
  let best = null;
  for (const fixture of candidates || []) {
    if (!fixture?.id || used.has(fixture.id)) continue;
    const h = teamHit(segment, fixture.h);
    const a = teamHit(segment, fixture.a);
    if (!h.ok || !a.ok) continue;
    const score = h.score + a.score + (h.index <= a.index ? 8 : 0) - Math.abs(h.index - a.index) / 2000;
    if (!best || score > best.score) best = { fixture, score };
  }
  return best?.fixture || null;
}

function teamHit(segment, teamName) {
  const normalizedSegment = norm(segment);
  const variants = teamVariants(teamName).map(norm).filter(Boolean).sort((a, b) => b.length - a.length);
  let best = { ok: false, index: -1, score: 0 };
  for (const variant of variants) {
    const idx = normalizedSegment.indexOf(variant);
    if (idx < 0) continue;
    const score = variant.length + (variant.split(' ').length * 3);
    if (!best.ok || score > best.score) best = { ok: true, index: idx, score };
  }
  return best;
}

function teamVariants(teamName) {
  const aliases = TEAM_ALIASES[teamName] || [];
  return [...new Set([teamName, ...aliases])];
}

function labelFromDate(date) {
  if (!date) return null;
  const [, month, day] = String(date).split('-');
  const ro = { '01': 'ian.', '02': 'feb.', '03': 'mar.', '04': 'apr.', '05': 'mai', '06': 'iun.', '07': 'iul.', '08': 'aug.', '09': 'sept.', '10': 'oct.', '11': 'nov.', '12': 'dec.' };
  return `${Number(day)} ${ro[month] || ''}`.trim();
}
