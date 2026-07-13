export function coordinatorStub(env) {
  if (!env.UPDATE_COORDINATOR) return null;
  const id = env.UPDATE_COORDINATOR.idFromName(env.COORDINATOR_NAME || 'superliga-main');
  return env.UPDATE_COORDINATOR.get(id);
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

export async function coordinatorRatingsCache(env) {
  const data = await coordinatorFetchJson(env, '/ratings-cache');
  return data?.ratings || data?.marketValues ? data : null;
}
