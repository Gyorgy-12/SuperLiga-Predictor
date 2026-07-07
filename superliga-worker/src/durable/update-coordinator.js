import { refreshFixtures } from '../services/fixture-refresh.service.js';
import { refreshOdds } from '../services/odds.service.js';
import { syncLive } from '../services/sync.service.js';
import { refreshTeamRatings } from '../services/team-ratings.service.js';

const STATE_KEY = 'coordinator-state';
const LOCK_KEY = 'coordinator-lock';
const DAY_MS = 24 * 60 * 60 * 1000;
const ODDS_MIN_MS = 6 * 60 * 60 * 1000;
const FIXTURE_MIN_MS = 20 * 60 * 60 * 1000;
const RATINGS_MIN_MS = 6 * 24 * 60 * 60 * 1000;

export class UpdateCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const task = url.searchParams.get('task') || 'daily';
    const force = url.searchParams.get('force') === '1';
    const round = url.searchParams.get('round') || null;

    if (request.method === 'GET' && (path === '/' || path === '/state')) return this.json(await this.readState());
    if (request.method === 'GET' && path === '/fixtures-cache') return this.json(await this.state.storage.get('fixtures-cache') || { ok: true, fixtures: [], source: 'empty' });
    if (request.method === 'GET' && path === '/odds-cache') return this.json(await this.state.storage.get('odds-cache') || { ok: true, odds: {}, source: 'empty' });
    if (request.method === 'GET' && path === '/ratings-cache') return this.json(await this.state.storage.get('ratings-cache') || { ok: true, ratings: {}, marketValues: {}, source: 'empty' });
    if (request.method === 'POST' && (path === '/run' || path === '/refresh')) {
      const result = await this.runTask(task, { force, manual: true, round });
      return this.json(result);
    }
    if (request.method === 'POST' && path === '/alarm') {
      await this.armNextAlarm();
      return this.json({ ok: true, alarmAt: await this.state.storage.getAlarm() });
    }
    return this.json({ ok: false, error: 'not_found' }, 404);
  }

  async alarm() {
    await this.runTask('daily', { force: false, alarm: true });
    await this.armNextAlarm();
  }

  async runScheduled(cron = '') {
    if (cron.includes('/15') || cron.includes('/10') || cron.includes('/5')) {
      return this.runTask('live', { force: false, cron });
    }
    return this.runTask('daily', { force: false, cron });
  }

  async runTask(task = 'daily', opts = {}) {
    const lock = await this.acquireLock(task, opts.force);
    if (!lock.ok) return lock;

    try {
      const normalizedTask = String(task || 'daily').toLowerCase();
      let result;
      if (normalizedTask === 'fixtures') result = await this.runFixtures(opts);
      else if (normalizedTask === 'odds') result = await this.runOdds(opts);
      else if (normalizedTask === 'ratings' || normalizedTask === 'elo' || normalizedTask === 'market-values') result = await this.runRatings(opts);
      else if (normalizedTask === 'weekly') result = await this.runWeekly(opts);
      else if (normalizedTask === 'live') result = await syncLive(this.env, { force: !!opts.force, cron: !!opts.cron });
      else result = await this.runDaily(opts);

      await this.updateState(normalizedTask, result, opts);
      return result;
    } finally {
      await this.releaseLock(lock.token);
    }
  }

  async runDaily(opts = {}) {
    const state = await this.readState();
    const now = Date.now();
    const force = !!opts.force;
    const jobs = [];

    const fixtureAge = now - Number(state.lastRuns?.fixtures?.ts || 0);
    if (force || fixtureAge >= Number(this.env.FIXTURE_REFRESH_MIN_MS || FIXTURE_MIN_MS)) {
      jobs.push(['fixtures', () => this.runFixtures(opts)]);
    }

    const oddsAge = now - Number(state.lastRuns?.odds?.ts || 0);
    if (force || oddsAge >= Number(this.env.ODDS_REFRESH_MIN_MS || ODDS_MIN_MS)) {
      jobs.push(['odds', () => this.runOdds(opts)]);
    }

    const results = {};
    for (const [name, fn] of jobs) results[name] = await fn();
    await this.armNextAlarm();

    return {
      ok: true,
      task: 'daily',
      ran: Object.keys(results),
      skipped: !Object.keys(results).length,
      results,
      updatedAt: new Date().toISOString()
    };
  }


  async runWeekly(opts = {}) {
    const state = await this.readState();
    const now = Date.now();
    const force = !!opts.force;
    const ratingsAge = now - Number(state.lastRuns?.ratings?.ts || 0);
    const results = {};
    if (force || ratingsAge >= Number(this.env.RATINGS_REFRESH_MIN_MS || RATINGS_MIN_MS)) {
      results.ratings = await this.runRatings(opts);
    }
    await this.armNextAlarm();
    return {
      ok: true,
      task: 'weekly',
      ran: Object.keys(results),
      skipped: !Object.keys(results).length,
      results,
      updatedAt: new Date().toISOString()
    };
  }

  async runRatings(opts = {}) {
    const result = await refreshTeamRatings(this.env, opts);
    await this.state.storage.put('ratings-cache', result);
    return result;
  }

  async runFixtures(opts = {}) {
    const result = await refreshFixtures(this.env, opts);
    await this.state.storage.put('fixtures-cache', result);
    return result;
  }

  async runOdds(opts = {}) {
    const result = await refreshOdds(this.env, opts);
    await this.state.storage.put('odds-cache', result);
    return result;
  }

  async acquireLock(task, force = false) {
    const now = Date.now();
    const current = await this.state.storage.get(LOCK_KEY);
    if (!force && current?.until && current.until > now) {
      return { ok: false, skipped: true, reason: 'coordinator_locked', task: current.task, until: current.until, updatedAt: new Date().toISOString() };
    }
    const token = crypto.randomUUID();
    await this.state.storage.put(LOCK_KEY, { task, token, since: now, until: now + 2 * 60 * 1000 });
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

  async updateState(task, result, opts = {}) {
    const state = await this.readState();
    const key = task === 'daily' ? 'daily' : task;
    state.ok = true;
    state.lastRuns = state.lastRuns || {};
    state.lastRuns[key] = {
      ts: Date.now(),
      at: new Date().toISOString(),
      ok: !!result?.ok,
      count: result?.count ?? result?.sourceCount ?? null,
      changedCount: result?.changedCount ?? null,
      changed: result?.changed ?? null,
      skipped: !!result?.skipped,
      force: !!opts.force,
      cron: opts.cron || null,
      error: result?.error || null
    };
    state.updatedAt = new Date().toISOString();
    await this.state.storage.put(STATE_KEY, state);
  }

  async armNextAlarm() {
    const hourUtc = Number(this.env.COORDINATOR_ALARM_HOUR_UTC || 2);
    const minuteUtc = Number(this.env.COORDINATOR_ALARM_MINUTE_UTC || 20);
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUtc, minuteUtc, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    await this.state.storage.setAlarm(next.getTime());
    return next.toISOString();
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
