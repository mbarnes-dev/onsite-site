# `@onsite/core` extraction — doc-55 migration, step 1

*Extract the validated domain engines into a portable, typed-at-the-boundary, tested package, prove they lift cleanly (the anchors hold), and consume them from the live prototype — for the price of a refactor, with no infra commitment.* Behaviour-preserving; the anchors (Holtet **kr 16 530**, scope classification on the docs 37–44 contract set, radar, intake) prove no drift.

## TL;DR — what shipped
- **`packages/core` (`@onsite/core` v0.1.0)** — pure engines + `RATES` + domain math, **zero DOM/storage/global reads**, authored as a single dependency-free **ESM** file.
- **Node tests** (`node --test`, zero-install) doubling as the **eval/ground-truth harness**: **9/9 green**, incl. `computeOffer(Holtet) === 16530` and the scope-classification fixtures.
- **`core.bundle.js`** — committed static ESM bundle (the source file *is* the bundle; no bundler). Loaded via `<script type="module">` → `window.OnSiteCore`. **Vercel stays a static deploy — no build command added.**
- **The live prototype consumes it:** the Phase-12 (radar), Phase-13 (intake) and Phase-14 (contract-scope) engines run on the bundle — verified by source-level hit-counters (4× classify on a board render, etc.). Every phase green, offer 16 530, zero console errors.

## Tooling choice (honest)
The prompt suggests TS + tsup/vitest. This environment has **no bundler cached and no `timeout`** to safely probe an `npm install` that might hang offline. To honor the hard constraints (*no infra, lean, commit the bundle, don't break the static deploy, don't balloon the task*) the core is authored as **dependency-free ESM JS + a hand-written `index.d.ts`**, tested with Node's **built-in `node --test`**. A single ESM file is already a browser-loadable module, so **no bundler is needed**. **PROD upgrade (trivial, documented):** author in TS, swap `node --test` → vitest, `build.mjs` → tsup. The load-bearing thesis (engines lift + are testable + consumable) is proven regardless of TS-vs-JS.

## Public API (`packages/core/src/index.mjs`, types in `index.d.ts`)
| Engine | Exports | Purity boundary lifted |
|---|---|---|
| Pricing | `computeOffer(c, {nowStr?, LAYERS?, catLabel?})`, `syncOfferTotals`, `rebuildOfferFlat`, `oLine`, `lineRemoved`, `RATES`, `MOD_TITLES`, `MOD_ORDER`, `layerToService` | `nowStr()`→`opts.nowStr`; `LAYERS`/`catLabel` (marker model)→`opts` |
| Schedule | `expandLine(line, from, to)`, `generateInstances`, `freqText` | none (already pure; cadence math) |
| While-here | *(deferred — see below)* | — |
| Radar | `recurringRadar(c, {now?})`, `radarKeyword`, `radarSeasonOf` | `refDate()`→`opts.now` |
| Intake | `parseIntake(text, {buildingId?, photoIds?, customers?})`, `INTAKE_CHANNELS`, `channelLabel`, `intakeTitle` | `customers()`→`ctx.customers` |
| Scope | `parseContract(text)`, `classifyAgainstScope(c, request)`, `scopeFromOffer`, `deriveScope`, `scopeMismatch`, `scopeKeyword`, `scopeDomLabel` | none (pure over customer+request) |
| Geodesic | `geoArea(pts)`, `geoLength(pts)` | none |
| Migration | `migrateState(s, schemaVersion)` | none (pure state transform) |
| Formatters | `kr`, `cap`, `iso`, `addDays`, `mondayOf`, `ymd`, `dateLabel`, `tsLabel` | none |

## Step-0 coupling map (the honest production estimate input)
Rating: **pure** (lifts verbatim) · **data-in** (reads a passed object, mutates it) · **global** (reaches a closure/global — the boundary lifted on extraction).

| Function (prototype) | Inputs | Coupling before extraction | Notes |
|---|---|---|---|
| `geoArea` / `geoLength` | `[[lat,lng],…]` | **pure** | verbatim |
| `computeOffer` | customer | **data-in** + reads `RATES`/`MOD_*`/`WPM` (move with it), `nowStr()`, `findZone`, `LAYERS`/`catLabel` (marker path) | mutates `c.offer`; globals lifted to `opts` |
| `syncOfferTotals`/`rebuildOfferFlat`/`oLine`/`lineRemoved` | customer / line | **data-in** | verbatim |
| `expandLine`/`generateInstances`/`freqText` | line + dates | **pure** | verbatim |
| `scheduleLines` | client | **data-in** + reads `catCadence` (SERVICE_CATALOGUE) | *kept inline* — pulls the whole catalogue blob (see deferred) |
| `suggestWhileHere` | customer, ctx | **global**: `refDate()`, `catEquipment`/catalogue, equipment registry, cross-client | *deferred* — most coupled (catalogue + equipment + refDate) |
| `recurringRadar` | customer | **data-in** + `refDate()`, `tsLabel`/`kr`/`cap` (moved) | `refDate`→`opts.now` |
| `parseIntake` | text, ctx | **data-in** + `customers()` | `customers()`→`ctx.customers` |
| `parseContract`/`classifyAgainstScope`/`scopeFromOffer`/`deriveScope`/`scopeMismatch` | customer/request/text | **data-in** (pure over their args) | verbatim |
| `migrate` | state | **pure** (in `index.html`) | lifted as `migrateState`; *kept inline live* — runs at parse-time before the deferred module |
| `*HTML` view builders, `save()`, `render()`, `esc()`, photo subsystem | — | **DOM/storage** | **stay in the app** — these are the view/IO layer, never moved to core |

**Headline finding:** the engines are *far* more portable than the file's size suggests. The compute/parse/classify/schedule/geodesic core is essentially **data-in or pure**; the only real couplings are (a) a handful of globals trivially lifted to parameters (`refDate`, `customers()`, `nowStr`, `LAYERS`), and (b) the SERVICE_CATALOGUE data blob (which `scheduleLines`/`suggestWhileHere` depend on). The doc-55 assumption — *"the engines carry forward ~verbatim"* — held in practice.

## What's wired live vs. extracted-only
- **Wired through the bundle (verified):** `classifyAgainstScope` / `deriveScope` / `scopeMismatch` (Phase 14), `recurringRadar` (Phase 12), `parseIntake` (Phase 13). Routed at the **call site** via `CORE("fn")` with an inline fallback.
- **Extracted + tested in core, still inline live (anchors green standalone):** `computeOffer` (+ totals), `expandLine`/`generateInstances`, `geoArea`/`geoLength`, `migrateState`. Same per-call-site pattern is the next mechanical increment.

## What didn't purify / map cleanly (the honest list)
1. **`suggestWhileHere` (while-here) — deferred.** Most coupled: needs the SERVICE_CATALOGUE blob, the equipment registry, *and* `refDate()`, and reasons across live clients. Extractable with the same boundary-lifting, but it pulls the catalogue in — bundled with item 2.
2. **`SERVICE_CATALOGUE` + `scheduleLines`.** The schedule *engine* (`expandLine`/`generateInstances`) is pure and extracted; `scheduleLines` (which turns a client into schedule lines) reads the catalogue. The catalogue is a large data structure that should move to `@onsite/core` as data — deferred to keep this step lean.
3. **`RATES` / catalogue are duplicated (app + core).** The app keeps its own `RATES` for the offer-detail *display* math; core has the authoritative copy for `computeOffer`. **Single-sourcing is a follow-up** (the app should read `window.OnSiteCore.RATES`). Values are identical (the 16 530 anchor proves it).
4. **Binding-reassignment does NOT propagate in the 4200-line IIFE.** The first wiring attempt reassigned the engines' function-declaration bindings at one point (`wireCore()`); the body *ran* (beacon confirmed) but callers kept the inline impl. A real measure of the closure's internal coupling. **What works is reading `window.OnSiteCore.X` at the call site.**
5. **ES-module namespace exports are read-only** — a verification gotcha, not a code issue. `window.OnSiteCore.fn = spy` silently no-ops, so routing must be proven by a source-level side-effect (hit-counter), not by overriding the export. (This is why early sentinel tests falsely read "not routed".)
6. **Loading order.** The bundle is a *deferred* module (`<script type="module">`); the classic `onboarding.js` parses first. Safe because every engine call is post-load. **`migrate` stays inline** (it runs during `index.html` parse, before the module). The `?v=` cache-buster must be applied to `onboarding.js`/`core.bundle.js`, not just `index.html` (caught during verification).

## Deploy model (unchanged)
`core.bundle.js` is a committed static file served by Vercel exactly like `onboarding.js`. `packages/core/build.mjs` (`node build.mjs`) is a **local** convenience that copies `src/index.mjs` → `core.bundle.js`; it is **not** a deploy dependency. No `vercel.json`/build-command change.

## Run it
```
cd packages/core && node --test     # 9/9 green — incl. Holtet 16 530 + scope/radar/intake/schedule/geo/migrate
cd packages/core && node build.mjs   # rebuild core.bundle.js from src (commit the result)
```
