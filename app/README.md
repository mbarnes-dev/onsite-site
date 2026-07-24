# OnSite — the production app (`/app`)

The offline-first field app on **https://onsite-prod-app.vercel.app**, talking to Supabase project
`onsite-prod` (`btneqhrqnxmggwowboei`). The **demo** is a separate thing on a separate origin
(`onsite-site.vercel.app`, repo root `index.html` + `onboarding.js`) — nothing in here touches it.
This file is the ops truth (review-3 F-M6). If reality changes, change this file in the same commit.

## Deploy — read this before assuming anything

- **`git push` does NOT deploy this app.** The Vercel git integration only builds the demo project.
  Empty-commit retriggers don't help either — commit `8296ca5` is the receipt (onboarding C shipped
  with a webhook that never fired and needed a manual push-button).
- **The deploy is the CLI, from this directory:**

  ```sh
  cd app && ~/.vercel-cli/node_modules/.bin/vercel deploy --prod --yes
  ```

- **The live signal is the SW cache name** — `curl -s https://onsite-prod-app.vercel.app/sw.js | grep CACHE`.
  Checking a `?v=` asset URL proves nothing (any `?v=` 200s; Vercel ignores unknown query strings).

## The version-bump chain (all four move together or users run stale code)

| What changed | Bump |
|---|---|
| `app.js` / `app.css` / `offline.js` / `boot.mjs` | its `?v=` in `index.html` **and** in `sw.js` SHELL |
| `packages/core/src` | `node packages/core/build.mjs` (writes BOTH deploy roots) → bump `core.bundle.js?v=` **inside `boot.mjs`** → that changes `boot.mjs` → bump its `?v=` too |
| anything above | **`sw.js` `CACHE` name (vN → vN+1)** — this is the release trigger; without it, installed clients keep the old precache |

**The SW dev gotcha:** if you're testing an edit and seeing old behavior, you're running the precached
shell. Bump the cache name, or unregister the SW + clear caches in DevTools. This has burned every
session that forgot it.

## Entry map

- `index.html` → `boot.mjs?vN` (loads `core.bundle.js?vN`, sets `window.OnSiteCore`) → `offline.js?vN`
  (`window.OnsiteOffline`: outbox/photoq/review/kv + the atomic ops + drain) → `app.js?vN` (everything else).
- `vendor/` is committed (supabase-js, leaflet) — no CDN; the CSP has no host for one.
- `vercel.json` carries the strict CSP. `script-src 'self'` — no inline scripts, ever.

## Write-path rules (doc-80 + review-3)

- Every outbox mutation is an **atomic read-check-write** (`txRCW` in `offline.js`): claim, ack (rev-verified),
  fail, merge, re-base. Never `getOp`-then-`setOp` across two transactions for a decision.
- Coalescing: **blob rows one rep owns** (buildings.checklist, offers drafts) → `queueCoalesced` (whole-row);
  **shared form rows** (assets/contacts/zones) → `OFF.queueUpdate` (field-merge, base-checked). Don't mix them.
- The drain is **single-instance across tabs** (Web Locks, localStorage-lease fallback). A tab without the
  lock only enqueues.
- UI: `render()` rewrites `#app` wholesale. Draw/typing surfaces (Leaflet map, befaring checklist, tray)
  update the DOM directly and must **never** call `render()` mid-interaction.

## Tests — run before every deploy

```sh
npm --prefix packages/core test         # 12 tests: core anchors + the APP-path 16 530 parity + strictFloors
node --check app/app.js app/offline.js app/sw.js
python3 -m http.server 8788             # repo root, then open:
#   http://localhost:8788/app/tests/interleave.html      → expect "DONE fails=0"
#   http://localhost:8788/app/tests/fangst.html          → expect "DONE fails=0"
#   http://localhost:8788/app/tests/befaring-focus.html  → expect "DONE fails=0"
#   http://localhost:8788/app/tests/fangst-camera.html   → expect "DONE fails=0"
```

`app/tests/interleave.html` is the committed outbox-interleaving harness (F-M2 razor, claim contention,
ack-vs-coalesce both orders, sign-out-during-sending, conflict regression). `app/tests/fangst.html` boots
the REAL app.js in basement mode with a mock camera (canvas captureStream) and drives the B2 capture loop
end-to-end (shoot→tap→chip, render-wipe with a live stream, track stop on exit, denial fallback, rapid-fire
5 → drain). `app/tests/befaring-focus.html` guards field-findings #3: it types into a befaring field with
>400 ms gaps (so the debounced save flushes between characters) and forces a full `render()` mid-typing,
asserting `document.activeElement` identity survives both — the iPad keyboard-drops-per-character bug.
`app/tests/fangst-camera.html` guards field-findings #4: with a mock camera (canvas captureStream) it
opens the map-pin camera, then fires every render path that runs during capture (placement, the online
event, a direct `render()`) and asserts the `<video>` node is the SAME element throughout, srcObject +
live track intact, and `play()` is never re-issued on the already-playing node — the black-preview bug.
All ship as inert pages but are not in the SW shell.

**The paint law these encode** (break it and the field notices before you do): anything that rewrites
`#app` while a control is focused, mid-interaction, or holding a live MediaStream must be deferred or made
surgical. `render()` guards on `clFieldFocused()` (defer to blur) AND on an active fangst pane (downgrade
to `refreshFangstView()`, leaving the `<video>` + Leaflet map in place); `refreshBefaring()` guards the
same way. The keyboard and the camera are the same bug class — a focused/live DOM node replaced under the
user — and each only reproduces on a real iPad online, so a new surface that types, draws or streams needs
this treatment AND a headless harness whose teeth are node/focus identity (verified by neutering the guard).

## Auth / config

`PROD-AUTH-CONFIG.md` in this directory is the auth-config artifact: current Management-API state, the
staged magic-link template (paste-ready for the Pro/SMTP unblock), and Martin's checklist.
