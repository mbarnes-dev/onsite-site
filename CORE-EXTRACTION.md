# `@onsite/core` extraction — doc-55 migration, step 1

*Extract the validated domain engines into a portable, typed-at-the-boundary, tested package, prove they lift cleanly (the anchors hold), and consume them from the live prototype — for the price of a refactor, with no infra commitment.* Behaviour-preserving; the anchors (Holtet **kr 16 530**, scope classification on the docs 37–44 contract set, radar, intake) prove no drift.

## TL;DR — what shipped
- **`packages/core` (`@onsite/core` v0.1.0)** — pure engines + `RATES` + domain math, **zero DOM/storage/global reads**, authored as a single dependency-free **ESM** file.
- **Node tests** (`node --test`, zero-install) doubling as the **eval/ground-truth harness**: **9/9 green**, incl. `computeOffer(Holtet) === 16530`, the scope-classification fixtures, and the while-here `rankWhileHere` 📍⏰🔧 anchor.
- **`core.bundle.js`** — committed static ESM bundle (the source file *is* the bundle; no bundler). Loaded via `<script type="module">` → `window.OnSiteCore`. **Vercel stays a static deploy — no build command added.**
- **The app is now a pure shell over the engines (Phase 16 — doc-55 step-1 *cleanup*).** The pricing/offer pipeline and the schedule engine **definition-delegate** to `window.OnSiteCore.*` — the inline copies are **deleted**, not retained as fallback, so core is the single runtime source. `RATES` is single-sourced (app copy deleted). The while-here **scoring/ranking** lifted to `rankWhileHere`. Phase-12/13/14 (radar/intake/scope) now **definition-delegate too** — the inline fallbacks are deleted and the call-site `CORE()` router is **retired**, so every engine is single-sourced the same way. Verified end-to-end in-browser: offer **kr 16 530** via the live `genOffer` path, walkaround **41 items**, while-here headline **Takrennerens 📍⏰🔧**, mark-done-no-resurface, all four role views, **zero console errors**.
- **Three things stay in the app *by design*** (parse-time / primitive deps that run before the deferred module, documented below): `migrate`, the geodesic `geoArea`/`geoLength` math, and the `SERVICE_CATALOGUE` + its parse-time fold.

## Tooling choice (honest)
The prompt suggests TS + tsup/vitest. This environment has **no bundler cached and no `timeout`** to safely probe an `npm install` that might hang offline. To honor the hard constraints (*no infra, lean, commit the bundle, don't break the static deploy, don't balloon the task*) the core is authored as **dependency-free ESM JS + a hand-written `index.d.ts`**, tested with Node's **built-in `node --test`**. A single ESM file is already a browser-loadable module, so **no bundler is needed**. **PROD upgrade (trivial, documented):** author in TS, swap `node --test` → vitest, `build.mjs` → tsup. The load-bearing thesis (engines lift + are testable + consumable) is proven regardless of TS-vs-JS.

## Public API (`packages/core/src/index.mjs`, types in `index.d.ts`)
| Engine | Exports | Purity boundary lifted |
|---|---|---|
| Pricing | `computeOffer(c, {nowStr?, LAYERS?, catLabel?})`, `syncOfferTotals`, `rebuildOfferFlat`, `oLine`, `lineRemoved`, `RATES`, `MOD_TITLES`, `MOD_ORDER`, `layerToService` | `nowStr()`→`opts.nowStr`; `LAYERS`/`catLabel` (marker model)→`opts` |
| Schedule | `expandLine(line, from, to)`, `generateInstances`, `freqText` | none (already pure; cadence math) |
| While-here | `rankWhileHere(cand, {hereAreas, hereEquip, WHILE_WINDOW, teamServices?, areaLabel, equipTypeLabel})` | the **scoring/ranking/dedupe** half; candidate gathering stays app-side (see findings) |
| Radar | `recurringRadar(c, {now?})`, `radarKeyword`, `radarSeasonOf` | `refDate()`→`opts.now` |
| Intake | `parseIntake(text, {buildingId?, photoIds?, customers?})`, `INTAKE_CHANNELS`, `channelLabel`, `intakeTitle` | `customers()`→`ctx.customers` |
| Scope | `parseContract(text)`, `classifyAgainstScope(c, request)`, `scopeFromOffer`, `deriveScope`, `scopeMismatch`, `scopeKeyword`, `scopeDomLabel` | none (pure over customer+request) |
| Geodesic | `geoArea(pts)`, `geoLength(pts)` | none (portable copy; **app keeps its own inline** — parse-time seed dep) |
| Formatters | `kr`, `cap`, `iso`, `addDays`, `mondayOf`, `ymd`, `dateLabel`, `tsLabel` | none (primitives; app keeps inline copies too) |

> **Not in core:** `migrateState` was removed — migration stays app-side (`index.html migrate`): it runs at parse-time before this deferred module loads and depends on `demo()` + `SCHEMA_VERSION`. A core copy the app never calls is an untested-against-live drift surface. Same reasoning as the inline geo math.

## Step-0 coupling map (the honest production estimate input)
Rating: **pure** (lifts verbatim) · **data-in** (reads a passed object, mutates it) · **global** (reaches a closure/global — the boundary lifted on extraction).

| Function (prototype) | Inputs | Coupling before extraction | Notes |
|---|---|---|---|
| `geoArea` / `geoLength` | `[[lat,lng],…]` | **pure** | verbatim |
| `computeOffer` | customer | **data-in** + reads `RATES`/`MOD_*`/`WPM` (move with it), `nowStr()`, `findZone`, `LAYERS`/`catLabel` (marker path) | mutates `c.offer`; globals lifted to `opts` |
| `syncOfferTotals`/`rebuildOfferFlat`/`oLine`/`lineRemoved` | customer / line | **data-in** | verbatim |
| `expandLine`/`generateInstances`/`freqText` | line + dates | **pure** | verbatim |
| `scheduleLines` | client | **data-in** + reads `catCadence` (SERVICE_CATALOGUE) | *kept inline* — pulls the whole catalogue blob (see findings) |
| `suggestWhileHere` | customer, ctx | **global**: `refDate()`, `catEquipment`/catalogue, equipment registry, `completedInstances`/`instKey` | **split**: gathering stays inline (catalogue + `instKey` contract); **scoring → `rankWhileHere`** |
| `recurringRadar` | customer | **data-in** + `refDate()`, `tsLabel`/`kr`/`cap` (moved) | `refDate`→`opts.now` |
| `parseIntake` | text, ctx | **data-in** + `customers()` | `customers()`→`ctx.customers` |
| `parseContract`/`classifyAgainstScope`/`scopeFromOffer`/`deriveScope`/`scopeMismatch` | customer/request/text | **data-in** (pure over their args) | verbatim |
| `migrate` | state | **pure** (in `index.html`) | **stays app-side** — parse-time (before the deferred module) + `demo()`-coupled; the core copy was removed (drift surface) |
| `*HTML` view builders, `save()`, `render()`, `esc()`, photo subsystem | — | **DOM/storage** | **stay in the app** — these are the view/IO layer, never moved to core |

**Headline finding:** the engines are *far* more portable than the file's size suggests. The compute/parse/classify/schedule/geodesic core is essentially **data-in or pure**; the only real couplings are (a) a handful of globals trivially lifted to parameters (`refDate`, `customers()`, `nowStr`, `LAYERS`), and (b) the SERVICE_CATALOGUE data blob (which `scheduleLines`/`suggestWhileHere` depend on). The doc-55 assumption — *"the engines carry forward ~verbatim"* — held in practice.

## What's wired live (Phase 16 — the cleanup)
- **Single runtime source, inline copy DELETED (definition-delegation):** `computeOffer` / `syncOfferTotals` / `rebuildOfferFlat` / `oLine` / `lineRemoved` (offer) and `expandLine` / `generateInstances` / `freqText` (schedule). Each declaration's body is now `return window.OnSiteCore.X(…)`; the ~160 lines of inline engine + `RATES`/`MOD_*`/`WPM`/`driverCounts`/`zoneAgg`/… are gone. Safe because the first call is always post-load (a render or user action) — both seeds set `offer:null`, so nothing computes an offer at parse-time.
- **Single-sourced data:** `RATES` (app literal deleted — only `computeOffer`, now core's, read it). The one live `MOD_TITLES` reader (`radarPropose`) reads `window.OnSiteCore.MOD_TITLES`.
- **Scoring lifted:** `suggestWhileHere` gathers candidates app-side (catalogue + `instKey` coupling) and delegates dedupe/scoring/ranking to `rankWhileHere`.
- **Definition-delegated (the radar/intake/scope increment, `?v=16e`):** `recurringRadar` (Phase 12), `parseIntake` (Phase 13), and `parseContract`/`classifyAgainstScope`/`scopeFromOffer`/`deriveScope`/`scopeMismatch` (Phase 14). Each declaration's body is now `return window.OnSiteCore.X(…)`; the inline engines + their now-dead helpers (`radarSeasonOf`/`monthsBetween`/`radarKeyword`/`radarServiceFromCategory`/`standingLineLabels`/`RADAR_TYPEW`/`scopeKeyword`/`scopeDomains`/`SCOPE_SAFETY`/`SCOPE_BORDERLINE`) are **deleted**, and the call-site `CORE("fn")` helper is **retired** (the binding IS the delegate, no fallback). The recurring `radarPropose`/`scopeUseOffer`/`scopeParseDo` call sites now call the delegating shells directly. **Display-only helpers stay app-side by design** (live readers in the view layer): `RADAR_BADGE`, `channelLabel`+`INTAKE_CHANNELS`, `intakeTitle`, `scopeDomLabel`+`SCOPE_DOM_LABEL`. Net −12.5 KB of duplicated domain logic. Safe because every engine caller is a render/user-action path (post-load), proven by a parse-time reachability sweep of `seedIfNeeded()`/the IIFE bottom.

## What stays in the app — by design (not a compromise)
1. **`migrate` (`index.html`).** Runs at **parse-time**, before the deferred module loads, and depends on the app's `demo()` seed + `SCHEMA_VERSION`. The core `migrateState` copy was **removed** — a duplicate the app never calls is an untested-against-live drift surface (its field-order even diverged from the live path). One migrate, app-side.
2. **Geodesic math (`geoArea`/`geoLength`).** A stateless primitive — and a **parse-time seed dependency**: `holtetZones → zoneRecompute → geoArea` runs during the IIFE's bottom `seedIfNeeded()`, before the module. Kept inline like the date/`kr` primitives; core ships a portable node-tested copy for the PROD boundary. (Naively delegating it threw `undefined.geoArea` at parse-time — caught + reverted during verification.)
3. **`SERVICE_CATALOGUE` + `scheduleLines` + the `cat*` accessors.** The catalogue is **mutated at parse-time** by the `foldChecklistIntoCatalogue` IIFE (the sole writer of `.checklist/.label/.zone/.cat/.captureType/.emoji/.freq/.upsell/.compliance`), then read by `instantiateChecklist` (→ the 41-item walkaround) and `scheduleLines`. Moving the catalogue to the deferred module while the fold stays app-side would give core an **un-folded** catalogue → silently shorter checklists / missing calendar lines. The fold is the parse-time blocker; the catalogue stays inline with it. (The schedule *engine* `expandLine`/`generateInstances` is pure and IS extracted — only the catalogue-reading `scheduleLines` stays.)

## Verification gotchas (carried, so they aren't relearned)
- **Binding reassignment DOES propagate** in the IIFE — the Phase-15 "it doesn't" finding was a **false negative**, caused by testing via a read-only ESM namespace override (`window.OnSiteCore.fn = spy` silently no-ops). Phase 16 confirmed propagation with a source-level hit-counter, then went further to **definition-delegation** (cleaner: the binding *is* the delegate; no swap needed).
- **ES-module namespace exports are read-only** — prove routing by a source-level side-effect or a behaviour anchor, never by overriding the export.
- **`nowStr` must be passed as the FUNCTION** (core accepts fn-or-value), so each offer's `createdAt` reflects its own compute moment. Passing `nowStr()` froze it at first render — a real bug the inventory caught; verified fixed (two computes stamp different `createdAt`).
- **Loading order.** The bundle is a *deferred* module; classic `onboarding.js` parses first. Every engine call is post-load — EXCEPT the three parse-time deps above, which is exactly why they stay inline. The `?v=` cache-buster must be applied to `onboarding.js` AND `core.bundle.js`, not just `index.html`.

## Deploy model (unchanged)
`core.bundle.js` is a committed static file served by Vercel exactly like `onboarding.js`. `packages/core/build.mjs` (`node build.mjs`) is a **local** convenience that copies `src/index.mjs` → `core.bundle.js`; it is **not** a deploy dependency. No `vercel.json`/build-command change.

## Run it
```
cd packages/core && node --test     # 9/9 green — Holtet 16 530 + scope/radar/intake/schedule/geo/while-here
cd packages/core && node build.mjs   # rebuild core.bundle.js from src (commit the result)
```
