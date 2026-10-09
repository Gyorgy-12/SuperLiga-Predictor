# SuperLiga Predictor Worker

The Cloudflare Worker normalizes fixture, live-score, event, odds, team-rating, and Liga 2 data for the frontend. Firestore stores final results and public caches, while a Durable Object coordinates scheduled refreshes.

## Setup

```bash
npm install
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put ADMIN_SECRET
```

Do not commit secret values. Keep existing Durable Object migration tags in `wrangler.toml` unchanged.

## Validation and deployment

```bash
npm run check
npm test
npm run build
npm run deploy
```

## Public endpoints

```text
GET /health
GET /bootstrap-light
GET /fixtures
GET /results
GET /live-results
GET /odds
GET /team-ratings
GET /liga2-standings
GET /community
```

Administrative routes require `ADMIN_SECRET`.

## Data rules

- LPF is the primary source for fixture dates and kickoff times.
- Live updates stay on the Worker hot path and are not written to Firestore on every tick.
- Final results are written only after FT, AET, or penalties and only when their fingerprint changes.
- Elo and Transfermarkt values are frozen with the final result and are not changed by later rating refreshes.
- The local fixture dataset is a fallback; Worker fixture data overrides it at runtime.
