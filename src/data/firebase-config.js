// SuperLiga Predictor frontend runtime config.
// Firebase web config is public by design. Never put service-account secrets here.

window.SUPERLIGA_WORKER_URL =
  window.SUPERLIGA_WORKER_URL ||
  'https://superliga-predictor-worker.wc26-guesses.workers.dev';

window.SUPERLIGA_FIREBASE_CONFIG = window.SUPERLIGA_FIREBASE_CONFIG || {
  apiKey: 'AIzaSyDB2h_hujTjvHMCryOlRVDNzy9nJl5BF7M',
  authDomain: 'spuerliga-predictor.firebaseapp.com',
  projectId: 'spuerliga-predictor',
  storageBucket: 'spuerliga-predictor.firebasestorage.app',
  messagingSenderId: '679886513608',
  appId: '1:679886513608:web:2e1d03d299b923820d0cfd',
  measurementId: 'G-QGKP2MB4GH'
};

window.SUPERLIGA_FIREBASE_COLLECTIONS =
  window.SUPERLIGA_FIREBASE_COLLECTIONS || {
    community: 'superliga_community_predictions_v1',
    users: 'superliga_users_v1',
    privatePredictions: 'superliga_private_predictions_v1',
    results: 'superliga_match_results_v1',
    fixtures: 'superliga_fixture_overrides_v1',
    odds: 'superliga_match_odds_v1',
    elo: 'superliga_team_elo_v1',
    publicCache: 'superliga_public_cache_v1'
  };
