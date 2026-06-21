# OnSite Prototype — Acquisition Due-Diligence Code-Review Findings

**Date:** June 2026 · **Scope:** `onsite-site` (static facility-management web app) — `index.html` (day-app + global state), `onboarding.js` (sales→onboarding, 2929 lines), `onboarding.css`, `vendor/leaflet/`, `vercel.json` · **Lens:** acquisition (clean, durable code as an asset)

> Produced by an adversarial multi-pass review (12 dimensions, per-finding verification against the source). Findings below are post-deduplication; every Critical/Major was independently re-checked against the cited code.

---

## 1. Executive summary

OnSite is a **competently-built, internally-coherent prototype with a genuinely valuable domain model wrapped in throwaway infrastructure** — but it ships with two correctness/data-integrity defects that an acquirer must treat as landmines, not polish items. The good news first: the offer/zone/proof/schedule **data shapes are thoughtfully designed and backend-ready**, the network/registry edge is defensively coded, XSS discipline is ~143-call-sites consistent, there are no secrets in the client, and license/IP hygiene is clean. The three dominant themes working against it are: **(1) silent data loss** — `save()` swallows every `localStorage` write error, so a quota-exceeded write toasts "✓ documented" while the completion-proof record (the product's core value proposition) is never persisted and vanishes on reload; **(2) no schema versioning or migration anywhere** — combined with an unguarded `l.review.decision` dereference, a single old-shape customer record throws a `TypeError` that blanks the **entire** Office and Sales list, the documented "hit reseed to restore" dead-end, which is unrecoverable for a real (non-seed) user; and **(3) two visible grand totals for the same offer** plus a UTC-vs-local date split that files the same completion under different days in the contractual PDF. Surrounding these is heavy structural debt — one 2929-line IIFE with 321 functions, a four-way un-unified "service" taxonomy, and a global single-tenant `localStorage` store that is a rewrite (not a port) for any real product. **Net: the domain model is the asset and carries forward; the persistence, auth, multi-tenancy, and rendering layers are demo-grade and must be rebuilt, and three defects should be fixed before any further demo.**

---

## 2. Severity overview

| Severity | Count |
|---|---|
| **Critical** | 2 |
| **Major** | 19 |
| **Minor** | 30 |
| **Nice-to-have** | 10 |

> Counts are the deduplicated canonical set detailed in §3. Cross-dimension duplicates are collapsed — C1 (silent `save()`) was reported under 4 review dimensions and M1 (no schema/migration) under 5; each is counted once.

### Critical & Major summary

| # | Title | Severity | File : loc | Effort |
|---|---|---|---|---|
| C1 | `save()` swallows QuotaExceededError → completions toasted as saved but lost on reload | **Critical** | `index.html:219` | S |
| C2 | `offerTotal()` unguarded `l.review.decision` → one old-shape offer blanks entire Office/Sales render | **Critical** | `onboarding.js:1083-1086` | S |
| M1 | No schema/version field; `load()` parses any shape with zero migration | **Major** | `index.html:215-219` | M |
| M2 | Reseed is the only recovery path — destructive and unavailable to a real returning user | **Major** | `onboarding.js:2811-2812` | M |
| M3 | `c.contacts[0]`/`.slice()` dereferenced without array guard in go-live + print | **Major** | `onboarding.js:1269,2465` | S |
| M4 | Grand total computed two incompatible ways — diverges across screens/PDF | **Major** | `onboarding.js:1068-1076` vs `1083-1086` | S |
| M5 | completionLog grouped by UTC in one surface, LOCAL date in another | **Major** | `onboarding.js:1533` vs `2584` | S |
| M6 | Stored XSS via building name in day-app `<option>` (no `esc()`) | **Major** | `index.html:289` | S |
| M7 | Stored XSS via zone label in Leaflet tooltip (`zoneShort()` bypasses `esc()`) | **Major** | `onboarding.js:497` | S |
| M8 | "Service type" is four parallel un-unified taxonomies hand-mapped by translators | **Major** | `onboarding.js:28-72,443-449,956-967` | L |
| M9 | Pricing hardcoded per-line in `computeOffer`, not data-driven | **Major** | `onboarding.js:1006-1038` | L |
| M10 | Single global-localStorage state, no tenant/user/schema scoping — won't carry to multi-tenant | **Major** | `index.html:188,215-219` | L |
| M11 | `onboarding.js` is one 2929-line IIFE, 321 functions, no module structure | **Major** | `onboarding.js` (whole file) | L |
| M12 | `delZone` never recomputes the offer → stale totals + dangling `zoneId` | **Major** | `onboarding.js:640` | S |
| M13 | Deleting a zone orphans its photo blobs in IndexedDB forever (no GC) | **Major** | `onboarding.js:640` | S |
| M14 | Photo capped-LS fallback silently evicts oldest (live, referenced) proof images | **Major** | `onboarding.js:812-821` | M |
| M15 | Every top-level render destroys and rebuilds ALL Leaflet maps from scratch | **Major** | `onboarding.js:1765-1774` | L |
| M16 | IndexedDB connection cached with no `onblocked`/`onversionchange` (Safari hang) | **Major** | `onboarding.js:800-809` | M |
| M17 | Real named board members in plaintext localStorage on shared, no-auth device | **Major** | `onboarding.js:1895-1896` | L |
| M18 | "Magic link / board access" is a label only — no auth implemented | **Major** | `onboarding.js:1091-1101` | L |
| M19 | Public OSM/Nominatim/Kartverket endpoints used commercially — terms breach | **Major** | `onboarding.js:702-705,373-374` | M |

---

## 2b. Remediation status — Hardening Pass 1 (2026-06-21)

Scoped fixes for this pass (both Criticals, both XSS, the tile-terms breach, two cheap correctness bugs). Remaining ~53 findings deferred to later passes.

- [ ] **C1** — `save()` returns success/failure; honest error on quota; `proofConfirm()` (and peers) only confirm on success.
- [ ] **C2** — `schemaVersion` + idempotent migration chain on load; `l.review?.decision` + audited deref guards; old-shape record migrates, never blanks Office/Sales.
- [ ] **M6 + M7** — `esc()` now escapes `'` (and `` ` ``); building name + zone tooltip + all enumerated untrusted sinks escaped.
- [ ] **M19** — OSM tiles + Nominatim geocoding removed; Kartverket + geonorge only; CSP tightened.
- [ ] **M4** — single-sourced offer total (removed-line filter); Holtet re-anchored (before/after in commit + chat).
- [ ] **M5** — local dates on board doc + Brøyterapport + audited `toISOString().slice` displays.

---

## 3. Detailed findings

### Lens 1 — Architecture & maintainability

#### M4 (Major) · Grand total computed two incompatible ways — board "remove"/travel diverge between screens
- **What:** The same offer shows two different grand totals. `rebuildOfferFlat`'s `o.totalMonthly`/`o.totalYearly` sum included module subtotals (`m.subtotal` at line 1070 sums **all** `m.lines` regardless of `l.review.decision`, and ignores `offer.travel`), while `offerTotal()` sums only `o.lines` with `review.decision!=='remove'` and **adds** `offer.travel`.
- **Where:** `onboarding.js` — `rebuildOfferFlat()` 1068-1076 (sink: 1070, 1073-1075) vs `offerTotal()` 1083-1086. Consumers split: `o.totalMonthly` at 2200-2201, 2514; `offerTotal()` at 2310, 2369, 2393, 2436, 2471.
- **Why it matters:** Once the board marks any line "remove" (`setDecision`, wired at dispatch case `dec` line 2800), the hero highlight and module "Sum fast" disagree with the offer-detail total, handover "Plan value locked", pipeline chip, and the leave-behind doc. For an acquisition where the generated offer is the **contractual artifact**, two visible prices for one offer is material. (Travel half is currently latent — `offer.travel` is initialized 0 and never set — so today only the remove-decision path triggers it.)
- **Fix + effort:** Pick one source of truth: either compute `totalMonthly/Yearly` from `o.lines` (already filtered) + travel, or route every display through `offerTotal()`; also filter `review.decision!=='remove'` in the line-1070 `m.subtotal` reduce. **S.**

#### M8 (Major) · "Service type" is four parallel un-unified taxonomies
- **What:** No single source of truth for a service. A marker carries a `LAYERS` key; pricing uses a different vocabulary (`base/cleaning/snow/grass/greenery/other`) reached only via `layerToService()`; zone-drawing uses `SERVICE_LIST` (`snow/grass/greenery/cleaning-ext/other`); the checklist uses `CATS` keys. `serviceOfTask()` re-maps `CATS`→pricing with a third inline `byCat` table. The vocabularies overlap but are not equal (`cleaning-ext` exists nowhere else; `base` spells to no `CAT`/`LAYER`/`SERVICE_LIST` key; `byCat`/`SERVICE_ICON` even emit a fifth set, `technical`/`compliance`).
- **Where:** `onboarding.js` — `LAYERS` 28-59, `CATS` 63-72, `SERVICE_LIST` 443-449, `MOD_ORDER`/`MOD_TITLES`/`RATES` 956-965, `layerToService` 966-967, `serviceOfTask` `byCat` 1403, `layerSchedule` 1310-1318.
- **Why it matters:** Any change to "what services exist" must be reconciled by hand across 4+ disjoint sites with no shared enum and no test. This is the single largest extensibility tax in the repo.
- **Fix + effort:** Define one canonical service registry (`id, label, emoji, cat, measure, unit, defaultRate, scheduleDefault`) and derive the others as views; collapse `layerToService`+`byCat`+`layerSchedule` into table lookups. **L.**

#### M9 (Major) · Pricing hardcoded per-line in `computeOffer`, not data-driven
- **What:** `RATES` looks like config, but the formulas consuming each rate are inlined as bespoke `oLine(...)` push statements. Adding a priced service is not "add a `RATES` row" — you must hand-author another block with the correct multiplier (m²/WPM/count×rate), id namespace, cadence string, **and** remember to add the service to `MOD_ORDER`/`MOD_TITLES` or it silently vanishes from grouped output at line 1050. No formula abstraction (per-unit/area/event/year reimplemented inline each time).
- **Where:** `onboarding.js` — `computeOffer` driver branch 1006-1038, `RATES` 956-962, `MOD_ORDER` map at 1050.
- **Why it matters:** Pricing changes on the revenue-critical path are high-risk and untestable; a new-service key not added to `MOD_ORDER` silently disappears.
- **Fix + effort:** Represent each priced line as data `{service, rateKey, qtyFn, periodicity}` and reduce through one builder; `RATES` becomes the only edit surface. **L.**

#### M10 (Major) · Single global-localStorage state, no tenant/user/schema scoping
- **What:** Everything reads/mutates one process-global `OnSite.state` persisted to one key with no tenant id, no per-user partition, no building/customer storage scoping. `completedInstances` is a flat map keyed `lineId|isoDate` across **all** clients globally.
- **Where:** `index.html` — `LS_KEY`/`load`/`save` 188, 215-219; `OnSite` bridge 468-478. `onboarding.js` — `S()=OnSite.state` 14; `completeInstance`/`currentUser` 1376-1396. (~143 `esc()`+innerHTML render sites assume one DOM/one dataset.)
- **Why it matters:** Moving to a real backend/multi-tenant product means this whole access+render layer is a rewrite, not a port. This is the structural ceiling on the prototype.
- **Fix + effort:** Carry the data shapes forward but replace the storage/access layer with a tenant-scoped repository abstraction; add a schema version now; move rendering toward component-scoped views. **L.**

#### M11 (Major) · `onboarding.js` is one 2929-line IIFE, 321 functions, no module structure
- **What:** Pricing engine, geo math, registry fetch, IndexedDB photos, schedule engine, 6 wizard steps, board/office/field render, cockpit, snow reports and print all live in one function scope sharing ~37 module-level `var`s (`LAYERS`, `RATES`, `ui`, `map`, `drawMode`, `pendingProof`, `opMaps`, …). No export surface (only `window.OnSite`), no file-per-concern, no way to unit-test or tree-shake any piece.
- **Where:** `onboarding.js` — whole file; IIFE opens line 8, closes EOF (2929); 220 KB.
- **Why it matters:** An acquirer cannot touch the pricing engine without loading the entire 220 KB scope. Dominant maintainability cliff.
- **Fix + effort:** Split into ES modules along the existing comment seams (`data.js`, `geo.js`, `registry.js`, `photos.js`, `schedule.js`, `render-*.js`, `print.js`); keep `window.OnSite` as the only global. Native ESM on Vercel needs no build step. **L.**

#### M12 (Major) · `delZone` never recomputes the offer
- **What:** Deleting a priced zone filters `c.zones`, saves, and re-renders — but never calls `recomputeOffer`. The offer line, stale subtotal/totals, and a dangling `line.zoneId` remain; a later recompute drops the line as a phantom price change. (`saveZoneFromSheet` at 615 correctly recomputes; the delete path does not.)
- **Where:** `onboarding.js` — `delZone` 640 (contrast `saveZoneFromSheet` 615).
- **Why it matters:** Produces a visibly wrong customer-facing offer total whenever a priced offer exists and a zone is deleted; self-heals only on the next recompute-triggering action.
- **Fix + effort:** After filtering `c.zones`, call `recomputeOffer(c)` guarded by `c.offer.modules`, mirroring `saveZone`. **S.**

#### Minor — Architecture
- **(Minor)** ~83-line / ~79-case "god switch" event dispatcher routes all onboarding interactions; `data-arg` pipe-split + `decodeURIComponent` reinvented per case with no shared decoder — `onboarding.js:2731-2813`. Replace with an `actions{}` lookup + one decode helper. **M.**
- **(Minor)** `computeOffer` carries two coexisting pricing models (zone/checklist "driver" + legacy "marker"/Solbakken) in one 69-line branch — `onboarding.js:998-1067` (driver 1007, marker 1041). Migrate seeds to the driver model and delete the else branch, or factor into `buildDriverLines`/`buildMarkerLines`. **M.**
- **(Minor)** `render()` destroys overlay Leaflet maps but only 2 of 3 overlays self-heal — board-doc map (`showBoardDoc`) has no render-survival guard (latent: no current path fires `render()` while it's open) — `onboarding.js:2550-2559` (contrast 1487, 2598). Centralize overlay map re-attachment via a registry of open-overlay rebuild thunks. **M.**
- **(Minor)** Single flat global `opMaps{}` couples all five map surfaces; `destroyOpMaps()` is all-or-nothing, subset cleanup via duplicated `bs-`/`snowrep-` prefix scans — `onboarding.js:442,643,2562/2566`. Give each surface its own maps object + `destroy()`, or add `destroyOpMaps(prefix)`. **M.**
- **(Minor)** Full innerHTML re-render on most actions, with view state fragmented across persisted `state` + transient `ui` + loose module vars (`map`, `drawMode`, `pendingProof`, `geoMini`); the partial-update helpers exist only to work around the full-render default — `onboarding.js:193,2863`. Document the render contract; consolidate draw/map vars into one `mapState`. **L.**
- **(Minor)** `reRenderProofSheet`/`obSheet` rebuild the whole sheet innerHTML on field-driven updates, dropping focus/caret/scroll; the zone-service `<select>` handler also reverts unsaved label/notes edits — `onboarding.js:573,896,2834`. Update only the affected sub-region via `setHTML` on a stable id. **S.**
- **(Minor)** `completionLog` entry shared by reference across customer and zone logs — harmless today but diverges after a JSON round-trip and is a latent mutation hazard — `onboarding.js:1479-1483`. Store a clone, or only the id in the zone log. **S.**
- **(Minor)** Schedule cadence for a new service requires editing two disjoint maps (`SCHEDULE_MAP` by checklist-id, `layerSchedule` by LAYERS key) with no fallback parity — a checklist item missing a `SCHEDULE_MAP` entry is silently dropped — `onboarding.js:1288-1318,1353-1369`. Key both off the canonical registry; make "no schedule" explicit. **M.**
- **(Minor)** `oLine.category` provenance is inconsistent — `MOD_TITLES[service]` (driver) vs `catLabel(layer)` (marker) vs `l.category||catLabel(l.layer)` (render) — so the same service shows different category strings across offer/schedule/print — `onboarding.js:991,1044,1242`. Resolve category once at line-creation from the canonical registry. **S.**
- **(Minor)** 5 dead functions (`checklistLine` 943, `upsellTotal` 1087, `stagesRailHTML` 1943, `offerLinesHTML` 2250, `offerUpsellsHTML` 2263) — superseded offer renderers signalling an incomplete refactor. Delete. **S.**
- **(Minor)** Four near-identical print routines (`printMapCard`/`printOffer`/`printBoard`/`printSnowReport`) duplicated with already-drifted timeouts (180/60/200/200 ms); mirrored in 4 `@media-print` CSS blocks — `onboarding.js:683,2448,2565,2693`. Extract `printWith(bodyClass, targetEl, delay)`. **S.**
- **(Minor)** Inconsistent English/Norwegian UI mix, even within `goLive()` — `onboarding.js:1224-1277,2002-2009`. Canonicalize Norwegian; lift user-facing strings into one table. **M.**
- **(Minor)** Section-header comments cover ~half the file; a ~1160-line unsectioned stretch (proof/cockpit/wizard/board/snow) carries the bulk of the functions — `onboarding.js:1283→2445`. Add interim section banners (fold into the module split). **S.**

#### Nice-to-have — Architecture
- **(Nice-to-have)** Two top-level `document` click listeners + `data-ob`/`data-act`/`data-do` delegation share global event space; correctness relies on a non-overlapping attribute namespace by convention and on `cur()||boardCustomer()` resolving the right record from ambient `ui` state — `index.html:231-238`, `onboarding.js:2724,2827`. Consolidate into one dispatcher; have targets carry their own customer-id context. **M.**
- **(Nice-to-have, positive)** Adding a building profile/checklist template **is** genuinely easy — `PROFILES` flat array + `CHECKLIST_TEMPLATE` keyed by profile with a defaulting fallback (`onboarding.js:77,108-171`). Use as the template for refactoring the service/rate taxonomies.
- **(Nice-to-have, positive)** Domain data shapes (offer/module/line with per-line `override`+`review`, geodesic zones, `completionLog` proof record, schedule-instance `lineId|isoDate`) are well-modeled, serializable, tenant-agnostic, and **carry forward** — `onboarding.js:977-1066,1372-1404`. The real acquirable asset.

---

### Lens 2 — Operational stability & durability

#### C1 (Critical) · `save()` swallows QuotaExceededError — completions toasted as saved but lost on reload
- **What:** `save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){} }` — empty catch, no return value. `localStorage` caps at ~5 MB; once the state blob (customers, zone geojson geometry, the **unbounded** completionLog) exceeds it, `setItem` throws, the catch eats it, and `save()` returns normally. All 49 callers treat the write as successful. Worst case `proofConfirm()` pushes the entry, calls `save()` (silently fails), then toasts `✓ Utført — dokumentert`. On reload, `load()` returns the last-good blob and the completion is gone.
- **Where:** `index.html:219` (sink); `onboarding.js:1474-1490` (`proofConfirm`: 1486 `save();render();`, 1489 toast with no check). `commit()` at `index.html:271` re-renders from in-memory state, masking the failure.
- **Why it matters:** Silent data loss with positive feedback, at the core of the product's value proposition (provable on-site completion: timestamp + GPS + photo refs). Worst failure mode for a record-keeping product sold on "your day is saved." (Note: photo binaries live in IndexedDB, not this blob — quota pressure here is geometry + the text completionLog, so the trigger threshold is higher than a naïve estimate, but the defect class is fully real.)
- **Fix + effort:** Make `save()` return a boolean; in the catch fire a distinct toast (`⚠️ Kunne ikke lagre — lagring full`) + `console.error(e)`. In `proofConfirm()`, branch the success toast on the result. Add a size guard (~4 MB) and an export-to-JSON escape hatch. **S.**

#### M1 (Major) · No schema/version field; `load()` parses any shape with zero migration
- **What:** `load(){ try{ var raw=localStorage.getItem(LS_KEY); if(raw) return JSON.parse(raw); }catch(e){} return demo(); }` returns the blob verbatim — no version tag, no shape validation, no migration. The try/catch only fires on malformed JSON; an old-but-valid shape parses cleanly and is handed to renderers that assume new fields. `LS_KEY="onsite_day_v1"` is the only "versioning," and bumping it orphans (not migrates) data. `save()` additionally swallows errors (see C1).
- **Where:** `index.html:188,215-219`; `demo()` 190-210 (no version key). Consumed unguarded in render: `modulesHTML` `c.offer.modules.map` (2207), `c.contacts[0]`/`.slice()` (1998, 1269), `LAYERS[m.layer].recordOnly` (1360).
- **Why it matters:** Every future deploy that adds/renames a field carries an undeclared risk of bricking existing users' local data with no automated recovery — the documented "hit reseed to restore" gotcha. For an acquirer, the persisted blob is the product's only datastore and has no forward-compatibility story. (For a single-user local prototype, impact is bounded by the existing reseed escape hatch — but reseed is destructive and seed-only; see M2.)
- **Fix + effort:** Add `state.schema=N` in `demo()` and a `migrate(raw)` step in `load()`: branch on `schema`, run ordered forward migrations or backfill missing required keys; snapshot the old blob to a backup key before any reseed. **M.**

#### M2 (Major) · Reseed is the only recovery path — destructive and unavailable to a real returning user
- **What:** The de-facto "migration" is the user clicking Demo/reseed, which filters out `holtet-cust`/`solbakken-cust` and re-inserts current-shape seeds. By construction it never touches a user's own (non-seed) customer id, so it cannot fix a crash caused by **their** old-shape record; `clearCustomers` (the only other reset) wipes everything.
- **Where:** `onboarding.js` — reseed 2812, `clearCustomers` 2811 (`S().customers=[]`).
- **Why it matters:** Combined with C2's list-render crash, a returning real user can land on a fully blank Office/Sales view with no in-app way out (only devtools).
- **Fix + effort:** Ship the `load()`-time `migrate()`/normalize pass (M1) so recovery is automatic and applies to user-created records. Keep reseed as a demo-data convenience, clearly labelled destructive. **M.**

#### M13 (Major) · Deleting a zone orphans all its photo blobs in IndexedDB forever (no GC)
- **What:** `delZone` filters the zone and saves, but `z.photoIds[]` blobs are never deleted from IndexedDB. There is **no** garbage-collection/reconcile anywhere (`photoDel` is only called from the single-thumb delete and proof-draft discard). Every deleted zone permanently leaks ~100-200 KB/photo.
- **Where:** `onboarding.js:640` (`delZone`); `photoDel` 845, callers 912 & 1472. (Same leak from `clearCustomers`/`reseed` 2811-2812 — reported separately as a **Minor** since reset paths discard whole records.)
- **Why it matters:** Unbounded invisible growth the user cannot see or clear; inflates any future export/migration of the photo DB during the acquisition's data hand-off.
- **Fix + effort:** On `delZone`, `(z.photoIds||[]).forEach(photoDel)` before filtering. More robustly, add a load-time reconcile GC that walks all live `photoIds` and deletes unreferenced IDB keys. **S.**

#### M14 (Major) · Photo capped-LS fallback silently evicts oldest (live, referenced) proof images
- **What:** When IndexedDB is unavailable (private mode, some iOS WebViews — the field-device scenario), photos fall back to `localStorage` capped at `PHOTO_CAP=50`. `lsPut` evicts oldest by `ts` with no awareness of whether a blob is still referenced; the quota-catch branch deletes the two oldest with an empty inner catch (can silently no-op). The dropped `photoId` survives in `completionLog`, so `photoGet` later returns null and the proof renders a blank `<img>` — a completion that looks documented but whose evidence is gone.
- **Where:** `onboarding.js:810-821` (cap 815, quota-catch 818, toast 819).
- **Why it matters:** Silent data loss of the app's core "documented completion" value, gated behind (IDB unavailable AND >50 photos). The file header already says "PROD: offload to object storage."
- **Fix + effort:** Make eviction reference-aware (never evict a `pid` in any live `photoIds`), track bytes not count, surface a hard "storage full — sync required" state; mark orphaned `photoIds` so the UI shows "image unavailable." Long term: object storage. **M.**

#### M15 (Major) · Every top-level render destroys and rebuilds ALL Leaflet maps from scratch
- **What:** `renderExtras` unconditionally calls `destroyMap()` + `destroyOpMaps()`, then re-instantiates maps via `L.map()` + tileLayer + re-add every zone layer. `render()` runs on every view switch and after every `commit()`/`save+render`, so an unrelated checklist tick tears down a fully-initialized map, re-fetches tiles, re-parses geometry, and loses the user's zoom/pan.
- **Where:** `onboarding.js:1765-1774` (1767-1768); invoked from `render()` `index.html:346-363`; rebuild `buildMap`/`buildOpMap` 366,669. (Renders are discrete user actions, so jank is per-interaction, not sustained.)
- **Why it matters:** Visible flash + multi-hundred-ms jank on iPad with several zones; churns tile requests against Kartverket/OSM.
- **Fix + effort:** Cache/reuse map instances keyed by element id; rebuild only when the element is absent or the data hash changed; skip `destroyOpMaps()` on renders that don't touch the map. **L.**

#### M16 (Major) · IndexedDB connection cached with no `onblocked`/`onversionchange` (Safari hang)
- **What:** `idbOpen` opens once and caches `_idb` for the session with no `rq.onblocked` and no `db.onversionchange`. On a blocked open (second tab/PWA instance, future schema bump) neither `onsuccess` nor `onerror` fires, so `photoPut`/`photoGet` callbacks **never resolve** and no LS fallback triggers (the fallback only runs inside the callback). `_idbTried` also latches `null` permanently after one transient failure.
- **Where:** `onboarding.js:800-809`. (Live triggers: multi-tab/PWA + transient Safari/private-mode failures; in-app schema bump is not reachable since version is pinned at 1.)
- **Why it matters:** Photos appear to "hang" on save with no error and no fallback; one transient failure disables IDB for the whole session.
- **Fix + effort:** Add `rq.onblocked` (toast + LS fallback), set `_idb.onversionchange=()=>_idb.close()`, add an open-timeout that falls back to LS, and allow a retry instead of latching `_idbTried`. **M.**

#### Minor — Operational
- **(Minor)** `fetch()` responses never check `response.ok` — a 4xx/5xx with a JSON body is treated as a successful empty result, masking a 429/503 outage as "no results, fill in manually" — `onboarding.js:696-705,739-745,764-766`. Add `if(!r.ok) throw` before `r.json()`. **S.**
- **(Minor)** `handlePhotoCapture` treats a null `compressImage` result as a silently-skipped file — N failed photos still toast "N lagret (~0 KB)" — `onboarding.js:884-903`. Track a failed count and report saved vs failed. **S.**
- **(Minor)** completionLog is unbounded and double-serialized per zone-scoped entry (same `entry` pushed into customer + zone logs, `JSON.stringify` expands each independently → ~2× bytes) — `onboarding.js:1482-1483`. Store canonically on the customer log; derive zone views by filtering `zoneId`; add retention/eviction. **M.**
- **(Minor)** Unbounded in-memory base64 `photoCache` never evicts (only on explicit `photoDel`) — tens of MB pinned in JS heap on a field day, raising iOS background-tab-kill likelihood — `onboarding.js:798`. LRU cap, or store Blobs + `URL.createObjectURL`. **M.**
- **(Minor)** IDB↔localStorage split-brain: a put can fall back to LS on a transient tx error while `idbOpen` still reports the DB available; `photoDel` then deletes from IDB only (never `lsDel`), leaving a second orphan path — `onboarding.js:824-846`. On `photoDel`, delete from both stores. **S.**
- **(Minor)** `hydratePhotos` is fire-and-forget async; sets `src` on possibly-detached `<img>` after a re-render — wasted work + flaky thumbnails on slow devices, O(n) re-query per render — `onboarding.js:877-882`. Guard with `if(img.isConnected)`; abort stale hydrations with a render token. **S.**
- **(Minor)** Geolocation invoked with no secure-context guard — on `http://`/`file://` the generic "Location unavailable (denied)" misleads the tech into thinking they denied permission — `onboarding.js:716-728`. Guard `if(!window.isSecureContext)`; query `navigator.permissions` for a Settings hint on iOS. **S.**
- **(Minor)** Full-screen overlays use `position:fixed;inset:0` + `backdrop-filter:blur` + `92vh` sheets with no `env(safe-area-inset-*)` — GPU-expensive over a live Leaflet map on older iPads, and the iOS dynamic URL bar can hide bottom-sheet action buttons — `onboarding.css:357,410,467`, `index.html:95`. Solid scrim on coarse pointers; `100dvh` + safe-area padding. **M.**
- **(Minor)** Permanent Leaflet tooltips re-created per zone on every op-map build; board doc builds two maps at once — DOM/layout cost scales with zones × maps on coarse-pointer devices — `onboarding.js:503-516,678,2558`. Use `preferCanvas:true` / zoom-threshold tooltips. **M.**
- **(Minor)** `instKey` collision: `nPerYear`/seasonal occurrences of the same line resolving to the same calendar date share one completion key, silently under-counting (latent: current windows are weeks apart) — `onboarding.js:1373,1347-1348`. Add an occurrence/window index to the key. **M.**
- **(Minor)** Period (`mnd`/`år`) math is inverted in the `år` branch — `sum` is monthly, but `år` sets `totalYearly=sum` and `totalMonthly=sum/12` (latent: `c.period` is always `"mnd"` in shipped data) — `onboarding.js:1074-1075`. Treat line amounts as monthly canonical; use period only to pick the headline unit. **S.**
- **(Minor)** `removeLine()` splices the flat mirror only — never updates `m.lines`, `m.subtotal`, or totals, and the next `computeOffer` resurrects the line — `onboarding.js:1174-1179`. Set `review.decision='remove'` (durable) instead, or remove from `m.lines` and call `rebuildOfferFlat(c)`. **S.**

#### Nice-to-have — Operational
- **(Nice-to-have)** No storage-pressure telemetry or state export — first signal of quota is missing data after reload; no `navigator.storage.estimate()` — `index.html:219,468-478`. Add a size gauge + export/import JSON. **M.**
- **(Nice-to-have)** No total-bytes/quota accounting for photos; LS fallback record drops `kb` (per-batch `totalKb` toast does exist) — `onboarding.js:890-898,813`. Maintain a running byte total; persist `kb` in the LS record. **M.**
- **(Nice-to-have)** Print/`invalidateSize` paths gated on hardcoded `setTimeout` magic delays (60/90/180/200 ms) tuned for desktop — `window.print()` can fire before a map redraws on slow iPads — `onboarding.js:385,681,689,2570`. Use double-`rAF` and trigger print from map `load`/`moveend`. **S.**
- **(Nice-to-have)** Mid-session IDB drop-out routes all photos to the 50-cap LS store with only a soft toast — silent capacity degradation, no escalation — `onboarding.js:800-840`. One-time "Bildelagring redusert" notice; name LS eviction as proof-data loss. **S.**
- **(Nice-to-have)** `geotag()` 8 s blind wait with only a "Requesting location…" toast and no spinner/cancel (error handling itself is sound) — `onboarding.js:716-728`. Show a non-blocking pending indicator; allow tap-to-place to pre-empt. **S.**

---

### Lens 3 — Security & privacy

#### C2 (Critical) · `offerTotal()` dereferences `l.review.decision` unguarded — one old-shape offer crashes the whole Office/Sales render
- **What:** `review:{decision,comment}` was added to offer lines later. `offerTotal()` guards `if(!offer)` but then does `offer.lines.filter(l=>l.review.decision!=='remove')` with no guard on `l.review`. It runs for **every** offer-bearing customer inside the Office and Sales list `.map`s. A returning user with one customer whose persisted lines predate the field gets a `TypeError` that aborts the whole `.map`/`.join`, blanking the entire Office and Sales views.
- **Where:** `onboarding.js:1083-1086` (also `upsellTotal` 1088-1090); callers `renderOfficeExtras` 2436 (inside `list.map` 2432) and `pipelineHTML` 1798 (inside `list.map` 1790). `review` created only at 949/996, never backfilled; raw `JSON.parse` load (`index.html:215-218`) restores stale lines without it.
- **Why it matters:** A single stale record nukes two primary views with no try/catch and no graceful degradation — the exact mechanism behind "hit reseed to restore," and unrecoverable for a real user who can't safely reseed (M2). It is a security/robustness defect because the trigger is uncontrolled persisted shape drift across deploys.
- **Fix + effort:** Default review at read time: `(l.review||{}).decision` everywhere (or a `lineDecision(l)` helper), or normalize lines on load (M1). Belt-and-suspenders: wrap each customer-row render in try/catch so one bad record degrades to a placeholder. **S.**

#### M3 (Major) · `c.contacts[0]`/`.slice()` dereferenced without array guard in go-live + print
- **What:** `c.contacts.slice()` at 1269 (and `var ct=c.contacts[0]||{}` at 2465) assume `c.contacts` is an array; a record persisted before `contacts` existed has `c.contacts===undefined`, so `goLive()` throws **after** already pushing items into `st.items` (line 1237) — a half-converted state with no transaction boundary. (Note: `c.contacts[0]?` at 1096/1230/1237 are NOT "safer" — those also throw on undefined; the bug is broader, not narrower.)
- **Where:** `onboarding.js` — `goLive` 1230/1237/1269, `printOffer` 2465, `sendOffer` 1096. Reachable only via legacy/migrated data (current creation paths all init `contacts`).
- **Why it matters:** Corrupts the most important state transition (paying client → day-app tasks) with a partial, non-rolled-back `st.items`.
- **Fix + effort:** Use `(c.contacts||[])` consistently (already done at 1979). For `goLive`, validate the full record up front before mutating `st.items`. **S.**

#### M5 (Major) · completionLog grouped by UTC in one surface, LOCAL date in another
- **What:** `ts` is a UTC ISO string (`new Date().toISOString()`). `boardProofHTML` buckets by `ts.slice(0,10)` (UTC); `compileServiceReports` buckets by `iso(new Date(ts))` (LOCAL parts). For any completion logged ~22:00–01:00 Oslo time, the board day-divider and the Brøyterapport file the same event under different calendar dates, and the report id `customerId|service|localdate` (and `dateLongNo` header) is off by a day vs the board.
- **Where:** `onboarding.js` — `ts` written 1478; `boardProofHTML` 1533; `compileServiceReports` 2584; `iso()` 1330; report id 2587, header 2667.
- **Why it matters:** Customer-visible documentation discrepancy in the exact compliance artifact (styret-facing PDF) the product sells.
- **Fix + effort:** Standardize one timezone for date bucketing — align everything on `iso(new Date(ts))` (local), changing `boardProofHTML` line 1533 to match. **S.**

#### M6 (Major) · Stored XSS via building name in day-app add-item dropdown
- **What:** `openSheet()` builds the building `<select>` with `'<option value="'+b.id+'">'+b.name+'</option>'` — `b.name` raw, **no `esc()`** (the only name sink in `index.html` that skips it). `goLive()` copies a brreg-sourced customer name (`titleCase(e.navn)`, network-fetched) into `st.buildings[].name`, so a malicious/typo'd org name like `<img src=x onerror=...>` executes when the day-app sheet opens. CSP allows `'unsafe-inline'`, so the handler runs.
- **Where:** `index.html:289` (sink); `onboarding.js:1229-1231` (data flow); brreg source 1886, endpoint 734. CSP `vercel.json:13`.
- **Why it matters:** Stored DOM-XSS reachable through the normal onboarding→go-live→open-sheet flow; constraint is only that the payload arrives via the (semi-trusted) Norwegian company register.
- **Fix + effort:** `'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>'`. **S.**

#### M7 (Major) · Stored XSS via zone label in Leaflet tooltip — `zoneShort()` bypasses `esc()`
- **What:** `zoneShort()` falls back to the raw user-entered `z.label` (when `methodLabel(z)` is `''`, reachable e.g. for service `other`) with no `esc()`, and is passed straight to `poly.bindTooltip(zoneShort(z), {permanent:true})`. Leaflet 1.9.4's `DivOverlay._updateContent` assigns string content via `innerHTML`, so `<img src=x onerror=...>` executes when the permanent-label op-map renders. (`zoneTip`/`zonePopupHTML` correctly `esc()` the label — `zoneShort` is the lone gap.)
- **Where:** `onboarding.js:497` (sink), bound at 507 & 512; `z.label` from input 592/603; Leaflet sink confirmed in `vendor/leaflet/leaflet.js`.
- **Why it matters:** Stored XSS executing in a viewer's context when the operasjonskart renders.
- **Fix + effort:** `esc(methodLabel(z)||z.label||'')` inside `zoneShort` (`methodLabel` is a controlled enum, so escaping it is harmless). **S.**

#### M17 (Major) · Real named board members in plaintext localStorage on a shared, no-auth device
- **What:** brreg roles (`styreleder`, `styremedlemmer[]`, `forvalter`, `revisor`) and cockpit roster names are persisted as cleartext into `LS_KEY` on a device the app itself labels "Delt nettbrett i bilen — ingen pålogging." These are identifiable living persons = personal data under GDPR; anyone with physical/DevTools access reads every board member's name, role, building address, and operator identities, with no auth, no encryption, no erasure/retention path. (`fodselsdato` is correctly dropped; brreg data is from a public register; default rosters are fake placeholders — so this sits at the lower edge of Major.)
- **Where:** `onboarding.js:1895-1896` (roles), 1603/1618-1624 (roster); persistence `index.html:219`.
- **Why it matters:** Concrete data-protection liability an acquirer inherits (storage limitation, security of processing, lawful basis for third-party board members).
- **Fix + effort:** Treat board/roster names as PII: document "no real personal data" for the demo; for production move person data behind per-user auth + server storage, or at minimum encrypt-at-rest with an erasure/expiry path. **L.**

#### M18 (Major) · "Magic link / board access" is a label only — no auth implemented
- **What:** The toast "Offer sent — board access granted (email + magic link)" and the event log imply access control that does not exist — no token, no link, no gate. The whole board view is reachable via `OnSite.go('board')` (a bare view switch) with zero authz. A repo-wide grep finds "magic link" only in this one copy string.
- **Where:** `onboarding.js:1091-1101` (toast 1098); `go` `index.html:476`.
- **Why it matters:** Acceptable as a single-device demo, but the copy must not be mistaken for a built capability; if board surfaces were ever shared externally, all customers' offers and board PII would be exposed.
- **Fix + effort:** Relabel as "demo — no real access link"; gate the board surface behind server-issued, expiring, single-customer tokens before any external sharing. Document as a required pre-production item. **L.**

#### M19 (Major) · Public OSM/Nominatim/Kartverket endpoints used commercially — terms breach
- **What:** Clients hit `nominatim.openstreetmap.org`, `tile.openstreetmap.org`, and Kartverket's cache directly, with no identifying `User-Agent`/`Referer` (grep finds none). OSMF's Nominatim and tile-server policies forbid this kind of bulk/commercial use of the free public endpoints.
- **Where:** `onboarding.js` — nominatim 702-705; tile layers 373-374, 441, 674, 1501, 2624. (Kartverket's public cache is more permissive than OSM/Nominatim — that portion is weaker.)
- **Why it matters:** At scale the deployment IP gets blocked; a terms breach the acquirer inherits.
- **Fix + effort:** Before commercial scale, self-host or use a paid/SLA'd geocoder + tile provider (commercial Nominatim host, MapTiler, Mapbox, or a Kartverket agreement); set a descriptive `User-Agent`; add throttling/caching; document terms in the data room. **M.**

#### Minor — Security & privacy
- **(Minor)** `esc()` does not escape single-quote — latent attribute-breakout footgun (non-exploitable today since all attributes are double-quoted) — `index.html:464`. Add `'`→`&#39;` (and `` ` ``→`&#96;`) to the map. **S.**
- **(Minor)** Defense-in-depth gap: CSP `script-src 'self' 'unsafe-inline'` gives the two stored-XSS sinks no second line of defense — `vercel.json`. Long term, move inline JS external and adopt Trusted Types; short term, the two `esc()` fixes (M6/M7) are the priority. **L.**
- **(Minor)** Completion-log geolocation stored at full GPS precision while the UI only shows 5 decimals — over-collection of employee location, retained indefinitely on a shared device — `onboarding.js:1463-1464,1480`. Round on capture to displayed precision; document a retention limit. **S.**
- **(Minor)** CSP missing `object-src 'none'` and `frame-ancestors` (X-Frame-Options is the sole clickjacking control) — `vercel.json`. Append `object-src 'none'; frame-ancestors 'self'`. **S.**
- **(Minor)** Address/search strings (potentially names) sent in GET query strings to geonorge/brreg/Nominatim — third-party logs the vendor doesn't control, so "no PII leaves the client" is not strictly true — `onboarding.js:695,703,740,765`. Document the flows; prefer a server proxy/POST for name-bearing searches. **M.**

#### Nice-to-have — Security & privacy (positive confirmations)
- **(Nice-to-have)** Canvas re-encode (`toDataURL('image/jpeg',0.6)`) strips EXIF/GPS — a genuine privacy positive, but incidental to compression, not a tested guarantee — `onboarding.js:849-865`. Comment it as a relied-upon property; guard any future raw-File path. **S.**
- **(Nice-to-have)** Leaflet BSD-2 attribution intact inline; `api/` is empty (no serverless functions); zero secrets/keys/tokens in client; brreg `fodselsdato` never extracted — `vendor/leaflet/leaflet.js:1-4`. Optional polish: vendor a `LICENSE` file for the acquirer's license scan. **S.**

---

## 4. Prototype vs Production readiness

### Demo-grade — must be rebuilt before production

| Capability | Current state | Why it can't ship | Carry-forward? |
|---|---|---|---|
| **Persistence** | One `localStorage` blob; `save()` swallows quota errors (C1); no telemetry/export | Silent data loss; ~5 MB ceiling; single-device | Storage layer: **rebuild** |
| **Schema / migration** | No version field; `load()` parses any shape (M1); reseed is destructive seed-only recovery (M2) | Every deploy risks bricking local data; crash unrecoverable for real users (C2) | **Rebuild** (add versioning now) |
| **Auth** | None — "magic link/board access" is a toast string (M18) | No authz on board/office surfaces; PII exposure | **Rebuild** (server tokens) |
| **Multi-tenancy** | Global `OnSite.state`, no tenant/user/building scoping (M10); `completedInstances` flat across all clients | Cannot serve >1 customer/operator securely | Access layer: **rebuild** |
| **Server PDF / email / "board access"** | Client-side `window.print()`; no email/token issuance | Not a real delivery/access mechanism | **Rebuild** |
| **Photo storage** | IndexedDB + capped-LS fallback with silent eviction (M14) and no GC (M13) | Proof-image loss; orphan leaks | Move to **object storage** |
| **Rendering** | Full innerHTML re-render; all Leaflet maps rebuilt per render (M15) | Field-device jank; ~143 sinks assume one DOM | Move to component-scoped views |
| **Tiles / geocoding** | Public OSM/Nominatim/Kartverket, no User-Agent (M19) | Terms breach; IP-block at scale | Swap to paid/SLA provider |

### Genuinely reusable — the acquirable asset

- **Domain data shapes** — offer/module/line with first-class per-line `override` + `review` state, `included`/`startDate`/`indexationPct`/`cap` per severable module; geodesic zones carrying `service`/`method`/`area_m2`/`length_m`; `completionLog` proof records (`ts`/`by`/`team`/`geo`/`photoIds`); schedule-instance key `lineId|isoDate`. Serializable, tenant-agnostic, **backend-ready** (`onboarding.js:977-1066,1372-1404`).
- **Domain logic** — the zone/offer/proof engine, inline geodesic geo math (equirectangular, sub-0.1% error at building scale), the Norwegian brreg/geonorge registry-intake flow, and the (generic, reusable) schedule expansion engine.
- **UX patterns** — the 6-step sales→onboarding wizard, the field/board/office/cockpit role-split, the completion-proof capture flow, and the data-driven `CHECKLIST_TEMPLATE` profile pattern (the one place the code did extensibility right).
- **Edge robustness** — defensive `fetch().catch()`/null-vs-empty discipline, IDB graceful fallback, EXIF-stripping on capture.

### Due-diligence acquirer lens

- **IP cleanliness:** No secrets/keys/tokens in client; `api/` empty; brreg `fodselsdato` never extracted. Clean.
- **Dependencies/licenses:** Single vendored dependency (Leaflet 1.9.4, BSD-2, attribution intact inline). Minimal supply-chain surface. Add a `vendor/leaflet/LICENSE` file for the license scan.
- **Structure:** 3-file split is principled at the boundary (day-app owns state + `window.OnSite` bridge; onboarding consumes it; CSS cleanly `ob-` namespaced). **All** maintainability debt is inside `onboarding.js` (M11) — a refactor-before-extend liability to price in, not a structural defect across the app.
- **Terms risk:** OSM/Nominatim commercial usage (M19) is the largest unmitigated external liability; resolve before scale.

---

## 5. Top-5 prioritized action list

1. **Stop silent data loss on save** — fix C1 (`save()` returns a boolean, distinct error toast, branch the `proofConfirm` success toast, add a ~4 MB size guard + JSON export). Highest value: the product's core promise is provable completion, and today it can lie about saving. **Effort S.**
2. **Stop one stale record from blanking Office/Sales** — fix C2 (`(l.review||{}).decision` + try/catch around each customer-row render), and ship the `load()`-time `migrate()`/normalize pass with a `schema` version (M1) so recovery is automatic and non-destructive (retires M2 and M3's legacy-data crash). Removes the "hit reseed to restore" dead-end. **Effort S (crash guard) + M (migration).**
3. **Close the two stored-XSS holes** — `esc()` the building `<option>` (M6) and `zoneShort()` tooltip (M7), and harden `esc()` to escape `'` (Minor). Three one-line fixes that retire a whole class given CSP offers no backstop. **Effort S.**
4. **Make the offer total single-sourced and timezone-consistent** — fix M4 (one grand-total path, filter removed lines from `m.subtotal`) and M5 (bucket all completion dates on local `iso(new Date(ts))`). The generated offer/Brøyterapport is the contractual/compliance artifact; it must not show two prices or file work under the wrong day. **Effort S.**
5. **Plug the photo/storage leaks and Safari IDB hang** — `delZone`/reset paths call `photoDel` (+ a load-time reconcile GC) (M13), reference-aware photo eviction (M14), and `onblocked`/`onversionchange`/timeout on `idbOpen` (M16). De-risks both the field-device reliability story and the acquisition's photo-DB data hand-off. **Effort S–M.**

> Structural items (M8/M9 taxonomy + data-driven pricing, M10 storage/tenancy, M11 module split, M15 map reuse) are **not** in the top 5 because they are rebuild-scoped, not pre-demo blockers — but they are the work an acquirer must budget to turn this prototype into a product. The domain model underneath them is sound and carries forward.
