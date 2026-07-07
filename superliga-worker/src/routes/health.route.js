import { json } from '../utils/http.js';
import { firestoreConfigured } from '../services/firestore.service.js';

export async function healthRoute(request, env) {
  return json({
    ok: true,
    app: env.APP_ID || 'superliga_2026_27',
    env: env.ENVIRONMENT || 'dev',
    firestoreConfigured: firestoreConfigured(env),
    liveScoreConfigured: !!env.LIVE_SCORE_BASE_URL,
    sofaScoreConfigured: !!env.SOFASCORE_BASE_URL,
    liveWriteToFirestore: String(env.LIVE_WRITE_TO_FIRESTORE || 'false') === 'true',
    finalWriteToFirestore: String(env.FINAL_WRITE_TO_FIRESTORE || 'true') === 'true',
    now: new Date().toISOString()
  }, {}, env);
}
