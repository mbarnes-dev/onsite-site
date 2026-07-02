// Local build (no bundler needed): the core IS a single dependency-free ESM file, so the
// "bundle" is just a copy to the repo root, committed and served as a static file. The live
// Vercel deploy stays static — no build command, no pipeline change. // PROD: swap for tsup.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "src", "index.mjs"), "utf8");
const banner = `/* core.bundle.js — BUILT ARTIFACT, do not edit. Source: packages/core/src/index.mjs\n` +
  ` * @onsite/core v${(src.match(/VERSION\s*=\s*"([^"]+)"/) || [])[1] || "0"} — committed static bundle (loaded via <script type="module">). */\n`;
const out = join(here, "..", "..", "core.bundle.js");
writeFileSync(out, banner + src);
// gate pass (review-2 T1-1): the prod app lives in app/ on its OWN origin/Vercel project — same
// committed-static pattern, so the bundle is written to BOTH deploy roots from the one source.
const outApp = join(here, "..", "..", "app", "core.bundle.js");
writeFileSync(outApp, banner + src);
console.log("built core.bundle.js + app/core.bundle.js (" + (banner + src).length + " bytes) from packages/core/src/index.mjs");
