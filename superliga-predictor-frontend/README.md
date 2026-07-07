# SuperLiga Predictor Frontend

Refaktorált, többfájlos frontend-verzió a korábbi egyfájlos SuperLiga predictor HTML-ből.
Nincs build step, nincs backend-kényszer: az `index.html` sima statikus oldalként tölti be a CSS és JS részmodulokat.

## Indítás

```bash
cd superliga-predictor-frontend
python -m http.server 5173
```

Majd böngészőben: `http://localhost:5173`.

> A közösségi/Firebase login csak `http://` vagy `https://` alatt működik. `file://` módban a lokális tippek működnek, a Google-login nem.

## Architektúra

```text
src/
  data/
    league-config.js          ligaadatok, csapatok, app/service config, globális state alapok
    fixtures.js               alapszakasz-meccsnaptár
  core/
    predictions-store.js      tippek localStorage/Firebase bridge, frozen snapshot, KO cleanup
    standings-engine.js       tabella, pontszámítás, fair play, formák
    stats-export.js           statisztikai aggregálás + statikus HTML export
    postseason-engine.js      playoff/playout/baraj generálás
  services/
    community-firebase.js     lazy Firebase auth + közösségi ranglista + takarékos autosave
    live-results.js           élő eredmény normalizálás + időablakos szinkron
  ui/
    dom-utils.js              escape, validScore, crest, logó fallback, kis UI helper-ek
  views/
    overview-table.view.js    áttekintés + tabella render
    stat-cards.view.js        gól/kártya/top meccsek kártyái
    matches-postseason-stats.view.js  meccsek, KO, baraj, statisztikák render
  app/
    bootstrap.js              router, tabok, kontrollok, resize/scroll sync, render scheduler
  styles/
    main.css                  CSS betöltési sorrend
    00-...07-...css           szerepkör szerinti stílusblokkok
```

## Firebase takarékos logika

- **Lazy SDK loading:** a Firebase SDK nem töltődik be automatikusan bootkor. Csak community tabon vagy Google-belépéskor indul.
- **Deduped autosave:** a tippek stabil hash alapján kerülnek mentésre. Ha nincs valódi változás, nincs Firestore write.
- **Debounced write:** tippelés után rövid autosave késleltetés van, hogy ne minden apró inputból legyen külön write.
- **Saját tipp védelme:** ha a saját remote tippek betöltése hibázik, az app nem ír rá vakon üres/lokális állapottal az adatbázisra.
- **Community listener csak tabon:** a ranglista realtime listener csak a Közösség fülön él; más fülre váltva lekapcsol.
- **TTL-es ranglista read:** a one-shot ranglista olvasás 60 másodperces cache-ablakot használ.
- **Élő eredmény polling csak meccsablakban:** alapesetben csak a kezdés előtti 5 perctől a kezdés utáni 140 percig szinkronizál percenként; azon kívül ritkán vagy a következő releváns ablakig vár.

## Névterek

A korábbi `WC26_*` / `wc26*` maradványok ki lettek szedve. A konfiguráció és service-réteg `SUPERLIGA_*` konstansokat, illetve `superliga*` függvény/állapotneveket használ.

## Ellenőrzés

```bash
for f in src/**/*.js; do node --check "$f"; done
cat $(cat src/app.order.txt) > /tmp/superliga-bundle.js && node --check /tmp/superliga-bundle.js
```

## 2026-07-05 pixel parity pass

- Match tip modal now reuses the WC26-style model block: team ELO pills, TM market-value pills and the `Modellezett esélyek` probability card are always rendered when both teams are known.
- Probability fallback mirrors WC26: if backend odds exist, normalized market odds are blended 70/30 with the ELO + squad-value model; otherwise the local model is used.
- SuperLiga match cards and modal team labels use the same short-name policy as the compact standings view, so `Universitatea Cluj` renders as `U. Cluj` in narrow card/modal slots.
- Static SuperLiga ELO / squad-value seed data lives in `src/data/league-config.js`; live backend ELO can still override it later without extra reads.


## 2026-07-05 modalGoalRows / stage-label javítás

- `modalGoalRows` helper visszakerült a WC26-kompatibilis modal flow-ba, így a meccskártyák kattintása nem dob ReferenceError-t.
- A top meccs-statisztikákban az `undefined` helyett Alapszakasz / Play-off / Play-out / Baraj jelző jelenik meg.
- Az alapszakasz tabella zónázása egyszerűsítve: Top 6 → playoff, 7-16 → playout.

## 2026-07-05 table polish
- Regular-season table now keeps only the inline stage labels: `Top 6 → playoff` and `7-16 → playout`; duplicated bottom legend/footer text was removed.
- Table stage labels were enlarged for desktop readability.
- Playoff/playout tables now show only one bottom meta block with post-halving points.
- Teams that finished the regular season on an odd point total are marked with `*`; they lose tied ranking priority against non-starred teams after halving.


## 2026-07-05 polish kör

- Playoff/playout tabellákon csak a tényleges jelentéssel bíró zónák kapnak színes blokkot és meta szöveget.
- Üres, pusztán középmezőnyös helyeknél nincs bal oldali blokk és nincs felesleges zónacím.
- Baraj fül új, kártyás layoutot kapott: ECL-baraj, két bentmaradás-baraj párharc, közvetlen kiesők és Liga 2 feljutási infó külön blokkokban.
- A baraj meccskártyák továbbra is ugyanazt a központi meccsmodal nyitási flow-t használják.
- Playoff zóna javítás: a 3. hely az ECL-baraj döntő résztvevője, a 4–6. hely nem kap zónajelölést.
- Baraj logika javítás: az ECL-baraj döntőben a playoff 3. helyezettje szerepel.

## 2026-07-05 mobile controls + playoff/playout dropdown

- A tabella felső `Végleges / aktuális` round selectora mobilon keskenyebb, hogy az `Összes / Hazai / Idegen` gombok és a nézetváltó ikon egy sorban maradjanak.
- A Playoff / Playout fülön ugyanaz a selector már nem az alapszakasz 1-30. fordulóit listázza, hanem külön rájátszás-logikát:
  - `Aktuális`
  - `Felezés után`
  - `Rájátszás 1-10. ford. után`
- A rájátszás tabella ezeket a cutoffokat ténylegesen figyelembe veszi: `Felezés után` csak a felezett indulópontokat mutatja, a fordulós opciók pedig csak az adott playoff/playout körig számolnak.

## 2026-07-05 stats round grouping cleanup

- A statisztikák `Hatékonyság fordulónként` blokkja már nem bontja külön `Playoff X. forduló` és `Playout X. forduló` kártyákra a rájátszást.
- A playoff és playout azonos sorszámú körei egy közös `Rájátszás X. forduló` kártyába kerülnek.
- A baraj és ECL-baraj meccsek továbbra is külön eseménykártyák maradnak, mert ott tényleg más a versenyhelyzet.

## 2026-07-05 finomhangolás

- A tabella legördülők többé nem klippelődnek a vezérlősáv mögé.
- A Szezonállás mobil/tablet nézet kompaktabb lett.
- Hazai/idegen szűrésnél a tabella újrarendeződik a szűrt pontok szerint.
- Forma nézetben a W/D/L kockák hazai/idegen szűrésnél a megfelelő hazai/idegen formát mutatják.
- Top meccs-statisztikáknál rövidített csapatnevek jelennek meg.

## 2026-07-05 polish pass: baraj + névhasználat

- Baraj fül egyszerűsítve: maradt a SuperLiga-app kártyás, sötét UI-nyelve, de kikerült a túlcsicsázott hero/chip/poszteres hatás.
- Csapatnév-logika központosítva `teamNameFor(name, context)` helperbe.
- Tabellákban a `Teljes` nézet mindig teljes csapatnevet használ, mobilon és desktopon is.
- Meccskártyákon, meccsmodalban és top meccs-statisztikákban desktopon teljes név, mobilon rövid név jelenik meg.
- Rövid/table/form nézetekben maradnak a rövid nevek, hogy telefonon ne robbanjon szét a layout.
- Breakpoint váltáskor a frontend újrarenderel, hogy a névhasználat is az aktuális kijelzőhöz igazodjon.


## 2026-07-05 control strip fix

- The active control strip is fixed under the header via `#ctrlWrap`, while main content receives `--ctrl-h` padding so cards remain scrollable and are not hidden under the controls.
- Dropdowns stay above cards and remain clickable inside the fixed control layer.


## Latest live-state pass

- Tab order is now Overview → Matches → Table → Playoff / Playout → Baraj → Stats → Community.
- Regular-season live matches now get a dedicated red live state on match cards.
- The match modal has a live banner with clock, live score and live goal-difference context.
- The regular Table tab shows a live-table panel while regular-season matches are in progress: live score, current position, position delta, live goal difference and points for both teams.
- Playoff/playout table live overlays are intentionally not enabled yet.

## 2026-07-05 live-state parity pass

The SuperLiga live-state UI now mirrors the optimized WC26 app behavior for shared components:

- match rows use the WC26 `live-locked` / result-class flow instead of a custom live strip;
- card score rendering uses the WC26 score compare stack with live clock/status pills;
- match modals use the same sheet state classes and below-score clock/event layout;
- regular table live rows use the WC26 `live-team` styling;
- the regular-season table keeps a compact SuperLiga-only live table panel because the SuperLiga app needs live standings impact during the regular season.

JS checks were run file-by-file and in the declared bundle order.

## 2026-07 worker bootstrap/live update

The frontend now supports the WC26-style public boot path:

- Set one base URL and the app derives the endpoints:

```html
<script>
  window.SUPERLIGA_WORKER_URL = 'https://YOUR-WORKER.workers.dev';
</script>
```

- Optional explicit endpoints still work:

```html
<script>
  window.SUPERLIGA_RESULTS_READ_URL = 'https://YOUR-WORKER.workers.dev/results';
  window.SUPERLIGA_RESULTS_SYNC_URL = 'https://YOUR-WORKER.workers.dev/live-results';
  window.SUPERLIGA_BOOTSTRAP_LIGHT_URL = 'https://YOUR-WORKER.workers.dev/bootstrap-light';
</script>
```

- `bootstrap-light` is prefetched from the document head when a worker URL is present.
- First live paint uses `/live-results?fast=1`, then follows with `/live-results?fresh=1&live=1` in the background.
- Fixture updates from the worker can now update the local fixture list even when the records are normal live cache rows, not only manual `overridden` rows.

## Worker-backed odds / Elo / Transfermarkt values

The frontend now consumes the Worker startup bundle more fully:

```text
/bootstrap-light -> fixtures + final results + live snapshot + odds + team ratings
/odds            -> match odds cache
/team-ratings    -> Elo + Transfermarkt market values
/elo             -> Elo only
/market-values   -> market values only
```

`TEAM_ELO` and `TEAM_MARKET` are still seeded locally for offline/fallback mode, but Worker data overrides them at runtime. The match modal probability card now uses:

```text
odds available:      market odds 70% + model 30%
no odds available:   Elo + squad market value model
```

Odds are stored separately in `SUPERLIGA_ODDS`, so future matches can show the market line before they have any live score object.
