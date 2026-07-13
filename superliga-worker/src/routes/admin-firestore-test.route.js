import { COLLECTIONS } from '../config/collections.js';
import { firestoreConfigured, patchDocument, getDocument, deleteDocument } from '../services/firestore.service.js';
import { json, requireAdmin, unauthorized } from '../utils/http.js';

export async function adminFirestoreTestRoute(request, env) {
  if (!requireAdmin(request, env)) return unauthorized(env);

  const url = new URL(request.url);
  const write = url.searchParams.get('write') === '1';
  const docId = '_worker_smoke_test';

  const meta = {
    ok: true,
    configured: firestoreConfigured(env),
    projectId: env.FIREBASE_PROJECT_ID || null,
    clientEmail: maskEmail(env.FIREBASE_CLIENT_EMAIL || ''),
    collection: COLLECTIONS.publicCache,
    docId
  };

  if (!meta.configured) {
    return json({
      ...meta,
      ok: false,
      error: 'firestore_not_configured',
      missing: missingFirestoreEnv(env),
      hint: 'Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY as Wrangler secrets, and keep FIREBASE_PROJECT_ID in wrangler.toml.'
    }, { status: 200 }, env);
  }

  if (!write) {
    return json({
      ...meta,
      mode: 'config_only',
      note: 'Secrets are present. Add ?write=1 to run a real Firestore write/read/delete smoke test.'
    }, {}, env);
  }

  try {
    const payload = {
      kind: 'worker-firestore-smoke-test',
      appId: env.APP_ID || 'superliga_2026_27',
      createdAt: new Date().toISOString(),
      worker: 'superliga-predictor-worker'
    };

    const written = await patchDocument(env, COLLECTIONS.publicCache, docId, payload);
    const readBack = await getDocument(env, COLLECTIONS.publicCache, docId);
    const deleted = await deleteDocument(env, COLLECTIONS.publicCache, docId);

    return json({
      ...meta,
      mode: 'write_read_delete',
      writeOk: !!written && !written.skipped,
      readOk: !!readBack && readBack.kind === payload.kind,
      deleteOk: !!deleted?.ok,
      message: 'Firestore auth + REST read/write/delete works.'
    }, {}, env);
  } catch (error) {
    return json({
      ...meta,
      ok: false,
      mode: 'write_read_delete',
      error: 'firestore_smoke_test_failed',
      message: error?.message || String(error),
      hint: 'Most common causes: private key newlines are broken, the service account lacks Firestore access, or the project ID does not match the service account project.'
    }, { status: 500 }, env);
  }
}

function missingFirestoreEnv(env) {
  return ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !env[k]);
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email ? '***' : null;
  const [name, domain] = email.split('@');
  const head = name.slice(0, 4);
  return `${head}***@${domain}`;
}
