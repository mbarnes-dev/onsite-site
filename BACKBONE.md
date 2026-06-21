# OnSite backbone — catalogue + persistence contract

*Phase 8 (doc 54). Read this before adding a service or changing a persisted shape.*

## 1. SERVICE_CATALOGUE — the single source of truth

One object in `onboarding.js`, keyed by **task/service id**, is the home for every
cross-cutting fact about a service. It replaced four scattered, separately-keyed
structures (`SCHEDULE_MAP`, `AREA_OF_ITEM`, `METHOD_OF_ITEM`, `serviceOfTask/byCat`).

```js
var SERVICE_CATALOGUE = {
  roof: { cadence:{type:"dateAnchored",anchor:"autumn"}, area:"tak", method:"stige", service:"technical" },
  ...
};
```

| facet | meaning | read via | consumed by |
|---|---|---|---|
| `cadence` | schedule cadence (omit = not on the calendar plan) | `catCadence(id)` | `scheduleLines` → `generateInstances` (schedule, Årsplan) |
| `area` | doc-38 walkaround area (default `"ute"`) | `catArea(id)` | `areaOfLineId` → while-here co-location |
| `method` | equipment heuristic (`stige/lift/maskin/manuell`) | `catMethod(id)` | `methodOfLineId` → while-here co-equipment |
| `service` | pricing/classification bucket (`snow/grass/cleaning/technical/compliance/other`) | `catService(id)` | `serviceOfTask` → cockpit team scope, while-here |
| `rateKey` | dotted path into `RATES` (informational link) | — | `computeOffer` reads `RATES` (formulas still inline — see §3) |
| `checklist`,`label`,`zone`,`cat`,`captureType`,`emoji`,`freq`,`upsell`,`compliance` | walkaround display facets | folded in at init; `instantiateChecklist()` | the walkaround |

**Read only via the `cat*()` accessors** — never index a removed map.

### Adding a service (one edit)
Add one catalogue entry. With `checklist:true` + display facets it appears in the
**walkaround**; with `cadence` it appears in the **schedule/Årsplan**; `area`/`method`/
`service` drive **while-here** (co-location/co-equipment) and **cockpit** team-scoping;
`compliance:true` flags it statutory. Verified by the Phase-8 demo (a `taktest` entry
surfaced in the checklist (41→42) and the schedule, then was removed).

### Known follow-ups (deferred, scoped out of this pass)
- **Pricing formulas.** `RATES` is data referenced by dotted `rateKey`, but `computeOffer`'s
  per-line **formulas** (qty × rate) are still inline. A new priced service needs a formula
  there; full data-driven pricing is the next increment.
- **Display facets** for *existing* items are still authored in `CHECKLIST_TEMPLATE` and folded
  into the catalogue at init (so the catalogue is the single *runtime* source). New services can
  be authored entirely in the catalogue.
- **Module split** (`data/engine/store/views` files) — deferred; the file is sectioned by banners.
- **Op-map / zone-draw** styling is still keyed by `zone.service` (`SERVICE_LIST`); link, not merged.

## 2. Persistence contract (`store`)

- **One store**, `localStorage["onsite_day_v1"]`, holding the whole `state` object.
  Photo binaries live **outside** it in IndexedDB (`onsite_photos_db`), records keep only `photoIds[]`.
- **`schemaVersion` + `migrate()`** (`index.html`). On load, `migrate(JSON.parse(raw))` runs an
  **idempotent** forward pass that backfills fields added in later phases (`review`, `zones`,
  `completionLog`, `contacts`, `travel`, `upcoming`). **When you change a persisted shape: bump
  `SCHEMA_VERSION` and add the backfill in `migrate()`** — never assume an old record has a new field.
- **Gated `save()`** (`index.html`) returns `true|false`; on `QuotaExceededError` it surfaces an honest
  toast and returns `false`. **Any writer that toasts success must branch on the result** (e.g.
  `proofConfirm` rolls back its mutations on a failed save — never a false "✓ dokumentert").
- **Photo lifecycle.** `photoDel(id)` clears both IndexedDB and the LS fallback. Deleting a zone
  reclaims its blobs (`zonePhotoIds`); `clearCustomers`/`reseed` run `photoGC()` — a reconcile that
  deletes any blob not referenced by a live record (`collectLivePhotoIds`).
- **IndexedDB open** (`idbOpen`) handles `onblocked`/`onerror`/version-change and an open-timeout
  (Safari/private-mode), coalesces concurrent opens, falls back to the LS photo store, and retries on
  the next call (no permanent latch). `// PROD: move record + photo persistence to a backend.`

## 3. Regression anchor (must stay green on any backbone change)
1. Holtet computed offer = **kr 16 530/mnd**; Solbakken intact.
2. Full chain: registry prefill → walkaround zones+photos → tiered offer → op-maps → board doc →
   schedule/Årsplan → completion proof → Brøyterapport → cockpit → **while-here (Holtet headline =
   Takrennerens 📍+⏰+🔧)**.
3. Old-shape localStorage migrates; gated `save()`, `esc()` (covers `'`), Kartverket/geonorge-only.
4. Zero console errors, local + prod.
