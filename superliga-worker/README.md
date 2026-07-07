# SuperLiga Predictor Worker

Clean Cloudflare Worker skeleton for the SuperLiga predictor.

Core rule copied from the optimized WC26 setup:

```text
LiveScore / event sources -> Cloudflare Worker -> normalized JSON -> frontend
Firestore -> predictions, community, final results, public cache
Durable Object -> refresh coordinator / lock / daily fixture+odds jobs
```

Live score ticks should **not** be written to Firestore every 30 seconds. The hot path is `/live-results`. Final results are written to Firestore only when a match reaches FT/AET/PEN and the hash changed.

## Structure

```text
superliga-worker/
  wrangler.toml
  package.json
  src/
    index.js
    config/
    core/
    data/
    durable/
      update-coordinator.js
    routes/
      admin-refresh.route.js
      odds.route.js
      ...
    services/
      coordinator.service.js
      fixture-refresh.service.js
      odds.service.js
      ...
    sources/
      fixture-refresh-source.js
      livescore-source.js
      odds-source.js
      sofascore-events-source.js
    utils/
```

## Endpoints

```text
GET  /health
GET  /fixtures
GET  /odds
GET  /results
GET  /live-results
GET  /live-results?force=1
GET  /live-results?nosync=1
GET  /community
GET  /sync?force=1                         admin only, immediate live sync
POST /fixtures                              admin only, fixture override
POST /admin/live                            admin only, manual live UI test
DEL  /admin/live                            admin only, clear manual live
POST /admin/refresh?task=daily&force=1      admin only, Durable Object refresh
POST /admin/refresh?task=fixtures&force=1   admin only
POST /admin/refresh?task=odds&force=1       admin only
GET  /admin/coordinator                     admin only, Durable Object state
POST /admin/coordinator/alarm               admin only, arms next DO alarm
```

## Durable Object refresh layer

The Worker now has a single named Durable Object:

```text
UPDATE_COORDINATOR -> UpdateCoordinator("superliga-main")
```

It coordinates background jobs so we do not launch duplicate fixture/odds refreshes from multiple cron/manual calls.

It stores:

```text
coordinator-state
coordinator-lock
fixtures-cache
odds-cache
```

Cron setup in `wrangler.toml`:

```toml
[triggers]
crons = ["*/15 * * * *", "20 2 * * *"]
```

Meaning:

```text
*/15 * * * *  -> lightweight live sync window check
20 2 * * *    -> daily Durable Object refresh: fixtures + odds
```

Cloudflare cron uses UTC. `20 2 * * *` is roughly morning Romania time in summer.



## Live fixture refresh

Fixtures are no longer only hardcoded seed data. `/fixtures` starts from `src/data/fixtures.js`, then overlays:

```text
1. Firestore public fixture cache, if configured
2. Durable Object fixture cache, if available
3. Manual fixture override collection
4. Static seed fallback
```

The default fixture source is LPF round pages:

```toml
FIXTURE_SOURCE_URL = "https://lpf.ro/etape-liga-1/{round}"
```

Manual refresh examples:

```bash
curl -X POST "WORKER_URL/admin/refresh?task=fixtures&round=1&force=1&secret=ADMIN_SECRET"
curl -X POST "WORKER_URL/admin/refresh?task=fixtures&force=1&secret=ADMIN_SECRET"
```

`round=1` refreshes only one round. Without `round`, the Worker refreshes all regular-season rounds 1-30.

## Firestore collections

```text
superliga_users_v1
superliga_predictions_v1
superliga_community_predictions_v1
superliga_match_results_v1
superliga_live_matches_v1           legacy/off by default
superliga_fixture_overrides_v1
superliga_match_odds_v1
superliga_team_elo_v1
superliga_public_cache_v1
```

## Wrangler / Cloudflare setup

Deploy:

```bash
cd superliga-worker
npm install
npm run check
npx wrangler deploy
```

Important: this project uses a Durable Object migration:

```toml
[[durable_objects.bindings]]
name = "UPDATE_COORDINATOR"
class_name = "UpdateCoordinator"

[[migrations]]
tag = "v1-update-coordinator"
new_sqlite_classes = ["UpdateCoordinator"]
```

Do not delete old migration tags later. If we add another Durable Object class, add a new migration tag.

Set secrets:

```bash
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put ADMIN_SECRET
```

`FIREBASE_PRIVATE_KEY` can be pasted with `\n` escapes. Do not commit it.

## Source URLs

These are intentionally empty until we inspect the exact XHR endpoints.

```toml
LIVE_SCORE_BASE_URL = ""
SOFASCORE_BASE_URL = ""
FIXTURE_SOURCE_URL = "https://lpf.ro/etape-liga-1/{round}"
ODDS_SOURCE_URL = ""
```

Expected generic source shapes are flexible.

`FIXTURE_SOURCE_URL` can return:

```text
[]
{ fixtures: [] }
{ matches: [] }
{ events: [] }
{ data: { fixtures: [] } }
{ Stages: [{ Events: [] }] }
```

`ODDS_SOURCE_URL` can return:

```text
[]
{ odds: [] }
{ matches: [] }
{ events: [] }
{ results: [] }
```

The adapters map by direct source id first, then fuzzy home/away names. Once we inspect the exact LiveScore/Oddspedia/etc. XHR shape, only `src/sources/*.js` should change.

## Manual refresh tests after deploy

```bash
curl.exe -X POST "https://YOUR-WORKER.workers.dev/admin/refresh?task=fixtures&force=1&secret=YOUR_SECRET"
curl.exe -X POST "https://YOUR-WORKER.workers.dev/admin/refresh?task=odds&force=1&secret=YOUR_SECRET"
curl.exe -X POST "https://YOUR-WORKER.workers.dev/admin/refresh?task=daily&force=1&secret=YOUR_SECRET"
```

State:

```text
https://YOUR-WORKER.workers.dev/admin/coordinator?secret=YOUR_SECRET
```

Odds:

```text
https://YOUR-WORKER.workers.dev/odds
```

Fixtures:

```text
https://YOUR-WORKER.workers.dev/fixtures
```

## Manual live UI test

This lets the frontend show WC26-style live states before real fixtures are live.

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/admin/live?secret=YOUR_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "results": {
      "m3": {
        "started": true,
        "finished": false,
        "status": "LIVE",
        "minute": "63'",
        "h": 2,
        "a": 1,
        "scorers": [
          {"team":"h","minute":"12'","player":"Nistor"},
          {"team":"a","minute":"44'","player":"Larie","penalty":true},
          {"team":"h","minute":"61'","player":"Lukic"}
        ],
        "redCards": [
          {"team":"a","minute":"70'","player":"Popescu","red":true}
        ]
      }
    }
  }'
```

Then call:

```text
https://YOUR-WORKER.workers.dev/live-results?nosync=1
```

Frontend integration:

```html
<script>
  window.SUPERLIGA_RESULTS_READ_URL = 'https://YOUR-WORKER.workers.dev/results';
  window.SUPERLIGA_RESULTS_SYNC_URL = 'https://YOUR-WORKER.workers.dev/live-results';
  window.SUPERLIGA_ODDS_URL = 'https://YOUR-WORKER.workers.dev/odds';
</script>
```

## Cost-saving behavior

- `/live-results` uses Worker memory + source polling; not Firestore hot writes.
- Final results go to `superliga_match_results_v1` only after FT/AET/PEN and only when hash changed.
- Durable Object daily jobs write fixture/odds public cache only when needed.
- `UPDATE_COORDINATOR` prevents duplicate refreshes.
- `/results`, `/fixtures`, and `/odds` read public cache/collection rather than every live tick.

## Fixture source note

`/fixtures` currently returns `src/data/fixtures.js` plus optional Firestore/public-cache overrides. The generated seed follows the official regular-season draw; round 1 has been manually refreshed with the announced exact dates/times.

Round 1 exact kickoff update:
- 17 iul. 18:30 FC Voluntari - FC Botoșani
- 17 iul. 21:30 FCSB - FC Argeș
- 18 iul. 18:30 Oțelul Galați - CFR Cluj
- 18 iul. 21:15 Universitatea Craiova - UTA Arad
- 19 iul. 17:00 Universitatea Cluj - Farul Constanța
- 19 iul. 19:30 Petrolul Ploiești - Dinamo
- 20 iul. 18:30 Corvinul Hunedoara - FK Csikszereda
- 20 iul. 21:30 Rapid București - Sepsi OSK


## Live score source test

A live hot path nem Firebase-ből jön, hanem a Worker `/live-results` endpointjából. A score-master adapter alapból a LiveScore Romania Liga 1 oldalt próbálja olvasni, és támogatja a LiveScore `Stages[].Events[]` JSON/XHR alakot is.

Admin diagnosztika deploy után:

```bat
curl.exe "WORKER_URL/admin/source-test?source=livescore&force=1&all=1&secret=ADMIN_SECRET"
```

Ha egy konkrét nem hivatalos XHR URL-t akarsz kipróbálni anélkül, hogy átírnád a `wrangler.toml`-t:

```bat
curl.exe "WORKER_URL/admin/source-test?source=livescore&force=1&all=1&secret=ADMIN_SECRET&url=ENCODED_URL"
```

A frontend továbbra is csak ezt fogyasztja:

```text
GET WORKER_URL/live-results
```

A LiveScore adapter csak score/percnt/státusz master. Gólszerzők/lapok továbbra is event-master adapterből jönnek később, pl. SofaScore incident endpointból, vagy manual override-ból tesztelésre.

## 2026-07 live/boot parity update

Ported the useful WC26 production ideas without copying the debug junk:

- `GET /bootstrap-light` returns a public startup bundle: fixtures + final results + fast live memory + odds cache.
- `GET /live-results?fast=1` returns memory-only live data immediately, with no provider call.
- `GET /live-results?fresh=1&live=1` forces the real live sync path and bypasses edge cache.
- Public `/results`, `/fixtures`, `/odds`, `/community`, `/bootstrap-light` now use Cloudflare edge cache wrappers.
- LiveScore source now prefers `prod-public-api.livescore.com/v1/api/app` with the WC26-style `x-fsign` header and date endpoints, then falls back to the public league page parser.
- LiveScore incident detail probing is available for goals/cards when the event payload exposes an event id; SofaScore remains the dedicated event-master path when `sofascoreId` mapping exists.

Useful production tests:

```bat
curl.exe "WORKER_URL/bootstrap-light"
curl.exe "WORKER_URL/live-results?fast=1"
curl.exe "WORKER_URL/live-results?fresh=1&live=1"
curl.exe "WORKER_URL/admin/source-test?source=livescore&force=1&all=1&secret=ADMIN_SECRET"
```

## SofaScore event-master adapter

A Worker most már külön SofaScore eseményforrást is tartalmaz:

- `src/sources/sofascore-events-source.js`
- score továbbra is LiveScore-first marad;
- SofaScore célja: gólszerzők, sárgák, pirosak, dupla sárgák;
- meccsazonosítás: saját fixture `id` → SofaScore `eventId` a scheduled-events endpointból, név + dátum fuzzy mappinggel;
- incident endpoint: `/event/{eventId}/incidents`.

Teszt:

```bat
curl.exe "WORKER_URL/admin/source-test?source=sofascore&date=2026-07-17&force=1&scheduled=1&secret=ADMIN_SECRET"
```

Csak konkrét meccs:

```bat
curl.exe "WORKER_URL/admin/source-test?source=sofascore&ids=m5&force=1&scheduled=1&secret=ADMIN_SECRET"
```

Csak forduló:

```bat
curl.exe "WORKER_URL/admin/source-test?source=sofascore&round=1&force=1&scheduled=1&secret=ADMIN_SECRET"
```

A `/live-results` automatikusan összeolvasztja:

```text
LiveScore   -> score / perc / státusz
SofaScore   -> scorers / yellowCards / redCards / doubleYellowCards
```

Ha SofaScore nem ad eseményt, a live score attól még nem hal meg.

## Odds + weekly TM/Elo refresh

Romanian SuperLiga odds are now attempted through a generic Odds adapter with Oddspedia-first defaults:

```text
GET /odds
POST /admin/refresh?task=odds&force=1&secret=ADMIN_SECRET
GET /admin/source-test?source=odds&round=1&force=1&secret=ADMIN_SECRET
GET /admin/source-test?source=odds&date=2026-07-17&force=1&secret=ADMIN_SECRET
```

The default odds probes are:

```text
https://oddspedia.com/api/v1/getMaxOddsWithPagination?...league=liga-1&category=romania&date={date}
https://oddspedia.com/api/v1/getMatchPoll?...league=liga-1&category=romania&date={date}
```

If we discover a cleaner XHR, set it in `ODDSPEDIA_SOURCE_URL` or `ODDS_SOURCE_URL`. Use `{date}` in the URL template.

Team model inputs have a weekly refresh layer:

```text
GET /team-ratings      -> Elo + Transfermarkt market values
GET /elo               -> Elo only
GET /market-values     -> Transfermarkt market values only
POST /admin/refresh?task=ratings&force=1&secret=ADMIN_SECRET
POST /admin/refresh?task=weekly&force=1&secret=ADMIN_SECRET
GET /admin/source-test?source=clubelo&force=1&secret=ADMIN_SECRET
GET /admin/source-test?source=transfermarkt&force=1&secret=ADMIN_SECRET
```

Cron:

```toml
crons = ["*/15 * * * *", "20 2 * * *", "0 7 * * 3"]
```

`0 7 * * 3` is Wednesday 07:00 UTC, which is 10:00 Romania time during the summer part of the season. If exact winter DST accuracy matters later, run an hourly Wednesday cron and gate it with `Europe/Bucharest` local time in code.

Data is saved to:

```text
superliga_public_cache_v1/team_ratings
superliga_public_cache_v1/elo
superliga_public_cache_v1/market_values
superliga_team_elo_v1/{team}
superliga_team_market_values_v1/{team}
```

When a match becomes final, `writeFinalIfChanged()` freezes a `modelSnapshot` into the final result document:

```json
{
  "modelSnapshot": {
    "frozenAt": "...",
    "odds": { "h": 2.1, "d": 3.2, "a": 3.5 },
    "homeElo": 1515,
    "awayElo": 1535,
    "homeMarketValueM": 22,
    "awayMarketValueM": 25
  }
}
```

That means later weekly TM/Elo refreshes do **not** rewrite the model inputs of already-finished matches. Future matches get the latest model values; finished matches keep the snapshot they had at finalization time.
