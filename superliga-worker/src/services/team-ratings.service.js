import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { getDocument, listDocuments, patchDocument } from './firestore.service.js';
import { getFixtures } from './fixtures.service.js';
import { fetchClubEloRatings } from '../sources/clubelo-source.js';
import { fetchTransfermarktMarketValues } from '../sources/transfermarkt-market-source.js';
import { sha256Hex, stableStringify } from '../core/hash.js';
import { coordinatorRatingsCache } from './coordinator.service.js';

export async function readTeamRatings(env) {
  const publicRatings = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.teamRatings).catch(() => null);
  if (publicRatings?.ratings || publicRatings?.marketValues) return normalizePack(publicRatings, 'firestore-public-cache');

  const publicElo = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.elo).catch(() => null);
  const publicMv = await getDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.marketValues).catch(() => null);
  if (publicElo?.ratings || publicMv?.marketValues) return normalizePack({ ...(publicElo || {}), ...(publicMv || {}) }, 'firestore-public-cache-split');

  const durable = await coordinatorRatingsCache(env).catch(() => null);
  if (durable?.ratings || durable?.marketValues) return normalizePack(durable, durable.source || 'durable-object-cache');

  const [eloDocs, mvDocs] = await Promise.all([
    listDocuments(env, COLLECTIONS.elo, { pageSize: 80 }).catch(() => []),
    listDocuments(env, COLLECTIONS.marketValues, { pageSize: 80 }).catch(() => [])
  ]);
  const ratings = {};
  for (const doc of eloDocs) if (doc.id && Number.isFinite(Number(doc.elo ?? doc.rating))) ratings[doc.id] = Number(doc.elo ?? doc.rating);
  const marketValues = {};
  for (const doc of mvDocs) if (doc.id && Number.isFinite(Number(doc.valueM ?? doc.marketValueM))) marketValues[doc.id] = Number(doc.valueM ?? doc.marketValueM);
  return normalizePack({ ratings, marketValues, updatedAt: null }, eloDocs.length || mvDocs.length ? 'firestore-team-collections' : 'empty');
}

export async function refreshTeamRatings(env, opts = {}) {
  const fixtures = await getFixtures(env);
  const previous = await readTeamRatings(env).catch(() => ({ ratings: {}, marketValues: {} }));

  const [eloPack, marketPack] = await Promise.all([
    fetchClubEloRatings(env, fixtures, opts).catch(error => ({ ok: false, source: 'clubelo', ratings: {}, error: error.message || String(error) })),
    fetchTransfermarktMarketValues(env, fixtures, opts).catch(error => ({ ok: false, source: 'transfermarkt', marketValues: {}, error: error.message || String(error) }))
  ]);

  const ratings = { ...(previous.ratings || {}), ...(eloPack.ratings || {}) };
  const marketValues = { ...(previous.marketValues || {}), ...(marketPack.marketValues || {}) };
  const payload = {
    ratings,
    marketValues,
    hash: await sha256Hex(stableStringify({ ratings, marketValues })),
    updatedAt: new Date().toISOString(),
    sources: {
      elo: summarize(eloPack),
      marketValues: summarize(marketPack)
    },
    warnings: [...(eloPack.warnings || []), ...(marketPack.warnings || [])]
  };
  const oldHash = await sha256Hex(stableStringify({ ratings: previous.ratings || {}, marketValues: previous.marketValues || {} }));
  const changed = payload.hash !== oldHash;
  const writeEnabled = String(env.RATINGS_WRITE_TO_FIRESTORE || 'true') === 'true';
  if (changed && writeEnabled) {
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.teamRatings, payload).catch(() => null);
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.elo, { ratings, updatedAt: payload.updatedAt, source: eloPack.source || 'clubelo', hash: await sha256Hex(stableStringify(ratings)) }).catch(() => null);
    await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.marketValues, { marketValues, updatedAt: payload.updatedAt, source: marketPack.source || 'transfermarkt', hash: await sha256Hex(stableStringify(marketValues)) }).catch(() => null);

    // Optional team-level docs make debugging and manual editing easier.
    await Promise.all(Object.entries(ratings).map(([team, elo]) => patchDocument(env, COLLECTIONS.elo, team, { elo, updatedAt: payload.updatedAt, source: eloPack.source || 'clubelo' }).catch(() => null)));
    await Promise.all(Object.entries(marketValues).map(([team, valueM]) => patchDocument(env, COLLECTIONS.marketValues, team, { valueM, updatedAt: payload.updatedAt, source: marketPack.source || 'transfermarkt' }).catch(() => null)));
  }

  return {
    ok: true,
    task: 'ratings',
    changed,
    written: changed && writeEnabled,
    count: Object.keys(ratings).length,
    marketCount: Object.keys(marketValues).length,
    elo: summarize(eloPack),
    marketValuesSource: summarize(marketPack),
    ratings,
    marketValues,
    warnings: payload.warnings,
    updatedAt: payload.updatedAt
  };
}

export async function readElo(env) {
  const pack = await readTeamRatings(env);
  return { ratings: pack.ratings || {}, source: pack.source, updatedAt: pack.updatedAt || null };
}

export async function readMarketValues(env) {
  const pack = await readTeamRatings(env);
  return { marketValues: pack.marketValues || {}, source: pack.source, updatedAt: pack.updatedAt || null };
}

export async function buildMatchContextSnapshot(env, match) {
  const pack = await readTeamRatings(env).catch(() => ({ ratings: {}, marketValues: {}, source: 'ratings-error' }));
  const oddsPack = await import('./odds.service.js').then(m => m.readOdds(env)).catch(() => ({ odds: {}, source: 'odds-error' }));
  const home = match.homeTeam || match.hTeam || match.home || match.hName || null;
  const away = match.awayTeam || match.aTeam || match.away || match.aName || null;
  return {
    frozenAt: new Date().toISOString(),
    odds: oddsPack.odds?.[match.id] || match.odds || null,
    oddsSource: oddsPack.source || match.oddsSource || null,
    homeElo: home ? pack.ratings?.[home] ?? null : null,
    awayElo: away ? pack.ratings?.[away] ?? null : null,
    homeMarketValueM: home ? pack.marketValues?.[home] ?? null : null,
    awayMarketValueM: away ? pack.marketValues?.[away] ?? null : null,
    ratingsSource: pack.source || null,
    marketSource: pack.source || null
  };
}

function normalizePack(doc = {}, source = 'unknown') {
  return {
    ok: true,
    source,
    ratings: numbersOnly(doc.ratings || doc.elo || {}),
    marketValues: numbersOnly(doc.marketValues || doc.values || {}),
    updatedAt: doc.updatedAt || null,
    sources: doc.sources || null,
    warnings: doc.warnings || []
  };
}

function numbersOnly(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const n = Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function summarize(pack = {}) {
  return {
    ok: !!pack.ok,
    source: pack.source || null,
    count: pack.count ?? Object.keys(pack.ratings || pack.marketValues || {}).length,
    fetched: pack.fetched ?? null,
    error: pack.error || null,
    warnings: pack.warnings || []
  };
}
