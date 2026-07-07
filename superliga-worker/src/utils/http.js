import { corsHeaders } from '../config/cors.js';

export function json(data, init = {}, env = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function text(body, init = {}, env = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'text/plain; charset=utf-8');
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(body, { ...init, headers });
}

export function notFound(env) {
  return json({ ok: false, error: 'not_found' }, { status: 404 }, env);
}

export function badRequest(message, env) {
  return json({ ok: false, error: 'bad_request', message }, { status: 400 }, env);
}

export function unauthorized(env) {
  return json({ ok: false, error: 'unauthorized' }, { status: 401 }, env);
}

export async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) return null;
  return request.json().catch(() => null);
}

export function requireAdmin(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) return false;
  const got = request.headers.get('x-admin-secret') || new URL(request.url).searchParams.get('secret') || '';
  return got && got === secret;
}
