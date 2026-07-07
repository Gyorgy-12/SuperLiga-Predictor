# SuperLiga Predictor Frontend

A refactored, multi-file frontend version of the former one-file SuperLiga predictor HTML app.
There is no build step and no required backend for basic usage: `index.html` loads the CSS and JavaScript modules as a plain static page.

## Root-ready layout

This package is prepared so `index.html` can live directly in your project root.
The clean structure is:

```text
SuperLiga Predictor/
  index.html
  README.md
  package.json
  ROOT_SETUP.txt
  src/
    app/
    core/
    data/
    services/
    styles/
    ui/
    views/
```

Important:

- `index.html` and `src/` must be in the same root folder.
- Do not use a nested layout like `SuperLiga Predictor/superliga-predictor-frontend/src` unless you also rewrite every relative path.
- Keep `superliga-worker/` as a separate project folder, not inside the frontend `src/` folder.

## Running locally

From the frontend root:

```bash
cd "SuperLiga Predictor"
python -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

Firebase / Google login requires `http://` or `https://`. Local predictions still work in `file://` mode, but Google login will not.

## Worker connection

The app supports a WC26-style public worker boot path. Set one base URL before the app scripts load:

```html
<script>
  window.SUPERLIGA_WORKER_URL = 'https://YOUR-WORKER.workers.dev';
</script>
```

The frontend derives these endpoints automatically:

```text
/results
/live-results
/bootstrap-light
/fixtures
/odds
/team-ratings
```

Explicit endpoint overrides still work:

```html
<script>
  window.SUPERLIGA_RESULTS_READ_URL = 'https://YOUR-WORKER.workers.dev/results';
  window.SUPERLIGA_RESULTS_SYNC_URL = 'https://YOUR-WORKER.workers.dev/live-results';
  window.SUPERLIGA_BOOTSTRAP_LIGHT_URL = 'https://YOUR-WORKER.workers.dev/bootstrap-light';
</script>
```

## Architecture

```text
src/
  data/
    league-config.js          league data, teams, app/service config, global state defaults
    fixtures.js               regular-season fixture seed
  core/
    predictions-store.js      localStorage/Firebase bridge, frozen snapshots, KO cleanup
    standings-engine.js       standings, points, fair play, form handling
    stats-export.js           stats aggregation + static HTML export
    postseason-engine.js      playoff/playout/baraj generation
  services/
    community-firebase.js     lazy Firebase auth, community leaderboard, efficient autosave
    live-results.js           live-result normalization, worker sync, bootstrap-light handling
  ui/
    dom-utils.js              escaping, validScore, crests, logo fallback, small UI helpers
  views/
    overview-table.view.js    overview and standings rendering
    stat-cards.view.js        goal/card/top-match stat cards
    matches-postseason-stats.view.js  matches, postseason, baraj and stats rendering
    match-modal.view.js       WC26-style match modal rendering
  app/
    bootstrap.js              router, tabs, controls, resize/scroll sync, render scheduler
  styles/
    main.css                  CSS import order
    00-...09-...css           role-based style blocks
```

## Firebase-efficient behavior

- **Lazy SDK loading:** Firebase SDK is not loaded at boot. It loads only on the Community tab or during Google sign-in.
- **Deduped autosave:** predictions are saved using a stable hash. If nothing changed, there is no Firestore write.
- **Debounced writes:** predictions are saved after a short delay, so every small input does not become a separate write.
- **Self-prediction protection:** if remote prediction loading fails, the app does not blindly overwrite the database with an empty/local state.
- **Community listener only on the tab:** the realtime leaderboard listener is active only while the Community tab is open.
- **TTL leaderboard read:** one-shot leaderboard reads use a cache window.
- **Live results do not use Firestore as the hot path:** the frontend reads live state from the Worker. Firebase is for predictions, community, final results and cached/public snapshots.

## Live-result flow

The shared live UI follows the optimized WC26 behavior where possible:

```text
LiveScore / SofaScore / manual source
        ↓
Cloudflare Worker
        ↓
/live-results
        ↓
frontend poll / bootstrap-light
        ↓
WC26-style live match cards, modal and table state
```

Current live behavior:

- match rows use the WC26 `live-locked` / result-class flow;
- live score rendering uses the WC26 score compare stack and clock/status pills;
- match modals use the same sheet state classes and below-score clock/event layout;
- regular-season table rows use WC26-style `live-team` highlighting;
- the Table tab also has a compact SuperLiga-specific live standings impact panel;
- playoff/playout live table overlays are intentionally not enabled yet.

## Odds, ELO and market-value data

The frontend can consume these from the Worker when available:

```text
/odds
/team-ratings
/market-values
/bootstrap-light
```

The match modal uses the latest available model data for upcoming/live matches. Finished matches should rely on the Worker-provided frozen `modelSnapshot`, so later ELO or Transfermarkt updates do not rewrite the context of already-finished matches.

## Team-name policy

Team naming is centralized through `teamNameFor(name, context)`.

- Full standings view uses full team names on both desktop and mobile.
- Compact/table/form views use shorter names where needed.
- Match cards, match modals and top-match stats use full names on desktop and short names on mobile.
- The app rerenders on breakpoint changes so the correct naming policy stays in sync with the current layout.

## Regular-season table zones

The regular-season table uses only two top-level sections:

```text
Top 6 → playoff
7-16 → playout
```

Playoff/playout tables only show zone labels where the position actually matters. Empty mid-table segments do not get decorative blocks or meaningless meta text.

## Playoff / playout rules implemented

- Regular-season points are halved before the playoff/playout stage.
- Halved points are rounded up.
- Teams that finished the regular season with an odd point total are marked with `*`.
- Starred teams lose tie priority against non-starred teams after the point-halving rule.
- Playoff 3rd place qualifies for the ECL baraj final.
- Playoff places 4–6 do not receive a zone marker.

## Baraj tab

The baraj tab keeps the same dark card-based visual language as the rest of the app. It intentionally avoids an over-designed poster/hero style.

It includes:

- ECL baraj path;
- two relegation/promotion baraj ties;
- aggregate context;
- direct relegation tiles;
- Liga 2 promotion information.

Baraj match cards use the same central match-modal opening flow as all other match cards.

## Responsive polish notes

- The control strip is fixed below the red header through `#ctrlWrap`.
- Main content receives `--ctrl-h` padding so cards remain scrollable and are not hidden under the controls.
- Dropdowns remain above cards and stay clickable inside the fixed control layer.
- The season summary is compact on mobile/tablet.
- Home/away filters rerank standings by the filtered points.
- The form view recalculates W/D/L boxes for the selected all/home/away filter.

## Validation

From the frontend root:

```bash
for f in src/**/*.js; do node --check "$f"; done
cat $(cat src/app.order.txt) > /tmp/superliga-bundle.js && node --check /tmp/superliga-bundle.js
```

## Change summary

This root-ready package includes the latest SuperLiga frontend work:

- multi-file architecture instead of one large HTML file;
- WC26-style match modal and live-state behavior;
- Worker bootstrap-light support;
- live match cards, live modal state and regular-season live table impact panel;
- responsive table/match/card tuning;
- centralized team-name handling;
- simplified and meaningful table zone labels;
- cleaner baraj tab;
- Firebase-efficient autosave and community logic;
- support for Worker-provided fixtures, odds, ELO and market values.

## Firebase setup files

This package now includes Firebase-ready project files:

```text
src/data/firebase-config.js      frontend Firebase + Worker config
firebase/firestore.rules        public/private Firestore rule split
firebase/firestore.indexes.json community ordering index
firebase/firebase.json          optional Firebase Hosting / Firestore deploy config
FIREBASE_SETUP.md               step-by-step Firebase checklist
```

The recommended setup is:

```text
Frontend Firebase SDK:
  Google Auth
  user profile document
  private user prediction document
  public community prediction document
  optional direct public Firestore fallback

Cloudflare Worker with service account:
  final match results
  fixture cache / overrides
  odds cache
  Elo + Transfermarkt market-value cache
  public bootstrap-light cache
```

Keep live scores on the Worker hot path. Do not make the browser listen to Firestore every 30 seconds for live scores.
