import { json, requireAdmin, unauthorized } from '../utils/http.js';
import { getFixtures } from '../services/fixtures.service.js';
import { patchDocument } from '../services/firestore.service.js';
import { COLLECTIONS, PUBLIC_CACHE_DOCS } from '../config/collections.js';
import { fetchLiveScoreResults } from '../sources/livescore-source.js';
import { fetchSofaScoreEvents } from '../sources/sofascore-events-source.js';
import { fetchEspnEvents, fetchEspnSummary } from '../sources/espn-source.js';
import { fetchFotmobEvents, fetchFotmobMatchDetails } from '../sources/fotmob-source.js';
import { fetchIncidentSourceCandidates } from '../sources/incidents-candidate-source.js';
import { fetchIncidentDeepCandidates } from '../sources/incident-discovery-source.js';
import { fetchSoccerwayEvents, fetchSoccerwayMatchDetails } from '../sources/soccerway-source.js';
import { fetchFlashscoreEvents, fetchFlashscoreMatchDetails, fetchFlashscoreEndpointScout, resolveFlashscoreMatchKeyFromMc } from '../sources/flashscore-source.js';
import { fetchFlashscoreOddsProbe } from '../sources/flashscore-odds-probe-source.js';
import { fetchOfficialSuperligaEvents, fetchOfficialSuperligaMatchDetails } from '../sources/official-superliga-source.js';
import { fetchOdds } from '../sources/odds-source.js';
import { fetchEloFootballRatings } from '../sources/elofootball-source.js';
import { fetchTransfermarktMarketValues } from '../sources/transfermarkt-market-source.js';
import { readOdds, refreshOdds } from '../services/odds.service.js';
import { readTeamRatings, refreshTeamRatings, refreshEloRatings, refreshMarketValues } from '../services/team-ratings.service.js';
import { interestingFixtures } from '../core/match-window.js';
import { readStoredResults } from '../services/results.service.js';
import { syncLive } from '../services/sync.service.js';
import { getLiveSnapshot } from '../services/memory-cache.service.js';
import { backfillFlashscoreMids } from '../services/flashscore-mid-backfill.service.js';

const SOURCE_TEST_ROUTE_VERSION = 'b33b-elofootball-write-import-fix';

export async function sourceTestRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const source = (url.searchParams.get('source') || 'livescore').toLowerCase();
  const force = url.searchParams.get('force') === '1';
  const write = url.searchParams.get('write') === '1';
  const date = url.searchParams.get('date') || undefined;
  const includeScheduled = url.searchParams.get('scheduled') === '1' || url.searchParams.get('includeScheduled') === '1';
  const sourceUrl = url.searchParams.get('url') || undefined;
  const round = url.searchParams.get('round');
  const ids = (url.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(Boolean);
  const provider = (url.searchParams.get('provider') || '').toLowerCase();
  const eventId = url.searchParams.get('eventId') || url.searchParams.get('sofascoreId') || url.searchParams.get('sofaScoreId') || url.searchParams.get('espnId') || url.searchParams.get('espnEventId') || url.searchParams.get('fotmobId') || url.searchParams.get('matchId') || url.searchParams.get('soccerwayId') || url.searchParams.get('soccerwayUrl') || undefined;

  const fixtures = await getFixtures(env, { skipCoordinatorCache: true });
  const stored = await readStoredResults(env).catch(() => ({ results: {} }));
  const isFlashscoreMidBackfill = source === 'flashscore-mid-backfill'
    || source === 'flashscore-auto-mid'
    || source === 'flashscore-mids'
    || source === 'flashscore-b25';
  let active = url.searchParams.get('all') === '1' || force || isFlashscoreMidBackfill
    ? fixtures
    : interestingFixtures(fixtures, stored.results);
  if (round) active = active.filter(f => String(f.r) === String(round));
  if (date) active = active.filter(f => String(f.date || '').slice(0, 10) === String(date).slice(0, 10));
  if (ids.length) active = active.filter(f => ids.includes(String(f.id)));
  const limit = Number(url.searchParams.get('limit') || 0);
  if (limit > 0) active = active.slice(0, limit);

  const sourceOpts = {
    force,
    date,
    url: sourceUrl,
    includeScheduled,
    scheduled: includeScheduled,
    maxDates: url.searchParams.get('maxDates') || undefined,
    debug: true,
    eventId,
    sofascoreId: eventId,
    espnId: eventId,
    espnEventId: eventId,
    fotmobId: eventId,
    matchId: eventId,
    soccerwayId: eventId,
    soccerwayUrl: url.searchParams.get('soccerwayUrl') || sourceUrl || undefined,
    leagueId: url.searchParams.get('leagueId') || undefined,
    season: url.searchParams.get('season') || undefined,
    ccode3: url.searchParams.get('ccode3') || undefined,
    timezone: url.searchParams.get('timezone') || url.searchParams.get('tz') || undefined,
    xFmReq: url.searchParams.get('xFmReq') || url.searchParams.get('xfm') || undefined,
    referer: url.searchParams.get('referer') || undefined,
    userAgent: url.searchParams.get('userAgent') || undefined,
    includeLeague: url.searchParams.get('includeLeague') === '1',
    league: url.searchParams.get('league') || undefined,
    includeIncidents: url.searchParams.get('incidents') === '1' || source === 'incidents' || source === 'espn-incidents' || source === 'espn-summary' || source === 'fotmob-incidents' || source === 'fotmob-details' || source === 'soccerway-incidents' || source === 'soccerway-details',
    provider,
    searchLimit: url.searchParams.get('searchLimit') || undefined,
    matchThreshold: url.searchParams.get('matchThreshold') || undefined,
    activeFixtures: active,
    group: url.searchParams.get('group') || url.searchParams.get('family') || undefined,
    candidateGroup: url.searchParams.get('group') || url.searchParams.get('family') || undefined,
    showBody: url.searchParams.get('showBody') === '1',
    sampleChars: url.searchParams.get('sampleChars') || url.searchParams.get('sample') || undefined,
    timeoutMs: url.searchParams.get('timeoutMs') || undefined,
    candidateLimit: url.searchParams.get('candidateLimit') || url.searchParams.get('probeLimit') || undefined,
    detailLimit: url.searchParams.get('detailLimit') || url.searchParams.get('matchDetailLimit') || undefined,
    soccerwayMatchThreshold: url.searchParams.get('soccerwayMatchThreshold') || url.searchParams.get('matchThreshold') || undefined,
    flashscoreMatchThreshold: url.searchParams.get('flashscoreMatchThreshold') || url.searchParams.get('matchThreshold') || undefined,
    officialMatchThreshold: url.searchParams.get('officialMatchThreshold') || url.searchParams.get('matchThreshold') || undefined,
    probeFeed: url.searchParams.get('probe') !== '0' && url.searchParams.get('probeFeed') !== '0',
    probe: url.searchParams.get('probe') || undefined,
    fetchScripts: url.searchParams.get('fetchScripts') !== '0',
    scriptLimit: url.searchParams.get('scriptLimit') || undefined,
    feedLimit: url.searchParams.get('feedLimit') || url.searchParams.get('probeLimit') || undefined,
    maxScriptChars: url.searchParams.get('maxScriptChars') || undefined,
    maxFeedChars: url.searchParams.get('maxFeedChars') || undefined,
    xFsign: url.searchParams.get('xFsign') || url.searchParams.get('xfsign') || undefined,
    feedToken: url.searchParams.get('feedToken') || url.searchParams.get('token') || undefined,
    feedBase: url.searchParams.get('feedBase') || undefined,
    feedReferer: url.searchParams.get('feedReferer') || undefined,
    feedProbeLimit: url.searchParams.get('feedProbeLimit') || undefined,
    mcFeed: url.searchParams.get('mcFeed') || url.searchParams.get('matchCenterFeed') || undefined,
    mcBase: url.searchParams.get('mcBase') || undefined,
    mcThreshold: url.searchParams.get('mcThreshold') || undefined,
    mcCandidateLimit: url.searchParams.get('mcCandidateLimit') || undefined,
    skipHtml: url.searchParams.get('skipHtml') || undefined,
    mid: url.searchParams.get('mid') || url.searchParams.get('flashscoreMid') || url.searchParams.get('matchKey') || undefined,
    flashscoreMid: url.searchParams.get('mid') || url.searchParams.get('flashscoreMid') || url.searchParams.get('matchKey') || undefined,
    fixtureId: url.searchParams.get('id') || url.searchParams.get('fixtureId') || url.searchParams.get('fixture') || undefined,
    write,
    overwrite: url.searchParams.get('overwrite') === '1',
    feed: url.searchParams.get('feed') || url.searchParams.get('feeds') || undefined,
    feedTemplate: url.searchParams.get('feedTemplate') || undefined,
    maxFeeds: url.searchParams.get('maxFeeds') || undefined,
    ambiguityGap: url.searchParams.get('ambiguityGap') || undefined,
    windowDaysBefore: url.searchParams.get('windowDaysBefore') || url.searchParams.get('daysBefore') || undefined,
    windowDaysAfter: url.searchParams.get('windowDaysAfter') || url.searchParams.get('daysAfter') || undefined,
    requestBudgetMode: url.searchParams.get('requestBudgetMode') || url.searchParams.get('budget') || undefined,
    primaryFeedOnly: url.searchParams.get('primaryFeedOnly') === '1' || undefined,
    primaryBaseOnly: url.searchParams.get('primaryBaseOnly') === '1' || undefined,
    pendingOnEmpty: url.searchParams.get('pendingOnEmpty') === '1' || undefined,
    skipSearch: url.searchParams.get('skipSearch') === '1' || undefined,
    singleBase: url.searchParams.get('singleBase') === '1' || undefined,
    skipPrematchIncidents: url.searchParams.get('skipPrematchIncidents') === '1' || undefined,
    oddsProbeLimit: url.searchParams.get('maxProbes') || url.searchParams.get('oddsProbeLimit') || undefined,
    oddsTokens: url.searchParams.get('oddsTokens') || url.searchParams.get('tokens') || undefined,
    oddsBases: url.searchParams.get('oddsBases') || url.searchParams.get('feedBases') || undefined,
    rawChars: url.searchParams.get('rawChars') || url.searchParams.get('sampleChars') || undefined,
    blockLimit: url.searchParams.get('blockLimit') || undefined,
    pairLimit: url.searchParams.get('pairLimit') || undefined,
    showRaw: url.searchParams.get('showRaw') === '1' || undefined,
    oddsMode: url.searchParams.get('oddsMode') || url.searchParams.get('mode') || undefined,
    bookmakerIds: url.searchParams.get('bookmakerIds') || url.searchParams.get('books') || undefined,
    maxBookmakers: url.searchParams.get('maxBookmakers') || undefined,
    maxFixtures: url.searchParams.get('maxFixtures') || undefined,
    concurrency: url.searchParams.get('concurrency') || undefined,
    oddsReason: url.searchParams.get('oddsReason') || undefined
  };

  let pack;
  if (source === 'live' || source === 'sync-live') {
    pack = await syncLive(env, { ...sourceOpts, source: 'source-test-live-sync', activeFixtures: active });
  } else if (source === 'snapshot' || source === 'memory-live') {
    pack = { ok: true, source: 'memory-live-snapshot', ...getLiveSnapshot() };
  } else if (source === 'livescore' || source === 'score') {
    pack = await fetchLiveScoreResults(env, active, sourceOpts);
    if (write) {
      const sourceIdWrite = await writeLiveScoreSourceIds(env, fixtures, pack);
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'candidates' || source === 'source-scout' || source === 'incidents-candidates' || source === 'candidate-sources') {
    pack = await fetchIncidentSourceCandidates(env, active, sourceOpts);
  } else if (source === 'deep-candidates' || source === 'deep-scout' || source === 'incident-deep' || source === 'source-deep') {
    pack = await fetchIncidentDeepCandidates(env, active, sourceOpts);
  } else if (isFlashscoreMidBackfill) {
    pack = await backfillFlashscoreMids(env, fixtures, {
      ...sourceOpts,
      write,
      overwrite: sourceOpts.overwrite,
      activeFixtures: active
    });
  } else if (source === 'flashscore-mid-write' || source === 'flashscore-set-mid' || source === 'flashscore-store-mid' || source === 'flashscore-b21') {
    const fixtureId = sourceOpts.fixtureId;
    const mid = sourceOpts.flashscoreMid;
    if (!fixtureId || !mid) {
      pack = { ok: false, source: 'flashscore-mid-write-b21', error: 'missing id/fixtureId or mid/flashscoreMid. Example: source=flashscore-mid-write&id=m5&mid=QqzwxwWH' };
    } else {
      pack = await writeFlashscoreMid(env, fixtures, fixtureId, mid, {
        url: sourceUrl,
        sourceName: 'flashscore-mid-b21'
      });
    }
  } else if (source === 'flashscore-mc' || source === 'flashscore-mid' || source === 'flashscore-resolve' || source === 'flashscore-b20') {
    const detailInput = eventId || sourceUrl;
    if (!detailInput) {
      pack = { ok: false, source: 'flashscore-mc-resolver-b20', error: 'missing flashscoreUrl query param. Example: source=flashscore-b20&url=https://www.flashscore.com/match/football/...' };
    } else {
      pack = await resolveFlashscoreMatchKeyFromMc(env, detailInput, sourceOpts);
    }
  } else if (source === 'flashscore-odds-probe' || source === 'flashscore-odds' || source === 'odds-flashscore' || source === 'flashscore-b29') {
    const fixture = active.find(f => sourceOpts.fixtureId && String(f.id) === String(sourceOpts.fixtureId)) || active[0] || null;
    const oddsInput = sourceOpts.flashscoreMid
      || fixture?.flashscoreMid
      || fixture?.sourceIds?.flashscoreMid
      || fixture?.sourceIds?.flashscoreEventId
      || eventId
      || sourceUrl;
    if (!oddsInput) {
      pack = {
        ok: false,
        source: 'flashscore-odds-probe-b29',
        error: 'missing Flashscore MID. Use &mid=hMOCvYkB or &ids=m1.',
        seen: {
          mid: sourceOpts.flashscoreMid || null,
          fixtureId: sourceOpts.fixtureId || null,
          activeFixtureId: fixture?.id || null
        }
      };
    } else {
      pack = await fetchFlashscoreOddsProbe(env, oddsInput, {
        ...sourceOpts,
        fixture,
        flashscoreUrl: fixture?.flashscoreUrl || fixture?.sourceIds?.flashscoreUrl || sourceUrl || undefined
      });
    }
  } else if (source === 'flashscore-scout' || source === 'flashscore-deep' || source === 'flashscore-endpoints' || source === 'flashscore-feed-scout' || source === 'flashscore-b17' || source === 'flashscore-b18') {
    const detailInput = eventId || sourceUrl;
    if (!detailInput) {
      pack = { ok: false, source: 'flashscore-endpoint-scout-b19-xfeed-parser', error: 'missing flashscoreUrl query param. Example: source=flashscore-scout&url=https://www.flashscore.com/match/football/...' };
    } else {
      pack = await fetchFlashscoreEndpointScout(env, detailInput, sourceOpts);
    }
  } else if (source === 'flashscore-details' || source === 'flashscore-match' || source === 'flashscore-summary' || source === 'flashscore-feed' || source === 'flashscore-xfeed' || source === 'flashscore-b19') {
    const detailInput = sourceOpts.flashscoreMid || eventId || sourceUrl;
    if (!detailInput) {
      pack = { ok: false, source: 'flashscore-match-details-route-b21e', routeVersion: SOURCE_TEST_ROUTE_VERSION, error: 'missing flashscoreUrl or mid query param. Example: source=flashscore-details&url=https://www.flashscore.com/match/football/... or &mid=QqzwxwWH', seen: { mid: sourceOpts.flashscoreMid || null, eventId: eventId || null, url: sourceUrl || null } };
    } else {
      pack = await fetchFlashscoreMatchDetails(env, detailInput, sourceOpts);
    }
  } else if (source === 'flashscore' || source === 'flashscore-fixtures' || source === 'flashscore-incidents' || source === 'soccer24' || (source === 'incidents' && (provider === 'flashscore' || provider === 'soccer24'))) {
    pack = await fetchFlashscoreEvents(env, active, {
      ...sourceOpts,
      includeIncidents: source === 'incidents' || source === 'flashscore-incidents' || url.searchParams.get('incidents') === '1'
    });
    if (write) {
      const sourceIdWrite = await writeUrlSourceIds(env, fixtures, pack, {
        sourceKey: 'flashscore',
        urlField: 'flashscoreUrl',
        idField: 'flashscoreId',
        sourceName: 'flashscore-b15'
      });
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'official-details' || source === 'official-match' || source === 'superliga-details' || source === 'lpf-details') {
    const detailInput = eventId || sourceUrl;
    if (!detailInput) {
      pack = { ok: false, source: 'official-superliga-match-details', error: 'missing officialUrl query param. Example: source=official-details&url=https://www.superliga.ro/meci/...' };
    } else {
      pack = await fetchOfficialSuperligaMatchDetails(env, detailInput, sourceOpts);
    }
  } else if (source === 'official' || source === 'official-fixtures' || source === 'official-incidents' || source === 'superliga' || source === 'lpf' || (source === 'incidents' && (provider === 'official' || provider === 'superliga' || provider === 'lpf'))) {
    pack = await fetchOfficialSuperligaEvents(env, active, {
      ...sourceOpts,
      includeIncidents: source === 'incidents' || source === 'official-incidents' || url.searchParams.get('incidents') === '1'
    });
    if (write) {
      const sourceIdWrite = await writeUrlSourceIds(env, fixtures, pack, {
        sourceKey: 'official',
        urlField: 'officialUrl',
        idField: 'officialId',
        sourceName: 'official-superliga-b15'
      });
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'soccerway-details' || source === 'soccerway-match' || source === 'soccerway-summary') {
    const detailInput = eventId || sourceUrl;
    if (!detailInput) {
      pack = { ok: false, source: 'soccerway-match-details', error: 'missing soccerwayUrl query param. Example: source=soccerway-details&soccerwayUrl=https://www.soccerway.com/matches/...' };
    } else {
      pack = await fetchSoccerwayMatchDetails(env, detailInput, sourceOpts);
    }
  } else if (source === 'soccerway' || source === 'soccerway-fixtures' || source === 'soccerway-incidents' || (source === 'incidents' && provider === 'soccerway')) {
    pack = await fetchSoccerwayEvents(env, active, {
      ...sourceOpts,
      includeIncidents: source === 'incidents' || source === 'soccerway-incidents' || url.searchParams.get('incidents') === '1'
    });
    if (write) {
      const sourceIdWrite = await writeSoccerwaySourceIds(env, fixtures, pack);
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'fotmob-details' || source === 'fotmob-summary' || source === 'match-details') {
    if (!eventId) {
      pack = { ok: false, source: 'fotmob-match-details', error: 'missing matchId / fotmobId query param' };
    } else {
      pack = await fetchFotmobMatchDetails(env, eventId, sourceOpts);
    }
  } else if (source === 'fotmob' || source === 'fotmob-fixtures' || source === 'fotmob-incidents' || (source === 'incidents' && provider === 'fotmob')) {
    pack = await fetchFotmobEvents(env, active, {
      ...sourceOpts,
      includeIncidents: source === 'incidents' || source === 'fotmob-incidents' || url.searchParams.get('incidents') === '1'
    });
    if (write) {
      const sourceIdWrite = await writeFotmobSourceIds(env, fixtures, pack);
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'espn-summary' || source === 'summary') {
    if (!eventId) {
      pack = { ok: false, source: 'espn-summary', error: 'missing eventId / espnId / espnEventId query param' };
    } else {
      pack = await fetchEspnSummary(env, eventId, sourceOpts);
    }
  } else if (source === 'espn' || source === 'espn-scoreboard' || source === 'espn-incidents' || (source === 'incidents' && provider === 'espn')) {
    pack = await fetchEspnEvents(env, active, {
      ...sourceOpts,
      includeIncidents: source === 'incidents' || source === 'espn-incidents' || url.searchParams.get('incidents') === '1'
    });
    if (write) {
      const sourceIdWrite = await writeEspnSourceIds(env, fixtures, pack);
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'sofascore' || source === 'events' || source === 'sofa-incidents' || source === 'sofascore-incidents' || source === 'incidents') {
    pack = await fetchSofaScoreEvents(env, active, sourceOpts);
    if (write) {
      const sourceIdWrite = await writeSofaScoreSourceIds(env, fixtures, pack);
      pack = { ...pack, sourceIdWrite };
    }
  } else if (source === 'odds' || source === 'flashscore-graphql-odds' || source === 'flashscore-odds-b31' || source === 'flashscore-odds-b31a') {
    pack = write
      ? await refreshOdds(env, { ...sourceOpts, force: true, date, url: sourceUrl, source: 'source-test-write' })
      : await fetchOdds(env, active, { ...sourceOpts, force, date, url: sourceUrl });
  } else if (source === 'ratings' || source === 'team-ratings') {
    if (write) pack = await refreshTeamRatings(env, { force: true, url: sourceUrl, source: 'source-test-write' });
    else {
      const [elo, marketValues] = await Promise.all([
        fetchEloFootballRatings(env, fixtures, { force, url: sourceUrl }),
        fetchTransfermarktMarketValues(env, fixtures, { force, url: sourceUrl })
      ]);
      pack = { ok: !!(elo.ok || marketValues.ok), source: 'ratings-source-test', elo, marketValues };
    }
  } else if (source === 'elo' || source === 'elofootball' || source === 'clubelo') {
    pack = write
      ? await refreshEloRatings(env, {
          force: true,
          url: sourceUrl,
          source: 'source-test-elo-write-b33'
        })
      : await fetchEloFootballRatings(env, fixtures, {
          force,
          url: sourceUrl
        });
  } else if (source === 'market-values' || source === 'market' || source === 'tm' || source === 'transfermarkt') {
    pack = write
      ? await refreshMarketValues(env, {
          force: true,
          url: sourceUrl,
          source: 'source-test-market-values-write-b32'
        })
      : await fetchTransfermarktMarketValues(env, fixtures, {
          force,
          url: sourceUrl
        });
  } else if (source === 'read-odds') {
    pack = await readOdds(env, { skipCoordinatorCache: true });
  } else if (source === 'read-ratings') {
    pack = await readTeamRatings(env, { skipCoordinatorCache: true });
  } else {
    pack = await fetchLiveScoreResults(env, active, sourceOpts);
  }

  return json({
    ok: !!pack?.ok,
    routeVersion: SOURCE_TEST_ROUTE_VERSION,
    source,
    sourceDebug: {
      midParam: sourceOpts.flashscoreMid || null,
      urlParam: sourceUrl || null,
      eventId: eventId || null,
      selectedFlashscoreInput: (source === 'flashscore-b19' || source === 'flashscore-details' || source === 'flashscore-match' || source === 'flashscore-summary' || source === 'flashscore-feed' || source === 'flashscore-xfeed' || source === 'flashscore-odds-probe' || source === 'flashscore-odds' || source === 'odds-flashscore' || source === 'flashscore-b29') ? (sourceOpts.flashscoreMid || active[0]?.flashscoreMid || active[0]?.sourceIds?.flashscoreMid || eventId || sourceUrl || null) : null
    },
    force,
    write,
    scheduled: includeScheduled,
    activeCount: active.length,
    envHints: {
      liveScoreConfigured: !!(env.LIVE_SCORE_APP_BASE_URL || env.LIVESCORE_APP_BASE_URL) || true,
      sofaScoreConfigured: !!(env.SOFASCORE_BASE_URL) || true,
      oddsSourceUrlConfigured: !!env.ODDS_SOURCE_URL,
      oddspediaOddsUrl: env.ODDSPEDIA_ODDS_URL || env.ODDSPEDIA_LIGA1_ODDS_URL || 'https://oddspedia.com/football/romania/liga-1/odds',
      transfermarktUrl: env.TRANSFERMARKET_MARKET_VALUES_URL || env.TRANSFERMARKT_MARKET_VALUES_URL || 'default',
      eloFootballUrl: env.ELOFOOTBALL_BASE_URL || 'https://elofootball.com/country.php',
      espnLeague: env.ESPN_SOCCER_LEAGUE || env.ESPN_LEAGUE || 'rou.1',
      fotmobLeagueId: env.FOTMOB_LEAGUE_ID || '189',
      fotmobBase: env.FOTMOB_API_BASE_URL || 'https://www.fotmob.com/api',
      fotmobXfmReqConfigured: !!env.FOTMOB_X_FM_REQ,
      soccerwayBase: env.SOCCERWAY_BASE_URL || 'https://www.soccerway.com',
      flashscoreBase: env.FLASHSCORE_BASE_URL || 'https://www.flashscore.com',
      officialSuperligaBase: env.OFFICIAL_SUPERLIGA_BASE_URL || 'https://www.superliga.ro'
    },
    active: active.map(f => ({
      id: f.id,
      r: f.r,
      date: f.date,
      t: f.t,
      h: f.h,
      a: f.a,
      livescoreId: f.livescoreId || f.sourceIds?.livescore || null,
      sofascoreId: f.sofascoreId || f.sourceIds?.sofascore || null,
      oddsId: f.oddsId || f.sourceIds?.odds || null,
      espnId: f.espnId || f.sourceIds?.espn || null,
      fotmobId: f.fotmobId || f.matchId || f.sourceIds?.fotmob || null,
      flashscoreUrl: f.flashscoreUrl || f.sourceIds?.flashscoreUrl || null,
      flashscoreMid: f.flashscoreMid || f.sourceIds?.flashscoreMid || null,
      officialUrl: f.officialUrl || f.sourceIds?.officialUrl || null
    })),
    pack
  }, {
    headers: { 'cache-control': 'no-store, max-age=0' }
  }, env);
}





async function writeFlashscoreMid(env, fixtures, fixtureId, mid, opts = {}) {
  const id = String(fixtureId || '').trim();
  const matchKey = String(mid || '').trim();
  if (!id || !/^[A-Za-z0-9]{6,20}$/.test(matchKey)) {
    return { ok: false, source: 'flashscore-mid-write-b21', error: 'invalid_fixture_id_or_mid', id, mid: matchKey || null };
  }

  const now = new Date().toISOString();
  let found = false;
  let changedFixture = null;

  const updatedFixtures = (fixtures || []).map(fixture => {
    if (String(fixture.id) !== id) return fixture;
    found = true;
    const current = fixture.flashscoreMid || fixture.sourceIds?.flashscoreMid || null;
    const next = {
      ...fixture,
      ...(opts.url ? { flashscoreUrl: opts.url } : {}),
      flashscoreMid: matchKey,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        ...(opts.url ? { flashscoreUrl: opts.url } : {}),
        flashscoreMid: matchKey,
        flashscoreEventId: matchKey
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        flashscoreMidOrigin: opts.url || 'manual-admin-b21'
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: opts.sourceName || 'flashscore-mid-b21'
    };
    changedFixture = next;
    return next;
  });

  if (!found) return { ok: false, source: 'flashscore-mid-write-b21', error: 'fixture_not_found', id, mid: matchKey };

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'flashscore-mid-backfill-b21',
    changedCount: 1,
    changedIds: [id],
    warning: 'This refresh only backfills Flashscore matchKey/mid; it does not alter match dates, teams, or results.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocWrite = { attempted: false, ok: false };
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs && changedFixture) {
    individualDocWrite = await patchDocument(env, COLLECTIONS.fixtures, id, {
      ...(opts.url ? { flashscoreUrl: opts.url } : {}),
      flashscoreMid: matchKey,
      sourceIds: changedFixture.sourceIds,
      liveSourceNames: changedFixture.liveSourceNames,
      sourceIdsUpdatedAt: changedFixture.sourceIdsUpdatedAt,
      sourceIdsSource: changedFixture.sourceIdsSource
    }).then(() => ({ attempted: true, ok: true })).catch(error => ({ attempted: true, ok: false, error: error?.message || String(error) }));
  }

  return {
    ok: !!publicCacheWrite.ok,
    source: 'flashscore-mid-write-b21',
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocWrite,
    changedCount: 1,
    changedIds: [id],
    id,
    flashscoreMid: matchKey,
    flashscoreUrl: opts.url || changedFixture?.flashscoreUrl || changedFixture?.sourceIds?.flashscoreUrl || null,
    message: 'flashscoreMid stored; B21 sync can now call df_sui_1_<mid> directly without the bad H2H HTML fallback.'
  };
}

async function writeUrlSourceIds(env, fixtures, pack, cfg) {
  const matched = Array.isArray(pack?.matched) ? pack.matched : [];
  const sourceKey = cfg.sourceKey;
  const urlField = cfg.urlField;
  const idField = cfg.idField;
  const sourceName = cfg.sourceName || sourceKey;
  const byId = new Map();

  for (const row of matched) {
    const url = row?.[urlField] || row?.url;
    if (!row?.id || !url) continue;
    byId.set(String(row.id), {
      url: String(url),
      sourceId: row?.[idField] ? String(row[idField]) : null,
      rawText: row.rawText || row.text || null,
      origin: row.origin || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentUrl = fixture[urlField] || fixture.sourceIds?.[`${sourceKey}Url`] || null;
    if (String(currentUrl || '') === String(found.url || '')) return fixture;
    const next = {
      ...fixture,
      [urlField]: found.url,
      ...(found.sourceId ? { [idField]: found.sourceId } : {}),
      sourceIds: {
        ...(fixture.sourceIds || {}),
        [`${sourceKey}Url`]: found.url,
        ...(found.sourceId ? { [sourceKey]: found.sourceId } : {})
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        [`${sourceKey}Text`]: found.rawText,
        [`${sourceKey}Origin`]: found.origin
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: sourceName
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: `no_new_${sourceKey}_urls` };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: `${sourceKey}-source-id-backfill`,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: `This refresh only backfills sourceIds/${urlField}; it does not alter match dates or teams.`
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        [urlField]: fixture[urlField],
        ...(fixture[idField] ? { [idField]: fixture[idField] } : {}),
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f[urlField]]))
  };
}



async function writeSoccerwaySourceIds(env, fixtures, soccerwayPack) {
  const matched = Array.isArray(soccerwayPack?.matched) ? soccerwayPack.matched : [];
  const byId = new Map();
  for (const row of matched) {
    const soccerwayUrl = row?.soccerwayUrl || row?.url;
    if (!row?.id || !soccerwayUrl) continue;
    byId.set(String(row.id), {
      soccerwayUrl: String(soccerwayUrl),
      soccerwayId: row.soccerwayId ? String(row.soccerwayId) : null,
      rawHome: row.rawHome || row.h || null,
      rawAway: row.rawAway || row.a || null,
      rawDate: row.date || null,
      origin: row.origin || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentUrl = fixture.soccerwayUrl || fixture.sourceIds?.soccerwayUrl || null;
    if (String(currentUrl || '') === String(found.soccerwayUrl || '')) return fixture;
    const next = {
      ...fixture,
      soccerwayUrl: found.soccerwayUrl,
      soccerwayId: found.soccerwayId || fixture.soccerwayId || null,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        soccerwayUrl: found.soccerwayUrl,
        ...(found.soccerwayId ? { soccerway: found.soccerwayId } : {})
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        soccerwayHome: found.rawHome,
        soccerwayAway: found.rawAway
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'soccerway-b13-match-link-parser'
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: 'no_new_soccerway_urls' };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'soccerway-source-id-backfill',
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: 'This refresh only backfills sourceIds/soccerwayUrl; it does not alter match dates or teams.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        soccerwayUrl: fixture.soccerwayUrl,
        soccerwayId: fixture.soccerwayId,
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f.soccerwayUrl]))
  };
}

async function writeFotmobSourceIds(env, fixtures, fotmobPack) {
  const matched = Array.isArray(fotmobPack?.matched) ? fotmobPack.matched : [];
  const byId = new Map();
  for (const row of matched) {
    const fotmobId = row?.fotmobId || row?.matchId;
    if (!row?.id || !fotmobId) continue;
    byId.set(String(row.id), {
      fotmobId: String(fotmobId),
      rawHome: row.rawHome || null,
      rawAway: row.rawAway || null,
      rawDate: row.date || null,
      rawStatus: row.status || null,
      pageUrl: row.pageUrl || null,
      origin: row.origin || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentId = fixture.fotmobId || fixture.matchId || fixture.sourceIds?.fotmob || null;
    if (String(currentId || '') === String(found.fotmobId || '')) return fixture;
    const next = {
      ...fixture,
      fotmobId: found.fotmobId,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        fotmob: found.fotmobId
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        fotmobHome: found.rawHome,
        fotmobAway: found.rawAway,
        fotmobPageUrl: found.pageUrl
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'fotmob-b11'
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: 'no_new_fotmob_ids' };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'fotmob-source-id-backfill',
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: 'This refresh only backfills sourceIds/fotmobId; it does not alter match dates or teams.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        fotmobId: fixture.fotmobId,
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f.fotmobId]))
  };
}

async function writeEspnSourceIds(env, fixtures, espnPack) {
  const matched = Array.isArray(espnPack?.matched) ? espnPack.matched : [];
  const byId = new Map();
  for (const row of matched) {
    if (!row?.id || !row?.espnId) continue;
    byId.set(String(row.id), {
      espnId: String(row.espnId),
      rawHome: row.rawHome || null,
      rawAway: row.rawAway || null,
      rawDate: row.date || null,
      rawStatus: row.status || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentId = fixture.espnId || fixture.sourceIds?.espn || null;
    if (String(currentId || '') === String(found.espnId || '')) return fixture;
    const next = {
      ...fixture,
      espnId: found.espnId,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        espn: found.espnId
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        espnHome: found.rawHome,
        espnAway: found.rawAway
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'espn-scoreboard-b10'
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: 'no_new_espn_ids' };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'espn-source-id-backfill',
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: 'This refresh only backfills sourceIds/espnId; it does not alter match dates or teams.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        espnId: fixture.espnId,
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f.espnId]))
  };
}


async function writeSofaScoreSourceIds(env, fixtures, sofaScorePack) {
  const matched = Array.isArray(sofaScorePack?.matched) ? sofaScorePack.matched : [];
  const byId = new Map();
  for (const row of matched) {
    if (!row?.id || !row?.sofascoreId) continue;
    byId.set(String(row.id), {
      sofascoreId: String(row.sofascoreId),
      sofaHome: row.sofaHome || null,
      sofaAway: row.sofaAway || null,
      tournament: row.tournament || null,
      origin: row.origin || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentId = fixture.sofascoreId || fixture.sourceIds?.sofascore || null;
    if (String(currentId || '') === String(found.sofascoreId || '')) return fixture;
    const next = {
      ...fixture,
      sofascoreId: found.sofascoreId,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        sofascore: found.sofascoreId
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        sofascoreHome: found.sofaHome,
        sofascoreAway: found.sofaAway,
        sofascoreTournament: found.tournament
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'sofascore-incidents-b9'
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: 'no_new_sofascore_ids' };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'sofascore-source-id-backfill',
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: 'This refresh only backfills sourceIds/sofascoreId; it does not alter match dates or teams.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        sofascoreId: fixture.sofascoreId,
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f.sofascoreId]))
  };
}


async function writeLiveScoreSourceIds(env, fixtures, liveScorePack) {
  const matched = Array.isArray(liveScorePack?.matched) ? liveScorePack.matched : [];
  const byId = new Map();
  for (const row of matched) {
    if (!row?.id || !row?.rawId) continue;
    byId.set(String(row.id), {
      livescoreId: String(row.rawId),
      rawHome: row.rawHome || null,
      rawAway: row.rawAway || null,
      rawDate: row.date || null,
      rawStatus: row.status || null
    });
  }

  const now = new Date().toISOString();
  const changed = [];
  const updatedFixtures = (fixtures || []).map(fixture => {
    const found = byId.get(String(fixture.id));
    if (!found) return fixture;
    const currentId = fixture.livescoreId || fixture.sourceIds?.livescore || null;
    if (String(currentId || '') === String(found.livescoreId || '')) return fixture;
    const next = {
      ...fixture,
      livescoreId: found.livescoreId,
      sourceIds: {
        ...(fixture.sourceIds || {}),
        livescore: found.livescoreId
      },
      liveSourceNames: {
        ...(fixture.liveSourceNames || {}),
        livescoreHome: found.rawHome,
        livescoreAway: found.rawAway
      },
      sourceIdsUpdatedAt: now,
      sourceIdsSource: 'livescore-app-json'
    };
    changed.push(next);
    return next;
  });

  if (!changed.length) {
    return { ok: true, written: false, changedCount: 0, changedIds: [], message: 'no_new_livescore_ids' };
  }

  const publicPayload = {
    fixtures: updatedFixtures,
    updatedAt: now,
    source: 'livescore-source-id-backfill',
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    warning: 'This refresh only backfills sourceIds/livescoreId; it does not alter match dates or teams.'
  };

  const publicCacheWrite = await patchDocument(env, COLLECTIONS.publicCache, PUBLIC_CACHE_DOCS.fixtures, publicPayload)
    .then(() => ({ ok: true }))
    .catch(error => ({ ok: false, error: error?.message || String(error) }));

  let individualDocsWritten = 0;
  let individualDocsAttempted = 0;
  const writeIndividualDocs = String(env.FIXTURE_WRITE_INDIVIDUAL_DOCS || 'true') === 'true';
  if (writeIndividualDocs) {
    individualDocsAttempted = changed.length;
    for (const fixture of changed) {
      const patch = {
        livescoreId: fixture.livescoreId,
        sourceIds: fixture.sourceIds,
        liveSourceNames: fixture.liveSourceNames,
        sourceIdsUpdatedAt: fixture.sourceIdsUpdatedAt,
        sourceIdsSource: fixture.sourceIdsSource
      };
      const ok = await patchDocument(env, COLLECTIONS.fixtures, fixture.id, patch)
        .then(() => true)
        .catch(() => false);
      if (ok) individualDocsWritten += 1;
    }
  }

  return {
    ok: !!publicCacheWrite.ok,
    written: !!publicCacheWrite.ok,
    publicCacheWrite,
    individualDocsAttempted,
    individualDocsWritten,
    changedCount: changed.length,
    changedIds: changed.map(f => f.id),
    ids: Object.fromEntries(changed.map(f => [f.id, f.livescoreId]))
  };
}
