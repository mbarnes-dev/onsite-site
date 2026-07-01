// OnSite allowlisted proxy (doc 66 A4 + Group C + doc 75 Ren Dunk). DEPLOYED to Supabase Edge Functions
// (project awyjzqgxfvoptyfvspxu, fn "proxy", verify_jwt=false). This file is the source of record.
//
// Forwards ONLY to known upstreams (an allowlist), validating params per target. NOT an open relay.
// A server-side secret/token is injected PER TARGET via Deno.env — it NEVER touches client JS.
//  - regnskap      : public brreg Regnskapsregister (no token; /enhetsregisteret is CORS-open but
//                    /regnskapsregisteret is not, which is why this exists).
//  - orthophoto    : Norge i bilder WMS mosaic. Its token is IP-bound + expires ≤weekly, so it lives ONLY
//                    here (Deno.env NIB_TOKEN), never in the browser. DEMO-GRADE. With no NIB_TOKEN set,
//                    this target returns 400 and the client keeps the Ortofoto base option off.
//  - tommekalender : Norkart "Min Renovasjon" municipal collection calendar (by address → fractions +
//                    dates). komteksky.norkart.no requires a WAAPI token that Norkart's own
//                    proxyserver.ashx injects, AND a RenovasjonAppKey header (a PUBLIC app key, kept here
//                    server-side / overridable via Deno.env RENOVASJON_APPKEY). Both the appKey and the
//                    Kommunenr header are required (verified 2026-07 against Gjøvik 3407). Response is
//                    JSON [{FraksjonId, Tommedatoer:[ISO]}]. Not every kommune is covered → [] = graceful.

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
function json(o: unknown, status: number) {
  return new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });
}

type Target = { build: (p: URLSearchParams) => string | null; headers?: (p: URLSearchParams) => Record<string, string> };
const ALLOW: Record<string, Target> = {
  regnskap: {
    build: (p) => {
      const orgnr = (p.get("orgnr") || "").replace(/\D/g, "");
      if (!/^\d{9}$/.test(orgnr)) return null;
      return `https://data.brreg.no/regnskapsregisteret/regnskap/${orgnr}`;
    },
  },
  orthophoto: {
    build: (p) => {
      const token = Deno.env.get("NIB_TOKEN");
      if (!token) return null; // not configured → 400; client leaves the Ortofoto base off
      const qs = new URLSearchParams(p);
      qs.delete("target");
      qs.set("token", token); // server-side token injection — never in client JS
      return `https://services.norgeibilder.no/wms/mosaikk?${qs.toString()}`;
    },
  },
  tommekalender: {
    build: (p) => {
      const knr = (p.get("kommunenr") || "").replace(/\D/g, "");
      const gatenavn = (p.get("gatenavn") || "").trim();
      const gatekode = (p.get("gatekode") || "").replace(/\D/g, "");
      const husnr = (p.get("husnr") || "").replace(/[^0-9A-Za-zæøåÆØÅ]/g, "");
      if (!/^\d{3,4}$/.test(knr) || !gatenavn || !/^\d+$/.test(gatekode) || !husnr) return null;
      const komtek = `https://komteksky.norkart.no/MinRenovasjon.Api/api/tommekalender?kommunenr=${knr}` +
        `&gatenavn=${encodeURIComponent(gatenavn)}&gatekode=${gatekode}&husnr=${encodeURIComponent(husnr)}`;
      // komteksky rejects direct calls (401) — forward through Norkart's proxyserver.ashx, which injects
      // the WAAPI token komteksky requires. The RenovasjonAppKey + Kommunenr headers ride along (below).
      return `https://norkartrenovasjon.azurewebsites.net/proxyserver.ashx?server=${encodeURIComponent(komtek)}`;
    },
    headers: (p) => ({
      "RenovasjonAppKey": Deno.env.get("RENOVASJON_APPKEY") || "AE13DEEC-804F-4615-A74E-B4FAC11F0A30",
      "Kommunenr": (p.get("kommunenr") || "").replace(/\D/g, ""),
    }),
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
  if (!upstream) return json({ error: "bad params or not configured" }, 400);
  try {
    const r = await fetch(upstream, { headers: { ...(def.headers ? def.headers(url.searchParams) : {}) } });
    // stream the upstream body through unchanged — works for JSON (regnskap/tommekalender) AND binary images (orthophoto)
    return new Response(r.body, {
      status: r.status,
      headers: { ...cors, "content-type": r.headers.get("content-type") || "application/octet-stream" },
    });
  } catch (_e) {
    return json({ error: "upstream fetch failed" }, 502);
  }
});
