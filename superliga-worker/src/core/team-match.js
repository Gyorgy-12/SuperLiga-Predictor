export function stripDiacritics(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normTeam(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/\b(afc|afk|fk|acs|acsc|as|csm|cs|fc|osk|sc|cf|clubul|fotbal|fotbalistic|sa)\b/g, ' ')
    .replace(/\b(1923|1948|2013|52)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const TEAM_ALIASES = {
  'FCSB': ['fcsb', 'steaua', 'fc steaua bucuresti', 'sca steaua'],
  'CFR Cluj': ['cfr cluj', 'cfr 1907 cluj', 'cluj cfr'],
  'Universitatea Craiova': ['universitatea craiova', 'cs universitatea craiova', 'u craiova', 'csu craiova', 'craiova'],
  'Rapid București': ['rapid bucuresti', 'rapid bucharest', 'fc rapid 1923', 'rapid'],
  'Farul Constanța': ['farul constanta', 'farul', 'fcv farul', 'constanta'],
  'Universitatea Cluj': ['universitatea cluj', 'u cluj', 'fc universitatea cluj', 'univ cluj'],
  'Sepsi OSK': ['sepsi osk', 'sepsi', 'sfantu gheorghe', 'sepsi sf gheorghe'],
  'Dinamo': ['dinamo', 'dinamo bucuresti', 'dinamo bucharest', 'fc dinamo 1948'],
  'Oțelul Galați': ['otelul galati', 'otelul', 'oțelul galați', 'asc otelul galati', 'galati'],
  'Petrolul Ploiești': ['petrolul ploiesti', 'petrolul', 'ploiesti'],
  'UTA Arad': ['uta arad', 'uta'],
  'FC Botoșani': ['botosani', 'fc botosani', 'botoșani'],
  'FC Voluntari': ['voluntari', 'fc voluntari'],
  'FC Argeș': ['arges', 'fc arges', 'argesh', 'arges pitesti', 'fc arges pitesti'],
  'Csikszereda': [
    'csikszereda',
    'csik szereda',
    'miercurea ciuc',
    'csikszereda miercurea',
    'csikszereda miercurea ciuc',
    'fk csikszereda',
    'fk csikszereda miercurea ciuc',
    'afk csikszereda miercurea ciuc'
  ],
  'Corvinul Hunedoara': ['corvinul hunedoara', 'corvinul', 'hunedoara']
};

export function teamVariants(team) {
  const variants = new Set([team, ...(TEAM_ALIASES[team] || [])].map(normTeam).filter(Boolean));
  return [...variants];
}

export function sameTeam(a, b) {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const aCanonical = canonicalTeam(a);
  const bCanonical = canonicalTeam(b);
  return !!aCanonical && !!bCanonical && aCanonical === bCanonical;
}

export function canonicalTeam(name, knownTeams = []) {
  const n = normTeam(name);
  if (!n) return null;
  const teams = knownTeams.length ? knownTeams : Object.keys(TEAM_ALIASES);
  let best = null;
  let bestScore = 0;
  for (const team of teams) {
    const variants = teamVariants(team);
    for (const v of variants) {
      let score = 0;
      if (n === v) score = 100;
      else if (n.includes(v) || v.includes(n)) score = Math.min(n.length, v.length) / Math.max(n.length, v.length) * 80;
      else score = tokenScore(n, v);
      if (score > bestScore) {
        bestScore = score;
        best = team;
      }
    }
  }
  return bestScore >= 52 ? best : null;
}

export function matchTeamName(rawName, knownTeams = []) {
  return canonicalTeam(rawName, knownTeams) || rawName;
}

function tokenScore(a, b) {
  const aa = new Set(a.split(' ').filter(Boolean));
  const bb = new Set(b.split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return (hit / Math.max(aa.size, bb.size)) * 70;
}

export function uniqueTeamsFromFixtures(fixtures = []) {
  return [...new Set(fixtures.flatMap(f => [f.h, f.a]).filter(Boolean))];
}
