# OnSite — project setup, architecture & conventions

This file is the briefing for any Claude Code session working in this repo. Read it first; it follows the same shape as our Assay project so the toolchain (GitHub → Vercel → Railway, Resend) is already familiar and already set up.

## What OnSite is

A field-first facility-management platform (working name "OnSite"). The wider concept/strategy lives in the sibling docs folder `../Facility Platform/` (docs 01–32). **This repo is the front end only** — start here, not there.

## Current state — read this before assuming a backend exists

Right now OnSite is a **single static web app**: `index.html`, no build step, no framework, no server. It's a clickable prototype that shows one day of facility work across three roles (Field / Board / Office). All state is kept in the **browser's `localStorage`** — there is no database and no API yet. So:

- There is **no worker, no auth, no env vars** needed to run or deploy today.
- "Deploy" = push to GitHub `main` → Vercel rebuilds the static site. That's the whole loop.

The Railway FastAPI worker described under "Planned shape" is **phase 2** — do not build it until we actually need shared/persistent data. Don't carry pieces this project doesn't have yet.

## The shape (target — same as Assay, but only the left half exists today)

| Repo | What it is | Host | Status |
|---|---|---|---|
| **onsite-site** (this repo) | Static app + (later) lightweight serverless `api/*.js` proxies | **Vercel** | **live now** |
| onsite-worker (later) | Python/FastAPI backend — Postgres, auth, the building-knowledge data model, PDF/report generation, scheduled jobs | **Railway** | **not built yet (phase 2)** |

GitHub is the source of truth. Neither host is edited directly: `git push origin main` → webhook → host builds & deploys.

## Site repo layout

```
index.html        # the whole prototype (inline <style> + inline <script>, no framework)
api/              # empty for now (.gitkeep). Serverless proxies to the worker go here in phase 2
vercel.json       # cleanUrls, security headers incl. CSP. connect-src is 'self' today;
                  #   add the worker origin here when the worker exists (see phase 2 below)
.gitignore
CLAUDE.md         # this file
README.md
```

### Conventions (match these)
- **Static, no build.** Plain HTML/CSS/JS. No bundler, no framework, no npm needed to deploy.
- **Self-contained pages.** Each page is a standalone `.html` with its own `<style>`; if we add pages, copy the shared design tokens (the `:root` CSS variables at the top of `index.html`) rather than introducing a build step.
- **Inline scripts only**, reading `?param=` for any variant switching — no SPA router. (This is why `vercel.json`'s CSP allows `'unsafe-inline'` for script/style; keep that in mind if you tighten CSP.)
- **`cleanUrls: true`** — `/foo` serves `foo.html`. If you add a rewrite, the destination must be the clean URL, not the `.html`, or it 404s.
- **Design language:** teal `#0f766e` primary, amber for Board, blue for Office; tokens defined once in `:root`.

## The working rhythm (what makes Code "get it")

Every change: **edit → `git commit` → `git push origin main` → wait for Vercel to redeploy → verify on the live URL (cache-busted, e.g. add `?v=2`) → report.** Don't assume a push is live; the GitHub→Vercel webhook occasionally drops an event — an empty commit (`git commit --allow-empty -m "retrigger"`) re-fires it. Commit messages are durable records of *what* and *why*.

## Deploy (first time)

This repo is zero-config static. With the Vercel CLI logged in:

```bash
cd onsite-site
vercel              # first run: link/create project "onsite-site", accept defaults (Other / no build)
vercel --prod       # production URL
```

Or connect the GitHub repo in the Vercel dashboard (Add New → Project → Import → framework preset "Other") so every push to `main` auto-deploys. `.vercel/project.json` (gitignored) links this folder to the Vercel project after the first `vercel` run.

## Planned shape — phase 2 (only when we need real data)

When the prototype needs multi-tenant persistence (building records, the knowledge graph, auth, real approvals), add the **onsite-worker** repo on Railway, mirroring Assay:

- **FastAPI factory** (`app/main.py`): CORS middleware (allow the site origin via `SITE_ORIGIN`), routers, optional startup watchdog for scheduled sweeps.
- **DB** (`app/db.py`): SQLAlchemy 2.0 models + `init_db()` doing `create_all` plus Postgres `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (additive boot migration — no migration framework).
- **Auth between halves:** the site's `api/*.js` serverless functions act as a proxy holding `WORKER_SHARED_SECRET` and call the worker with `Authorization: Bearer <secret>` (browser never sees it). Public reads can fetch the worker directly **only if** the worker's CORS allows the site origin **and** `vercel.json`'s CSP `connect-src` whitelists the worker origin. Those two lining up is the thing that, if wrong, makes everything look deployed but silently fail.
- **Dockerfile build-gate:** assert at build time that deps, templates and binaries (e.g. chromium/pandoc for PDF reports) exist, so a broken image fails the *build*, not a customer request.
- **Env vars** (set in dashboards, never in git): Vercel site → `WORKER_BASE_URL`, `WORKER_SHARED_SECRET`, `SITE_URL` (+ `RESEND_*` if the site sends mail). Railway worker → `DATABASE_URL` (Railway Postgres), `WORKER_SHARED_SECRET` (must match the site exactly), `SITE_ORIGIN`, a persistent `STORAGE_DIR` on a Railway volume, `RESEND_*`, plus any Stripe keys.

When you build the worker, update this file's status table and the CSP `connect-src` in `vercel.json`.

## The production app (`app/`)

Everything above describes the **demo**. The production app in `app/` is a different animal with
different rules — **read `app/README.md` before touching it** (deploy is CLI-only from `app/`, the
SW cache name is the release trigger, outbox writes have an atomicity discipline, tests run pre-deploy).
