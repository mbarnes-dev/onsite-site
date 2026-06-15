# OnSite — prototype site

Static, field-first facility-management prototype. One `index.html`, no build step, no backend (state lives in the browser's `localStorage`). Concept/strategy docs live in `../Facility Platform/`.

## Run locally
Open `index.html` in a browser. That's it.

## Deploy (Vercel, zero-config static)
```bash
vercel          # link/create project "onsite-site" (framework: Other, no build)
vercel --prod   # production URL
```
Or import the GitHub repo in the Vercel dashboard so pushes to `main` auto-deploy.

## Update
Edit `index.html` → commit → `git push origin main` → Vercel redeploys → verify the live URL (cache-bust with `?v=N`).

See **CLAUDE.md** for full architecture, conventions, and the phase-2 Railway worker plan.
