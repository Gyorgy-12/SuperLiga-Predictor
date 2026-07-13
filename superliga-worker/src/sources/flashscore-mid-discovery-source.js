const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_X_FSIGN = 'SW9D1eZo';
const DEFAULT_TIMEZONE = 'Europe/Bucharest';
const DEFAULT_FEED_TEMPLATE = 'f_1_{offset}_3_en_1';
const DEFAULT_FEED_BASES = [
  'https://2.flashscore.ninja/2/x/feed',
  'https://d.flashscore.com/x/feed'
];

/**
 * B25 automatic Flashscore MID discovery.
 *
 * Flashscore's football list feed exposes the real match key in AA, kickoff in
 * AD and the two team names in AE/AF.  We probe the feed for the fixture dates,
 * parse those rows and match them back to our canonical fixtures.
 */
export async function discoverFlashscoreMids(env, fixtures = [], opts = {}) {
  const timezone = String(opts.timezone || env?.FLASHSCORE_TIMEZONE || DEFAULT_TIMEZONE);
  const threshold = clampNumber(opts.matchThreshold || opts.flashscoreMatchThreshold || env?.FLASHSCORE_MID_MATCH_THRESHOLD || 86, 55, 100);
  const ambiguityGap = clampNumber(opts.ambiguityGap || env?.FLASHSCORE_MID_AMBIGUITY_GAP || 7, 1, 25);
  const timeoutMs = clampNumber(opts.timeoutMs || env?.FLASHSCORE_MID_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 1500, 25000);
  const maxFeeds = clampNumber(opts.maxFeeds || env?.FLASHSCORE_MID_MAX_FEEDS || 36, 1, 48);
  const xFsign = String(opts.xFsign || opts.xfsign || env?.FLASHSCORE_X_FSIGN || DEFAULT_X_FSIGN);
  const referer = String(opts.referer || env?.FLASHSCORE_REFERER || 'https://www.flashscore.com/');
  const userAgent = String(opts.userAgent || env?.FLASHSCORE_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');

  const targets = (fixtures || []).filter(f => f?.id && f?.date && f?.h && f?.a);
  if (!targets.length) {
    return emptyPack('no_target_fixtures');
  }

  const explicitFeeds = splitList(opts.feed || opts.feeds || env?.FLASHSCORE_MID_DISCOVERY_FEEDS);
  const template = String(opts.feedTemplate || env?.FLASHSCORE_DAILY_FEED_TEMPLATE || DEFAULT_FEED_TEMPLATE);
  const feedNames = explicitFeeds.length
    ? explicitFeeds
    : buildDateFeedNames(targets, template, timezone, maxFeeds);

  // These are cheap compatibility probes for installations where the list feed
  // uses the legacy -1/current-day selector rather than a date offset.
  for (const fallback of splitList(env?.FLASHSCORE_MID_FALLBACK_FEEDS || 'f_1_-1_3_en_1,f_1_0_3_en_1')) {
    if (!feedNames.includes(fallback) && feedNames.length < maxFeeds) feedNames.push(fallback);
  }

  const bases = dedupe([
    ...splitList(opts.feedBase || opts.feedBases || env?.FLASHSCORE_FEED_BASES || env?.FLASHSCORE_FEED_BASE),
    ...DEFAULT_FEED_BASES
  ].map(x => String(x || '').replace(/\/+$/, '')).filter(isHttpUrl));

  const feedProbes = [];
  const allEvents = [];
  const seenEventIds = new Set();

  for (const feedName of feedNames.slice(0, maxFeeds)) {
    let accepted = null;
    for (const base of bases) {
      const url = `${base}/${encodeURIComponent(feedName).replace(/%7B/gi, '{').replace(/%7D/gi, '}')}`;
      const probe = await fetchFeed(url, { timeoutMs, xFsign, referer, userAgent });
      const events = probe.ok ? parseFlashscoreListFeed(probe.text || '', timezone) : [];
      const report = {
        feed: feedName,
        url,
        ok: probe.ok,
        status: probe.status,
        bytes: probe.text?.length || 0,
        contentType: probe.contentType,
        elapsedMs: probe.elapsedMs,
        eventCount: events.length,
        dateSample: dedupe(events.map(e => e.date).filter(Boolean)).slice(0, 8),
        error: probe.error || null,
        sample: compact(probe.text || '').slice(0, 260)
      };
      feedProbes.push(report);

      if (events.length) {
        accepted = { url, events };
        break;
      }
    }

    if (!accepted) continue;
    for (const event of accepted.events) {
      if (!event.mid || seenEventIds.has(event.mid)) continue;
      seenEventIds.add(event.mid);
      allEvents.push({ ...event, feed: feedName, feedUrl: accepted.url });
    }
  }

  const matched = [];
  const ambiguous = [];
  const unmatched = [];
  const usedMids = new Set();

  for (const fixture of targets) {
    const ranked = allEvents
      .map(event => ({ event, score: scoreFixtureEvent(fixture, event) }))
      .filter(row => row.score >= threshold - 15)
      .sort((a, b) => b.score - a.score);

    const best = ranked[0] || null;
    const second = ranked[1] || null;

    if (!best || best.score < threshold) {
      unmatched.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        bestScore: best?.score || 0,
        bestMid: best?.event?.mid || null,
        bestHome: best?.event?.home || null,
        bestAway: best?.event?.away || null,
        reason: allEvents.length ? 'no_confident_match' : 'no_flashscore_events_found'
      });
      continue;
    }

    const tooClose = second && second.score >= threshold && (best.score - second.score) < ambiguityGap;
    if (tooClose || usedMids.has(best.event.mid)) {
      ambiguous.push({
        id: fixture.id,
        date: fixture.date,
        h: fixture.h,
        a: fixture.a,
        reason: usedMids.has(best.event.mid) ? 'mid_already_used' : 'top_candidates_too_close',
        candidates: ranked.slice(0, 4).map(row => summarizeCandidate(row.event, row.score))
      });
      continue;
    }

    usedMids.add(best.event.mid);
    matched.push({
      id: fixture.id,
      date: fixture.date,
      h: fixture.h,
      a: fixture.a,
      flashscoreMid: best.event.mid,
      flashscoreEventId: best.event.mid,
      flashscoreUrl: existingOrGenericUrl(fixture, best.event.mid),
      rawHome: best.event.home,
      rawAway: best.event.away,
      rawDate: best.event.date,
      rawKickoffAt: best.event.kickoffAt,
      rawTimestamp: best.event.timestamp,
      score: best.score,
      feed: best.event.feed,
      origin: best.event.feedUrl,
      tournament: best.event.tournament || null,
      country: best.event.country || null
    });
  }

  return {
    ok: true,
    source: 'flashscore-mid-discovery-b25-list-feed',
    targetCount: targets.length,
    feedCount: feedNames.length,
    probedFeedCount: feedProbes.length,
    rawEventCount: allEvents.length,
    count: matched.length,
    matched,
    ambiguous,
    unmatched,
    feedProbes,
    eventSample: allEvents.slice(0, 24),
    settings: { timezone, threshold, ambiguityGap, maxFeeds, feedTemplate: template },
    warning: matched.length
      ? null
      : 'No MID was matched. Inspect feedProbes; the feed template/base can be overridden without changing code.',
    updatedAt: new Date().toISOString()
  };
}

export function parseFlashscoreListFeed(raw, timezone = DEFAULT_TIMEZONE) {
  const text = String(raw || '');
  if (!text || text === '0' || !/[¬÷]/.test(text)) return [];

  const rows = [];
  let context = {};
  for (const rawBlock of text.split('~')) {
    const fields = parseFields(rawBlock);
    if (!Object.keys(fields).length) continue;

    // Tournament/country fields usually precede event blocks and can be carried
    // forward. They are debug-only; matching itself uses date and teams.
    if (fields.ZA || fields.ZE || fields.ZY || fields.ZC) {
      context = {
        ...context,
        tournament: fields.ZA || fields.ZE || context.tournament || null,
        country: fields.ZY || fields.ZC || context.country || null
      };
    }

    const mid = cleanMid(fields.AA);
    const home = cleanText(fields.AE);
    const away = cleanText(fields.AF);
    const timestamp = toNumber(fields.AD);
    if (!mid || !home || !away || !timestamp) continue;

    rows.push({
      mid,
      timestamp,
      kickoffAt: new Date(timestamp * 1000).toISOString(),
      date: dateInTimezone(timestamp, timezone),
      home,
      away,
      homeScore: nullableNumber(fields.AG),
      awayScore: nullableNumber(fields.AH),
      tournament: context.tournament || null,
      country: context.country || null
    });
  }
  return rows;
}

function buildDateFeedNames(fixtures, template, timezone, maxFeeds) {
  const today = todayInTimezone(timezone);
  const dates = dedupe(fixtures.map(f => String(f.date || '').slice(0, 10)).filter(isIsoDate)).sort();
  const names = [];
  for (const date of dates) {
    const offset = dayDiff(today, date);
    const name = String(template || DEFAULT_FEED_TEMPLATE)
      .replaceAll('{offset}', String(offset))
      .replaceAll('{date}', date.replaceAll('-', ''));
    if (!names.includes(name)) names.push(name);
    if (names.length >= maxFeeds) break;
  }
  return names;
}

function scoreFixtureEvent(fixture, event) {
  const fixtureDate = String(fixture.date || '').slice(0, 10);
  const dateDiff = Math.abs(dayDiff(fixtureDate, event.date));
  if (dateDiff > 1) return 0;

  const home = teamSimilarity(fixture.h, event.home);
  const away = teamSimilarity(fixture.a, event.away);
  const reverseHome = teamSimilarity(fixture.h, event.away);
  const reverseAway = teamSimilarity(fixture.a, event.home);

  // Never accept a clearly reversed home/away pairing. Flashscore's AA event
  // rows expose AE as home and AF as away.
  if ((reverseHome + reverseAway) > (home + away) + 0.12) return 0;

  const dateScore = dateDiff === 0 ? 45 : 18;
  const teamScore = Math.round(home * 25) + Math.round(away * 25);
  const exactBonus = canonicalTeam(fixture.h) === canonicalTeam(event.home) && canonicalTeam(fixture.a) === canonicalTeam(event.away) ? 5 : 0;
  return Math.min(100, dateScore + teamScore + exactBonus);
}

function teamSimilarity(a, b) {
  const ca = canonicalTeam(a);
  const cb = canonicalTeam(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.includes(cb) || cb.includes(ca)) return 0.93;

  const ta = new Set(ca.split(' ').filter(Boolean));
  const tb = new Set(cb.split(' ').filter(Boolean));
  const intersection = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const jaccard = intersection / union;
  const prefix = [...ta].some(x => [...tb].some(y => x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)))) ? 0.18 : 0;
  return Math.min(0.92, jaccard + prefix);
}

function canonicalTeam(value) {
  let s = normalize(value)
    .replace(/\b(afc|acs|asc|as|cs|csm|fc|fotbal club|clubul sportiv|sc|fk)\b/g, ' ')
    .replace(/\b(bucuresti|bucurest|buc)\b/g, ' bucuresti ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases = [
    [/^(acs )?champions? (fc )?arges$|^campionii arges$|^arges$/, 'arges'],
    [/^fcsb$|^steaua bucuresti$/, 'fcsb'],
    [/^universitatea cluj$|^u cluj$|^univ cluj$/, 'universitatea cluj'],
    [/^universitatea craiova$|^univ craiova$|^u craiova$/, 'universitatea craiova'],
    [/^rapid bucuresti$|^rapid$/, 'rapid bucuresti'],
    [/^dinamo bucuresti$|^dinamo$/, 'dinamo bucuresti'],
    [/^sepsi( osk)?$|^sepsi sf gheorghe$/, 'sepsi'],
    [/^csikszereda$|^miercurea ciuc$|^csikszereda miercurea ciuc$/, 'csikszereda'],
    [/^otelul galati$|^otelul$/, 'otelul galati'],
    [/^petrolul ploiesti$|^petrolul$/, 'petrolul ploiesti'],
    [/^farul constanta$|^farul$/, 'farul constanta'],
    [/^corvinul hunedoara$|^corvinul$/, 'corvinul hunedoara'],
    [/^voluntari$/, 'voluntari'],
    [/^botosani$/, 'botosani'],
    [/^cfr cluj$/, 'cfr cluj'],
    [/^uta arad$|^uta$/, 'uta arad']
  ];
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(s)) return replacement;
  }
  return s;
}

function parseFields(block) {
  const out = {};
  for (const part of String(block || '').split('¬')) {
    const idx = part.indexOf('÷');
    if (idx < 0) continue;
    const key = part.slice(0, idx).replace(/^~+/, '').trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

async function fetchFeed(url, opts) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), opts.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'x-fsign': opts.xFsign,
        'referer': opts.referer,
        'user-agent': opts.userAgent,
        'accept': 'text/plain,*/*'
      },
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      text,
      elapsedMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      text: '',
      elapsedMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeCandidate(event, score) {
  return {
    mid: event.mid,
    date: event.date,
    home: event.home,
    away: event.away,
    kickoffAt: event.kickoffAt,
    score,
    feed: event.feed,
    origin: event.feedUrl
  };
}

function existingOrGenericUrl(fixture, mid) {
  return fixture.flashscoreUrl
    || fixture.sourceIds?.flashscoreUrl
    || `https://www.flashscore.com/match/${mid}/`;
}

function emptyPack(reason) {
  return {
    ok: true,
    source: 'flashscore-mid-discovery-b25-list-feed',
    targetCount: 0,
    rawEventCount: 0,
    count: 0,
    matched: [],
    ambiguous: [],
    unmatched: [],
    feedProbes: [],
    eventSample: [],
    skipped: true,
    reason,
    updatedAt: new Date().toISOString()
  };
}

function dateInTimezone(timestamp, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(timestamp * 1000));
    const map = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return new Date(timestamp * 1000).toISOString().slice(0, 10);
  }
}

function todayInTimezone(timezone) {
  return dateInTimezone(Math.floor(Date.now() / 1000), timezone);
}

function dayDiff(a, b) {
  if (!isIsoDate(a) || !isIsoDate(b)) return 9999;
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

function cleanMid(value) {
  const s = String(value || '').trim();
  return /^[A-Za-z0-9]{6,20}$/.test(s) ? s : null;
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map(x => x.trim()).filter(Boolean);
  return String(value || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
}

function dedupe(values) {
  return [...new Set(values)];
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clampNumber(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}
