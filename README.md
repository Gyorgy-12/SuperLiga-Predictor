# SuperLiga Predictor

A browser-based Romanian SuperLiga prediction app with live scores, standings, playoff/playout simulation, qualification and relegation ties, community predictions, and match statistics.

The frontend has no build step. It loads its JavaScript and CSS files directly from `index.html`. A Cloudflare Worker provides fixtures, live and final results, odds, team ratings, and Liga 2 data.

## Local development

Requirements: Node.js 20 or newer.

```bash
npm install
npm --prefix superliga-worker install
npm run dev
```

Open `http://localhost:5173`.

## Validation

```bash
npm test
npm --prefix superliga-worker run build
```

## Data flow

```text
LPF and match-data providers -> Cloudflare Worker -> frontend
Firestore -> predictions, community data, final results, and public caches
```

Worker fixture data is authoritative. `src/data/fixtures.js` is only an offline fallback.

## Worker deployment

See [`superliga-worker/README.md`](superliga-worker/README.md) for configuration and deployment.
