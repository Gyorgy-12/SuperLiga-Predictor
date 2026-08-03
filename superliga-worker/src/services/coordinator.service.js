export function coordinatorStub(env) {
  if (!env.UPDATE_COORDINATOR) return null;
  return env.UPDATE_COORDINATOR.getByName(env.COORDINATOR_NAME || 'superliga-main');
}

async function coordinatorFetchJson(env, path, init = {}) {
  const stub = coordinatorStub(env);
  if (!stub) return null;
  const res = await stub.fetch(`https://coordinator.local${path}`, init);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function runCoordinator(env, task = 'wake', opts = {}) {
  const stub = coordinatorStub(env);
  if (!stub) return { ok: false, error: 'durable_object_not_bound' };
  const url = new URL('https://coordinator.local/run');
  url.searchParams.set('task', task);
  if (opts.force) url.searchParams.set('force', '1');
  if (opts.round) url.searchParams.set('round', String(opts.round));
  const res = await stub.fetch(url.toString(), { method: 'POST' });
  return res.json().catch(() => ({ ok: false, error: 'coordinator_bad_json' }));
}

export async function coordinatorState(env) {
  const stub = coordinatorStub(env);
  if (!stub) return { ok: false, error: 'durable_object_not_bound' };
  const res = await stub.fetch('https://coordinator.local/state');
  return res.json().catch(() => ({ ok: false, error: 'coordinator_bad_json' }));
}

export async function armCoordinatorAlarm(env) {
  const stub = coordinatorStub(env);
  if (!stub) return { ok: false, error: 'durable_object_not_bound' };
  const res = await stub.fetch('https://coordinator.local/alarm', { method: 'POST' });
  return res.json().catch(() => ({ ok: false, error: 'coordinator_bad_json' }));
}

export async function ensureCoordinatorAlarm(env) {
  const stub = coordinatorStub(env);
  if (!stub) return { ok: false, error: 'durable_object_not_bound' };
  const res = await stub.fetch('https://coordinator.local/ensure-alarm', { method: 'POST' });
  return res.json().catch(() => ({ ok: false, error: 'coordinator_bad_json' }));
}

export async function coordinatorFixtureCache(env) {
  const data = await coordinatorFetchJson(env, '/fixtures-cache');
  return Array.isArray(data?.fixtures) ? data : null;
}

export async function coordinatorOddsCache(env) {
  const data = await coordinatorFetchJson(env, '/odds-cache');
  return data?.odds ? data : null;
}


export async function coordinatorLiveResultsCache(env) {
  const data = await coordinatorFetchJson(env, '/live-results-cache');
  return data?.results && typeof data.results === 'object' ? data : null;
}
export async function coordinatorRatingsCache(env) {
  const data = await coordinatorFetchJson(env, '/ratings-cache');
  const ratingCount = Object.keys(data?.ratings || {}).length;
  const marketCount = Object.keys(data?.marketValues || {}).length;
  return ratingCount > 0 || marketCount > 0 ? data : null;
}
