import { json, requireAdmin, unauthorized } from '../utils/http.js';
import { syncLive } from '../services/sync.service.js';

export async function syncRoute(request, env) {
  const url = new URL(request.url);
  const fromCron = request.headers.get('x-superliga-cron') === '1';
  const manualOk = requireAdmin(request, env);
  if (!fromCron && !manualOk) return unauthorized(env);

  const pack = await syncLive(env, {
    force: url.searchParams.get('force') === '1',
    date: url.searchParams.get('date') || undefined
  });
  return json(pack, {}, env);
}
