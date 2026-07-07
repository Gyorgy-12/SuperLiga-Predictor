# Firebase setup for SuperLiga Predictor

## 1. Frontend config

Edit:

```text
src/data/firebase-config.js
```

Set your Firebase web config and Worker URL:

```js
window.SUPERLIGA_WORKER_URL = 'https://YOUR-WORKER.workers.dev';
window.SUPERLIGA_FIREBASE_CONFIG = {
  apiKey: '...',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: '...',
  appId: '...'
};
```

The frontend lazily loads Firebase only when it needs it:

- Google sign-in
- own prediction sync
- community leaderboard
- direct public Firestore fallback when the Worker URL is missing

Live score polling still goes through the Cloudflare Worker. Firestore is not used as the 30-second live hot path.

## 2. Firebase Auth

In Firebase Console:

1. Authentication → Sign-in method
2. Enable Google
3. Add your domain under Authorized domains, for example:
   - `localhost`
   - your GitHub Pages / production domain

## 3. Firestore rules

The rules are included in:

```text
firebase/firestore.rules
```

Deploy them from the `firebase` folder:

```bash
cd firebase
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore:rules,firestore:indexes
```

## 4. Cloudflare Worker service account

The Worker writes final results, fixture cache, odds, Elo and public cache through a Firebase service account.

Set these Worker secrets:

```bash
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

The private key should be pasted with escaped newlines (`\n`) if CMD/Windows makes multiline input annoying.

## 5. Collections

Frontend user/community collections:

```text
superliga_users_v1
superliga_private_predictions_v1
superliga_community_predictions_v1
```

Worker/public data collections:

```text
superliga_match_results_v1
superliga_fixture_overrides_v1
superliga_match_odds_v1
superliga_team_elo_v1
superliga_public_cache_v1
```

## 6. Frozen match model snapshots

When a match becomes final, the Worker can store `modelSnapshot` on the match result. That freezes the odds, Elo and Transfermarkt market-value inputs for that match, so later weekly updates do not rewrite the historical model basis.
