# Code review #3 — the offline-first production app, adversarially

**Date:** 2026-07-14 · **Scope:** everything since the review-2 remediation (`82df58d..HEAD`, 18 commits) · **Reviewer stance:** the engineer signing off (a) doc-80 sync semantics and (b) the kroner the app now computes for a real prospect.
**Method:** git log as the only authoritative pass list; full re-read of `offline.js` (v4, 344 lines) and every money-path function in `app.js` (3 000 lines); targeted greps for esc/PII/CSP; live SQL probes (read-only + rolled-back) for constraints; core suite executed. Zero code changes shipped; no deploys; no temp files left.

## In-scope commits (authoritative)

```
53ef554 desk mode D — batch photos, assignment tray, document ingest
c03141f self-conflict fix — coalesce pending class-B edits
8296ca5 retrigger Vercel deploy (webhook dropped e4c2568)   ← ops signal, see F-M6
e4c2568 onboarding C — befaring checklist + computed, severable offer
e347d3a onboarding B1 — map + zones
881e6f8 onboarding A — Step-0 registry prefill
b5473f1 / 6662b8c docs(auth) — Management API pass + OTP-email defer
6b83559 field findings #1 — photo-attach honesty + landscape keyboard
d9dfa59 OTP code login (SHIPPED — contrary to at least one session memory; the log wins)
27ef4e2 contacts + install prompt · 07be571 offline v1.5 · d5c9f07 offline v1
f34c7a0 landing tweak (demo) · ddaced7/dbc15cc/ec11ec5/68748cf 1c-2
```

**Step-0 inventory:** `app.js` 3 000 · `offline.js` 344 · `sw.js` 59 · `app.css` 190 lines. Version chain **consistent**: index.html (css v8 / offline v4 / app v14 / boot v2) == SW SHELL == CACHE `onsite-app-v14`; `boot.mjs?v=2` imports `core.bundle.js?v=2` (both precached). Core bundles in **both** deploy roots rebuilt + diffed: **identical to source**. Core suite: **10/10 pass**. Working tree clean. Every per-pass harness (v1 airplane, v1.5, small-pass, field, onboarding-A, zones, coalesce, desk) was temp-deleted after its run — see **F-M5**.

---

## Findings

### Critical

None. (Weighed F-M2 for Critical — silent loss of a saved edit is the worst consequence class — but the interleaving window is milliseconds wide and requires a same-row double-save racing the drain; Major with priority-1 urgency is the honest rank.)

### Major

**F-M1 · OTP input hard-codes 6 digits; the live auth config emits 8.**
`app/app.js:171` (`/^\d{6}$/` + "Koden er 6 sifre"), `:706–707` (`maxlength="6"`, copy "6-sifret") vs `mailer_otp_length: 8` recorded in `app/PROD-AUTH-CONFIG.md`. Today it's dormant (the `{{ .Token }}` email is Free-tier-blocked). The moment Martin unblocks (Pro/SMTP) — the entire point of the deferral plan — **code login dead-ends: an 8-digit code cannot pass a 6-digit gate**, on the exact installed-iOS path the feature exists to fix. *Fix (S):* accept 6–8 (`/^\d{6,8}$/`, `maxlength=8`, copy "engangskode"), or pin `mailer_otp_length: 6` in the same Management-API pass that unblocks the template — either side, one line; do it *before* the unblock, not during.

**F-M2 · queueUpdate ↔ drain TOCTOU can silently delete a merged edit.**
`app/offline.js:99–112` (queueUpdate: `listOps` sees the op `queued` → merges → `setOp` writes payload *with the stale `queued` status*) vs `:215–219` (drain flips the same op to `sending` and fires the request) and `:251` (ack `delOp`s by id). Interleaving: drain reads fresh + sends *old* fields → queueUpdate overwrites the record with merged fields → ack **deletes the record containing the merge**. The second edit vanishes — no op, no review, no error. The corridor is real in practice because the first save *triggers* the drain that the second save then races. This is the mirror image of the race the drain re-read already guards. *Fix (M):* make the merge atomic — a single readwrite IDB transaction that get-checks `status === "queued"` before put (fall back to queue-behind otherwise), and have the ack re-read the op and skip `delOp` if the payload changed since send (a simple `rev` counter on the op makes both checks trivial).

**F-M3 · Multi-tab double-drain: the fresh re-read doesn't re-check status.**
`app/offline.js:215–218`: `getOp` re-reads but only skips on `!fresh`. The run filter (`:188–192`) guards the *snapshot*; if tab A flips an op to `sending` after tab B snapshotted, B's re-read sees `sending` and **re-sends anyway** (`_draining` is per-tab). Updates: A applies, B's identical base then misses → **false «Trenger gjennomsyn» entry**; inserts are idempotent (harmless). Desk mode makes same-user multi-tab plausible for the first time. *Fix (S):* in the re-read, proceed only if `fresh.status === "queued"` (or `sending` with `sendingAt` older than the stale threshold — preserving the crash-recovery path); pairs naturally with F-M2's transactional rework.

**F-M4 · `floors || 4`: trappevask can price on a fabricated floor count.**
`packages/core/src/index.mjs` `driverCounts` (`floors: c.floors || 4`) reached from `app/app.js:2350` (`floors: clNum("etasjer")` — null when uncaptured). C's own comment calls the default "a fabricated number in a codebase whose whole discipline is that we don't fabricate" — and captured `etasjer` fixes it — but the guard is only as strong as the rep remembering the field: **oppganger captured + etasjer blank → a real kroner line silently priced on floors=4.** Wrong-total risk on a real offer. *Fix (S):* in `computeOfferNow`/`buildingToCustomer`, when `oppganger` is captured and `etasjer` isn't, either render the trappevask line as *ikke priset — mangler etasjer* or hard-stop with the existing honest-error pattern. (Core default can stay for the demo path.)

**F-M5 · The money path's app half has no committed test; every harness was deleted.**
The 16 530 anchor **is** committed and green at core level (`packages/core/test/fixtures/holtet.json` + `core.test.mjs`, 10/10). But `buildingToCustomer` (`app/app.js:2343` — entrance-marker materialisation from `innganger`, floors mapping, checklist/zone projection) is tested **nowhere in the repo**; app-path parity ran once in C's deleted harness. Same story for the sync engine: eight harnesses, ~140 accumulated assertions, all deleted post-pass — and the coalesce pass proved the methodology's value when a harness *flake* was the finding (window 3). Regression cover for the two riskiest subsystems currently exists only in session transcripts. *Fix (M):* commit `app/test/` with the harness skeleton (mock-supabase module + the per-pass scenario files, gated out of the SW SHELL and deploy) and a parity test that runs `buildingToCustomer → computeOffer` against the Holtet fixture; wire `node --check` + core suite + (headless) harness into one `npm test` at repo root.

**F-M6 · Deploy/ops truth lives in session memory, contradicted by the repo's own docs.**
`CLAUDE.md` (repo root) describes the demo era: "no worker, no env vars", "git push → webhook → host builds & deploys". Reality since the gate pass: **two Vercel projects**, `app/` deploys **only** via CLI from `app/` (`vercel deploy --prod --yes`), the SW cache-name bump is the release signal, and the `?v=` chain must move in lockstep — none of it written down in-repo. Commit `8296ca5` is the receipt: C's session didn't know the webhook doesn't cover `app/`, shipped nothing, and needed a manual retrigger. *Fix (S):* an `app/README.md` (or CLAUDE.md section): deploy command, version-bump checklist, SW gotcha, harness policy, the queueCoalesced/queueUpdate boundary pointer.

### Minor

**F-m1 · Rejected photos are visible but unactionable.** `renderOutbox` gives rejected *ops* a "Forkast denne" button; rejected *photos* (incl. the new "foto-data mangler på enheten" class) render with no affordance — the chip total (`countPending` counts them) can never reach zero without DevTools. *Fix (S):* discard button on rejected photo rows (delPhoto).

**F-m2 · «Bruk min likevel» onto a tombstoned row silently vanishes.** `app/app.js:641` (`gone = !r.serverRow`) and `:2717` treat only *missing* rows as gone; a `serverRow` with `deleted_at` set keeps the button enabled → the re-apply hits the soft-deleted row, base often matches (the review captured the tombstone's `updated_at`), fields land in a row no UI shows. The worker's explicit "use mine anyway" disappears. *Fix (S):* treat `serverRow.deleted_at` as gone + copy "raden er slettet på serveren".

**F-m3 · `_acked` is session-lived; window 3 reopens across a reload.** `offline.js:88`. Edit made post-reload, pre-delta → stale base → false conflict. Narrow (boot triggers deltas) but the same class the pass closed. *Fix (S):* persist `_acked` to kv per user, or load-time seed from the cached rows' `updated_at`.

**F-m4 · Sign-out "Forkast alt" scope.** `discardAll` (`offline.js:307`) clears ops+photos but not the user's review items, tray drafts, or kv caches; an op in `sending` when discarded may still land server-side after the user was told it's gone. Isolation holds (all reads are userId-filtered) — this is residue + honesty-of-copy, not leakage. *Fix (S):* include review store (and optionally tray drafts) in discard; note cache retention in the guard copy.

**F-m5 · `signedUrlCache` never expires within a session.** `app/app.js:2126` — entries outlive the 3 600 s URL on long desk sessions → broken thumbnails until reload. *Fix (S):* store `{url, ts}` and refetch past ~50 min.

**F-m6 · No unique index on `offers (building_id, version)`.** Live probe: pkey only, 0 dupes today. Two devices computing concurrently could both write "v2" (single-rep sanctioned, but the board doc prints "tilbud v2"). *Fix (S):* additive unique index; on conflict re-read max version.

**F-m7 · A `queueReview` rejection aborts the rest of the drain run.** `offline.js:244–245` — the rejection propagates past the per-op handler (no per-op catch) to the outer `.catch`; the conflicted op correctly retries later, but every op *behind it* waits for the next trigger. *Fix (S):* per-op `.catch` that marks retry and lets the chain continue.

**F-m8 · Draft/photo storage is unbounded.** Tray drafts (55-photo batches ≈ 5–10 MB each) + outbox + caches share one origin quota with no accounting or pruning beyond manual discard and the 1 h uploaded-GC. C1 failures ARE loud when quota hits — the discipline holds — but nothing prevents the hit. *Fix (M, later):* a lager-status line (navigator.storage.estimate) + oldest-batch prompt. `[DEFERRED-KNOWN]`-adjacent; boundary holds.

**F-m9 · FIFO trusts the device clock.** `clientTs` ordering (`offline.js:117`) reorders under a backwards clock jump. Coalescing removes the worst case (delete replaces the pending edit in place, keeping its slot); remaining exposure is exotic. *Fix:* document; optionally add a monotonic per-session sequence.

**F-m10 · The next `DB_VER` bump will hit `onblocked` with two tabs open.** `offline.js:39` rejects with a clear message — correct — but nothing in the upgrade path prompts closing other tabs. Not live today (DB_VER=2 since v1.5). *Fix:* note in the (F-M6) README; surface the message string in the boot error path when it occurs.

### Nice

**F-n1 · The two coalesce mechanisms are a documented fork — keep it that way on purpose.** `queueCoalesced` (whole-row, blob rows, `app.js:1911` — rationale comment is excellent) vs `queueUpdate` (field-merge, form rows, `offline.js:97`). Boundary is real and justified; the risk is the *next* contributor picking by proximity. Add a two-line pointer at `queueUpdate` referencing the other and the rule ("blob rows one rep owns → whole-row; shared form rows → field-merge"); longer-term `queueUpdate({mode:"wholeRow"})` could subsume.

**F-n2 · Direct-DOM islands need their rule written where the next pass looks.** The innerHTML-rerender + direct-DOM hybrid now has three islands (Leaflet/draw `mountKartMap` comment ✓ good, `refreshBefaring` surgical updates, tray strip) — the rule ("draw/typing surfaces update DOM directly, never render()") exists as scattered comments; hoist to the F-M6 README.

**F-n3 · No upload-state chip on asset/zone/tray photos.** Only proof rows show `foto synkes`; an assigned tray photo's upload state is invisible (photo count renders regardless). Cosmetic honesty gap.

**F-n4 · Error-copy ladder: consistent.** Spot-checked all eight sections — the "Kunne IKKE lagre … er IKKE trygg/lagret" + «lagret på enheten → synkes → synket ✓» wording holds everywhere new. One stray: tray uses "skuffen" informally (fine).

---

## (a) Sync-engine confidence verdict

**Certify doc-80 as implemented — with two carve-outs to fix before the next field week (F-M2, F-M3).** The state machine (draft → queued → coalesced → sending → ack/re-base → rejected/held → review → delta → tombstone → cache) is faithfully built, all three known self-conflict windows are closed, tombstones/deltas/watermarks verified against live SQL repeatedly, and honesty surfaces (chips, review store, loud C1 failures) match the contract. The engine's remaining weakness is not semantics but **concurrency between the queue's mutators**: every writer (queueUpdate, queueCoalesced, drain, discard, retryHeld) does read-then-write against IDB without a serialization discipline, and both Majors fall out of exactly that. **The next window I'd hunt:** intra-device interleavings — enumerate every pair of outbox mutators and force each interleaving in a committed harness; then multi-tab as a first-class scenario (BroadcastChannel drain-leader election or a kv lease would retire the class). Honourable mentions checked and clean: sign-out during sending (guard blocks; discard edge noted F-m4), photo-vs-op ordering (op-first is by design, `foto synkes` covers proof), watermark↔acks interplay (re-fetch of own rows is a harmless merge), SW update mid-drain (drain is foreground; a reload mid-flight leaves `sending` → 60 s stale-recovery path picks it up — by design).

## (b) Status audits

**CODE-REVIEW-2 items: all 11 closed (`- [x]`), zero unticked.** Spot-verified in code this review: T1-1 origin isolation + strict CSP (live header matches file), T1-2 `shouldCreateUser:false` (+ server-side `disable_signup:true` since), T1-3 deterministic tenancy (`created_at asc`, no bare limit), T1-5 config artifact (now also carries the Management-API state), T3-1 esc sinks. Nothing regressed.

**Known-deferred ledger:**

| Item | Status |
|---|---|
| Focus-steal on background render | `[DEFERRED-KNOWN]` — boundary holds (text survives via mirrors; keyboard closes). Unchanged since field-findings. |
| Proxy quota exposure (demo `RenovasjonAppKey` fallback in `supabase/functions/proxy`) | `[DEFERRED-KNOWN]` — demo-origin only, allowlisted targets; unchanged. Revisit at backend milestone. |
| Demo `cloudFlush` race | `[DEFERRED-KNOWN]` — `index.html:348`, demo-only, untouched since review 2. |
| Demo dead fns + titleCase æøå backport | **Still open** — `onboarding.js:935` still mis-capitalizes æøå ("MellomgÅRden"); `brregStreet` still dead. Demo-cosmetic; batch into the next demo pass. |
| OTP UI stub remnants | **Memory was wrong; code is right.** `d9dfa59` shipped the full OTP UI (verifyOtp + li_code + degrade copy). The *real* residue is **F-M1** (6 vs 8 digits). |
| Staged `/tmp/magiclink.html` | **Volatile copy gone; body not committed anywhere** (`PROD-AUTH-CONFIG.md` references `{{ .Token }}` but lacks the full HTML). Paste the template body into the config doc so the unblock pass doesn't reconstruct it. |
| Hard-delete permitted server-side (unused) | `[DEFERRED-KNOWN]` — unchanged; production-hardening decision stands open. |
| B2 split-screen capture mode | Deferred by scope split (chips shipped in D and are ready for it). |

**Also verified clean (absence = checked):** CSP census exact per origin (app: connect self+supabase+geonorge+brreg, img self+data+supabase+kartverket — matches every fetch/img in code; demo CSP untouched); registry strings esc()d at every render sink checked (wizard results/confirm, headers, zone tips, checklist rows, board doc incl. print path — `boardDocHTML` escapes name/meta/status/tenant); RLS: no client-trust added since review 2 (tenant_id always from resolved membership; with_check enforced; zones/doc_type probed live under impersonation); `fodselsdato` never touches state (`parseRoles` reads `navn` only — code-verified, not report-trusted); storage paths built from membership tenant only; wizard error surfaces leak no internals; `disable_signup` reliance documented in the config artifact; per-user isolation of kv/outbox/photoq/review across sign-out cycles holds (all reads userId-filtered; `_acked` is keyed by row not user — cross-user upgrade on a shared device is benign since it's the same row's server timestamp).

## (c) Top-5 actions

1. **Serialize the outbox (F-M2 + F-M3 together):** transactional merge in `queueUpdate`, status re-check in the drain's fresh re-read, `rev`-guarded ack delete — then promote the coalesce harness to a committed test that forces the interleavings. This is the sign-off blocker for the sync engine.
2. **Fix the OTP length mismatch (F-M1) now, while it's dormant** — one line in the app (accept 6–8) so the eventual Pro/SMTP unblock can't dead-end installed-iOS login.
3. **Guard the floors fabrication (F-M4)** — no trappevask kroner from a defaulted floor count; honest *ikke priset* instead.
4. **Commit the test substrate (F-M5):** `app/test/` harness skeleton + the app-path Holtet parity run, wired into one `npm test`.
5. **Write the ops truth into the repo (F-M6)** and fold in the S-batch while there: rejected-photo discard (F-m1), review-tombstone guard (F-m2), signed-URL expiry (F-m5).

## Remediation (fix pass, 2026-07-14)

- [x] **F-M1** — OTP input accepts 6–8 (`/^\d{6,8}$/`, `maxlength=8`, neutral copy); staged template body committed into `app/PROD-AUTH-CONFIG.md`.
- [x] **F-M2** — outbox serialized: `txRCW` atomic read-check-write primitive; `rev` on every op; `claimOp` (atomic queued→sending), `ackDeleteOp` (deletes only status=sending + rev match — a mid-flight change survives as queued), `failOp` (status+rev-verified write-backs), `mergeInto` (in-tx re-verify; refuses `sending` → queue-behind). *Proven by the committed harness: the razor test forces a mid-flight change and the ack does not delete it.*
- [x] **F-M3** — drain single-instance across tabs: Web Locks (`onsite-drain`, ifAvailable) + localStorage heartbeat-lease fallback; claim atomicity as the belt underneath. *Proven with two real tabs: loser drain returns false with zero sends; both tabs' edits land through one instance, review empty.*
- [x] **F-M4** — `floors || 4` killed for the app path: core `strictFloors` (app default on) → etasjer blank yields an honest unpriced «Trappevask … — mangler etasjer» line (computed 0, excluded from totals); checklist highlights the missing driver on the etasjer row; **the core fixture itself gained explicit `floors: 4`** (the anchor had silently leaned on the default). c-builder fallback audit: `innganger || 0` materialises zero markers (entryways then falls back to the *captured* oppganger count — real data, not fabrication); no other defaults found.
- [x] **F-M5** — test substrate committed: `app/tests/interleave.html` (16 deterministic assertions: razor, ack-vs-coalesce both orders, claim contention, gated flow, sign-out-during-sending, remote-conflict regression, F-m4 coverage) + `buildCustomerFromApp` moved INTO core with `fixtures/holtet-app.json` and two node tests (app-path 16 530 parity + strictFloors) — core suite now 12/12; commands in `app/README.md`.
- [x] **F-M6** — `app/README.md` written (CLI-only deploy with `8296ca5` as the receipt, SW cache-name as live signal + dev gotcha, the four-part version chain, entry map, write-path rules incl. the coalesce boundary, tests); `CLAUDE.md` points at it.
- [x] **F-m1** — rejected photos get «Forkast dette bildet» in the outbox (delPhoto; the chip can reach zero).
- [x] **F-m2** — review store treats `serverRow.deleted_at` as gone (button disabled + copy path); `reviewUseMine` belt-guard added.
- [x] **F-m4** — `discardAll` also clears the user's review items (harness-asserted).
- [x] **F-m5** — signed-URL cache entries carry `ts` (50-min expiry) and a one-shot `onerror` re-mint replaces broken images.
- [x] **F-m7** — per-op `.catch` in the drain: one op's unexpected failure backs off that op and the run continues.
- [ ] Open (accepted for now): F-m3 (`_acked` session-lived), F-m6 (offers unique index), F-m8 (quota accounting), F-m9 (clock-jump FIFO), F-m10 (DB_VER bump copy), F-n1..n4. Demo titleCase backport stays its own tiny pass.

**Closing verdict: fixes-needed.** No Critical. The six Majors gate as follows: F-M2/F-M3 block *sync-engine sign-off* (fix before the next multi-device or multi-tab field use); F-M4 blocks *money sign-off* for offers where etasjer is uncapturable; F-M1 blocks the *OTP unblock plan* (not today's login); F-M5/F-M6 block neither runtime but compound every future pass's risk. Minors are batchable. The system's honesty discipline — loud failures, no fabricated numbers, server-wins-with-review — held up under adversarial reading everywhere except the four places named above, which is, for 18 commits of this velocity, the strongest of the three reviews.
