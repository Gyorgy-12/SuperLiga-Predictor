import { getMemory } from './memory-cache.service.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

export function firestoreConfigured(env) {
  return !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}

export async function getDocument(env, collection, id) {
  if (!firestoreConfigured(env)) return null;
  const url = docUrl(env, collection, id);
  const res = await firebaseFetch(env, url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get ${collection}/${id} failed: ${res.status}`);
  return fromFirestoreDocument(await res.json());
}

export async function listDocuments(env, collection, { pageSize = 300 } = {}) {
  if (!firestoreConfigured(env)) return [];
  const url = `${baseUrl(env)}/${encodeURIComponent(collection)}?pageSize=${pageSize}`;
  const res = await firebaseFetch(env, url);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Firestore list ${collection} failed: ${res.status}`);
  const data = await res.json();
  return (data.documents || []).map(fromFirestoreDocument).filter(Boolean);
}

export async function patchDocument(env, collection, id, data) {
  if (!firestoreConfigured(env)) return { skipped: true, reason: 'firestore_not_configured' };
  const url = docUrl(env, collection, id);
  const body = JSON.stringify({ fields: toFirestoreFields(data) });
  const res = await firebaseFetch(env, url, { method: 'PATCH', body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore patch ${collection}/${id} failed: ${res.status} ${text}`);
  }
  return fromFirestoreDocument(await res.json());
}

export async function deleteDocument(env, collection, id) {
  if (!firestoreConfigured(env)) return { skipped: true, reason: 'firestore_not_configured' };
  const res = await firebaseFetch(env, docUrl(env, collection, id), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore delete ${collection}/${id} failed: ${res.status}`);
  return { ok: true };
}

async function firebaseFetch(env, url, init = {}) {
  const token = await accessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(url, { ...init, headers });
}

function baseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

function docUrl(env, collection, id) {
  return `${baseUrl(env)}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

async function accessToken(env) {
  const mem = getMemory();
  const now = Date.now();
  if (mem.accessToken && mem.accessTokenExpiresAt > now + 60_000) return mem.accessToken;
  const jwt = await signJwt(env);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if (!res.ok) throw new Error(`OAuth token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  mem.accessToken = data.access_token;
  mem.accessTokenExpiresAt = now + Math.max(60, data.expires_in || 3600) * 1000;
  return mem.accessToken;
}

async function signJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64urlBytes(sig)}`;
}

async function importPrivateKey(privateKeyInput) {
  const normalized = normalizePrivateKeyInput(privateKeyInput);
  const b64 = extractPkcs8Base64(normalized);

  let raw;
  try {
    raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch (error) {
    throw new Error(
      'Firebase private key is not valid PKCS8 PEM/base64. Re-save FIREBASE_PRIVATE_KEY as the service account private_key value, not the whole JSON file. ' +
      `Details: ${error?.message || String(error)}`
    );
  }

  return crypto.subtle.importKey(
    'pkcs8',
    raw.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function normalizePrivateKeyInput(input) {
  let value = String(input || '').trim();

  // Wrangler sometimes stores pasted strings with surrounding quotes.
  value = stripWrappingQuotes(value).trim();

  // Accept either the raw private_key value or the whole service-account JSON.
  const parsed = tryParseJsonish(value);
  if (parsed && typeof parsed === 'object' && parsed.private_key) {
    value = String(parsed.private_key || '').trim();
  } else if (typeof parsed === 'string') {
    value = parsed.trim();
  }

  value = stripWrappingQuotes(value).trim();
  value = value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Accept base64 encoded full PEM as a secret too.
  if (!value.includes('BEGIN PRIVATE KEY') && looksLikeBase64(value)) {
    const decoded = safeAtobToString(value);
    if (decoded && decoded.includes('BEGIN PRIVATE KEY')) {
      value = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    }
  }

  return value;
}

function extractPkcs8Base64(value) {
  const pem = String(value || '').trim();

  if (pem.includes('BEGIN PRIVATE KEY')) {
    return pem
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  // Accept raw PKCS8 base64 body without PEM headers.
  return pem.replace(/\s+/g, '').trim();
}

function stripWrappingQuotes(value) {
  let out = String(value || '').trim();
  for (let i = 0; i < 2; i += 1) {
    if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
      out = out.slice(1, -1).trim();
    }
  }
  return out;
}

function tryParseJsonish(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const variants = [raw];
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    variants.push(raw.slice(1, -1));
  }
  for (const variant of variants) {
    try {
      return JSON.parse(variant);
    } catch {}
  }
  return null;
}

function looksLikeBase64(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  return compact.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function safeAtobToString(value) {
  try {
    return atob(String(value || '').replace(/\s+/g, ''));
  } catch {
    return null;
  }
}

function b64urlJson(obj) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64urlBytes(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toFirestoreFields(obj = {}) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toFirestoreValue(v)]));
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'object') return { mapValue: { fields: toFirestoreFields(value) } };
  return { stringValue: String(value) };
}

function fromFirestoreDocument(doc) {
  if (!doc) return null;
  const id = String(doc.name || '').split('/').pop();
  return { id, ...fromFirestoreFields(doc.fields || {}), _name: doc.name, _createTime: doc.createTime, _updateTime: doc.updateTime };
}

function fromFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromFirestoreValue(v)]));
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}
