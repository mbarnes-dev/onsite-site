# OnSite — Code Review #2: full re-review at the production threshold

**Date:** 2026-07-01 · **Scope:** everything since Hardening Pass 1 (`dad3f7d`, 2026-06-21) — 36 commits — plus a regression audit of the first review (`CODE-REVIEW-FINDINGS.md`). · **Lens:** external technical due diligence (doc 30) + pre-production security gate (doc 79). **Report only — no code was changed in this pass.**

> Central question: **what must be true before a real tenant's data lives in the 1c app?** Findings are tiered so severity reads in context: a demo-grade shortcut is Critical in Tier 1 (production surface), possibly a note in Tier 3 (prototype body). Every claim below was verified against HEAD (`e9fe6c2`), not taken from docs or commit messages.

---

## 0. Inventory — what is actually in the repo (verified, not from docs)

| Artifact | Size / state |
|---|---|
| `index.html` | 661 lines / 41.5 KB — the **demo** day-app: state owner, `migrate()` (sv **12**), doc-64 cloud blob-sync to project `awyjzqgxfvoptyfvspxu` |
| `onboarding.js` | **4,864 lines / 402 KB** (was 2,944 / 220 KB at review #1 — **+65%**) — sales→onboarding + all phase-7–17 features, one IIFE |
| `onboarding.css` | 773 lines |
| `app.html` + `app.js` | 55 + 185 lines — the **1c production entry** (`/app` via cleanUrls) against **onsite-prod** (`btneqhrqnxmggwowboei`, eu-north-1, 16 RLS tables) |
| `packages/core` | `src/index.mjs` 450 lines, 40 exports; `index.d.ts` (34 declared); tests 10 |
| `core.bundle.js` | committed static bundle — **rebuilt and diffed: byte-identical to source, no drift** |
| `vendor/` | Leaflet 1.9.4 (BSD-2, attribution intact) + supabase-js **2.108.2** UMD (205 KB) |
| `supabase/` | `workspaces.sql` (demo blob table) + `functions/proxy/index.ts` (allowlisted proxy, 3 targets, deployed v3 to the **dev** project) |
| `api/` | empty (no serverless functions) |
| `vercel.json` | CSP + headers; connect-src lists **both** Supabase origins |
| Git | 54 commits total; working tree clean; **history secret-scan clean** (see T1-P below) |

**Core test suite: 10/10 green**, incl. the `computeOffer(Holtet) === 16 530` contract anchor. `SCHEMA_VERSION = 12` (`index.html:193`) — **note: three feature passes (17o/17p/17r) added persisted fields after sv12 with no bump**; see T2-3.

Entry points and their datastores — the split that now matters:

| | Demo (`/`) | Prod (`/app`) |
|---|---|---|
| Backend | `awyjzqgxfvoptyfvspxu` ("Onsite Dev") — `workspaces` blob, anon key, id-= -access | `btneqhrqnxmggwowboei` ("onsite-prod") — 16-table RLS schema, magic-link auth |
| localStorage keys | `onsite_day_v1`, `onsite_ws_id`, `onsite_overlays`, `onsite_photos` (+IDB `onsite_photos_db`) | `onsite_prod_email`, `sb-btneqhrqnxmggwowboei-auth-token` (supabase-js) |
| Key overlap | **none** (verified by full key inventory) | |
| Origin | **the same origin** — this is finding **T1-1** | |

---

## 1. Executive summary

The prototype body is in better shape than at review #1 where it was touched by the hardening pass — all six ticked fixes **held** (verified at HEAD, no regressions), the `@onsite/core` extraction is real and pure (0 DOM/storage reads in core, bundle == source, contract tests green), the four-way taxonomy is substantially unified behind `SERVICE_CATALOGUE`, and the new Ren Dunk surfaces largely honour the esc()/gated-save disciplines. The blob-sync bridge is what it claims to be — demo-grade LWW with a documented caveat — **except** its conflict notice is best-effort, not atomic: a check-then-write race can drop a save silently (T2-1).

**At the production threshold, the picture changes.** The 1c slice itself is small and mostly honest (RLS proven server-side including foreign-tenant insert rejection; no false-success writes; keys public-by-design; no secrets anywhere in git history). But it ships with four gate-blocking properties: **(1)** the prod app shares an **origin** with the 4,864-line innerHTML-rendered demo under a `'unsafe-inline'` CSP — any single future esc() miss in the demo is a stored-XSS that can read the prod session token from localStorage and act as the tenant; **(2)** login is **open-signup** — `signInWithOtp` without `shouldCreateUser:false` gives any email on earth an authenticated session; **(3)** the tenant is picked by `memberships … limit(1)` with no ordering — nondeterministic the day a user has two memberships, and writes key off it; **(4)** auth-failure states (expired/cross-device magic link) are silently swallowed. None of these is expensive to fix; all four must be fixed before Ren Dunk's real data goes in. The proxy edge function's allowlist is genuinely tight (no arbitrary-URL relay — verified), but it is an unauthenticated, un-rate-limited public endpoint burning third-party quota on our egress IP.

**Verdict in one line: the domain core is production-worthy; the 1c shell needs ~a week of auth/origin hardening before real tenant data; the demo and bridge stay demo-grade by declared design — and their declared boundaries mostly hold.**

---

## 1b. Remediation status — Gate-closing pass (2026-07-02)

Scoped to the doc-79 gate blockers + the two discipline leftovers. Each item verified before ticking.

- [x] **T1-1 (Critical) — origin isolation.** The prod app moved to its own deploy root `app/` and its own Vercel project on its own origin: **`https://onsite-prod-app.vercel.app`** (commits `ba974cd`, `46982f1`). Its own `vercel.json` copies the security headers then tightens: **`script-src 'self'` (no `'unsafe-inline'` — all JS external via `boot.mjs`)**, `connect-src` = the onsite-prod origin only, `geolocation=()`. The demo keeps `onsite-site.vercel.app` untouched; `/app`, `/app.html`, `/app/*` on the demo origin redirect to the new origin. *Verified live: new origin 200 with the strict CSP header; localStorage/token isolation now holds by origin (demo XSS can no longer read the prod session token); Vercel deployment-protection SSO disabled so the public app + magic-link redirects work.*
- [x] **T1-2 (Major) — closed signup.** `signInWithOtp` sends `shouldCreateUser:false`; unknown email → "Ingen konto for denne adressen — kontakt administrator". *Verified live against onsite-prod: fake email → refusal shown, `auth.users` unchanged (1 user, 0 probes); known email still sends.*
- [x] **T1-3 (Major) — deterministic tenancy.** All memberships fetched ordered by `created_at` asc (no bare `limit(1)`); 0 memberships → dedicated "Ingen tilgang" screen with sign-out; ≥2 → deterministic first + "· tilgang 1 av N" visible in the tenant chip; tenant re-resolved on every sign-in and on user change (`S._uid`), never cached across users. *Code-verified + refusal paths live-tested; the 0-membership end-to-end needs a throwaway dashboard user (Martin's checklist — no session can be minted client-side).*
- [x] **T1-4 (Major) — surfaced auth failures.** Redirect error params (query + hash: `error`/`error_code`/`error_description`) parsed on boot → visible message with a send-ny-lenke path, URL cleaned; expired-session writes read "Økten er utløpt — logg inn på nytt (arbeidet ble IKKE lagret)". *Verified live: simulated `otp_expired` redirect → message + recovery form, URL cleaned.*
- [x] **T1-5 (Major) — config as artifact.** `app/PROD-AUTH-CONFIG.md`: Site URL, redirect allowlist (app origin **only**), OTP expiry, rate limits, leaked-password protection — with a current-as-of block for Martin to initial. *Dashboard values themselves remain his checklist.*
- [x] **T3-2 / review-1 M12 — `delZone` re-prices.** Deletion flows through the `computeOffer`/`syncOfferTotals` seam. *Verified end-to-end: Holtet 16 530 → delete snow-machine zone → 15 337 (exactly −1 193), line gone, 0 dangling zoneIds; reseeded Holtet → 16 530; core anchor green.*
- [x] **T2-3 (discipline) — sv13.** `migrate()` backfills `c.renovasjon` / `assets[].bin` / `completionLog[].binwash` / `s.crewLang`; `SCHEMA_VERSION=13`. *Verified: hand-crafted sv12 blob → loads, migrates, all four backfilled, zero console errors.*
- [x] **T3-1 (Minor) — the four `dateNO()` sinks now `esc()`d.**
- [x] **Review-1 M18 (relabel half) — the demo toast/log no longer claim a magic link** ("demo — innlogging kommer i produktet"); the real magic-link auth is the `/app` product.
- [x] **T3-12 (Minor) — pl/lt + AqtiVann HMS text visibly marked "⚠ Maskinoversatt — under kontroll av morsmålsbruker"** until native review.
- [x] **T1-10 (part) — `onsite_prod_email` cleared on sign-out** (shared-device hygiene).

Still open from the gate list (deliberately not this pass): T1-6 proxy auth/rate-limit · T2-1 atomic blob-sync conflict (CAS) · the Tier-3 structural set. **Remaining before real tenant data: Martin's dashboard clicks per `app/PROD-AUTH-CONFIG.md` + sign-off.**

---

## 2. Tier 1 — production surface (reviewed at production severity)

### T1-1 · **Critical (gate)** — prod session token shares an origin with the demo's XSS surface
- **What:** `app.js` (supabase-js `persistSession:true`) stores the onsite-prod session in localStorage key `sb-btneqhrqnxmggwowboei-auth-token`, on the **same origin** (`onsite-site.vercel.app`) as the demo. The demo is 4,864 lines of string-concatenated `innerHTML` under `script-src 'unsafe-inline'` (`vercel.json:13`) — review #1 found two stored-XSS in exactly this surface, and this review found four new (low-exploitability) unescaped sinks (T3-1). localStorage is origin-scoped: **any** XSS anywhere on the origin reads the prod token and can act as the logged-in tenant against onsite-prod.
- **Where:** `app.js` client init (persistSession default true); `vercel.json` single CSP for all routes; demo sinks throughout `onboarding.js`.
- **Why it matters:** it couples the security of a real tenant's data to the weakest esc() call in a fast-moving 400 KB demo file. The demo's threat model ("single shared tablet, public-registry data") must not become the prod app's threat model by cohabitation.
- **Fix + effort:** host the prod app on its **own origin** (separate Vercel project or subdomain, e.g. `app.…`) before any real tenant data; keep the demo where it is. Longer term: CSP nonces/hashes for the prod app (its only inline script is the core-bundle module loader — trivially nonce-able). **M** (mostly deployment plumbing).

### T1-2 · **Major** — open signup: any email gets an authenticated session
- **What:** `sendMagicLink()` calls `sb.auth.signInWithOtp({ email, options:{ emailRedirectTo } })` **without `shouldCreateUser:false`** — the default creates a user. Anyone can sign up, confirm, and hold an `authenticated` JWT. RLS bounds the blast radius to *empty* (no membership → no rows, verified), but: auth.users pollution, email-sending on our quota, and an authenticated principal exists for any future policy that forgets the membership join.
- **Where:** `app.js` `sendMagicLink()` (~line 60).
- **Fix + effort:** invite-only for now: `shouldCreateUser:false` + a friendly "ingen konto — kontakt oss" on the refusal (the API already returns "Signups not allowed for otp" — verified live). Revisit when self-serve tenant creation ships. **S.**

### T1-3 · **Major** — nondeterministic tenant on multi-membership; stale-tenant writes
- **What:** `prodDb.myMembership()` = `from('memberships').select('tenant_id, role').limit(1).maybeSingle()` — no `order`, no multi-row handling. With 2+ memberships Postgres returns an arbitrary row; the user lands in a random tenant and `createBuilding` keys `tenant_id` off it. RLS `with_check` only rejects tenants the user is NOT in — with two legal tenants, a write can land in the *wrong legal* tenant with no error. Also read once per login: a membership revoked mid-session isn't noticed until a write fails (that failure IS surfaced — good).
- **Where:** `app.js` `prodDb.myMembership` (~52), `loadTenantAndBuildings` (~80).
- **Why it matters:** today there is exactly 1 membership, so it's latent — but the multi-tenant model is the product's core claim, and the very first FM company with two tenants (e.g. Bygårdsservice + Ren Dunk pilots) hits it.
- **Fix + effort:** select all memberships; 1 → proceed; >1 → explicit tenant picker persisted per session; 0 → the existing message. **S.**

### T1-4 · **Major** — magic-link failure states vanish silently
- **What:** an expired/used link, or a link opened in a different browser (PKCE verifier lives in the original browser's storage), redirects back with error params — `app.js` neither parses `?error=`/`#error_description` nor surfaces `onAuthStateChange` failures. The user sees a fresh login screen with no explanation. The happy path and the "Åpne den på denne enheten" hint exist; the unhappy paths are mute.
- **Where:** `app.js` boot block (~169-183); no URL-error handling anywhere.
- **Fix + effort:** on boot, read error params → render `.msg.err` ("Lenken er utløpt / åpnet i en annen nettleser — send en ny"); clear the params. **S.**

### T1-5 · **Major** — auth **configuration** is unverifiable from the repo (gate checklist)
- **What:** three things live only in the Supabase dashboard and gate the login loop: (a) the **redirect allowlist** must include `https://onsite-site.vercel.app/app` (and localhost dev) or `emailRedirectTo` is ignored; (b) OTP/link expiry + rate limits; (c) signup policy (see T1-2). None is in code; none could be verified in this review. Supabase's own security advisor adds one WARN: **leaked-password protection disabled** (moot for magic-link-only, but free to enable).
- **Fix + effort:** verify/set all four in the dashboard; record the settings in `CLOUD-SETUP.md` (or a new `PROD-SETUP.md`) so they're reviewable. **S.**

### T1-6 · **Major** — the `proxy` edge function is an unauthenticated public endpoint (documented for regnskap; now ×3 targets)
- **What:** `verify_jwt=false` + `Access-Control-Allow-Origin:*` + no rate limiting. The allowlist itself is **tight** — verified: fixed target keys only, `regnskap` orgnr `^\d{9}$`, `tommekalender` params digit/charset-validated and double-encoded (no way to smuggle a foreign host or extra query into the upstream), `orthophoto` inert without `NIB_TOKEN`. So it is *not* an open relay — but anyone on the internet can burn brreg/Norkart quota through our egress IP (Norkart bans by IP), and the tommekalender target added a second live upstream to that exposure.
- **Where:** `supabase/functions/proxy/index.ts` (deployed v3 — deployed this session from this exact file).
- **Fix + effort:** for the demo, acceptable-as-documented; **before prod use**: require the Supabase anon JWT (`verify_jwt=true` — both apps already hold one) + a simple per-IP rate limit, and split demo/prod proxies per project. **M.**
- **Related (Minor):** the `RenovasjonAppKey` fallback is hardcoded in the committed source of a **public repo** (`index.ts:61`). It is a publicly-circulated key and the env override exists — but env-only would be cleaner. **S.**

### T1-7 · Key hygiene — **clean (positive confirmation, verified in history not just HEAD)**
- `git log --all -S` over all 54 commits: `service_role` appears **only in comments/docs** ("NEVER put the service_role key here"); zero hits for `sb_secret`, `SUPABASE_SERVICE`, `NIB_TOKEN=`, private keys; **no `.env` file ever committed**. Client holds exactly the two public-by-design keys (demo anon JWT, prod publishable key). `NIB_TOKEN` is `Deno.env`-only. ✔

### T1-8 · Demo/prod separation — **holds at the storage layer; fails at the origin layer**
- Full localStorage/IndexedDB key inventory (see §0): **zero shared keys**; `app.js` never touches demo state, `onboarding.js`/`index.html` never touch onsite-prod. Visually distinct (PROD tag). The one coupling is T1-1 (same origin). One process risk: `app.html` pins `core.bundle.js?v=17r` **separately** from `index.html`'s pin — the next demo version bump will silently leave the prod app on a stale-cached core. Add the app pin to the bump checklist or use one include. **Minor, S.**

### T1-9 · `@onsite/core` — **solid, with edges fraying**
- **Positive (verified):** purity holds — `grep` for `document|window|localStorage|navigator` in `src/index.mjs` hits only comments; committed bundle is byte-identical to a fresh rebuild; 10/10 tests incl. the Holtet 16 530 anchor and doc-37–44-derived fixtures; determinism/idempotency tested.
- **T1-9a (Minor):** `index.d.ts` has drifted — **6 exports undeclared**: `addDays`, `aggregateBruksenheter`, `layerToService`, `mondayOf`, `parseBruksenhet`, `ymd`. **S.**
- **T1-9b (Minor):** the newest core logic is untested — the 17m count-marker aggregation (`opt:mk:` optionLines) and the whole marker-model (non-checklist) pricing branch have no test; the Holtet anchor never exercises them. A wrong Heis×4 option is customer-visible money. **S.**
- **T1-9c (Minor):** engine logic is accreting **app-side again** post-extraction: `markerPrice` (`onboarding.js:207` — the pricing that produces `m.price`, which core then consumes), `walkTotal` (3842), `operabilityPct` (1920, a scoring engine), `layerTally` (208). Same-shaped drift risk that motivated doc-55. Fold into core on next touch. **M.**

### T1-10 · Failure honesty in the 1c slice — **passes the C1 bar (positive)**
- `addBuilding`/list surface every error; success toast only on a confirmed insert (`!r.error`); offline/dead-session → supabase-js error → visible `.msg.err`; "JWT expired" mapped to a re-login hint. No silent loss, no false success. ✔ (Two nits: `renderApp` full-innerHTML re-render wipes the add-form on an error render — user retypes; `updateBuilding` is exported dead code until an edit UI ships. **Nice-to-have.**)
- `onsite_prod_email` convenience key persists the operator's email on a shared device and survives sign-out — clear it in `signOut()`. **Minor, S.**

### T1-11 · `vercel.json` CSP — **tight and exactly matching (positive)**
- connect-src enumerates precisely the hosts the code calls (geonorge ws/wfs, brreg, both Supabase origins, NVE, NGU); img-src matches the tile/WMS sources; `object-src 'none'`, `frame-ancestors 'self'` present (review-1 minors fixed). The one structural weakness is `script-src 'unsafe-inline'` — required by the demo's inline IIFE, inherited by the prod route → folds into T1-1's separate-origin fix (then nonce the prod app). No over-broad additions crept in during the fast passes. ✔

---

## 3. Tier 2 — the bridge (doc-64 blob-sync; demo-grade **by design** — does the declared boundary hold?)

### T2-1 · **Major (in-tier)** — the LWW conflict notice is best-effort, not atomic: close races drop a save **silently**
- **What:** `cloudFlush()` (`index.html:343-366`) does `select rev` → *(async gap)* → **unconditional** `upsert rev+1`. Two devices with interleaved debounced saves both read `rev=N`, both pass the `serverRev > base` check, both write `N+1` — the second silently overwrites the first. The "Oppdatert på en annen enhet" toast only fires when the check itself catches the skew. The doc-64 caveat says last-write-wins *with* a conflict notice; the notice has a hole exactly in the race window the caveat is about.
- **Fix + effort:** make the write conditional — `update … .eq('rev', base)` and treat 0 rows as conflict (or a tiny RPC compare-and-swap); or explicitly document "sub-second cross-device races can drop one save". **S/M.**

### T2-2 · **Minor** — sync-chip truthfulness gaps at the edges
- No timeout on any cloud op → a stalled fetch leaves the chip on "synker…" forever; the 1.2 s debounce has no `beforeunload`/`visibilitychange` flush → closing the tab inside the window loses the cloud write (local copy intact, so single-device users never notice; cross-device users see stale state until the next save). Otherwise the state machine (`idle/syncing/synced/offline/conflict`, `index.html:375`) is honest and set on every path — verified. **S.**

### T2-3 · **Minor (discipline)** — sv12 is stale: three passes of schema drift with no migrate step
- `c.renovasjon`, `assets[].bin`, `completionLog[].binwash`, `st.crewLang` (commits 17o/17p/17r) were added with **no `migrate()` backfill and no sv bump** (`migrate()` ends at v12/`c.hazards` — verified line-by-line). It *works* because every reader is defensively guarded (`(c.assets||[])`, `e.binwash` truthy-check, `(st.crewLang||{})` — verified), and an old-shape blob arriving cross-device loads fine. But the declared discipline is "schema change → migrate + bump", and it lapsed silently three times. Either bump sv13 with explicit backfills or write down the guarded-read convention as the new rule. **S.**

### T2-4 · **Minor (boundary check)** — the "workspace-id = access" caveat holds, but its PII payload grew
- The blob now cloud-syncs: real board-member names from brreg (public register, names only, `fodselsdato` dropped — unchanged), roster/crew first names, and now **crew language preferences keyed by name** (17r). Photos verifiably do **not** sync (IDB/photoCache only — re-checked). Anyone with the anon key + a workspace id reads/writes that workspace (documented). Within the demo's declared "public-registry + first-names" boundary — but this is review-1's **M17 with a wider blast radius** (device → cloud). Must not carry a single step further (no emails, no phone numbers, no real crew surnames into seeds or demos). **Note.**

### T2-5 · Positives (verified)
- Cloud pull runs through the **same `migrate()`** as local load (`index.html:324`) ✔ · a cloud failure can never break or fake the local save — the C1 gate reads only the localStorage write, `cloudSaveSoon()` fires after (`save()`, `index.html:285-297`) ✔ · prod entry shares no keys with the bridge (T1-8) ✔ · rev-inflation on idle reloads is the known cosmetic minor and stands.

---

## 4. Tier 3 — the prototype body (regression + growth audit)

### Discipline spot-checks on everything added since the hardening pass

- **T3-1 (Minor)** · Four unescaped `dateNO()` sinks — `onboarding.js:1144`, `1147` (×2), `4525`: remote-derived (tømmekalender) / persisted date strings concatenated into innerHTML without `esc()`. Exploitability is heavily bounded (the value is `String(s).slice(0,10)` upstream — 10 chars), but the house rule is escape-at-sink, and these are the only misses found in all the new surfaces. Everything else checked clean: `hazardNoteHTML` (radon class esc'd), vaskerapport (all `bw.*`/names esc'd), instruction card, bin fields, marker-popup aggregate, finance card, cockpit roster. **S.**
- **T3-2 (Major in-tier)** · **Review-1 M12 is still open** — `delZone` (`onboarding.js:761`) frees photos (M13 ✔) but still never calls `recomputeOffer`: deleting a priced zone leaves the stale offer line, stale totals, and a dangling `zoneId` until the next unrelated recompute. It was never in the hardening scope, and three walkaround-heavy passes later it's more reachable than in June. **S.**
- **T3-3 (Minor)** · Gated-`save()` discipline: held on every money/proof path (checked: `proofConfirm` full rollback intact at 1969-1998; asset save/delete rollbacks intact); lapsed on two new *low-stakes* writes — `setCrewLang` (2135) and the tømmekalender cache write (1133) ignore the return. Acceptable; note the convention boundary ("preferences may be ungated"). **S.**
- **T3-4 (Minor)** · Old-shape record: hand-verified against `migrate()` + guarded reads — a pre-17o record loads, gets `rendunk-cust` back-seeded, renders all views. ✔ (but see T2-3 — this works by convention, not by migration).

### Growth & structure

- **T3-5 (Minor, trending Major)** · `onboarding.js` 2,944 → **4,864 lines (+65%)**; the god-switch dispatcher is now **132 cases** (was ~79); print routines now **5** near-identical (`printMapCard/printOffer/printBoard/printSnowReport/printWashReport`) + a 6th isolation pattern in CSS. Review-1's M11/M15 stand unchanged (single IIFE; full-innerHTML re-render destroying/rebuilding **all** Leaflet maps per render — and there are *more* maps now: teig underlay, hazard overlays, wash panels). Complexity is still mostly landing in data/engines (catalogue + core) per doc 62 — the screens/dispatcher are where it leaks. **L (rebuild-scoped, as before).**
- **T3-6 (Minor)** · Dead code grew: review-1's five dead functions all still present (`checklistLine`, `upsellTotal`, `stagesRailHTML`, `offerLinesHTML`, `offerUpsellsHTML` — verified: definition is the only reference), plus `brregStreet` (documented dead) and `removeLine`'s splice-only bug still has a live call site. **S** to sweep.
- **T3-7 (Minor)** · Review-1 latent minors re-verified as still open: `instKey` occurrence collision (`onboarding.js:1800`), completionLog double-store-by-reference (1982), unbounded in-memory `photoCache` (1200), fetch `response.ok` checked on only 2 of 11 fetch sites (the new regnskap/tømmekalender paths do check — the older geo paths don't), no `isSecureContext` guard on geolocation. None escalated; none fixed.

### Correctness, performance, PII, licensing

- **T3-8 (spot-checks, pass)** · Offer recompute after the Ren Dunk/catalogue additions verified live this session (bin-wash kr 600/mnd line; Holtet unchanged 16 530). Core date model is consistently **local-time** (`ymd`, `setDate` — no UTC mixing; DST-safe at date granularity) with an implicit device-TZ (Europe/Oslo) assumption — fine for the market, worth one comment. Geodesic math unchanged and tested.
- **T3-9 (Minor)** · Performance posture on tablet: unchanged architecture (full re-render + map rebuild) now carries more per render — teig polygons, entrance pins, optional WMS overlays (off by default ✔), fatter completionLog. No new pathological path found; the cost curve is M15's, steepening. Revisit with M15.
- **T3-10 (Minor)** · PII drift: crew first-names + per-person language now persisted and cloud-synced (see T2-4); `onsite_prod_email` on shared devices (T1-10); photo EXIF/geo still stripped by the canvas re-encode path (re-verified — unchanged code). The seeded Ren Dunk contact is fictional ✔; the two remaining real-person surfaces are the documented brreg board names and self-entered roster names.
- **T3-11 (pass)** · Licensing/attribution on **all** current map layers verified in code: Kartverket (`© Kartverket` on all six tile layers), NGU/DSA + NVE attribution strings on every WMS overlay (`makeHazardOverlays`), `Norge i bilder (demo)` on the (gated-off) ortho base, OSM/Nominatim still fully absent (0 references). Leaflet BSD-2 header intact. ✔
- **T3-12 (Minor, content not code)** · The pl/lt translations in `TASK_I18N` — including the AqtiVann **HMS/safety** text — are machine-authored and unreviewed by native speakers, and the UI presents them as authoritative safety instructions. Have a native speaker (or the partner's crew) review before demoing to Ren Dunk as an HMS feature. **S.**

---

## 5. Verdict on the doc-79 gate

**Can a real tenant's (Ren Dunk's) data live in the 1c app today? Not yet.** The backend is ready (RLS proven, including cross-tenant read/write denial); the client slice is honest; but the **surrounding shell** fails the gate on four concrete points. The gate list, in order:

1. **Move `/app` to its own origin** (separate Vercel project/subdomain) so the prod session token no longer cohabits with the demo's `'unsafe-inline'` innerHTML surface. *(T1-1 — the only Critical.)*
2. **Close signup**: `shouldCreateUser:false` until invite-flow exists. *(T1-2)*
3. **Dashboard audit, recorded in the repo**: redirect allowlist (`…/app` + localhost), OTP expiry, auth rate limits, enable leaked-password protection. *(T1-5)*
4. **Deterministic tenancy**: handle 0/1/N memberships explicitly; never `limit(1)` an identity decision. *(T1-3)*
5. **Surface auth failures** (expired/cross-device links). *(T1-4)*
6. **Proxy decision**: it currently serves the demo from the dev project — fine; if anything prod-facing ever routes through it, `verify_jwt=true` + rate limit first. *(T1-6)*
7. **Before the photo port** (next slices): the private `photos` bucket's policies were not reviewable in this pass — review them with the same RLS rigor before any upload code, and strip EXIF server-side or keep the canvas re-encode.
8. Keep the demo boundary: no real personal data beyond the public register in any seed/workspace *(T2-4)*, and no demo code ever touching the prod origin *(holds today — keep it tested)*.

Items 2–5 are each **S**; item 1 is **M** (deployment plumbing). This is roughly a week, not a quarter — the doc-78 sequencing survives contact with the review.

---

## 6. Status audit of `CODE-REVIEW-FINDINGS.md` (every item, verified at HEAD — ticks were checked, not trusted)

| # | Review-1 finding | Status now | Evidence |
|---|---|---|---|
| C1 | `save()` swallows quota errors | **Fixed — verified, holds** | `index.html:285-297` returns false + honest toast; money/proof callers gated with rollback (`proofConfirm` 1969-1998). New low-stakes writes ignore the return (T3-3) — doesn't regress C1's promise |
| C2 | `l.review.decision` blanks Office/Sales | **Fixed — verified** | `lineRemoved()` guard in core (`core:86`), delegated (`onboarding.js:1399`); `migrate()` `fixLine` backfills |
| M1 | No schema/migration | **Fixed — verified** (then drifted) | `migrate()` sv12, idempotent, runs on local load **and** cloud pull. Discipline lapsed post-17o → T2-3 |
| M2 | Reseed only recovery | **Fixed via M1** | automatic migration retires the dead-end; reseed remains a demo convenience |
| M3 | `c.contacts` unguarded derefs | **Mitigated via M1** | raw derefs still exist (`1421,1556,1563,1595,3760,4044,4252`) but `migrate()` guarantees `contacts:[]` on every load path — safe; style debt only |
| M4 | Two grand totals | **Fixed — verified** | single `syncOfferTotals` in core with `lineRemoved` filter (core:149-155); Holtet anchor pins it |
| M5 | UTC vs local day-bucketing | **Fixed — verified** | local `iso(new Date(ts))` both surfaces (`onboarding.js:2034` comment + code) |
| M6 | XSS building `<option>` | **Fixed — verified** | `index.html:456` both esc'd |
| M7 | XSS zone tooltip | **Fixed — verified** | `zoneShort` esc (`onboarding.js:616`) |
| M8 | 4-way service taxonomy | **Largely fixed** | `SERVICE_CATALOGUE` (Phase 8) is the single source for cadence/area/method/service + BACKBONE.md contract; LAYERS/SERVICE_LIST/MOD_* persist as bounded views. Residual: adding a service still touches >1 table |
| M9 | Pricing not data-driven | **Partially fixed** | `rateKey` exists; formulas still hand-authored per line — but now in **tested core** with the 16 530 contract anchor, which was the actual risk. Residual: MOD_ORDER omission still silently drops a service |
| M10 | Global single-tenant store | **In progress by design** | the answer is 1c/onsite-prod (real tenancy, RLS), not a demo retrofit. Demo unchanged as declared |
| M11 | One 2,929-line IIFE | **Open — worse** | now 4,864 lines / 132-case dispatcher (T3-5) |
| M12 | `delZone` no offer recompute | **⚠ STILL OPEN** | `onboarding.js:761` — never was in hardening scope; flagged again as T3-2 |
| M13 | Zone-photo IDB leak | **Fixed — verified** | `delZone` frees via `zonePhotoIds→photoDel`; `photoGC()` on reset paths |
| M14 | LS photo eviction | **Partially fixed** | eviction toast is now honest; eviction itself still count-capped, not reference-aware |
| M15 | Destroy/rebuild all maps per render | **Open — worse** | `onboarding.js:3367-3368`; more maps exist now (T3-5/T3-9) |
| M16 | IDB no onblocked/onversionchange | **Fixed — verified** | full fix incl. 3 s open-timeout, waiter queue, no `_idbTried` latch (`idbOpen`) |
| M17 | Real names in plaintext on shared device | **Open — blast radius widened** | unchanged in kind, but the blob-sync now puts the same names in a cloud row readable by workspace-id (T2-4). Documented demo caveat; hard stop at the prod boundary |
| M18 | "Magic link" label-only | **Split** | demo copy still fakes it (`onboarding.js:1423` — relabel still pending); the **real** magic-link auth now exists in `/app` (1c). Close by relabelling the demo toast |
| M19 | OSM/Nominatim terms breach | **Fixed — verified, no regression** | 0 references; all six Kartverket layers attributed; new WMS providers attributed (T3-11) |
| Minor: `esc()` quote gap | **Fixed** (hardening) — re-verified in `esc()` map |
| Minor: CSP `object-src`/`frame-ancestors` | **Fixed** — present in `vercel.json` |
| Minor: fetch `.ok` unchecked | **Open** (2 of 11 sites check; new code does, old doesn't) |
| Minor: period-inversion (år branch) | **Open, still latent** (`core:153-154`; all shipped data `mnd`) |
| Minor: `instKey` collision · photoCache unbounded · completionLog double-store · dead fns ×5 · print duplication · god-switch | **All open, all still latent** — dead fns and print/dispatcher duplication grew (T3-5/6/7) |
| Minor: geolocation secure-context · hydratePhotos isConnected · safe-area CSS · GET-with-names to registries | **Open — not re-verified in depth this pass** (no code movement observed in those regions) |
| Nice-to-have set (export/import, storage telemetry, print rAF, etc.) | **Open** — unchanged |

**Audit summary:** all 6 hardening ticks genuinely fixed and held; 3 more review-1 Majors retired since (M13, M16, M8-mostly) plus M1/M2/M3 by migration; **one Major (M12) slipped through every pass since June and is still live**; the structural set (M10/M11/M15/M17) stands as declared rebuild-scope — with M10's real answer now under construction as 1c.

---

## 7. Top-5 prioritized actions

1. **Separate the prod app's origin** (own Vercel project/subdomain for `/app`), then nonce its one inline script. Retires the only Critical (T1-1): demo XSS ⇏ prod session theft. **M.**
2. **Lock the auth shell in one small `app.js` pass + one dashboard pass:** `shouldCreateUser:false` (T1-2), surface redirect/PKCE errors (T1-4), deterministic 0/1/N-membership handling (T1-3), clear `onsite_prod_email` on sign-out (T1-10), record the dashboard settings in the repo (T1-5). **S × 5.**
3. **Sweep the two review-leftovers that touch money and discipline:** `delZone` → `recomputeOffer` (M12/T3-2, one line + a test), and esc() the four `dateNO` sinks (T3-1). **S.**
4. **Re-arm the schema discipline:** bump sv13 backfilling `renovasjon`/`bin`/`binwash`/`crewLang` (or codify the guarded-read convention), and add the missing core tests + d.ts entries for the 17m marker-aggregation and A2 exports (T2-3, T1-9a/b). **S.**
5. **Harden the write-side of the bridges before more demos ride them:** conditional-upsert (rev CAS) so the blob-sync conflict notice is atomic (T2-1), and decide the proxy's future — demo-only as-is vs `verify_jwt` + rate-limit (T1-6). **S/M.**

> Deliberately **not** in the top 5: the structural set (M11 module split, M15 map reuse, M17 PII-at-rest) — unchanged advice from review #1: rebuild-scope, priced into the production track (doc 78 phases), not pre-demo blockers. The domain core underneath is in the best shape it has been: pure, tested, single-sourced, and now provably identical between source and shipped bundle.
