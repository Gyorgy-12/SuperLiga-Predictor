import { json, requireAdmin, unauthorized } from '../utils/http.js';
import { runCoordinator, coordinatorState, armCoordinatorAlarm } from '../services/coordinator.service.js';

export async function adminRefreshRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);
  const url = new URL(request.url);
  const task = url.searchParams.get('task') || 'daily';
  const force = url.searchParams.get('force') === '1';
  const round = url.searchParams.get('round') || null;
  const result = await runCoordinator(env, task, { force, round });
  return json(result, {}, env);
}

export async function coordinatorStateRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);
  const state = await coordinatorState(env);
  return json(state, {}, env);
}

export async function coordinatorAlarmRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);
  const result = await armCoordinatorAlarm(env);
  return json(result, {}, env);
}
