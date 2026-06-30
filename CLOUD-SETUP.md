# Cloud persistence v1 (doc 64) — enabling cross-device sync

The app ships **cloud-disabled**: with no credentials it is 100% `localStorage`-only and the
Supabase SDK is never even loaded (boot is byte-for-byte unchanged). Three steps turn it on.

## 1. Create the table (once)
Run [`supabase/workspaces.sql`](supabase/workspaces.sql) in the Supabase project's SQL editor
(EU region). It creates `public.workspaces (id, state jsonb, rev, updated_at)` with a **demo-grade**
RLS policy (anon may read/insert/update by `id` — the workspace id *is* the access token).
This is NOT production access control; real auth + per-tenant RLS is doc 58.

## 2. Add the credentials (client)
In `index.html`, fill the `CLOUD` config (search `var CLOUD =`):

```js
var CLOUD = { url: "https://<ref>.supabase.co", anonKey: "<anon public key>", table: "workspaces" };
```

- The **anon public key** is public-by-design and safe in the client.
- **NEVER** put the `service_role` key here (it bypasses RLS).

## 3. Allow the origin in CSP
In `vercel.json`, add **only** the project origin to `connect-src` (add the `wss://` form too only
if realtime is ever used):

```
connect-src 'self' https://ws.geonorge.no https://wfs.geonorge.no https://data.brreg.no https://<ref>.supabase.co;
```

Bump `?v=` on both includes, commit, push. The `☁︎ <workspace>` chip appears in the topbar.

## How it works
- **Workspace id** (`onsite_ws_id` in localStorage, default `solbakken-demo`) identifies the shared
  blob. The topbar chip shows / sets / shares it — open the same id on another device to load the same data.
- **Load:** render from the localStorage cache instantly, then async-pull the workspace row; if its
  `rev` is newer than the local base, replace state (through `migrate()`) and re-render. Offline → cache.
- **Save:** synchronous `localStorage` (C1 gating intact) **and** a debounced upsert
  (`rev = rev+1`). A cloud failure never breaks the local save — the chip shows "ikke synket", retries next save.
- **Conflict:** before each upsert the server `rev` is checked; if another device advanced it, the app
  shows "Oppdatert på en annen enhet — laster på nytt" and reloads (last-write-wins on `rev`; no CRDTs).

## v1 limits (by design — hooks left in code)
- **Photos stay device-local** (IndexedDB); only the state JSON syncs. `// TODO v2: Supabase Storage for photo blobs`.
- **No auth / per-tenant RLS** — demo-grade (workspace id = access). `// TODO doc-58 auth + RLS`.
- **Whole-blob sync** (not per-entity) — fine at demo scale.
