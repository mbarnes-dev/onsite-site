// OnSite allowlisted proxy (doc 66 A4 + Group C seam). DEPLOYED to Supabase Edge Functions
// (project awyjzqgxfvoptyfvspxu, fn "proxy", verify_jwt=false). This file is the source of record.
//
// Forwards ONLY to known upstreams (an allowlist), validating params per target. NOT an open relay.
// A server-side secret/token can be injected PER TARGET via Deno.env — it NEVER touches client JS.
// Today: `regnskap` = public brreg Regnskapsregister (no token; /enhetsregisteret is CORS-open but
// /regnskapsregisteret is not, which is why this exists). Group C: add an `orthophoto` target whose
// upstream needs a key — put the key in Deno.env and read it in that target's headers(); for a PAID
// token, redeploy with verify_jwt=true + add rate-limiting so a public proxy can't burn the quota.

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
function json(o: unknown, status: number) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
}

type Target = { build: (p: URLSearchParams) => string | null; headers?: () => Record<string, string>; accept?: string };
const ALLOW: Record<string, Target> = {
  regnskap: {
    build: (p) => {
      const orgnr = (p.get("orgnr") || "").replace(/\D/g, "");
      if (!/^\d{9}$/.test(orgnr)) return null;
      return `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`;
    },
    accept: "application/json",
    headers: () => ({}), // ← Group C token seam: e.g. { "X-API-Key": Deno.env.get("NIB_KEY")! } — server-side only
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const url = new URL(req.url);
  const target = url.searchParams.get("target") || "regnskap";
  const def = ALLOW[target];
  if (!def) return json({ error: "unknown target" }, 400);
  const upstream = def.build(url.searchParams);
  if (!upstream) return json({ error: "bad or missing params" }, 400);
  try {
    const r = await fetch(upstream, { headers: { accept: def.accept || "application/json", ...(def.headers ? def.headers() : {}) } });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { ...cors, "content-type": r.headers.get("content-type") || "application/json" } });
  } catch (_e) {
    return json({ error: "upstream fetch failed" }, 502);
  }
});
