// Firebase + Worker runtime configuration for the SuperLiga Predictor.
// Edit this file once after extracting the project.
// The public Firebase config is safe to ship in a static frontend. Firestore rules protect writes.

window.SUPERLIGA_WORKER_URL = window.SUPERLIGA_WORKER_URL || '';

window.SUPERLIGA_FIREBASE_CONFIG = window.SUPERLIGA_FIREBASE_CONFIG || {
  apiKey: 'AIzaSyDrq7tIR6TUc645EX7bazv0ggvIlxmoq3A',
  authDomain: 'wc-2026-guesses.firebaseapp.com',
  projectId: 'wc-2026-guesses',
  storageBucket: 'wc-2026-guesses.firebasestorage.app',
  messagingSenderId: '436476011719',
  appId: '1:436476011719:web:3bfb35e7bc9a342454cae2',
  measurementId: 'G-5TZH7BM8GB'
};

window.SUPERLIGA_FIREBASE_COLLECTIONS = window.SUPERLIGA_FIREBASE_COLLECTIONS || {
  users: 'superliga_users_v1',
  privatePredictions: 'superliga_private_predictions_v1',
  community: 'superliga_community_predictions_v1',
  results: 'superliga_match_results_v1',
  fixtures: 'superliga_fixture_overrides_v1',
  odds: 'superliga_match_odds_v1',
  elo: 'superliga_team_elo_v1',
  publicCache: 'superliga_public_cache_v1'
};

// Keep true: when the Worker URL is missing or down, the frontend can still read public
// Firestore final results/ratings if Firestore rules allow public reads.
window.SUPERLIGA_FIREBASE_RESULTS_FALLBACK = window.SUPERLIGA_FIREBASE_RESULTS_FALLBACK !== false;
