import { refreshFixtures } from '../services/fixture-refresh.service.js';
import { readOdds, refreshOdds } from '../services/odds.service.js';
import { refreshTeamRatings } from '../services/team-ratings.service.js';
import { syncLive } from '../services/sync.service.js';
import { getFixtures } from '../services/fixtures.service.js';
import { backfillFlashscoreMids } from '../services/flashscore-mid-backfill.service.js';

const STATE_KEY = 'coordinator-state';
const LOCK_KEY = 'coordinator-lock';
const SCHEDULER_KEY = 'event-scheduler-state-b28';
const PREMATCH_ODDS_KEY = 'prematch-odds-state-b28';

const DEFAULT_TIMEZONE = 'Europe/Bucharest';
const DEFAULT_DAILY_HOUR = 6;
const DEFAULT_DAILY_MINUTE = 0;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_PREMATCH_ODDS_MINUTES = 30;
const DEFAULT_ROLLING_ODDS_REFRESH_MINUTES = 360;
const DEFAULT_ROLLING_ODDS_STALE_MINUTES = 360;
const DEFAULT_LIVE_START_BEFORE_MINUTES = 5;
const DEFAULT_LIVE_END_AFTER_MINUTES = 120;
const DEFAULT_LIVE_INTERVAL_SECONDS = 30;
const ALARM_EARLY_GRACE_MS = 1_500;

export class UpdateCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const task = url.searchParams.get('task') || 'wake';
    const force = url.searchParams.get('force') === '1';
    const round = url.searchParams.get('round') || null;

    if (request.method === 'GET' && (path === '/' || path === '/state')) {
      return this.json(await this.readPublicState());
    }
    if (request.method === 'GET' && path === '/fixtures-cache') {
      return this.json(await this.state.storage.get('fixtures-cache') || { ok: true, fixtures: [], source: 'empty' });
    }
    if (request.method === 'GET' && path === '/odds-cache') {
      return this.json(await this.state.storage.get('odds-cache') || { ok: true, odds: {}, source: 'empty' });
    }
    if (request.method === 'GET' && path === '/ratings-cache') {
      return this.json(await this.state.storage.get('ratings-cache') || { ok: true, ratings: {}, marketValues: {}, source: 'empty' });
    }

    if (request.method === 'POST' && (path === '/run' || path === '/refresh')) {
      return this.json(await this.runTask(task, { force, manual: true, round }));
    }

    if (request.method === 'POST' && path === '/alarm') {
      const next = await this.scheduleNextAlarm({ force: true, reason: 'manual_arm' });
      return this.json({ ok: true, ...next });
    }

    if (request.method === 'POST' && path === '/ensure-alarm') {
      const next = await this.scheduleNextAlarm({ force: false, reason: 'ensure_alarm' });
      return this.json({ ok: true, ...next });
    }

    return this.json({ ok: false, error: 'not_found' }, 404);
  }

  async alarm() {
    try {
      await this.runTask('scheduler', { force: false, alarm: true });
    } catch (error) {
      await this.storeSchedulerError(error);
    } finally {
      await this.scheduleNextAlarm({ force: true, reason: 'alarm_complete' });
    }
  }

  async runTask(task = 'wake', opts = {}) {
    const lock = await this.acquireLock(task, opts.force);
    if (!lock.ok) {
      await this.scheduleNextAlarm({ force: false, reason: 'locked_retry' });
      return lock;
    }

    try {
      const normalizedTask = String(task || 'wake').toLowerCase();
      let result;

      if (['wake', 'scheduler', 'tick'].includes(normalizedTask)) {
        result = await this.runSchedulerTick(opts);
      } else if (normalizedTask === 'daily') {
        result = await this.runDailyBatch(opts);
      } else if (normalizedTask === 'fixtures') {
        result = await this.runFixtures(opts);
      } else if (['flashscore-fixtures', 'flashscore-schedule', 'flashscore-mids', 'flashscore-mid-backfill', 'mids', 'schedule'].includes(normalizedTask)) {
        result = await this.runFlashscoreFixtures(opts);
      } else if (normalizedTask === 'odds') {
        result = await this.runOdds(opts);
      } else if (normalizedTask === 'ratings' || normalizedTask === 'team-ratings') {
        result = await this.runRatings(opts);
      } else if (normalizedTask === 'live') {
        result = await this.runManualLive(opts);
      } else {
        result = { ok: false, error: 'unknown_task', task: normalizedTask };
      }

      await this.updateState(normalizedTask, result, opts);
      await this.scheduleNextAlarm({ force: false, reason: `task_${normalizedTask}_complete` });
      return result;
    } finally {
      await this.releaseLock(lock.token);
    }
  }

  async runSchedulerTick(opts = {}) {
    const now = Date.now();
    const timezone = this.timezone();
    let scheduler = await this.readSchedulerState();
    let fixtures = await getFixtures(this.env, { skipCoordinatorCache: true }).catch(() => []);
    const results = {};
    const ran = [];

    const dailyTarget = this.dailyTargetForNow(now, timezone);
    const localDate = dateKeyInZone(now, timezone);
    const dailyDue = now + ALARM_EARLY_GRACE_MS >= dailyTarget
      && scheduler.lastDailyLocalDate !== localDate;

    if (dailyDue) {
      results.daily = await this.runDailyBatch({ ...opts, scheduler: true, localDate });
      ran.push('daily');
      scheduler = await this.readSchedulerState();
      fixtures = Array.isArray(results.daily?.fixtures)
        ? results.daily.fixtures
        : await getFixtures(this.env, { skipCoordinatorCache: true }).catch(() => fixtures);
    }

    const weekly = this.weeklySchedule(now, timezone, scheduler);
    if (weekly.enabled && weekly.due) {
      results.ratings = await this.runRatings({ ...opts, scheduler: true, weekly: true });
      ran.push('ratings');
      scheduler.lastWeeklyRatingsKey = weekly.key;
      scheduler.lastWeeklyRatingsAt = new Date().toISOString();
      await this.writeSchedulerState(scheduler);
    }

    const prematch = await this.runDuePrematchOdds(fixtures, now, opts);
    if (!prematch.skipped) {
      results.prematchOdds = prematch;
      ran.push('prematch-odds');
    }

    const rollingOdds = await this.runDueRollingOdds(fixtures, now, opts);
    if (!rollingOdds.skipped) {
      results.rollingOdds = rollingOdds;
      ran.push('rolling-odds');
    }

    const liveFixtures = this.selectLiveFixtures(fixtures, now);
    if (liveFixtures.length) {
      results.live = await syncLive(this.env, {
        ...opts,
        force: true,
        cron: !!opts.alarm,
        activeFixtures: liveFixtures,
        includeScheduled: true,
        source: 'coordinator-live-b28-windowed-30s'
      });
      ran.push('live');
      scheduler = await this.readSchedulerState();
      scheduler.lastLiveTickAt = new Date().toISOString();
      scheduler.lastLiveFixtureIds = liveFixtures.map(f => String(f.id));
      await this.writeSchedulerState(scheduler);
    }

    return {
      ok: Object.values(results).every(row => row?.ok !== false),
      task: 'scheduler',
      source: 'event-driven-scheduler-b28',
      ran,
      skipped: !ran.length,
      results,
      activeLiveIds: liveFixtures.map(f => String(f.id)),
      now: new Date(now).toISOString(),
      timezone,
      updatedAt: new Date().toISOString()
    };
  }

  async runDailyBatch(opts = {}) {
    const timezone = this.timezone();
    const localDate = opts.localDate || dateKeyInZone(Date.now(), timezone);

    const officialFixtures = await this.runFixtures({ ...opts, dailyBatch: true });
    const flashscoreFixtures = await this.runFlashscoreFixtures({ ...opts, dailyBatch: true });
    const fixtures = Array.isArray(flashscoreFixtures?.fixtures)
      ? flashscoreFixtures.fixtures
      : (Array.isArray(officialFixtures?.fixtures) ? officialFixtures.fixtures : await getFixtures(this.env, { skipCoordinatorCache: true }).catch(() => []));

    const windowFixtures = this.selectDailyWindow(fixtures, Date.now());
    const odds = await this.runOdds({
      ...opts,
      force: true,
      activeFixtures: windowFixtures,
      fixtureIds: windowFixtures.map(f => String(f.id)),
      oddsReason: 'daily_two_week_fixture_scan'
    });

    const scheduler = await this.readSchedulerState();
    scheduler.lastDailyLocalDate = localDate;
    scheduler.lastDailyAt = new Date().toISOString();
    scheduler.lastDailyFixtureIds = windowFixtures.map(f => String(f.id));
    scheduler.lastRollingOddsAt = new Date().toISOString();
    await this.writeSchedulerState(scheduler);

    return {
      ok: officialFixtures?.ok !== false && flashscoreFixtures?.ok !== false && odds?.ok !== false,
      task: 'daily',
      source: 'daily-two-week-fixtures-plus-odds-b28',
      localDate,
      windowDays: this.dailyWindowDays(),
      selectedCount: windowFixtures.length,
      selectedIds: windowFixtures.map(f => String(f.id)),
      officialFixtures,
      flashscoreFixtures,
      odds,
      fixtures,
      updatedAt: new Date().toISOString()
    };
  }

  async runDuePrematchOdds(fixtures, now, opts = {}) {
    const beforeMs = this.prematchOddsMinutes() * 60_000;
    const state = await this.readPrematchOddsState();
    const due = [];

    for (const fixture of fixtures || []) {
      const kickoffMs = fixtureKickoffMs(fixture, this.timezone());
      if (!Number.isFinite(kickoffMs)) continue;
      const target = kickoffMs - beforeMs;
      const key = `${fixture.id}@${kickoffMs}`;
      const record = state[key];
      const insideAttemptWindow = now + ALARM_EARLY_GRACE_MS >= target && now < kickoffMs + 5 * 60_000;
      if (!insideAttemptWindow || record?.done) continue;
      if (record?.lastAttemptAt && now - Number(record.lastAttemptAt) < 5 * 60_000) continue;
      due.push({ fixture, kickoffMs, target, key });
    }

    if (!due.length) {
      return { ok: true, skipped: true, reason: 'no_prematch_odds_due', count: 0 };
    }

    const result = await this.runOdds({
      ...opts,
      force: true,
      activeFixtures: due.map(row => row.fixture),
      fixtureIds: due.map(row => String(row.fixture.id)),
      oddsReason: 'prematch_minus_30_minutes'
    });

    const attemptedAt = Date.now();
    const matchedIds = new Set((result?.matchedIds || []).map(String));
    const unmatchedIds = new Set((result?.unmatchedIds || []).map(String));
    for (const row of due) {
      const fixtureId = String(row.fixture.id);
      const previous = state[row.key] || {};
      const matched = matchedIds.has(fixtureId);
      state[row.key] = {
        fixtureId,
        kickoffMs: row.kickoffMs,
        targetMs: row.target,
        attempts: Number(previous.attempts || 0) + 1,
        lastAttemptAt: attemptedAt,
        done: matched,
        ok: matched,
        matched,
        unmatched: unmatchedIds.has(fixtureId),
        sourceCount: result?.sourceCount ?? null,
        changed: result?.changed ?? null,
        error: matched ? null : (result?.error || 'odds_not_available_yet')
      };
    }
    cleanupPrematchState(state, now);
    await this.state.storage.put(PREMATCH_ODDS_KEY, state);

    return {
      ok: result?.ok !== false,
      task: 'prematch-odds',
      source: 'prematch-odds-b28',
      count: due.length,
      ids: due.map(row => String(row.fixture.id)),
      targetMinutesBeforeKickoff: this.prematchOddsMinutes(),
      result,
      updatedAt: new Date().toISOString()
    };
  }

  async runDueRollingOdds(fixtures, now, opts = {}) {
    const scheduler = await this.readSchedulerState();
    const intervalMs = this.rollingOddsRefreshMinutes() * 60_000;
    const lastMs = Date.parse(scheduler.lastRollingOddsAt || '');
    if (Number.isFinite(lastMs) && now - lastMs < intervalMs) {
      return { ok: true, skipped: true, reason: 'rolling_odds_not_due', nextAt: new Date(lastMs + intervalMs).toISOString() };
    }

    const current = await readOdds(this.env, { skipCoordinatorCache: true }).catch(() => ({ odds: {} }));
    const staleMs = this.rollingOddsStaleMinutes() * 60_000;
    const windowFixtures = this.selectDailyWindow(fixtures, now);
    const targets = windowFixtures.filter(fixture => {
      const row = current?.odds?.[String(fixture.id)];
      if (!row || !Number.isFinite(Number(row.h)) || !Number.isFinite(Number(row.d)) || !Number.isFinite(Number(row.a))) return true;
      const updated = Date.parse(row.updatedAt || row.feedUpdatedAt || '');
      return !Number.isFinite(updated) || now - updated >= staleMs;
    }).slice(0, Number(this.env.FLASHSCORE_ODDS_MAX_FIXTURES || 24));

    let result = { ok: true, skipped: true, reason: 'rolling_odds_cache_fresh', count: 0 };
    if (targets.length) {
      result = await this.runOdds({ ...opts, force: true, activeFixtures: targets, fixtureIds: targets.map(f => String(f.id)), oddsReason: 'rolling_upcoming_odds_retry' });
    }

    scheduler.lastRollingOddsAt = new Date(now).toISOString();
    scheduler.lastRollingOddsFixtureIds = targets.map(f => String(f.id));
    await this.writeSchedulerState(scheduler);

    return { ok: result?.ok !== false, task: 'rolling-odds', source: 'rolling-upcoming-odds-b37', count: targets.length, ids: targets.map(f => String(f.id)), intervalMinutes: this.rollingOddsRefreshMinutes(), staleMinutes: this.rollingOddsStaleMinutes(), result, updatedAt: new Date().toISOString() };
  }

  async runFixtures(opts = {}) {
    const result = await refreshFixtures(this.env, { ...opts, skipCoordinatorCache: true });
    await this.state.storage.put('fixtures-cache', result);
    await this.updateState('fixtures', result, opts);
    return result;
  }

  async runFlashscoreFixtures(opts = {}) {
    const result = await backfillFlashscoreMids(this.env, null, {
      ...opts,
      write: true,
      overwrite: false,
      syncSchedule: true,
      windowDaysBefore: 0,
      windowDaysAfter: this.dailyWindowDays(),
      maxFeeds: Number(this.env.FLASHSCORE_FIXTURE_MAX_FEEDS || this.env.FLASHSCORE_MID_MAX_FEEDS || 18)
    });

    if (Array.isArray(result?.fixtures)) {
      await this.state.storage.put('fixtures-cache', {
        ok: !!result.ok,
        source: result.source,
        fixtures: result.fixtures,
        count: result.fixtures.length,
        changedCount: result.changedCount || 0,
        changedIds: result.changedIds || [],
        midChangedCount: result.midChangedCount || 0,
        midChangedIds: result.midChangedIds || [],
        scheduleChangedCount: result.scheduleChangedCount || 0,
        scheduleChangedIds: result.scheduleChangedIds || [],
        rollingWindow: result.rollingWindow || null,
        updatedAt: result.updatedAt
      });
    }

    await this.updateState('flashscore-fixtures', result, opts);
    await this.updateState('flashscore-mids', result, opts);
    return result;
  }

  async runOdds(opts = {}) {
    const result = await refreshOdds(this.env, { ...opts, skipCoordinatorCache: true });
    await this.state.storage.put('odds-cache', result);
    await this.updateState('odds', result, opts);
    return result;
  }

  async runRatings(opts = {}) {
    const result = await refreshTeamRatings(this.env, { ...opts, skipCoordinatorCache: true });
    await this.state.storage.put('ratings-cache', result);
    await this.updateState('ratings', result, opts);
    return result;
  }

  async runManualLive(opts = {}) {
    return syncLive(this.env, {
      ...opts,
      force: !!opts.force,
      source: 'coordinator-live-manual-b28'
    });
  }

  selectDailyWindow(fixtures, now) {
    const timezone = this.timezone();
    const startDate = dateKeyInZone(now, timezone);
    const endDate = addLocalDays(startDate, this.dailyWindowDays());
    return (fixtures || []).filter(fixture => {
      const date = String(fixture?.date || '').slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= startDate && date <= endDate;
    });
  }

  selectLiveFixtures(fixtures, now) {
    const startBeforeMs = this.liveStartBeforeMinutes() * 60_000;
    const endAfterMs = this.liveEndAfterMinutes() * 60_000;
    return (fixtures || []).filter(fixture => {
      const kickoffMs = fixtureKickoffMs(fixture, this.timezone());
      return Number.isFinite(kickoffMs)
        && now + ALARM_EARLY_GRACE_MS >= kickoffMs - startBeforeMs
        && now <= kickoffMs + endAfterMs;
    });
  }

  async scheduleNextAlarm({ force = false, reason = null } = {}) {
    const now = Date.now();
    const timezone = this.timezone();
    const scheduler = await this.readSchedulerState();
    const fixtures = await getFixtures(this.env, { skipCoordinatorCache: true }).catch(() => []);
    const prematchState = await this.readPrematchOddsState();
    const candidates = [];

    const localDate = dateKeyInZone(now, timezone);
    const todayDailyTarget = this.dailyTargetForNow(now, timezone);
    if (scheduler.lastDailyLocalDate !== localDate && now + ALARM_EARLY_GRACE_MS >= todayDailyTarget) {
      candidates.push({ at: now + 1_000, type: 'daily_overdue' });
    } else {
      const nextDaily = scheduler.lastDailyLocalDate === localDate
        ? this.dailyTargetForDate(addLocalDays(localDate, 1), timezone)
        : todayDailyTarget;
      candidates.push({ at: nextDaily, type: 'daily_scan' });
    }

    const weekly = this.weeklySchedule(now, timezone, scheduler);
    if (weekly.enabled) candidates.push({ at: weekly.nextAt, type: weekly.due ? 'weekly_ratings_overdue' : 'weekly_ratings' });

    const rollingIntervalMs = this.rollingOddsRefreshMinutes() * 60_000;
    const lastRollingMs = Date.parse(scheduler.lastRollingOddsAt || '');
    candidates.push({ at: Number.isFinite(lastRollingMs) ? Math.max(now + 1_000, lastRollingMs + rollingIntervalMs) : now + 1_000, type: 'rolling_odds' });

    const preOddsMs = this.prematchOddsMinutes() * 60_000;
    const liveBeforeMs = this.liveStartBeforeMinutes() * 60_000;
    const liveAfterMs = this.liveEndAfterMinutes() * 60_000;
    let activeLive = false;

    for (const fixture of fixtures || []) {
      const kickoffMs = fixtureKickoffMs(fixture, timezone);
      if (!Number.isFinite(kickoffMs)) continue;

      const preKey = `${fixture.id}@${kickoffMs}`;
      const preTarget = kickoffMs - preOddsMs;
      const preRecord = prematchState[preKey];
      if (!preRecord?.done && kickoffMs + 5 * 60_000 > now) {
        if (preTarget <= now + ALARM_EARLY_GRACE_MS) {
          const retryAt = preRecord?.lastAttemptAt
            ? Number(preRecord.lastAttemptAt) + 5 * 60_000
            : now + 1_000;
          candidates.push({ at: Math.max(now + 1_000, retryAt), type: 'prematch_odds', fixtureId: fixture.id });
        } else {
          candidates.push({ at: preTarget, type: 'prematch_odds', fixtureId: fixture.id });
        }
      }

      const liveStart = kickoffMs - liveBeforeMs;
      const liveEnd = kickoffMs + liveAfterMs;
      if (now >= liveStart - ALARM_EARLY_GRACE_MS && now <= liveEnd) {
        activeLive = true;
      } else if (liveStart > now) {
        candidates.push({ at: liveStart, type: 'live_start', fixtureId: fixture.id });
      }
      if (liveEnd > now) candidates.push({ at: liveEnd, type: 'live_final_tick', fixtureId: fixture.id });
    }

    if (activeLive) {
      candidates.push({ at: nextAlignedBoundary(now, this.liveIntervalSeconds() * 1_000), type: 'live_tick' });
    }

    const valid = candidates
      .filter(row => Number.isFinite(row.at) && row.at > now)
      .sort((a, b) => a.at - b.at);
    const next = valid[0] || { at: now + 24 * 60 * 60 * 1_000, type: 'daily_fallback' };
    const currentAlarm = await this.state.storage.getAlarm();
    const shouldSet = force || !currentAlarm || next.at + 1_000 < currentAlarm || currentAlarm <= now;

    if (shouldSet) await this.state.storage.setAlarm(Math.max(now + 1_000, Math.floor(next.at)));

    const nextAlarmAt = shouldSet ? Math.max(now + 1_000, Math.floor(next.at)) : currentAlarm;
    scheduler.nextAlarmAt = new Date(nextAlarmAt).toISOString();
    scheduler.nextAlarmType = shouldSet ? next.type : scheduler.nextAlarmType || 'existing_alarm_kept';
    scheduler.nextAlarmFixtureId = shouldSet ? (next.fixtureId || null) : (scheduler.nextAlarmFixtureId || null);
    scheduler.lastArmReason = reason;
    scheduler.lastArmedAt = new Date().toISOString();
    scheduler.alarmWasChanged = shouldSet;
    await this.writeSchedulerState(scheduler);

    return {
      alarmAt: nextAlarmAt,
      alarmAtIso: new Date(nextAlarmAt).toISOString(),
      alarmType: shouldSet ? next.type : 'existing_alarm_kept',
      fixtureId: shouldSet ? (next.fixtureId || null) : null,
      changed: shouldSet,
      activeLive,
      reason
    };
  }

  dailyTargetForNow(now, timezone) {
    return this.dailyTargetForDate(dateKeyInZone(now, timezone), timezone);
  }

  dailyTargetForDate(date, timezone) {
    return zonedDateTimeToEpoch(date, this.dailyHour(), this.dailyMinute(), timezone);
  }

  weeklySchedule(now, timezone, scheduler) {
    const enabled = String(this.env.WEEKLY_RATINGS_ENABLED || 'false').toLowerCase() === 'true';
    if (!enabled) return { enabled: false, due: false, nextAt: Number.POSITIVE_INFINITY, key: null };

    const day = clampInt(this.env.WEEKLY_RATINGS_DAY ?? 3, 0, 6);
    const hour = clampInt(this.env.WEEKLY_RATINGS_HOUR_LOCAL ?? 10, 0, 23);
    const minute = clampInt(this.env.WEEKLY_RATINGS_MINUTE_LOCAL ?? 0, 0, 59);
    const localDate = dateKeyInZone(now, timezone);
    const currentDay = weekdayInZone(now, timezone);
    const daysUntil = (day - currentDay + 7) % 7;
    let targetDate = addLocalDays(localDate, daysUntil);
    let targetAt = zonedDateTimeToEpoch(targetDate, hour, minute, timezone);
    const key = `${targetDate}@${hour}:${String(minute).padStart(2, '0')}`;
    const due = daysUntil === 0 && now + ALARM_EARLY_GRACE_MS >= targetAt && scheduler.lastWeeklyRatingsKey !== key;

    if (!due && targetAt <= now) {
      targetDate = addLocalDays(targetDate, 7);
      targetAt = zonedDateTimeToEpoch(targetDate, hour, minute, timezone);
    }

    return { enabled: true, due, nextAt: due ? now + 1_000 : targetAt, key };
  }

  timezone() {
    return this.env.SCHEDULER_TIMEZONE || DEFAULT_TIMEZONE;
  }

  dailyHour() {
    return clampInt(this.env.DAILY_SCAN_HOUR_LOCAL ?? DEFAULT_DAILY_HOUR, 0, 23);
  }

  dailyMinute() {
    return clampInt(this.env.DAILY_SCAN_MINUTE_LOCAL ?? DEFAULT_DAILY_MINUTE, 0, 59);
  }

  dailyWindowDays() {
    return clampInt(this.env.DAILY_FIXTURE_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS, 1, 31);
  }

  prematchOddsMinutes() {
    return clampInt(this.env.PREMATCH_ODDS_MINUTES ?? DEFAULT_PREMATCH_ODDS_MINUTES, 1, 180);
  }

  rollingOddsRefreshMinutes() {
    return clampInt(this.env.ROLLING_ODDS_REFRESH_MINUTES ?? DEFAULT_ROLLING_ODDS_REFRESH_MINUTES, 30, 720);
  }

  rollingOddsStaleMinutes() {
    return clampInt(this.env.ROLLING_ODDS_STALE_MINUTES ?? DEFAULT_ROLLING_ODDS_STALE_MINUTES, 30, 1440);
  }

  liveStartBeforeMinutes() {
    return clampInt(this.env.LIVE_SYNC_START_BEFORE_MINUTES ?? DEFAULT_LIVE_START_BEFORE_MINUTES, 0, 60);
  }

  liveEndAfterMinutes() {
    return clampInt(this.env.LIVE_SYNC_END_AFTER_MINUTES ?? DEFAULT_LIVE_END_AFTER_MINUTES, 30, 360);
  }

  liveIntervalSeconds() {
    return clampInt(this.env.LIVE_SYNC_INTERVAL_SECONDS ?? DEFAULT_LIVE_INTERVAL_SECONDS, 30, 300);
  }

  async acquireLock(task, force = false) {
    const now = Date.now();
    const current = await this.state.storage.get(LOCK_KEY);
    if (!force && current?.until && current.until > now) {
      return {
        ok: false,
        skipped: true,
        reason: 'coordinator_locked',
        task: current.task,
        until: current.until,
        updatedAt: new Date().toISOString()
      };
    }
    const token = crypto.randomUUID();
    await this.state.storage.put(LOCK_KEY, { task, token, since: now, until: now + 4 * 60 * 1_000 });
    return { ok: true, token };
  }

  async releaseLock(token) {
    const current = await this.state.storage.get(LOCK_KEY);
    if (current?.token === token) await this.state.storage.delete(LOCK_KEY);
  }

  async readState() {
    const state = await this.state.storage.get(STATE_KEY);
    return state || { ok: true, lastRuns: {}, createdAt: new Date().toISOString() };
  }

  async readSchedulerState() {
    return await this.state.storage.get(SCHEDULER_KEY) || {
      version: 'b28-event-driven',
      createdAt: new Date().toISOString(),
      lastDailyLocalDate: null,
      lastWeeklyRatingsKey: null
    };
  }

  async writeSchedulerState(state) {
    state.version = 'b28-event-driven';
    state.updatedAt = new Date().toISOString();
    await this.state.storage.put(SCHEDULER_KEY, state);
  }

  async readPrematchOddsState() {
    return await this.state.storage.get(PREMATCH_ODDS_KEY) || {};
  }

  async readPublicState() {
    return {
      ...(await this.readState()),
      scheduler: await this.readSchedulerState(),
      prematchOdds: await this.readPrematchOddsState(),
      alarmAt: await this.state.storage.getAlarm(),
      schedulerConfig: {
        timezone: this.timezone(),
        dailyScanLocalTime: `${String(this.dailyHour()).padStart(2, '0')}:${String(this.dailyMinute()).padStart(2, '0')}`,
        dailyFixtureWindowDays: this.dailyWindowDays(),
        prematchOddsMinutes: this.prematchOddsMinutes(),
        liveStartBeforeMinutes: this.liveStartBeforeMinutes(),
        liveEndAfterMinutes: this.liveEndAfterMinutes(),
        liveIntervalSeconds: this.liveIntervalSeconds(),
        weeklyRatingsEnabled: String(this.env.WEEKLY_RATINGS_ENABLED || 'false').toLowerCase() === 'true',
        weeklyRatingsDay: Number(this.env.WEEKLY_RATINGS_DAY ?? 3),
        weeklyRatingsLocalTime: `${String(clampInt(this.env.WEEKLY_RATINGS_HOUR_LOCAL ?? 10, 0, 23)).padStart(2, '0')}:${String(clampInt(this.env.WEEKLY_RATINGS_MINUTE_LOCAL ?? 0, 0, 59)).padStart(2, '0')}`
      }
    };
  }

  async updateState(task, result, opts = {}) {
    const state = await this.readState();
    const key = task === 'daily' ? 'daily' : task;
    state.ok = true;
    state.lastRuns = state.lastRuns || {};
    state.lastRuns[key] = {
      ts: Date.now(),
      at: new Date().toISOString(),
      ok: !!result?.ok,
      count: result?.count ?? result?.sourceCount ?? result?.marketCount ?? result?.selectedCount ?? null,
      changedCount: result?.changedCount ?? null,
      scheduleChangedCount: result?.scheduleChangedCount ?? null,
      midChangedCount: result?.midChangedCount ?? null,
      changed: result?.changed ?? null,
      skipped: !!result?.skipped,
      force: !!opts.force,
      cron: opts.cron || null,
      error: result?.error || null
    };
    state.updatedAt = new Date().toISOString();
    await this.state.storage.put(STATE_KEY, state);
  }

  async storeSchedulerError(error) {
    const scheduler = await this.readSchedulerState();
    scheduler.lastErrorAt = new Date().toISOString();
    scheduler.lastError = error?.message || String(error);
    await this.writeSchedulerState(scheduler);
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}

function fixtureKickoffMs(fixture, timezone) {
  const direct = Date.parse(fixture?.kickoffAt || '');
  if (Number.isFinite(direct)) return direct;
  const date = String(fixture?.date || '').slice(0, 10);
  const time = String(fixture?.t || fixture?.time || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  const [hour, minute] = time.split(':').map(Number);
  return zonedDateTimeToEpoch(date, hour, minute, timezone);
}

function dateKeyInZone(epochMs, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(epochMs));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function weekdayInZone(epochMs, timezone) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date(epochMs));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}

function zonedDateTimeToEpoch(date, hour, minute, timezone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const desiredPseudoUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desiredPseudoUtc;

  for (let i = 0; i < 4; i += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(guess));
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const actualPseudoUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second)
    );
    const diff = desiredPseudoUtc - actualPseudoUtc;
    guess += diff;
    if (Math.abs(diff) < 1_000) break;
  }

  return guess;
}

function addLocalDays(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  return d.toISOString().slice(0, 10);
}

function nextAlignedBoundary(now, intervalMs) {
  return Math.floor(now / intervalMs) * intervalMs + intervalMs;
}

function cleanupPrematchState(state, now) {
  const oldest = now - 14 * 24 * 60 * 60 * 1_000;
  for (const [key, row] of Object.entries(state || {})) {
    if (!row?.kickoffMs || Number(row.kickoffMs) < oldest) delete state[key];
  }
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}
