# SuperLiga Predictor – gyors bekötési lépések

## 1. Repo root struktúra

A ZIP tartalmát közvetlenül a repo rootba másold/kicsomagold, hogy így nézzen ki:

```text
SuperLiga-Predictor/
  index.html
  README.md
  FIREBASE_SETUP.md
  SETUP_STEPS_HU.md
  package.json
  firebase/
  src/
  superliga-worker/
```

## 2. Frontend Firebase config

Nyisd meg:

```text
src/data/firebase-config.js
```

Töltsd ki:

```js
window.SUPERLIGA_WORKER_URL = 'https://A-TE-WORKERED.workers.dev';

window.SUPERLIGA_FIREBASE_CONFIG = {
  apiKey: '...',
  authDomain: '...',
  projectId: '...',
  storageBucket: '...',
  messagingSenderId: '...',
  appId: '...'
};
```

## 3. Firestore rules / indexes deploy

```bat
cd firebase
npx firebase-tools login
npx firebase-tools use --add
npx firebase-tools deploy --only firestore:rules,firestore:indexes
```

## 4. Worker secretök

```bat
cd ..\superliga-worker
npx wrangler login
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

A `FIREBASE_PRIVATE_KEY` legyen egy sorban, `\n` escape-ekkel.

## 5. Worker deploy

```bat
npx wrangler deploy
```

A kapott URL-t írd vissza ide:

```text
src/data/firebase-config.js
```

## 6. Frontend teszt

Repo rootból:

```bat
python -m http.server 5173
```

Böngésző:

```text
http://localhost:5173
```

## 7. Worker teszt endpointok

```text
WORKER_URL/health
WORKER_URL/bootstrap-light
WORKER_URL/fixtures
WORKER_URL/results
WORKER_URL/live-results?fast=1
WORKER_URL/odds
WORKER_URL/team-ratings
```

Admin teszt:

```bat
curl.exe -X POST "WORKER_URL/admin/refresh?task=fixtures&force=1&secret=ADMIN_SECRET"
curl.exe -X POST "WORKER_URL/admin/refresh?task=odds&force=1&secret=ADMIN_SECRET"
curl.exe -X POST "WORKER_URL/admin/refresh?task=ratings&force=1&secret=ADMIN_SECRET"
```

## 8. Fontos logika

- Élő score/percek: Worker `/live-results`, nem Firestore spam.
- Tippek/community: Firebase frontendből.
- Végleges eredmények, odds, Elo, Transfermarkt MV cache: Worker + Firestore/cache.
- Lezárt meccsnél a modelladat snapshot befagy, későbbi Elo/TM frissítés nem írja át a múltbeli meccset.
