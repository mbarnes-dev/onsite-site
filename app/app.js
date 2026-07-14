/* OnSite PRODUCTION app — slice 1c + gate pass + offline v1.5 (doc 78/79/80, review-2). Talks to
 * onsite-prod (real multi-tenant backend). Magic-link auth + tenant-isolated buildings. Everything goes
 * through the authenticated client; RLS scopes reads/writes to the user's tenant. NO service_role in the
 * client. v1.5 (doc-80 §2/§3): ALL class-B writes (buildings/assets) go through the outbox — online and
 * offline are the same path; drains are base-version-checked (server wins, losers land in «Trenger
 * gjennomsyn»); reads are delta pulls on per-table watermarks, tombstones ride the same delta.
 * Own Vercel project on its OWN ORIGIN (review-2 T1-1). Demo: onsite-site.vercel.app, untouched. */
(function () {
  "use strict";

  // --- connection (public-by-design; safe in the client). publishable key = the modern anon key. ---
  var PROD = {
    url: "https://btneqhrqnxmggwowboei.supabase.co",
    key: "sb_publishable__cTZRSq_nzMpBvGPZRToDA_ZaWR0XFm"
    // legacy anon JWT (fallback if a library needs a JWT): eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...RIvM
  };
  if (!window.supabase || !window.supabase.createClient) { document.getElementById("app").innerHTML = "<div class='card'>Kunne ikke laste Supabase-klienten.</div>"; return; }
  var sb = window.supabase.createClient(PROD.url, PROD.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
  });

  var app = document.getElementById("app");
  var SB_REF = "btneqhrqnxmggwowboei";
  var OFF = window.OnsiteOffline;   // doc-80 offline core (offline.js) — cache/outbox/photoq/SW
  var S = { session: null, tenant: null, buildings: null, loading: false, error: null, msg: null, noAccess: false, _uid: null,
    // 1c-2: view routing — the building detail is the container for the per-table sections (assets/proof/offers)
    view: { name: "list" }, assets: null, proof: null, offers: null, editAsset: null, secBusy: {}, secErr: {}, secMsg: {},
    // contacts port (small pass): second class-B table riding the SAME v1.5 outbox/LWW/delta machinery
    contacts: null, editContact: null, installEvt: null,
    // onboarding A (doc-82): the Step-0 registry-prefill wizard state (search → confirm → create)
    nb: null,
    // OTP pass: the email a code was sent to — verifyOtp must target IT, not a later-edited input
    otpEmail: null,
    // field-findings #1: the proof photo lives in IDB from the moment it is picked ({path, dataUrl
    // read BACK from the store}) — never in a DOM file input, which any background render wipes
    proofPhoto: null,
    // offline v1 (doc-80): offline identity + read-cache stamps + pending (outbox) state + SW update hint
    offlineIdent: null, offline: !navigator.onLine, snapTs: null, listTs: null,
    pending: { total: 0, ops: 0, photos: 0, rejected: 0 }, pendingOps: [], pendingPhotos: [], updateReg: null,
    // offline v1.5 (doc-80 §2): device-local conflict store — a lost LWW race is reviewed, never toasted
    review: [] };

  // effective identity: the live session, else the persisted one when OFFLINE (doc-80 §5 — never force
  // sign-out in a basement; reads come from cache, writes queue under this user and drain after re-auth)
  function userId() { return (S.session && S.session.user && S.session.user.id) || (S.offlineIdent && S.offlineIdent.id) || null; }
  function userEmail() { return (S.session && S.session.user && S.session.user.email) || (S.offlineIdent && S.offlineIdent.email) || ""; }
  function timeHM(ts) { try { return new Date(ts).toLocaleTimeString("no", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }

  /* ============================ @onsite/core mapping ============================
   * DB row  <->  the plain-JS building shape the engines expect. The core engines never see a DB row;
   * they operate on {id,name,addr,gnr,bnr,kommunenr,lat,lon,...} — same shape the demo builds. As later
   * tables (offers/assets/proof) come online, each maps the same way and feeds the same engines. */
  function rowToCore(row) {
    return { id: row.id, name: row.name, orgnr: row.org_nr || "", addr: row.address || "",
      gnr: row.gnr || "", bnr: row.bnr || "", kommunenr: row.kommunenr || "",
      lat: row.lat, lon: row.lon, createdAt: row.created_at, _row: row };
  }
  function coreToRow(tenantId, b) {
    var row = { name: (b.name || "").trim(), org_nr: b.orgnr || null, address: b.addr || null,
      gnr: b.gnr || null, bnr: b.bnr || null, kommunenr: b.kommunenr || null,
      lat: (b.lat != null && b.lat !== "" ? +b.lat : null), lon: (b.lon != null && b.lon !== "" ? +b.lon : null) };
    if (tenantId) row.tenant_id = tenantId; // set on INSERT; RLS with_check enforces it is the user's tenant
    return row;
  }
  function coreReady() { return !!(window.OnSiteCore && Object.keys(window.OnSiteCore).length); }

  /* ============================ prodDb: authenticated data layer ============================
   * RLS does the tenant filtering server-side. We only ever set tenant_id from the user's own membership. */
  var prodDb = {
    // gate item 3 (review-2 T1-3): fetch ALL memberships, deterministically ordered — never a bare limit(1).
    myMemberships: function () { return sb.from("memberships").select("tenant_id, role, created_at").order("created_at", { ascending: true }); },
    tenantName: function (tid) { return sb.from("tenants").select("name").eq("id", tid).maybeSingle(); },
    // v1.5 (doc-80 §2/§3): READS ONLY — every class-B write (buildings/assets) goes through the outbox,
    // online or offline, one path. Full pulls filter tombstones; DELTA pulls must NOT (tombstones ride
    // the same delta: soft-delete is an UPDATE → trigger bumps updated_at → the delta returns the row
    // with deleted_at set → the cache drops it).
    listBuildings: function () { return sb.from("buildings").select("*").is("deleted_at", null).order("name", { ascending: true }); },
    listBuildingsDelta: function (wm) { return sb.from("buildings").select("*").gt("updated_at", wm); },
    listAssets: function (bid) { return sb.from("assets").select("*").eq("building_id", bid).is("deleted_at", null).order("created_at", { ascending: true }); },
    listAssetsDelta: function (bid, wm) { return sb.from("assets").select("*").eq("building_id", bid).gt("updated_at", wm); },
    listContacts: function (bid) { return sb.from("contacts").select("*").eq("building_id", bid).is("deleted_at", null).order("created_at", { ascending: true }); },
    listContactsDelta: function (bid, wm) { return sb.from("contacts").select("*").eq("building_id", bid).gt("updated_at", wm); },
    listProof: function (bid) { return sb.from("completion_proof").select("*").eq("building_id", bid).order("ts", { ascending: false }); },
    signPhoto: function (path) { return sb.storage.from("photos").createSignedUrl(path, 3600); },
    // offers stay online-only writes this pass (class D-ish until v2 intents) — severability toggles direct
    listOffers: function (bid) { return sb.from("offers").select("*").eq("building_id", bid).order("version", { ascending: false }); },
    updateOffer: function (id, patch) { return sb.from("offers").update(patch).eq("id", id).select().single(); }
  };
  // watermarks advance ONLY from returned server rows — never the device clock (doc-80 §3)
  function maxUpdatedAt(rows, current) {
    var m = current || "";
    (rows || []).forEach(function (r) { if (r.updated_at && r.updated_at > m) m = r.updated_at; });
    return m;
  }
  function validWm(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v); }   // corrupted watermark → full snapshot

  /* ---- asset mapping: DB row ↔ the Phase-10 asset shape the demo/core already understand ---- */
  var ASSET_TYPES = [
    { id: "hovedstoppekran", emoji: "🚰", label: "Hovedstoppekran (vann)", area: "kjeller" },
    { id: "el-skap", emoji: "⚡", label: "Hovedtavle (el-skap)", area: "teknisk" },
    { id: "brannsentral", emoji: "🔥", label: "Brannsentral", area: "oppgang" },
    { id: "ventilasjon", emoji: "🌀", label: "Ventilasjonsaggregat", area: "tak" },
    { id: "varmekilde", emoji: "♨️", label: "Varmekilde", area: "teknisk" },
    { id: "nøkkelboks", emoji: "🔑", label: "Nøkkelboks", area: "oppgang" },
    { id: "avfall-bin", emoji: "♻️", label: "Avfallsdunk / -brønn", area: "avfall", isBin: true },
    { id: "annet", emoji: "🔧", label: "Annet anlegg", area: "teknisk" }
  ];
  var AREAS = ["kjeller", "teknisk", "oppgang", "ute", "tak", "avfall", "heis", "fasade", "annet"];
  var BIN_TYPES = ["nedgravd", "frittstående", "kompaktor"];
  var BIN_FRACTIONS = ["Restavfall", "Papir", "Matavfall", "Plast", "Glass/metall", "Drikkekartong", "Farlig avfall", "Tekstiler"];
  function assetTypeDef(t) { return ASSET_TYPES.filter(function (x) { return x.id === t; })[0] || ASSET_TYPES[ASSET_TYPES.length - 1]; }
  function assetRowToCore(row) {
    return { id: row.id, type: row.type || "annet", label: row.label || "", area: row.area || "",
      geo: (row.lat != null && row.lon != null) ? { lat: row.lat, lon: row.lon } : null,
      access: row.access || "", notes: row.notes || "", complianceLink: row.compliance_link || null,
      bin: row.bin || null, photoIds: row.photo_ids || [], _row: row };
  }
  function assetToRow(a) {
    var isBin = assetTypeDef(a.type).isBin;
    return { type: a.type, label: (a.label || "").trim() || assetTypeDef(a.type).label, area: a.area || assetTypeDef(a.type).area,
      lat: a.geo ? a.geo.lat : null, lon: a.geo ? a.geo.lon : null,
      access: a.access || null, notes: a.notes || null, compliance_link: a.complianceLink || null,
      bin: isBin ? (a.bin || {}) : null };
  }

  /* ============================ auth ============================ */
  function sendMagicLink(email) {
    email = (email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { S.error = "Skriv en gyldig e-postadresse."; S.msg = null; render(); return; }
    S.loading = true; S.error = null; S.msg = null; render();
    // gate item 2 (review-2 T1-2): closed signup — an unknown email gets a clear refusal, no user row created.
    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: false } })
      .then(function (r) {
        S.loading = false;
        if (r.error) { S.error = authHint(r.error); }
        else {
          // OTP pass: the same email carries a 6-digit code ({{ .Token }} in the template) AND the link.
          // The code is the path that works in an installed iOS app (the link opens in Safari, whose
          // storage the standalone app can't see — the 2-Jul wrong-browser failure class).
          S.otpEmail = email;
          S.msg = "📧 E-post sendt til " + email + " — skriv inn koden under" + (isStandalone() ? "." : ", eller åpne lenken på denne enheten.");
        }
        render();
        var ce = document.getElementById("li_code"); if (ce) ce.focus();
      });
  }
  function verifyCode() {
    var code = (val("li_code") || "").replace(/\D/g, "");
    var email = S.otpEmail;
    if (!email) { S.error = "Send en kode først."; S.msg = null; render(); return; }
    if (!/^\d{6}$/.test(code)) { S.error = "Koden er 6 sifre — sjekk e-posten."; render(); return; }
    S.loading = true; S.error = null; render();
    // fully in-app: no redirect, no PKCE verifier handoff — works in standalone iOS and any browser.
    // shouldCreateUser stays enforced upstream: an unknown email never got a code, and verifyOtp
    // cannot create users (confirmed live: 403 otp_expired, auth.users unchanged).
    sb.auth.verifyOtp({ email: email, token: code, type: "email" }).then(function (r) {
      S.loading = false;
      if (r.error) { S.error = otpHint(r.error); render(); return; }
      S.msg = null; S.error = null; S.otpEmail = null;   // session lands via onAuthStateChange — same path as the redirect login
    });
  }
  function otpHint(err) {
    var m = (err && err.message) || "ukjent feil";
    if (/rate limit|too many/i.test(m)) return "For mange forsøk — vent et minutt og prøv igjen.";
    if (/expired|invalid/i.test(m)) return "Feil kode — prøv igjen, eller send en ny e-post hvis koden er utløpt.";
    return "Innlogging feilet: " + m;
  }
  function authHint(err) {
    var m = (err && err.message) || "ukjent feil";
    if (/signups? not allowed/i.test(m)) return "Ingen konto for denne adressen — kontakt administrator for å få tilgang.";
    if (/not enabled|disabled|provider/i.test(m)) return "Innlogging er ikke slått på ennå — den virker straks e-post/magic-link er aktivert. (" + m + ")";
    if (/rate limit|too many/i.test(m)) return "For mange forsøk — vent et minutt og prøv igjen.";
    return "Innlogging feilet: " + m;
  }
  function signOut() {
    sb.auth.signOut().then(function () {
      try { localStorage.removeItem("onsite_prod_email"); } catch (e) {}   // shared-device hygiene: no email crumb after sign-out
      S.tenant = null; S.buildings = null; S.msg = null; S.error = null; S.noAccess = false;
      // OTP pass: reset the VIEW too — the code login has no page reload (unlike the redirect), so a
      // stale signoutGuard/building view would otherwise resurface after the next in-app sign-in.
      S.view = { name: "list" }; S._prevView = null;
      render();
    });
  }

  /* ============================ load-after-login ============================ */
  function loadTenantAndBuildings() {
    var uid = userId(); if (!uid) return;
    // doc-80 §0/§3: render cache-first ALWAYS (instant paint), then background-refresh when online
    Promise.all([OFF.cacheGet(uid, "meta"), OFF.cacheGet(uid, "buildings")]).then(function (r) {
      var meta = r[0], blds = r[1];
      if (meta && meta.v) { S.tenant = meta.v; }
      if (blds && blds.v) { S.buildings = blds.v.map(rowToCore); S.listTs = blds.ts; }
      if (S.tenant || S.buildings) render();
      if (!S.session || !navigator.onLine) { S.loading = false; render(); return; }   // offline: the cache is the day
      networkRefreshTenantAndBuildings(uid);
    }).catch(function () { if (S.session && navigator.onLine) networkRefreshTenantAndBuildings(uid); });
  }
  function networkRefreshTenantAndBuildings(uid) {
    S.loading = S.buildings == null; S.error = null; S.noAccess = false; if (S.loading) render();
    prodDb.myMemberships().then(function (mr) {
      if (mr.error) throw mr.error;
      var rows = mr.data || [];
      if (!rows.length) {   // 0 memberships → a clear no-access screen, not an empty app (gate item 3)
        S.noAccess = true; S.tenant = null; S.buildings = null; S.loading = false; render(); return;
      }
      var m = rows[0];   // deterministic: oldest membership first (created_at asc)
      S.tenant = { id: m.tenant_id, role: m.role, name: null, count: rows.length };
      return prodDb.tenantName(m.tenant_id).then(function (tr) {
        if (tr.data) S.tenant.name = tr.data.name;
        OFF.cachePut(uid, "meta", S.tenant);   // the offline day needs the tenant (writes are keyed to it)
        return pullBuildings(uid);
      }).then(function (rows2) {
        S.buildings = rows2.map(rowToCore); S.listTs = Date.now();
        S.loading = false; render();
      });
    }).catch(function (e) { S.loading = false; S.error = friendly(e); render(); });
  }
  /* v1.5 delta pull, buildings (doc-80 §3): watermark = max server updated_at seen. Delta pulls take
   * `updated_at > wm` WITHOUT the deleted_at filter — tombstones must arrive to be dropped from the
   * cache. Full snapshot only on first login / cleared cache / corrupted watermark. Resolves to the
   * merged RAW rows (live only) and persists cache + watermark. */
  function pullBuildings(uid) {
    return OFF.cacheGet(uid, "wm:buildings").then(function (wm) {
      var mark = wm && wm.v;
      if (!validWm(mark)) return fullPullBuildings(uid);
      return Promise.all([prodDb.listBuildingsDelta(mark), OFF.cacheGet(uid, "buildings")]).then(function (r) {
        var dr = r[0], cached = (r[1] && r[1].v) || null;
        if (dr.error) throw dr.error;
        if (cached == null) return fullPullBuildings(uid);   // watermark without a cache = corrupted state
        var byId = {}; cached.forEach(function (row) { byId[row.id] = row; });
        (dr.data || []).forEach(function (row) { if (row.deleted_at) delete byId[row.id]; else byId[row.id] = row; });
        var rows = Object.keys(byId).map(function (k) { return byId[k]; });
        rows.sort(function (x, y) { return (x.name || "") < (y.name || "") ? -1 : 1; });
        var nm = maxUpdatedAt(dr.data, mark);
        return Promise.all([OFF.cachePut(uid, "buildings", rows),
          nm !== mark ? OFF.cachePut(uid, "wm:buildings", nm) : Promise.resolve()]).then(function () { return rows; });
      });
    });
  }
  function fullPullBuildings(uid) {
    return prodDb.listBuildings().then(function (br) {
      if (br.error) throw br.error;
      var rows = br.data || [];
      var nm = maxUpdatedAt(rows, "");
      // nm from server rows, or null when empty — a full pull always leaves a CLEAN watermark state
      return Promise.all([OFF.cachePut(uid, "buildings", rows),
        OFF.cachePut(uid, "wm:buildings", nm || null)]).then(function () { return rows; });
    });
  }
  function snapshotBuilding(bid) {   // write the per-building snapshot after any section refresh
    var uid = userId(); if (!uid) return;
    OFF.cachePut(uid, "b:" + bid, { assets: S.assets, proof: S.proof, offers: S.offers, contacts: S.contacts });
    S.snapTs = Date.now();
  }

  /* v1.5 (doc-80 §2): new building = client-UUID insert THROUGH THE OUTBOX — online and offline are the
   * same path. Optimistic row into state+cache immediately (chip says `lagret på enheten` until acked);
   * the post-drain delta pull replaces it with the server row. */
  function addBuilding() {
    var b = { name: val("nb_name"), addr: val("nb_addr"), gnr: val("nb_gnr"), bnr: val("nb_bnr") };
    if (!b.name) { S.error = "Bygg-navn må fylles ut."; S.msg = null; render(); return; }
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid) { S.error = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    var row = coreToRow(S.tenant.id, b); row.id = OFF.uuid();
    S.error = null; S.msg = null;
    OFF.queueOp({ entity: "buildings", op: "insert", payload: row, baseUpdatedAt: null,
      tenantId: S.tenant.id, buildingId: row.id, userId: uid, title: "Nytt bygg: " + row.name })
      .then(function () {
        S.buildings = (S.buildings || []); S.buildings.push(rowToCore(row));
        S.buildings.sort(function (x, y) { return (x.name || "") < (y.name || "") ? -1 : 1; });
        return OFF.cacheGet(uid, "buildings").then(function (c) {
          return OFF.cachePut(uid, "buildings", ((c && c.v) || []).concat([row]));
        });
      })
      .then(function () {
        S.msg = "Lagret på enheten: " + row.name + " — synkes.";
        refreshPending(function () { render(); });
        drainAll();
      })
      .catch(function (e) {   // C1: durable queueing failed — loud, never a fake ✓
        S.error = "⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — bygget er IKKE lagret.";
        render();
      });
  }
  function friendly(e) { var m = (e && e.message) || String(e); if (/JWT|not authenticated|session missing|401/i.test(m)) return "Økten er utløpt — logg inn på nytt (arbeidet ble IKKE lagret)."; return m; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  /* ============================ onboarding A: Step-0 registry prefill (doc-82) ============================
   * Port of the demo's proven Step-0 layer into /app: one search → a confirmed, editable building record
   * from public, key-free, CORS-open registries (geonorge adresser + Brønnøysund enheter). Behaviour is
   * ported verbatim from the demo incl. **null-on-fail** (never throws; always falls back to manual) and
   * **fodselsdato NEVER retained** — parseRoles reads names only (the roller payload DOES carry birthdates;
   * they must not touch client state, doc-82 §4). CSP: connect-src allows ws.geonorge.no + data.brreg.no. */
  var BRREG = "https://data.brreg.no/enhetsregisteret/api/enheter";
  function titleCase(s) {
    // capitalize the first letter after a real separator only — treating æ/ø/å as word chars. (The demo's
    // /\b(...)/ version mis-fires mid-word on æ/ø/å — "MellomgÅRden"; JS \b counts them as non-word. Fixed here.)
    return (s || "").toLowerCase().replace(/(^|[\s\-\/])([a-zà-ÿ])/g, function (m, p, c) { return p + c.toUpperCase(); })
      .replace(/\bAs\b/g, "AS").replace(/\bUsbl\b/g, "USBL").replace(/\bObos\b/g, "OBOS")
      .replace(/\bKpmg\b/g, "KPMG").replace(/\bBbl\b/g, "BBL").replace(/\bBrl\b/g, "BRL").replace(/\bSa\b/g, "SA").replace(/\bDa\b/g, "DA");
  }
  function personName(p) { var n = (p && p.navn) || {}; return [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean).join(" "); }
  function brregSearch(name, cb) {
    fetch(BRREG + "?navn=" + encodeURIComponent(name) + "&size=10").then(function (r) { return r.json(); })
      .then(function (j) { cb(((j._embedded || {}).enheter) || []); }).catch(function () { cb(null); });
  }
  function brregRoles(orgnr, cb) {
    fetch(BRREG + "/" + encodeURIComponent(orgnr) + "/roller").then(function (r) { return r.json(); })
      .then(function (j) { cb(parseRoles(j)); }).catch(function () { cb(null); });
  }
  function parseRoles(j) {   // → {forvalter, styreleder, styremedlemmer[], revisor} — NAMES ONLY (never fodselsdato)
    var out = { forvalter: null, styreleder: null, styremedlemmer: [], revisor: null };
    (((j || {}).rollegrupper) || []).forEach(function (g) {
      var gk = ((g.type || {}).kode) || "";
      (g.roller || []).forEach(function (r) {
        var rk = ((r.type || {}).kode) || "";
        var nm = r.enhet ? titleCase((r.enhet.navn || []).join(" ")) : r.person ? personName(r.person) : null;   // reads navn ONLY
        if (!nm) return;
        if (gk === "FFØR" && !out.forvalter) out.forvalter = nm;
        else if (gk === "STYR" && rk === "LEDE" && !out.styreleder) out.styreleder = nm;
        else if (gk === "STYR" && rk === "MEDL") out.styremedlemmer.push(nm);
        else if (gk === "REVI" && !out.revisor) out.revisor = nm;
      });
    });
    return out;
  }
  function geoSearch(q, cb) {
    fetch("https://ws.geonorge.no/adresser/v1/sok?sok=" + encodeURIComponent(q) + "&treffPerSide=10&fuzzy=true")
      .then(function (r) { return r.json(); }).then(function (j) { cb((j.adresser) || []); }).catch(function () { cb(null); });
  }
  function parseAddr(a) {
    return { adressetekst: a.adressetekst || "", postnummer: a.postnummer || "", poststed: a.poststed || "",
      kommunenavn: a.kommunenavn || "", kommunenummer: a.kommunenummer || "",
      gnr: (a.gardsnummer != null ? String(a.gardsnummer) : ""), bnr: (a.bruksnummer != null ? String(a.bruksnummer) : ""),
      lat: (a.representasjonspunkt || {}).lat, lon: (a.representasjonspunkt || {}).lon,
      units: ((a.bruksenhetsnummer) || []).length };
  }
  function geoLookup(q, cb) { geoSearch(q, function (list) { cb(list === null ? null : (list[0] ? parseAddr(list[0]) : false)); }); }
  // doc-83 #1 / doc-66 A1: once gnr/bnr is known, discover EVERY entrance on the property (Holtveien 9 = A+B+C
  // shows as 3 oppganger) so the true building shape is known before leaving the office. null-on-fail.
  function addrByMatrikkel(knr, gnr, bnr, cb) {
    if (!knr || gnr == null || gnr === "" || bnr == null || bnr === "") { cb(null); return; }
    var url = "https://ws.geonorge.no/adresser/v1/sok?kommunenummer=" + encodeURIComponent(knr)
      + "&gardsnummer=" + encodeURIComponent(gnr) + "&bruksnummer=" + encodeURIComponent(bnr) + "&utkoordsys=4258&treffPerSide=100";
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var ents = ((j && j.adresser) || []).map(function (a) {
        return { address: (a.adressetekst || ((a.adressenavn || "") + " " + a.nummer + (a.bokstav || ""))),
          nummer: a.nummer, bokstav: a.bokstav || "", gnr: String(a.gardsnummer), bnr: String(a.bruksnummer),
          units: ((a.bruksenhetsnummer) || []).length, lat: (a.representasjonspunkt || {}).lat, lon: (a.representasjonspunkt || {}).lon };
      }).sort(function (x, y) { return (x.nummer - y.nummer) || (x.bokstav < y.bokstav ? -1 : 1); });
      cb(ents);
    }).catch(function () { cb(null); });
  }

  /* ---- the wizard: search → pick → confirm card → create (buildings + contacts through the outbox) ---- */
  function nbOpen() { S.nb = { mode: "name", loading: false, error: null, results: null, prefill: null }; S.view = { name: "newBuilding" }; S.msg = null; S.error = null; render(); }
  function nbCancel() { S.nb = null; S.view = { name: "list" }; render(); }
  function nbSetMode(m) { if (!S.nb) return; S.nb.mode = m; S.nb.results = null; S.nb.error = null; render(); }
  function nbSearch() {
    var nb = S.nb; if (!nb) return;
    var q = val("nb_q"); if (!q) { nb.error = "Skriv et navn eller en adresse."; render(); return; }
    nb.results = null; nb.error = null; nb.prefill = null; nb.loading = true; render();
    if (nb.mode === "name") {
      brregSearch(q, function (list) { nb.loading = false; if (list === null) nb.error = "Brønnøysund utilgjengelig (nett) — søk på adresse eller fyll inn manuelt."; else nb.results = { type: "brreg", items: list }; render(); });
    } else {
      geoSearch(q, function (list) { nb.loading = false; if (list === null) nb.error = "geonorge utilgjengelig — fyll inn manuelt."; else nb.results = { type: "geo", items: list }; render(); });
    }
  }
  function prefillFromGeo(a) {
    var p = parseAddr(a);
    return { source: "geonorge", name: (p.adressetekst || ""), orgnr: "", orgform: "Eierseksjonssameie",
      addr: p.adressetekst, postnummer: p.postnummer, poststed: p.poststed, kommunenavn: p.kommunenavn, kommunenummer: p.kommunenummer,
      gnr: p.gnr, bnr: p.bnr, lat: p.lat, lon: p.lon, units: p.units, forvalter: "", styreleder: "", entrances: null, oppgangLoading: false };
  }
  // brreg forretningsadresse is the FORVALTER's c/o office, NOT the building — do NOT seed address/coords
  // from it (the demo lesson: that put the map on the forvalter). Org + roles are correct; the rep types
  // the real street + 📍 Geokod resolves gnr/bnr/coords.
  function prefillFromBrreg(e) {
    var of = (e.organisasjonsform || {});
    return { source: "Brønnøysund", name: titleCase(e.navn), orgnr: e.organisasjonsnummer || "", orgform: (of.beskrivelse || of.kode || ""),
      addr: "", postnummer: "", poststed: "", kommunenavn: "", kommunenummer: "", gnr: "", bnr: "", lat: null, lon: null, units: 0,
      forvalter: "", styreleder: "", entrances: null, oppgangLoading: false };
  }
  function nbDiscover(p) {   // fill p.entrances from the property's gnr/bnr (oppganger); silent on fail
    if (!p || !p.kommunenummer || !p.gnr || !p.bnr) return;
    p.oppgangLoading = true; render();
    addrByMatrikkel(p.kommunenummer, p.gnr, p.bnr, function (ents) {
      p.oppgangLoading = false; p.entrances = ents || null;   // null-on-fail: just no count, never a crash
      if (S.nb && S.nb.prefill === p) render();
    });
  }
  function nbPick(idx) {
    var nb = S.nb; if (!nb || !nb.results) return; var it = (nb.results.items || [])[idx]; if (!it) return;
    if (nb.results.type === "geo") { nb.prefill = prefillFromGeo(it); render(); nbDiscover(nb.prefill); return; }
    var p = prefillFromBrreg(it); nb.prefill = p; render();
    if (p.orgnr) brregRoles(p.orgnr, function (roles) {
      if (roles && S.nb && S.nb.prefill === p) { p.forvalter = roles.forvalter || ""; p.styreleder = roles.styreleder || ""; render(); }
    });
  }
  function nbSyncForm() {
    var p = S.nb && S.nb.prefill; if (!p) return;
    p.name = val("nb_name"); p.orgnr = val("nb_orgnr"); p.orgform = val("nb_orgform"); p.addr = val("nb_addr");
    p.gnr = val("nb_gnr"); p.bnr = val("nb_bnr"); p.kommunenummer = val("nb_kommunenr");
    var la = parseFloat(val("nb_lat")), lo = parseFloat(val("nb_lon")); if (!isNaN(la)) p.lat = la; if (!isNaN(lo)) p.lon = lo;
    var u = parseInt(val("nb_units"), 10); if (!isNaN(u)) p.units = u;
    p.forvalter = val("nb_forvalter"); p.styreleder = val("nb_styreleder");
  }
  function nbGeocode() {
    var p = S.nb && S.nb.prefill; if (!p) return; nbSyncForm();
    var q = val("nb_addr"); if (!q) { S.nb.error = "Skriv en adresse å geokode."; render(); return; }
    S.nb.error = null; p.geoBusy = true; render();
    geoLookup(q, function (res) {
      p.geoBusy = false;
      if (res === null) { S.nb.error = "geonorge utilgjengelig — fyll inn gnr/bnr manuelt."; render(); return; }
      if (!res) { S.nb.error = "Fant ikke adressen — prøv med husnummer/bokstav, eller fyll inn manuelt."; render(); return; }
      p.addr = res.adressetekst; p.postnummer = res.postnummer; p.poststed = res.poststed;
      p.kommunenavn = res.kommunenavn || p.kommunenavn; p.kommunenummer = res.kommunenummer || p.kommunenummer;
      p.gnr = res.gnr; p.bnr = res.bnr; p.lat = res.lat; p.lon = res.lon; if (res.units) p.units = res.units;
      if (!p.name) p.name = res.adressetekst || "";
      render(); nbDiscover(p);   // resolved gnr/bnr → discover oppganger
    });
  }
  function nbManual() {
    if (!S.nb) return;
    S.nb.results = null; S.nb.error = null; S.nb.loading = false;
    S.nb.prefill = { source: "manuelt", name: "", orgnr: "", orgform: "Borettslag", addr: "", postnummer: "", poststed: "",
      kommunenavn: "", kommunenummer: "", gnr: "", bnr: "", lat: null, lon: null, units: "", forvalter: "", styreleder: "", entrances: null, oppgangLoading: false };
    render();
  }
  function nbCreate() {
    var nb = S.nb; if (!nb || !nb.prefill) return; nbSyncForm(); var p = nb.prefill;
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid) { nb.error = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    if (!p.name) p.name = (p.addr || "").split(",")[0].trim() || "Nytt bygg";   // address/discovery path may have no org name → never silently block
    var b = { name: p.name, orgnr: p.orgnr, addr: p.addr, gnr: p.gnr, bnr: p.bnr, kommunenr: p.kommunenummer, lat: p.lat, lon: p.lon };
    var row = coreToRow(S.tenant.id, b); row.id = OFF.uuid();
    // contacts: styreleder + forvalter, NAME + ROLE only (registry gives no work phone/email; those are manual later)
    var contactRows = [];
    if ((p.styreleder || "").trim()) contactRows.push({ id: OFF.uuid(), tenant_id: S.tenant.id, building_id: row.id, name: p.styreleder.trim(), role: "Styreleder", phone: null, email: null });
    if ((p.forvalter || "").trim()) contactRows.push({ id: OFF.uuid(), tenant_id: S.tenant.id, building_id: row.id, name: p.forvalter.trim(), role: "Forvalter", phone: null, email: null });
    nb.busy = true; nb.error = null; render();
    // FIFO matters: queue the BUILDING first (contacts.building_id FKs it), then the contacts.
    OFF.queueOp({ entity: "buildings", op: "insert", payload: row, baseUpdatedAt: null,
      tenantId: S.tenant.id, buildingId: row.id, userId: uid, title: "Nytt bygg: " + row.name })
      .then(function () {
        S.buildings = (S.buildings || []); S.buildings.push(rowToCore(row));
        S.buildings.sort(function (x, y) { return (x.name || "") < (y.name || "") ? -1 : 1; });
        return OFF.cacheGet(uid, "buildings").then(function (c) { return OFF.cachePut(uid, "buildings", ((c && c.v) || []).concat([row])); });
      })
      .then(function () {   // queue contacts sequentially so their clientTs follows the building's
        return contactRows.reduce(function (chain, cr) {
          return chain.then(function () {
            return OFF.queueOp({ entity: "contacts", op: "insert", payload: cr, baseUpdatedAt: null,
              tenantId: S.tenant.id, buildingId: row.id, userId: uid, title: cr.name });
          });
        }, Promise.resolve());
      })
      .then(function () {
        // seed the building's contact cache so the detail view shows them immediately (they drain right after)
        if (contactRows.length) OFF.cachePut(uid, "b:" + row.id, { assets: [], proof: [], offers: null, contacts: contactRows.slice() });
        S.nb = null;
        openBuilding(row.id);   // land in the new building's detail view (ready for pass B's map)
        drainAll();
      })
      .catch(function (e) {
        nb.busy = false;
        nb.error = "⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — bygget er IKKE lagret.";
        render();
      });
  }

  /* ============================ render ============================ */
  function buildingById(id) { return (S.buildings || []).filter(function (b) { return b.id === id; })[0] || null; }
  function discardProofDraft() {   // an abandoned draft photo never lingers in the queue store
    if (S.proofPhoto) { try { OFF.delPhoto(S.proofPhoto.path); } catch (e) {} }
    S.proofPhoto = null; S.proofDraft = null;
  }
  function openBuilding(id) {
    discardProofDraft();
    S.view = { name: "building", id: id };
    S.assets = null; S.proof = null; S.offers = null; S.contacts = null; S.editAsset = null; S.editContact = null; S.secErr = {}; S.secMsg = {}; S.msg = null; S.error = null; S.snapTs = null;
    render();
    loadBuildingSections(id);   // cache-first paint, then background refresh; each section surfaces its own errors (C1)
  }
  function closeBuilding() { discardProofDraft(); S.view = { name: "list" }; S.editAsset = null; S.msg = null; S.error = null; render(); }
  function loadBuildingSections(id) {
    var uid = userId();
    var start = function () { refreshPending(); if (!S.session || !navigator.onLine) { render(); return; } loadAssets(id); loadContacts(id); loadProof(id); loadOffers(id); };
    if (!uid) { start(); return; }
    OFF.cacheGet(uid, "b:" + id).then(function (snap) {
      if (snap && snap.v) { S.assets = snap.v.assets; S.proof = snap.v.proof; S.offers = snap.v.offers; S.contacts = snap.v.contacts || null; S.snapTs = snap.ts; render(); }
      start();
    }).catch(start);
  }

  /* ---------- offline plumbing: pending state + drain (doc-80 §2/§6) ---------- */
  function refreshPending(cb) {
    var uid = userId(); if (!uid) { S.pending = { total: 0, ops: 0, photos: 0, rejected: 0 }; S.pendingOps = []; S.pendingPhotos = []; S.review = []; if (cb) cb(); return; }
    Promise.all([OFF.countPending(uid), OFF.listOps(uid), OFF.listPhotos(uid), OFF.listReview(uid)]).then(function (r) {
      S.pending = r[0]; S.pendingOps = r[1]; S.pendingPhotos = r[2]; S.review = r[3] || [];
      if (cb) cb();
    }).catch(function () { if (cb) cb(); });
  }
  function drainAll() {
    var uid = userId();
    if (!uid || !S.session || !navigator.onLine) return;   // draining needs a live token; the offline identity only queues
    OFF.drain(sb, uid, function () { refreshPending(function () { render(); }); }).then(function (changed) {
      refreshPending(function () {
        render();
        if (!changed) return;
        // acked (or conflict-resolved) ops → the DELTA pull brings server truth into the cache, chips flip
        if (S.view.name === "building") { loadAssets(S.view.id); loadContacts(S.view.id); loadProof(S.view.id); }
        var u2 = userId();
        if (u2 && S.session && navigator.onLine) {
          pullBuildings(u2).then(function (rows) { S.buildings = rows.map(rowToCore); S.listTs = Date.now(); render(); }).catch(function () {});
        }
      });
    });
  }
  function headerChipsHTML() {
    var out = "";
    if (S.offline) out += ' <span class="chip q">frakoblet</span>';   // a NORMAL state — neutral, no red panic (doc 62)
    if (S.pending.total > 0) out += ' <button class="chip pendbtn" data-act="openOutbox">● ' + S.pending.total + ' usendte</button>';
    // doc-80 §2: a lost LWW race is NEVER a mid-field-day error toast — a quiet, neutral badge
    if ((S.review || []).length > 0) out += ' <button class="chip q pendbtn" data-act="openReview">⚑ ' + S.review.length + ' trenger gjennomsyn</button>';
    if (S.updateReg) out += ' <button class="chip s pendbtn" data-act="applyUpdate">ny versjon — last på nytt</button>';
    return out;
  }
  // v1.5 honesty chips (doc-80 §6): a record with a queued class-B op wears its sync state on the row
  function pendingOpByRecord(entity) {
    var m = {};
    (S.pendingOps || []).forEach(function (o) { if (o.entity === entity && o.payload && o.payload.id) m[o.payload.id] = o; });
    return m;
  }
  function opChip(o) {
    if (!o) return "";
    return o.status === "sending" ? ' <span class="chip s">synkes…</span>'
      : o.status === "rejected" ? ' <span class="chip err">avvist</span>'
      : o.status === "held" ? ' <span class="chip warn">får ikke synket</span>'
      : ' <span class="chip q">lagret på enheten</span>';
  }
  function renderOutbox() {
    var rows = (S.pendingOps || []).map(function (o) {
      var st = o.status === "sending" ? '<span class="chip s">synkes…</span>'
        : o.status === "rejected" ? '<span class="chip err">avvist</span>'
        : o.status === "held" ? '<span class="chip warn">får ikke synket</span>'
        : '<span class="chip q">lagret på enheten</span>';
      var b = buildingById(o.buildingId);
      var when = ""; try { when = new Date(o.clientTs).toLocaleString("no", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) {}
      return '<div class="bldg"><span class="t">📝 ' + esc(o.title || o.entity) + ' ' + st + '</span>'
        + '<span class="d">' + esc(b ? b.name : (o.buildingId || "")) + ' · ' + esc(when)
        + (o.lastError ? ' · ' + esc(o.lastError) : '') + (o.attempts ? ' · forsøk: ' + o.attempts : '') + '</span>'
        + (o.status === "rejected" ? '<span style="display:block;margin-top:6px"><button class="btn ghost" style="padding:7px 10px" data-act="discardOp" data-id="' + esc(o.opId) + '">Forkast denne</button></span>' : '')
        + '</div>';
    }).join("");
    var prows = (S.pendingPhotos || []).filter(function (p) { return p.status !== "uploaded" && p.status !== "draft"; }).map(function (p) {   // a draft belongs to its open form, not the outbox
      var st = p.status === "sending" ? '<span class="chip s">synkes…</span>'
        : p.status === "rejected" ? '<span class="chip err">avvist</span>'
        : p.status === "held" ? '<span class="chip warn">får ikke synket</span>'
        : '<span class="chip q">i kø</span>';
      var b = buildingById(p.buildingId);
      return '<div class="bldg"><span class="t">📷 Bilde ' + st + '</span><span class="d">' + esc(b ? b.name : "") + (p.lastError ? ' · ' + esc(p.lastError) : '') + '</span></div>';
    }).join("");
    var anyHeld = (S.pendingOps || []).some(function (o) { return o.status === "held"; }) || (S.pendingPhotos || []).some(function (p) { return p.status === "held"; });
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>' + headerChipsHTML() + '</div>'
      + '<div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(userEmail()) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="bhead"><button class="btn ghost" data-act="back" style="padding:9px 13px">← Tilbake</button><div><h1>Usendte registreringer</h1>'
      + '<div class="note">«synket ✓» er eneste status styret kan se. Avviste synkes aldri på nytt uten at du gjør noe.</div></div></div>'
      + (rows || prows ? rows + prows : '<div class="empty">Ingenting i kø — alt er synket ✓</div>')
      + '<div class="bar">' + (anyHeld ? '<button class="btn" data-act="retryHeld">Prøv igjen nå</button>' : '') + '</div>';
  }
  /* v1.5 «Trenger gjennomsyn» (doc-80 §2): the device-local store of lost LWW races. Server won and
   * stands; each item shows your value vs the server's, both timestamps, and two honest exits:
   * «Bruk min likevel» = a NEW edit on top of the CURRENT server base (through the outbox, base-checked
   * again) — «Forkast min» = drop it. Never an error toast mid-field-day. */
  var FIELD_LABELS = { label: "Navn/merking", type: "Type", area: "Område", access: "Tilgang", notes: "Notat",
    bin: "Dunk-detaljer", lat: "Posisjon (lat)", lon: "Posisjon (lon)", compliance_link: "Kravlenke",
    deleted_at: "Sletting", name: "Navn", address: "Adresse", org_nr: "Org.nr", gnr: "gnr", bnr: "bnr", kommunenr: "Kommunenr",
    role: "Rolle", phone: "Telefon", email: "E-post" };
  function fmtFieldVal(k, v) {
    if (k === "deleted_at") return v ? "slettet" : "ikke slettet";
    if (v == null || v === "") return "—";
    if (typeof v === "object") { try { var parts = []; for (var key in v) if (v[key] != null && v[key] !== "") parts.push(key + ": " + v[key]); return parts.join(", ") || "—"; } catch (e) { return JSON.stringify(v); } }
    return String(v);
  }
  function fmtWhen(ts) { if (!ts) return ""; try { return new Date(ts).toLocaleString("no", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function renderReview() {
    var rows = (S.review || []).map(function (r) {
      var b = buildingById(r.buildingId);
      var gone = !r.serverRow;
      var diffs = Object.keys(r.fields || {}).filter(function (k) { return k !== "id"; }).map(function (k) {
        var mine = fmtFieldVal(k, r.fields[k]);
        var srv = gone ? "(raden finnes ikke lenger på serveren)" : fmtFieldVal(k, r.serverRow[k]);
        return '<span class="d" style="margin-top:3px"><b>' + esc(FIELD_LABELS[k] || k) + ':</b> din: «' + esc(mine) + '» · på serveren: «' + esc(srv) + '»</span>';
      }).join("");
      return '<div class="bldg"><span class="t">⚑ ' + esc(r.recordName || r.entity) + ' <span class="chip q">serveren står</span></span>'
        + '<span class="d">' + esc(b ? b.name : "") + (b ? ' · ' : '') + 'din endring ' + esc(fmtWhen(r.ts))
        + (r.serverUpdatedAt ? ' · serverens versjon ' + esc(fmtWhen(r.serverUpdatedAt)) : '') + '</span>'
        + diffs
        + '<span style="display:flex;gap:8px;margin-top:9px">'
        + '<button class="btn" style="padding:8px 12px" data-act="reviewUseMine" data-id="' + esc(r.reviewId) + '"' + (gone ? ' disabled' : '') + '>Bruk min likevel</button>'
        + '<button class="btn ghost" style="padding:8px 12px" data-act="reviewDiscard" data-id="' + esc(r.reviewId) + '">Forkast min</button>'
        + '</span>' + (gone ? '<span class="d" style="margin-top:5px">Raden er slettet på serveren — endringen kan bare forkastes.</span>' : '') + '</div>';
    }).join("");
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>' + headerChipsHTML() + '</div>'
      + '<div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(userEmail()) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="bhead"><button class="btn ghost" data-act="back" style="padding:9px 13px">← Tilbake</button><div><h1>Trenger gjennomsyn</h1>'
      + '<div class="note">Noen andre endret det samme før deg — serverens versjon står. Velg per endring.</div></div></div>'
      + (rows || '<div class="empty">Ingenting å gjennomgå.</div>');
  }
  // doc-80 §5: sign-out with a non-empty outbox blocks — sync first, discard explicitly, or cancel.
  function renderSignoutGuard() {
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span></div></div>'
      + '<div class="card"><div class="ct">Usendte registreringer</div>'
      + '<p class="note" style="margin-top:-2px"><b>' + S.pending.total + ' registrering' + (S.pending.total !== 1 ? 'er' : '') + ' er ikke synket.</b> Logger du av nå uten å synke, blir de liggende usynlige for styret til du logger inn igjen på denne enheten — eller forsvinner hvis du forkaster dem.</p>'
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + '<div class="bar">'
      + '<button class="btn" data-act="guardSync"' + (navigator.onLine ? '' : ' disabled') + '>Synk først' + (navigator.onLine ? '' : ' (frakoblet)') + '</button>'
      + '<button class="btn ghost" data-act="guardDiscard">Forkast ' + S.pending.total + '</button>'
      + '<button class="btn ghost" data-act="guardCancel">Avbryt</button>'
      + '</div></div>';
  }

  function render() {
    if (!S.session && !S.offlineIdent) { renderLogin(); }
    else if (S.view.name === "signoutGuard") { renderSignoutGuard(); }
    else if (S.view.name === "outbox") { renderOutbox(); }
    else if (S.view.name === "review") { renderReview(); }
    else if (S.view.name === "newBuilding") { renderNewBuilding(); }
    else if (S.noAccess) { renderNoAccess(); }
    else if (S.view.name === "building" && buildingById(S.view.id)) { renderBuilding(buildingById(S.view.id)); hydrateProofPhotos(); }
    else { S.view = { name: "list" }; renderApp(); }
    bind();
  }
  // gate item 3: an authenticated user with NO membership gets a clear dead-end with a way out — never an empty app.
  function renderNoAccess() {
    var email = (S.session.user && S.session.user.email) || "";
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span></div>'
      + '<div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="card"><div class="ct">Ingen tilgang</div>'
      + '<p class="note" style="margin-top:-2px">Kontoen din er bekreftet, men den er ikke knyttet til noen virksomhet ennå.</p>'
      + '<div class="msg err">Ingen tilgang — kontakt administrator for å bli lagt til i riktig virksomhet.</div>'
      + '</div>';
  }
  function renderLogin() {
    // OTP pass: the CODE is the primary path (it works everywhere, incl. the installed iOS app where
    // the magic link would open in Safari instead). The link stays as the alternative.
    var codeBlock = "";
    if (S.otpEmail) {
      codeBlock =
        '<label>Skriv inn 6-sifret kode fra e-posten</label>'
        + '<input id="li_code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="letter-spacing:.3em;font-size:19px;font-weight:700">'
        + '<div class="bar"><button class="btn" data-act="verifyCode"' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? '<span class="spin"></span>Sjekker…' : 'Logg inn med kode →') + '</button></div>'
        + '<p class="note" style="margin-bottom:0">'
        + (isStandalone()
          ? 'I den installerte appen er <b>koden</b> veien inn — lenken i e-posten åpner i nettleseren, ikke her.'
          : '…eller klikk lenken i e-posten <b>på denne enheten</b>.')
        + ' Ser du ingen kode? E-posten inneholder også en innloggingslenke.</p>';
    }
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span></div></div>'
      + '<div class="card"><div class="ct">Logg inn</div>'
      + '<p class="note" style="margin-top:-2px">Produksjonsappen mot <b>onsite-prod</b>. Ingen passord — vi sender en e-post med engangskode (6 siffer) og innloggingslenke.</p>'
      + '<label>E-post</label><input id="li_email" type="email" inputmode="email" autocomplete="email" placeholder="deg@firma.no" value="' + esc(S.otpEmail || lastEmail()) + '">'
      + (S.msg ? '<div class="msg ok">' + esc(S.msg) + '</div>' : '')
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + '<div class="bar"><button class="btn' + (S.otpEmail ? ' ghost' : '') + '" data-act="login"' + (S.loading ? ' disabled' : '') + '>' + (S.loading && !S.otpEmail ? '<span class="spin"></span>Sender…' : (S.otpEmail ? 'Send ny e-post' : 'Send kode →')) + '</button></div>'
      + codeBlock
      + '</div>'
      + '<p class="note">Demoen (Ren Dunk) ligger uendret på <a href="https://onsite-site.vercel.app">onsite-site.vercel.app</a>. Denne appen kjører på sitt eget domene (origin-isolert fra demoen) og snakker med den ekte, tenant-isolerte backenden.</p>';
  }
  /* ---- add-to-home-screen (doc 81, small pass): a quiet one-line hint on the LIST only — never during
   * capture (doc 62), never in standalone, dismissal remembered. iOS = manual steps; Android = the
   * captured beforeinstallprompt. ---- */
  var A2HS_KEY = "onsite_a2hs_dismissed";
  var A2HS_IOS_ENABLED = false;   // iOS add-to-home hint suppressed until installed-iOS login works (OTP email unblocked)
  function isStandalone() { try { return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; } catch (e) { return false; } }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent || ""); }
  function a2hsDismissed() { try { return localStorage.getItem(A2HS_KEY) === "1"; } catch (e) { return true; } }
  function installHintHTML() {
    if (isStandalone() || a2hsDismissed()) return "";
    if (S.installEvt) {
      return '<div class="card" style="padding:11px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px">'
        + '<span class="note" style="margin:0">📲 Installer OnSite for rask tilgang fra Hjem-skjermen.</span>'
        + '<span style="display:flex;gap:8px;flex-shrink:0"><button class="btn" style="padding:8px 12px" data-act="a2hsInstall">Installer</button>'
        + '<button class="btn ghost" style="padding:8px 10px" data-act="a2hsDismiss" aria-label="Ikke nå">✕</button></span></div>';
    }
    // Housekeeping (doc-82, Martin's 7 Jul defer): the iOS hint invites users to install, but the
    // installed-iOS PWA login is still broken until the {{ .Token }} email works (blocked on Supabase
    // Free tier). So the iOS hint stays SUPPRESSED. Flip A2HS_IOS_ENABLED back to true when Pro/SMTP lands.
    if (A2HS_IOS_ENABLED && isIOS()) {
      return '<div class="card" style="padding:11px 14px;display:flex;justify-content:space-between;gap:10px;align-items:center">'
        + '<span class="note" style="margin:0">📲 Legg til på Hjem-skjerm for rask tilgang: trykk <b>Del</b> (firkanten med pil ↑), velg <b>«Legg til på Hjem-skjerm»</b> — og logg inn i appen med koden fra e-posten.</span>'
        + '<button class="btn ghost" style="padding:8px 10px;flex-shrink:0" data-act="a2hsDismiss" aria-label="Ikke nå">✕</button></div>';
    }
    return "";
  }
  function renderApp() {
    var email = userEmail() || "innlogget";
    var head =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + (S.tenant.role ? ' · ' + esc(S.tenant.role) : '') + (S.tenant.count > 1 ? ' · tilgang 1 av ' + S.tenant.count : '') + '</span>' : '')
      + headerChipsHTML()
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>';

    var list;
    if (S.loading && S.buildings == null) { list = '<div class="empty"><span class="spin"></span>Henter bygg fra onsite-prod…</div>'; }
    else if (!S.buildings || !S.buildings.length) { list = '<div class="empty">Ingen bygg ennå for denne tenanten. Legg til det første nedenfor.</div>'; }
    else {
      var bPend = pendingOpByRecord("buildings");
      list = S.buildings.map(function (b) {
        var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
        return '<button class="bldg click" data-act="openBuilding" data-id="' + esc(b.id) + '"><span><span class="t">🏢 ' + esc(b.name) + opChip(bPend[b.id]) + '</span>' + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + '</span><span class="chev">›</span></button>';
      }).join("");
    }

    var buildingsCard =
      '<div class="card"><div class="ct">Bygg <span class="muted" style="font-weight:600">· ' + (S.buildings ? S.buildings.length : '…') + ' · fra onsite-prod (RLS: kun din tenant)</span></div>'
      + (S.msg ? '<div class="msg ok">' + esc(S.msg) + '</div>' : '')
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + list + '</div>';

    // onboarding A: the add flow is now search-first (registry prefill); manual lives inside the wizard.
    var addCard =
      '<div class="card"><div class="ct">＋ Legg til bygg</div>'
      + '<p class="note" style="margin-top:-2px">Søk opp borettslaget/sameiet i offentlige registre — så er navn, org.nr, styre og gnr/bnr fylt ut før du drar på befaring.</p>'
      + '<div class="bar"><button class="btn" data-act="nbOpen">🔎 Søk og legg til bygg →</button></div>'
      + '</div>';

    app.innerHTML = head + installHintHTML() + buildingsCard + addCard;
  }
  /* onboarding A: the search-first add-building wizard view (doc-82). */
  function renderNewBuilding() {
    var nb = S.nb || { mode: "name" };
    var head =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + '</span>' : '') + headerChipsHTML()
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(userEmail()) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>';
    var bhead = '<div class="bhead"><button class="btn ghost" data-act="nbCancel" style="padding:9px 13px">← Bygg</button><div><h1>Legg til bygg</h1><div class="note">Fra offentlige registre — geonorge + Brønnøysund</div></div></div>';

    var search = '';
    if (!nb.prefill) {
      var tName = 'class="btn ' + (nb.mode === "name" ? '' : 'ghost') + '" data-act="nbModeName" style="padding:9px 13px"';
      var tAddr = 'class="btn ' + (nb.mode === "address" ? '' : 'ghost') + '" data-act="nbModeAddr" style="padding:9px 13px"';
      search = '<div class="card"><div class="ct">1 · Søk</div>'
        + '<div class="bar" style="margin-top:0"><button ' + tName + '>🏢 Navn (borettslag/sameie)</button><button ' + tAddr + '>📍 Adresse</button></div>'
        + '<label>' + (nb.mode === "name" ? "Navn på borettslag/sameie" : "Adresse") + '</label>'
        + '<input id="nb_q" placeholder="' + (nb.mode === "name" ? "f.eks. Mellomgården borettslag" : "f.eks. Rødtvetveien 20, Oslo") + '" value="' + esc(nb.query || "") + '">'
        + (nb.error ? '<div class="msg err">' + esc(nb.error) + '</div>' : '')
        + '<div class="bar"><button class="btn" data-act="nbSearch"' + (nb.loading ? ' disabled' : '') + '>' + (nb.loading ? '<span class="spin"></span>Søker…' : 'Søk →') + '</button>'
        + '<button class="btn ghost" data-act="nbManual">Fyll inn manuelt</button></div></div>';
    }

    var results = '';
    if (nb.results && !nb.prefill) {
      var items = nb.results.items || [];
      var body = !items.length ? '<div class="empty">Ingen treff — prøv et annet søk eller fyll inn manuelt.</div>'
        : items.map(function (it, i) {
          if (nb.results.type === "brreg") {
            var of = (it.organisasjonsform || {});
            return '<button class="bldg click" data-act="nbPick" data-idx="' + i + '"><span><span class="t">🏢 ' + esc(titleCase(it.navn || "")) + '</span><span class="d">org ' + esc(it.organisasjonsnummer || "") + (of.beskrivelse ? ' · ' + esc(of.beskrivelse) : '') + '</span></span><span class="chev">›</span></button>';
          }
          var pa = parseAddr(it);
          return '<button class="bldg click" data-act="nbPick" data-idx="' + i + '"><span><span class="t">📍 ' + esc(pa.adressetekst) + '</span><span class="d">' + esc([pa.poststed, (pa.gnr ? 'gnr ' + pa.gnr + '/' + pa.bnr : '')].filter(Boolean).join(' · ')) + '</span></span><span class="chev">›</span></button>';
        }).join("");
      results = '<div class="card"><div class="ct">2 · Velg treff</div>' + body + '</div>';
    }

    var confirm = nb.prefill ? nbConfirmHTML(nb.prefill, nb) : '';
    app.innerHTML = head + bhead + search + results + confirm;
  }
  function nbConfirmHTML(p, nb) {
    var needGeo = (nb.results && nb.results.type === "brreg") || p.source === "Brønnøysund" || !p.gnr;
    var opp = p.oppgangLoading ? '<div class="note"><span class="spin"></span>Søker oppganger…</div>'
      : (p.entrances && p.entrances.length)
        ? '<div class="binbox" style="border-color:var(--teal)"><b>🏘️ ' + p.entrances.length + ' oppgang' + (p.entrances.length !== 1 ? 'er' : '') + ' funnet</b> på gnr ' + esc(p.gnr) + '/' + esc(p.bnr) + ': '
          + p.entrances.map(function (e) { return esc((e.nummer || "") + (e.bokstav || "")); }).join(", ")
          + ' · ' + p.entrances.reduce(function (s, e) { return s + (e.units || 0); }, 0) + ' boenheter'
          + '<div class="note" style="margin:4px 0 0">Befaringen starter med byggets faktiske form.</div></div>'
        : '';
    return '<div class="card"><div class="ct">' + (nb.results ? '3' : '2') + ' · Bekreft og rediger <span class="muted" style="font-weight:600">· kilde: ' + esc(p.source || "") + '</span></div>'
      + (nb.error ? '<div class="msg err">' + esc(nb.error) + '</div>' : '')
      + '<label>Navn *</label><input id="nb_name" value="' + esc(p.name || "") + '" placeholder="Sameiet Solsiden">'
      + '<div class="row2"><div style="flex:1"><label>Org.nr</label><input id="nb_orgnr" value="' + esc(p.orgnr || "") + '"></div><div style="flex:1"><label>Org.form</label><input id="nb_orgform" value="' + esc(p.orgform || "") + '"></div></div>'
      + '<label>Adresse (byggets gate — ikke forvalters)</label><input id="nb_addr" value="' + esc(p.addr || "") + '" placeholder="Gate 1, 0123 Oslo">'
      + (needGeo ? '<div class="bar" style="margin-top:8px"><button class="btn ghost" data-act="nbGeocode"' + (p.geoBusy ? ' disabled' : '') + '>' + (p.geoBusy ? '<span class="spin"></span>Geokoder…' : '📍 Geokod (finn gnr/bnr + koordinater)') + '</button></div>' : '')
      + '<div class="row2"><div style="flex:1"><label>gnr</label><input id="nb_gnr" value="' + esc(p.gnr || "") + '"></div><div style="flex:1"><label>bnr</label><input id="nb_bnr" value="' + esc(p.bnr || "") + '"></div><div style="flex:1"><label>Kommunenr</label><input id="nb_kommunenr" value="' + esc(p.kommunenummer || "") + '"></div></div>'
      + '<div class="row2"><div style="flex:1"><label>~ Boenheter</label><input id="nb_units" value="' + esc(p.units != null ? p.units : "") + '"></div><div style="flex:1"><label>lat</label><input id="nb_lat" value="' + esc(p.lat != null ? p.lat : "") + '"></div><div style="flex:1"><label>lon</label><input id="nb_lon" value="' + esc(p.lon != null ? p.lon : "") + '"></div></div>'
      + opp
      + '<label>Forvalter</label><input id="nb_forvalter" value="' + esc(p.forvalter || "") + '" placeholder="—">'
      + '<label>Styreleder</label><input id="nb_styreleder" value="' + esc(p.styreleder || "") + '" placeholder="—">'
      + '<p class="note">Styreleder og forvalter lagres som kontakter — <b>kun navn + rolle</b> fra registeret. Telefon/e-post legges til manuelt senere; personopplysninger utover det offentlige registeret venter på sikkerhets-signoff.</p>'
      + '<div class="bar"><button class="btn" data-act="nbCreate"' + (nb.busy ? ' disabled' : '') + '>' + (nb.busy ? '<span class="spin"></span>Oppretter…' : 'Opprett bygg →') + '</button>'
      + '<button class="btn ghost" data-act="nbCancel">Avbryt</button></div></div>';
  }
  /* ============================ section: Eiendeler (1c-2 item 1 — assets) ============================ */
  /* v1.5 delta pull, assets (doc-80 §3): per-building watermark `wm:assets:<bid>`. Delta WITHOUT the
   * deleted_at filter — a tombstone arrives as a normal delta row (trigger bumped updated_at) and is
   * dropped from the cache/UI here. Full snapshot on first visit / no cache / corrupted watermark. */
  function loadAssets(bid) {
    S.secBusy.assets = true; S.secErr.assets = null;
    var uid = userId();
    var done = function (coreList) { S.secBusy.assets = false; S.assets = coreList; snapshotBuilding(bid); render(); };
    var fail = function (e) { S.secBusy.assets = false; S.secErr.assets = friendly(e); render(); };
    var full = function () {
      return prodDb.listAssets(bid).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data || [];
        var nm = maxUpdatedAt(rows, "");
        // nm from server rows, or null when the table is empty — never leave a corrupted marker behind
        if (uid) OFF.cachePut(uid, "wm:assets:" + bid, nm || null);
        done(rows.map(assetRowToCore));
      });
    };
    if (!uid) { full().catch(fail); return; }
    OFF.cacheGet(uid, "wm:assets:" + bid).then(function (wm) {
      var mark = wm && wm.v;
      if (!validWm(mark) || S.assets == null) return full();   // no watermark / no cached list → snapshot
      return prodDb.listAssetsDelta(bid, mark).then(function (r) {
        if (r.error) return fail(r.error);
        var delta = r.data || [];
        var byId = {}; (S.assets || []).forEach(function (a) { byId[a.id] = a; });
        delta.forEach(function (row) { if (row.deleted_at) delete byId[row.id]; else byId[row.id] = assetRowToCore(row); });
        var merged = Object.keys(byId).map(function (k) { return byId[k]; });
        merged.sort(function (x, y) { return (((x._row && x._row.created_at) || "")) < (((y._row && y._row.created_at) || "")) ? -1 : 1; });
        var nm = maxUpdatedAt(delta, mark);
        if (nm !== mark) OFF.cachePut(uid, "wm:assets:" + bid, nm);
        done(merged);
      });
    }).catch(fail);
  }
  function assetFormHTML(a) {
    var d = assetTypeDef(a.type);
    var typeOpts = ASSET_TYPES.map(function (t) { return '<option value="' + t.id + '"' + (a.type === t.id ? ' selected' : '') + '>' + t.emoji + ' ' + esc(t.label) + '</option>'; }).join("");
    var areaOpts = AREAS.map(function (k) { return '<option value="' + k + '"' + (a.area === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join("");
    var bin = a.bin || {};
    var binOpts = BIN_TYPES.map(function (t) { return '<option value="' + t + '"' + (bin.binType === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join("");
    var fracOpts = '<option value="">— velg —</option>' + BIN_FRACTIONS.map(function (f) { return '<option value="' + esc(f) + '"' + (bin.fraction === f ? ' selected' : '') + '>' + esc(f) + '</option>'; }).join("");
    return '<div class="aform" data-sec="assetform">'
      + '<label>Type</label><select id="as_type" data-field="as_type">' + typeOpts + '</select>'
      + '<label>Navn / merking</label><input id="as_label" value="' + esc(a.label || "") + '" placeholder="' + esc(d.label) + '">'
      + '<label>Område</label><select id="as_area">' + areaOpts + '</select>'
      + (d.isBin
        ? '<div class="binbox"><div class="note" style="font-weight:800;text-transform:uppercase;font-size:10.5px;letter-spacing:.03em;margin-bottom:2px">♻️ Dunk-detaljer</div>'
          + '<label>Dunktype</label><select id="as_bintype">' + binOpts + '</select>'
          + '<label>Fraksjon</label><select id="as_fraction">' + fracOpts + '</select>'
          + '<div class="row2"><div style="flex:1"><label>Leverandør</label><input id="as_supplier" value="' + esc(bin.supplier || "") + '" placeholder="Molok / Strømberg…"></div>'
          + '<div style="flex:1"><label>Volum</label><input id="as_capacity" value="' + esc(bin.capacity || "") + '" placeholder="5 m³ / 660 l"></div></div>'
          + '<label>Lokk / hengsel</label><input id="as_lidhinge" value="' + esc(bin.lidHinge || "") + '"></div>'
        : '')
      + '<label>Tilgang — nøkkel / kode / hvor</label><input id="as_access" value="' + esc(a.access || "") + '" placeholder="f.eks. nøkkel B3">'
      + '<label>Notat</label><input id="as_notes" value="' + esc(a.notes || "") + '">'
      + '<div class="bar"><button class="btn" data-act="assetSave"' + (S.secBusy.assets ? ' disabled' : '') + '>' + (a.id ? 'Lagre endringer' : 'Lagre eiendel') + ' →</button>'
      + '<button class="btn ghost" data-act="assetCancel">Avbryt</button></div></div>';
  }
  function syncAssetForm() {
    var a = S.editAsset; if (!a) return;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : undefined; };
    if (g("as_type") !== undefined) a.type = g("as_type");
    if (g("as_label") !== undefined) a.label = g("as_label");
    if (g("as_area") !== undefined) a.area = g("as_area");
    if (g("as_access") !== undefined) a.access = g("as_access");
    if (g("as_notes") !== undefined) a.notes = g("as_notes");
    if (assetTypeDef(a.type).isBin) {
      a.bin = a.bin || {};
      if (g("as_bintype") !== undefined) a.bin.binType = g("as_bintype");
      if (g("as_fraction") !== undefined) a.bin.fraction = g("as_fraction");
      if (g("as_supplier") !== undefined) a.bin.supplier = g("as_supplier");
      if (g("as_capacity") !== undefined) a.bin.capacity = g("as_capacity");
      if (g("as_lidhinge") !== undefined) a.bin.lidHinge = g("as_lidhinge");
    }
  }
  function sectionAssetsHTML(b) {
    var body;
    if (S.secBusy.assets && S.assets == null) body = '<div class="empty"><span class="spin"></span>Henter eiendeler…</div>';
    else if (!S.assets || !S.assets.length) body = '<div class="empty">Ingen eiendeler registrert ennå.</div>';
    else { var aPend = pendingOpByRecord("assets"); body = S.assets.map(function (a) {
      var d = assetTypeDef(a.type), bin = a.bin || {};
      var meta = [a.area, bin.fraction, bin.binType, bin.capacity, bin.supplier, a.access].filter(Boolean).join(' · ');
      return '<div class="bldg"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><span class="t">' + d.emoji + ' ' + esc(a.label || d.label) + opChip(aPend[a.id]) + '</span>'
        + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + (a.notes ? '<span class="d">' + esc(a.notes) + '</span>' : '') + '</span>'
        + '<span style="display:flex;gap:6px;flex-shrink:0"><button class="btn ghost" style="padding:7px 10px" data-act="assetEdit" data-id="' + esc(a.id) + '">✎</button>'
        + '<button class="btn ghost" style="padding:7px 10px" data-act="assetDel" data-id="' + esc(a.id) + '">🗑</button></span></div></div>';
    }).join(""); }
    return '<div class="card"><div class="ct">🧰 Eiendeler <span class="muted" style="font-weight:600">· ' + (S.assets ? S.assets.length : '…') + ' · assets (RLS: kun din tenant)</span></div>'
      + (S.secMsg.assets ? '<div class="msg ok">' + esc(S.secMsg.assets) + '</div>' : '')
      + (S.secErr.assets ? '<div class="msg err">' + esc(S.secErr.assets) + '</div>' : '')
      + body
      + (S.editAsset ? assetFormHTML(S.editAsset) : '<div class="bar"><button class="btn ghost" data-act="assetNew">＋ Legg til eiendel</button></div>')
      + '</div>';
  }
  /* v1.5 (doc-80 §2): class-B asset writes go through the outbox — one path, online or offline.
   * Edit → `update` op with ONLY the changed fields + baseUpdatedAt = the updated_at the edit was
   * built on (cached verbatim). New → client-UUID `insert` (idempotent upsert). A row that has never
   * synced (no server updated_at yet) is re-upserted whole instead — there is no base to check against. */
  function assetSave() {
    syncAssetForm();
    var a = S.editAsset, b = buildingById(S.view.id); if (!a || !b) return;
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid) { S.secErr.assets = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    S.secErr.assets = null; S.secMsg.assets = null;
    var row = assetToRow(a), op, coreAfter;
    if (a.id) {
      var orig = (S.assets || []).filter(function (x) { return x.id === a.id; })[0];
      var base = (orig && orig._row) || {};
      var merged = {}; for (var mk in base) merged[mk] = base[mk]; for (var rk in row) merged[rk] = row[rk]; merged.id = a.id;
      coreAfter = assetRowToCore(merged);
      if (base.updated_at) {
        var fields = { id: a.id }, changed = false;
        for (var k in row) {
          var oldV = base[k] == null ? null : base[k], newV = row[k] == null ? null : row[k];
          if (JSON.stringify(oldV) !== JSON.stringify(newV)) { fields[k] = row[k]; changed = true; }
        }
        if (!changed) { S.editAsset = null; S.secMsg.assets = "Ingen endringer."; render(); return; }
        op = { entity: "assets", op: "update", payload: fields, baseUpdatedAt: base.updated_at,
          tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: a.label || assetTypeDef(a.type).label };
      } else {
        // local row, never acked — full re-upsert under the same client id (nobody else has seen it)
        var re = {}; for (var pk in row) re[pk] = row[pk];
        re.id = a.id; re.tenant_id = S.tenant.id; re.building_id = b.id;
        op = { entity: "assets", op: "insert", payload: re, baseUpdatedAt: null,
          tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: a.label || assetTypeDef(a.type).label };
      }
    } else {
      row.id = OFF.uuid(); row.tenant_id = S.tenant.id; row.building_id = b.id;
      op = { entity: "assets", op: "insert", payload: row, baseUpdatedAt: null,
        tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: row.label };
      coreAfter = assetRowToCore(row);
    }
    OFF.queueOp(op).then(function () {
      // optimistic: state + snapshot take the edit NOW; the chip says `lagret på enheten` until acked
      if (a.id) S.assets = (S.assets || []).map(function (x) { return x.id === a.id ? coreAfter : x; });
      else S.assets = (S.assets || []).concat([coreAfter]);
      S.editAsset = null;
      S.secMsg.assets = "Lagret på enheten: " + (coreAfter.label || "eiendel") + " — synlig for andre når den viser «synket ✓».";
      snapshotBuilding(b.id);
      refreshPending(function () { render(); });
      drainAll();
    }).catch(function (e) {   // C1: durable queueing failed — loud, optimistic state NOT applied
      S.secErr.assets = "⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — endringen er IKKE trygg.";
      render();
    });
  }
  /* v1.5 (doc-80 §3): SOFT delete replaces hard delete — `update set deleted_at` through the outbox,
   * base-version-checked like any other class-B edit. The server row survives as a tombstone; other
   * devices drop it when the tombstone rides their next delta pull. */
  function assetDelete(id) {
    var a = (S.assets || []).filter(function (x) { return x.id === id; })[0];
    if (!a || !window.confirm("Slette «" + (a.label || "eiendel") + "»?")) return;
    var uid = userId(), b = buildingById(S.view.id);
    if (!uid || !b || !S.tenant || !S.tenant.id) return;
    var base = a._row || {}, op;
    var title = "Slett: " + (a.label || assetTypeDef(a.type).label);
    if (base.updated_at) {
      op = { entity: "assets", op: "update", payload: { id: id, deleted_at: new Date().toISOString() },
        baseUpdatedAt: base.updated_at, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title };
    } else {
      // never synced — upsert it born-dead under the same client id (works whether or not the insert drained)
      var row = assetToRow(a); row.id = id; row.tenant_id = S.tenant.id; row.building_id = b.id;
      row.deleted_at = new Date().toISOString();
      op = { entity: "assets", op: "insert", payload: row, baseUpdatedAt: null,
        tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title };
    }
    OFF.queueOp(op).then(function () {
      S.assets = (S.assets || []).filter(function (x) { return x.id !== id; });
      S.secMsg.assets = "Slettet — lagret på enheten, synkes.";
      snapshotBuilding(b.id);
      refreshPending(function () { render(); });
      drainAll();
    }).catch(function (e) {
      S.secErr.assets = "⚠ Kunne ikke lagre slettingen på enheten (" + ((e && e.message) || "lagringsfeil") + ").";
      render();
    });
  }

  /* ============================ section: Kontakter (small pass — the SECOND class-B table) ============================
   * The point of this section: it is pure REGISTRATION into the v1.5 machinery. Same outbox ops, same
   * LWW drain, same watermark delta, same review surface — no new concepts. PII discipline (doc 60):
   * work contacts only — name · role · one phone · one email; nothing else gets a field. */
  function loadContacts(bid) {
    S.secBusy.contacts = true; S.secErr.contacts = null;
    var uid = userId();
    var done = function (rows) { S.secBusy.contacts = false; S.contacts = rows; snapshotBuilding(bid); render(); };
    var fail = function (e) { S.secBusy.contacts = false; S.secErr.contacts = friendly(e); render(); };
    var full = function () {
      return prodDb.listContacts(bid).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data || [];
        var nm = maxUpdatedAt(rows, "");
        if (uid) OFF.cachePut(uid, "wm:contacts:" + bid, nm || null);
        done(rows);
      });
    };
    if (!uid) { full().catch(fail); return; }
    OFF.cacheGet(uid, "wm:contacts:" + bid).then(function (wm) {
      var mark = wm && wm.v;
      if (!validWm(mark) || S.contacts == null) return full();
      return prodDb.listContactsDelta(bid, mark).then(function (r) {
        if (r.error) return fail(r.error);
        var delta = r.data || [];
        var byId = {}; (S.contacts || []).forEach(function (c) { byId[c.id] = c; });
        delta.forEach(function (row) { if (row.deleted_at) delete byId[row.id]; else byId[row.id] = row; });
        var merged = Object.keys(byId).map(function (k) { return byId[k]; });
        merged.sort(function (x, y) { return ((x.created_at || "")) < ((y.created_at || "")) ? -1 : 1; });
        var nm = maxUpdatedAt(delta, mark);
        if (nm !== mark) OFF.cachePut(uid, "wm:contacts:" + bid, nm);
        done(merged);
      });
    }).catch(fail);
  }
  function contactFormHTML(c) {
    return '<div class="aform">'
      + '<label>Navn *</label><input id="ct_name" value="' + esc(c.name || "") + '" placeholder="f.eks. Kari Nordmann">'
      + '<label>Rolle</label><input id="ct_role" value="' + esc(c.role || "") + '" placeholder="styreleder / vaktmester / rørlegger">'
      + '<div class="row2"><div style="flex:1"><label>Telefon (jobb)</label><input id="ct_phone" inputmode="tel" value="' + esc(c.phone || "") + '"></div>'
      + '<div style="flex:1"><label>E-post (jobb)</label><input id="ct_email" inputmode="email" value="' + esc(c.email || "") + '"></div></div>'
      + '<div class="bar"><button class="btn" data-act="contactSave">' + (c.id ? 'Lagre endringer' : 'Lagre kontakt') + ' →</button>'
      + '<button class="btn ghost" data-act="contactCancel">Avbryt</button></div></div>';
  }
  function sectionContactsHTML(b) {
    var body;
    if (S.secBusy.contacts && S.contacts == null) body = '<div class="empty"><span class="spin"></span>Henter kontakter…</div>';
    else if (!S.contacts || !S.contacts.length) body = '<div class="empty">Ingen kontakter for dette bygget ennå.</div>';
    else { var cPend = pendingOpByRecord("contacts"); body = S.contacts.map(function (c) {
      var meta = [c.role, c.phone, c.email].filter(Boolean).join(' · ');
      return '<div class="bldg"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><span class="t">👤 ' + esc(c.name || "(uten navn)") + opChip(cPend[c.id]) + '</span>'
        + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + '</span>'
        + '<span style="display:flex;gap:6px;flex-shrink:0"><button class="btn ghost" style="padding:7px 10px" data-act="contactEdit" data-id="' + esc(c.id) + '">✎</button>'
        + '<button class="btn ghost" style="padding:7px 10px" data-act="contactDel" data-id="' + esc(c.id) + '">🗑</button></span></div></div>';
    }).join(""); }
    return '<div class="card"><div class="ct">👥 Kontakter <span class="muted" style="font-weight:600">· ' + (S.contacts ? S.contacts.length : '…') + ' · kun arbeidskontakter</span></div>'
      + (S.secMsg.contacts ? '<div class="msg ok">' + esc(S.secMsg.contacts) + '</div>' : '')
      + (S.secErr.contacts ? '<div class="msg err">' + esc(S.secErr.contacts) + '</div>' : '')
      + body
      + (S.editContact ? contactFormHTML(S.editContact) : '<div class="bar"><button class="btn ghost" data-act="contactNew">＋ Legg til kontakt</button></div>')
      + '<p class="note" style="margin-bottom:0">Kun arbeidskontakter: navn, rolle, jobbtelefon, jobb-e-post — ingen personopplysninger utover det.</p>'
      + '</div>';
  }
  function contactSave() {
    var ec = S.editContact, b = buildingById(S.view.id); if (!ec || !b) return;
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid) { S.secErr.contacts = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    var row = { name: val("ct_name"), role: val("ct_role") || null, phone: val("ct_phone") || null, email: val("ct_email") || null };
    if (!row.name) { S.secErr.contacts = "Navn må fylles ut."; render(); return; }
    S.secErr.contacts = null; S.secMsg.contacts = null;
    var op, after;
    if (ec.id) {
      var base = (S.contacts || []).filter(function (x) { return x.id === ec.id; })[0] || {};
      after = {}; for (var mk in base) after[mk] = base[mk]; for (var rk in row) after[rk] = row[rk]; after.id = ec.id;
      if (base.updated_at) {
        var fields = { id: ec.id }, changed = false;
        for (var k in row) {
          var oldV = base[k] == null ? null : base[k], newV = row[k] == null ? null : row[k];
          if (oldV !== newV) { fields[k] = row[k]; changed = true; }
        }
        if (!changed) { S.editContact = null; S.secMsg.contacts = "Ingen endringer."; render(); return; }
        op = { entity: "contacts", op: "update", payload: fields, baseUpdatedAt: base.updated_at,
          tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: row.name };
      } else {
        var re = {}; for (var pk in row) re[pk] = row[pk];
        re.id = ec.id; re.tenant_id = S.tenant.id; re.building_id = b.id;
        op = { entity: "contacts", op: "insert", payload: re, baseUpdatedAt: null,
          tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: row.name };
      }
    } else {
      row.id = OFF.uuid(); row.tenant_id = S.tenant.id; row.building_id = b.id;
      op = { entity: "contacts", op: "insert", payload: row, baseUpdatedAt: null,
        tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: row.name };
      after = row;
    }
    OFF.queueOp(op).then(function () {
      if (ec.id) S.contacts = (S.contacts || []).map(function (x) { return x.id === ec.id ? after : x; });
      else S.contacts = (S.contacts || []).concat([after]);
      S.editContact = null;
      S.secMsg.contacts = "Lagret på enheten: " + after.name + " — synkes.";
      snapshotBuilding(b.id);
      refreshPending(function () { render(); });
      drainAll();
    }).catch(function (e) {
      S.secErr.contacts = "⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — kontakten er IKKE trygg.";
      render();
    });
  }
  function contactDelete(id) {
    var c = (S.contacts || []).filter(function (x) { return x.id === id; })[0];
    if (!c || !window.confirm("Slette «" + (c.name || "kontakt") + "»?")) return;
    var uid = userId(), b = buildingById(S.view.id);
    if (!uid || !b || !S.tenant || !S.tenant.id) return;
    var op, title = "Slett: " + (c.name || "kontakt");
    if (c.updated_at) {
      op = { entity: "contacts", op: "update", payload: { id: id, deleted_at: new Date().toISOString() },
        baseUpdatedAt: c.updated_at, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title };
    } else {
      var row = { id: id, tenant_id: S.tenant.id, building_id: b.id, name: c.name || null, role: c.role || null,
        phone: c.phone || null, email: c.email || null, deleted_at: new Date().toISOString() };
      op = { entity: "contacts", op: "insert", payload: row, baseUpdatedAt: null,
        tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title };
    }
    OFF.queueOp(op).then(function () {
      S.contacts = (S.contacts || []).filter(function (x) { return x.id !== id; });
      S.secMsg.contacts = "Slettet — lagret på enheten, synkes.";
      snapshotBuilding(b.id);
      refreshPending(function () { render(); });
      drainAll();
    }).catch(function (e) {
      S.secErr.contacts = "⚠ Kunne ikke lagre slettingen på enheten (" + ((e && e.message) || "lagringsfeil") + ").";
      render();
    });
  }

  /* ============================ section: Dokumentert arbeid (1c-2 item 2 — completion_proof + photos) ============================ */
  // same pipeline as the demo: FileReader → canvas ≤1280px → JPEG q0.6. Data-URL path keeps the strict CSP
  // (img-src 'self' data: …); the canvas re-encode also strips EXIF/GPS — a relied-upon privacy property.
  function compressImage(file, cb) {   // → data-URL (renderable offline under img-src data:, uploadable from the photo queue)
    try {
      var rd = new FileReader();
      rd.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var MAX = 1280, w = img.width, h = img.height;
            if (w > MAX || h > MAX) { var s = Math.min(MAX / w, MAX / h); w = Math.round(w * s); h = Math.round(h * s); }
            var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
            cv.getContext("2d").drawImage(img, 0, 0, w, h);
            cb(cv.toDataURL("image/jpeg", 0.6));   // re-encode strips EXIF/GPS (relied-upon privacy property)
          } catch (e) { cb(null); }
        };
        img.onerror = function () { cb(null); };
        img.src = rd.result;
      };
      rd.onerror = function () { cb(null); };
      rd.readAsDataURL(file);
    } catch (e) { cb(null); }
  }
  var signedUrlCache = {};   // storage path → signed url (1 h TTL; per-session cache)
  function hydrateProofPhotos() {
    [].forEach.call(app.querySelectorAll("img[data-photo-path]"), function (img) {
      var path = img.getAttribute("data-photo-path");
      if (signedUrlCache[path]) { img.src = signedUrlCache[path]; return; }
      prodDb.signPhoto(path).then(function (r) {
        if (r.error || !r.data || !r.data.signedUrl) { img.alt = "bilde utilgjengelig"; return; }
        signedUrlCache[path] = r.data.signedUrl;
        if (img.isConnected) img.src = r.data.signedUrl;
      });
    });
  }
  function loadProof(bid) {
    S.secBusy.proof = true; S.secErr.proof = null;
    prodDb.listProof(bid).then(function (r) {
      S.secBusy.proof = false;
      if (r.error) { S.secErr.proof = friendly(r.error); } else { S.proof = r.data || []; snapshotBuilding(bid); }
      render();
    });
  }
  function skewChip(p) {   // ⚠ enhetsklokke avvek N t — captured_at vs server created_at (doc-80 §7.3)
    if (!p.captured_at || !p.created_at) return "";
    var skewMs = Math.abs(new Date(p.created_at) - new Date(p.captured_at));
    if (skewMs < 60 * 60 * 1000) return "";
    return ' <span class="chip warn">⚠ enhetsklokke avvek ' + Math.round(skewMs / 3600000) + ' t</span>';
  }
  function pendingPhotoPaths() {
    var m = {}; (S.pendingPhotos || []).forEach(function (p) { if (p.status !== "uploaded" && p.status !== "draft") m[p.path] = p; }); return m;
  }
  /* field-findings #1 (iPad, 3 Jul): the photo picker BACKGROUNDS the page; returning fires
   * visibilitychange → drainAll → render(), and app.innerHTML rebuilds the <input type=file> EMPTY —
   * so the picked file silently vanished before save (desktop dialogs don't background → invisible in
   * dev). Fix: capture to IDB the moment the file is chosen (status "draft" — the upload queue skips
   * it), show the thumbnail from the READ-BACK blob, and let save reference only blobs that exist. */
  function attachProofPhoto(el) {
    var b = buildingById(S.view.id); if (!b) return;
    var uid = userId(), tenantId = S.tenant && S.tenant.id;
    var file = el.files && el.files[0];
    if (!file) return;   // picker cancelled — nothing chosen, nothing claimed
    if (!uid || !tenantId) { S.secErr.proof = "Mangler tenant/bruker — åpne appen på nett én gang først."; render(); return; }
    var oldPath = S.proofPhoto && S.proofPhoto.path;
    S.secErr.proof = null; S.secMsg.proof = null;
    compressImage(file, function (dataUrl) {
      if (!dataUrl) { S.secErr.proof = "⚠ Kunne IKKE lagre foto — det følger ikke med registreringen (kunne ikke lese/komprimere bildet). Prøv et annet."; render(); return; }
      var path = tenantId + "/" + b.id + "/" + OFF.uuid() + ".jpg";
      OFF.queuePhoto({ path: path, userId: uid, buildingId: b.id, dataUrl: dataUrl, status: "draft" })
        .then(function () { return OFF.getPhoto(path); })   // read BACK: the thumbnail shows what is STORED
        .then(function (stored) {
          if (!stored || !stored.dataUrl) throw new Error("lagret foto kunne ikke leses tilbake");
          S.proofPhoto = { path: path, dataUrl: stored.dataUrl };
          if (oldPath) OFF.delPhoto(oldPath);
          render();
        })
        .catch(function (e) {   // IDB refused (quota / private mode) — LOUD; nothing is claimed (C1)
          S.proofPhoto = null;
          S.secErr.proof = "⚠ Kunne IKKE lagre foto — det følger ikke med registreringen (" + ((e && e.message) || "lagringsfeil") + "). Fullfør uten foto, eller frigjør plass og prøv igjen.";
          render();
        });
    });
  }
  function sectionProofHTML(b) {
    var body = "";
    // 1) pending captures for THIS building — the outbox view of the timeline (doc-80 §6 chips)
    var pend = (S.pendingOps || []).filter(function (o) { return o.buildingId === b.id && o.entity === "completion_proof"; });
    var localPhotoByPath = {}; (S.pendingPhotos || []).forEach(function (p) { localPhotoByPath[p.path] = p; });
    body += pend.slice().reverse().map(function (o) {
      var p = o.payload || {};
      var chip = o.status === "sending" ? '<span class="chip s">synkes…</span>'
        : o.status === "rejected" ? '<span class="chip err">avvist: ' + esc(o.lastError || "ukjent") + '</span>'
        : o.status === "held" ? '<span class="chip q">lagret på enheten</span> <span class="chip warn">får ikke synket — prøver igjen</span>'
        : '<span class="chip q">lagret på enheten</span>';
      var when = ""; try { when = new Date(p.captured_at).toLocaleString("no", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) {}
      var img = "";
      ((p.photo_ids) || []).forEach(function (path) { var lp = localPhotoByPath[path]; if (lp && lp.dataUrl) img += '<img class="proofimg" src="' + lp.dataUrl + '" alt="bilde (lokalt)">'; });
      var assetChip = (p.extra && p.extra.asset_label) ? ' <span class="tenant" style="font-size:11px">' + esc(p.extra.asset_label) + '</span>' : '';
      return '<div class="bldg"><span class="t">📝 ' + esc(p.title || "Utført arbeid") + assetChip + ' ' + chip + '</span>'
        + '<span class="d">' + esc(when) + (p.by_name ? ' · ' + esc(p.by_name) : '') + (p.note ? ' · ' + esc(p.note) : '') + '</span>' + img + '</div>';
    }).join("");
    // 2) server rows — ordered by captured_at (device truth), skew flagged, `foto synkes` while the blob queue drains
    var photoPend = pendingPhotoPaths();
    if (S.secBusy.proof && S.proof == null && !body) body += '<div class="empty"><span class="spin"></span>Henter dokumentert arbeid…</div>';
    else if ((!S.proof || !S.proof.length) && !body) body += '<div class="empty">Ingen dokumentert arbeid ennå — registrer det første nedenfor.</div>';
    else body += (S.proof || []).slice().sort(function (a, b2) { return (b2.captured_at || b2.ts || "") < (a.captured_at || a.ts || "") ? -1 : 1; }).map(function (p) {
      var when = ""; try { when = new Date(p.captured_at || p.ts).toLocaleString("no", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) {}
      var assetChip = (p.extra && p.extra.asset_label) ? ' <span class="tenant" style="font-size:11px">' + esc(p.extra.asset_label) + '</span>' : '';
      var fotoChip = ((p.photo_ids || []).some(function (path) { return photoPend[path]; })) ? ' <span class="chip s">foto synkes</span>' : '';
      var photos = (p.photo_ids || []).map(function (path) {
        var lp = localPhotoByPath[path];
        if (lp && lp.dataUrl) return '<img class="proofimg" src="' + lp.dataUrl + '" alt="bilde (lokalt)">';   // local-first render (doc-80 §4)
        return '<img class="proofimg" data-photo-path="' + esc(path) + '" alt="bilde">';
      }).join("");
      return '<div class="bldg"><span class="t">✅ ' + esc(p.title || "Utført arbeid") + assetChip + ' <span class="chip ok">synket ✓</span>' + fotoChip + skewChip(p) + '</span>'
        + '<span class="d">' + esc(when) + (p.by_name ? ' · ' + esc(p.by_name) : '') + (p.note ? ' · ' + esc(p.note) : '') + '</span>' + photos + '</div>';
    }).join("");
    var assetOpts = '<option value="">— ingen spesifikk eiendel —</option>' + (S.assets || []).map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.label || assetTypeDef(a.type).label) + '</option>'; }).join("");
    var d = S.proofDraft || {};
    var form =
      '<div class="aform"><div class="note" style="font-weight:800;text-transform:uppercase;font-size:10.5px;letter-spacing:.03em">Registrer utført arbeid</div>'
      + '<label>Hva ble gjort</label><input id="pf_title" value="' + esc(d.title || "") + '" placeholder="f.eks. Dunkvask + AqtiVann-desinfeksjon">'
      + '<label>Notat</label><input id="pf_note" value="' + esc(d.note || "") + '" placeholder="valgfritt">'
      + '<label>Eiendel (valgfritt)</label><select id="pf_asset">' + assetOpts + '</select>'
      + '<label>Bilde (valgfritt — komprimeres til ≤1280px)</label>'
      + (S.proofPhoto
        ? '<div class="thumbrow"><img class="proofimg" style="margin-top:0" src="' + S.proofPhoto.dataUrl + '" alt="valgt bilde (lagret på enheten)">'
          + '<button class="btn ghost" style="padding:7px 10px" data-act="proofPhotoRemove">✕ Fjern</button></div>'
          + '<div class="note">Bildet er lagret på enheten og følger med registreringen.</div>'
        : '<input type="file" id="pf_photo" accept="image/*">')
      + '<div class="bar"><button class="btn" data-act="proofSave"' + (S.secBusy.proof ? ' disabled' : '') + '>' + (S.secBusy.proof ? '<span class="spin"></span>Lagrer…' : '✓ Dokumentér i onsite-prod') + '</button></div></div>';
    return '<div class="card"><div class="ct">📋 Dokumentert arbeid <span class="muted" style="font-weight:600">· ' + (S.proof ? S.proof.length : '…') + ' · completion_proof + photos-bucket</span></div>'
      + (S.secMsg.proof ? '<div class="msg ok">' + esc(S.secMsg.proof) + '</div>' : '')
      + (S.secErr.proof ? '<div class="msg err">' + esc(S.secErr.proof) + '</div>' : '')
      + body + form + '</div>';
  }
  /* doc-80 v1: EVERY capture goes through the outbox — offline and online are the SAME code path.
   * Queue durably (loud C1 failure if IDB refuses) → chips say `lagret på enheten` → drain (immediately
   * when online) → `synkes…` → server ack → `synket ✓`. captured_at = device time (server created_at
   * stays server-truth); the photo rides the separate blob queue (forward-referenced photo_ids). */
  function proofSave() {
    var b = buildingById(S.view.id); if (!b) return;
    var uid = userId();
    var tenantId = (S.tenant && S.tenant.id) || null;
    if (!uid || !tenantId) { S.secErr.proof = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    var title = val("pf_title") || "Utført arbeid", note = val("pf_note"), assetId = val("pf_asset");
    var asset = (S.assets || []).filter(function (a) { return a.id === assetId; })[0] || null;
    var draft = S.proofPhoto;   // field-findings #1: the photo comes from STATE+IDB, never a file input
    S.secBusy.proof = true; S.secErr.proof = null; S.secMsg.proof = null; render();
    function fail(msg) { S.secBusy.proof = false; S.secErr.proof = msg; S.proofDraft = { title: title, note: note }; render(); }
    // the op may only reference photo_ids whose blob verifiably exists in IDB RIGHT NOW (findings #1c)
    (draft ? OFF.getPhoto(draft.path) : Promise.resolve(null)).then(function (stored) {
      if (draft && (!stored || !stored.dataUrl)) {
        S.proofPhoto = null;   // the thumbnail lied only until this check — never let the op lie
        fail("⚠ Bildet er borte fra enhetens lager — registreringen ble IKKE sendt. Legg ved bildet på nytt, eller fullfør uten.");
        return;
      }
      var photoPath = stored ? draft.path : null;
      var payload = { id: OFF.uuid(), tenant_id: tenantId, building_id: b.id, title: title, note: note || null,
        by_name: userEmail() || "innlogget", service: "prod-app",
        extra: asset ? { asset_id: asset.id, asset_label: asset.label || assetTypeDef(asset.type).label } : null,
        photo_ids: photoPath ? [photoPath] : null,
        captured_at: new Date().toISOString() };   // device time, honest label; server created_at is server-truth
      var op = { entity: "completion_proof", op: "insert", payload: payload, baseUpdatedAt: null,
        tenantId: tenantId, buildingId: b.id, userId: uid, title: title };
      // the draft blob is already durable — queuing the op just PROMOTES it into the upload queue
      var q = photoPath ? OFF.promotePhoto(photoPath).then(function () { return OFF.queueOp(op); }) : OFF.queueOp(op);
      q.then(function () {
        S.secBusy.proof = false;
        S.proofPhoto = null; S.proofDraft = null;
        // honesty copy: only `synket ✓` means the board can see it (doc-80 §6)
        S.secMsg.proof = "Lagret på enheten — synlig for styret først når den viser «synket ✓».";
        refreshPending(function () { render(); });
        drainAll();
      }).catch(function (e) {
        // C1 at its hardest: the capture could NOT be durably queued — fail LOUDLY, never a fake ✓
        fail("⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — registreringen er IKKE trygg. Frigjør plass og prøv igjen.");
      });
    });
  }

  /* ============================ section: Tilbud (1c-2 item 3 — offers round-trip) ============================
   * offers.data carries the SAME modules/lines shape @onsite/core computes; the app never trusts stored
   * totals — it re-derives them through core (rebuildOfferFlat on a {offer} wrapper) and shows the match.
   * Computing offers from zones/walkaround stays in later passes; this is persist/render + severability. */
  function loadOffers(bid) {
    S.secBusy.offers = true; S.secErr.offers = null;
    prodDb.listOffers(bid).then(function (r) {
      S.secBusy.offers = false;
      if (r.error) { S.secErr.offers = friendly(r.error); } else { S.offers = r.data || []; snapshotBuilding(bid); }
      render();
    });
  }
  function kr(n) { return "kr " + (Math.round(n) || 0).toLocaleString("no"); }
  function coreDerive(data) {   // re-derive totals from the stored shape via core; null if core not loaded yet
    if (!coreReady() || !data || !data.modules) return null;
    try { var w = { offer: JSON.parse(JSON.stringify(data)) }; window.OnSiteCore.rebuildOfferFlat(w); return w.offer; }
    catch (e) { return null; }
  }
  function sectionOffersHTML(b) {
    var body;
    if (S.secBusy.offers && S.offers == null) body = '<div class="empty"><span class="spin"></span>Henter tilbud…</div>';
    else if (!S.offers || !S.offers.length) body = '<div class="empty">Ingen tilbud for dette bygget ennå.</div>';
    else {
      var o = S.offers[0], data = o.data || {};
      var derived = coreDerive(data);
      var per = (o.period === "år") ? "år" : "mnd";
      var head = derived
        ? '<div style="font-size:21px;font-weight:800;letter-spacing:-.02em">' + kr(derived.totalMonthly) + ' <span class="muted" style="font-size:13px;font-weight:650">/' + per + '</span> · ' + kr(derived.totalYearly) + ' <span class="muted" style="font-size:13px;font-weight:650">/år</span></div>'
        : '<div style="font-size:21px;font-weight:800">' + kr(o.total_monthly) + ' <span class="muted" style="font-size:13px;font-weight:650">/' + per + '</span></div>';
      var verify = derived
        ? (Math.round(derived.totalMonthly) === Math.round(o.total_monthly || 0)
          ? '<div class="msg ok" style="margin:8px 0">✓ Totaler verifisert av @onsite/core etter DB-rundtur (' + kr(derived.totalMonthly) + '/mnd)</div>'
          : '<div class="msg err" style="margin:8px 0">⚠ Avvik: DB ' + kr(o.total_monthly) + ' vs core ' + kr(derived.totalMonthly) + '</div>')
        : '<div class="note">@onsite/core laster — totaler vises fra DB inntil verifisert…</div>';
      var mods = (derived ? derived.modules : (data.modules || [])).map(function (m) {
        return '<div class="bldg" style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
          + '<span><span class="t">' + esc(m.title || m.service) + (m.included ? '' : ' <span class="muted">(valgt bort)</span>') + '</span>'
          + '<span class="d">' + m.lines.length + ' linje' + (m.lines.length !== 1 ? 'r' : '') + ' · kan sies opp separat</span></span>'
          + '<span style="display:flex;gap:10px;align-items:center;flex-shrink:0"><b>' + kr(m.subtotal) + '</b>'
          + '<label style="display:flex;gap:5px;align-items:center;font-size:12px;margin:0"><input type="checkbox" data-act="offerModToggle" data-id="' + esc(o.id) + '" data-svc="' + esc(m.service) + '"' + (m.included ? ' checked' : '') + (coreReady() ? '' : ' disabled') + '> med</label></span></div>';
      }).join("");
      var opts = (data.optionLines || []).length
        ? '<div class="note" style="margin-top:8px"><b>Opsjoner (utenfor grunnbeløpet):</b> ' + data.optionLines.map(function (l) { return esc(l.label) + ' (' + kr(l.final) + ')'; }).join(' · ') + '</div>'
        : '';
      body = head + verify + mods + opts
        + (o.cover_note ? '<div class="note" style="margin-top:8px">' + esc(o.cover_note) + '</div>' : '')
        + '<div class="note" style="margin-top:6px">v' + o.version + ' · status: ' + esc(o.status) + ' · offers.data (jsonb, core-form)</div>';
    }
    return '<div class="card"><div class="ct">💰 Tilbud <span class="muted" style="font-weight:600">· offers (RLS: kun din tenant)</span></div>'
      + (S.secMsg.offers ? '<div class="msg ok">' + esc(S.secMsg.offers) + '</div>' : '')
      + (S.secErr.offers ? '<div class="msg err">' + esc(S.secErr.offers) + '</div>' : '')
      + body + '</div>';
  }
  function offerModToggle(el) {
    var id = el.getAttribute("data-id"), svc = el.getAttribute("data-svc"), want = !!el.checked;
    var o = (S.offers || []).filter(function (x) { return x.id === id; })[0]; if (!o || !o.data) return;
    var data = JSON.parse(JSON.stringify(o.data));
    (data.modules || []).forEach(function (m) { if (m.service === svc) m.included = want; });
    var derived = coreDerive(data);
    if (!derived) { S.secErr.offers = "@onsite/core ikke lastet — kan ikke beregne."; render(); return; }
    S.secBusy.offers = true; S.secErr.offers = null; S.secMsg.offers = null; render();
    // persist the toggled shape + core-derived totals; C1 — on error nothing pretends to have saved
    prodDb.updateOffer(id, { data: derived, total_monthly: derived.totalMonthly, total_yearly: derived.totalYearly }).then(function (r) {
      S.secBusy.offers = false;
      if (r.error) { S.secErr.offers = friendly(r.error); render(); return; }
      S.secMsg.offers = (want ? "Modul inkludert" : "Modul valgt bort — kan sies opp separat") + " · ny total " + kr(derived.totalMonthly) + "/mnd";
      loadOffers(S.view.id);   // re-read: the UI shows what actually persisted
    });
  }

  /* ============================ building detail (1c-2 item 0) ============================
   * The container for the per-table sections: Eiendeler · Dokumentert arbeid · Tilbud. Tablet-first. */
  function renderBuilding(b) {
    var email = userEmail();
    var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
    var synk = S.snapTs ? ' · sist synket ' + timeHM(S.snapTs) : (S.offline ? ' · frakoblet — viser lagret kopi' : '');
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + '</span>' : '')
      + headerChipsHTML()
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="bhead"><button class="btn ghost" data-act="back" style="padding:9px 13px">← Bygg</button>'
      + '<div><h1>🏢 ' + esc(b.name) + '</h1><div class="note">' + esc(meta) + esc(synk) + '</div></div></div>'
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + sectionAssetsHTML(b)
      + sectionContactsHTML(b)
      + sectionProofHTML(b)
      + sectionOffersHTML(b);
  }

  function lastEmail() { try { return localStorage.getItem("onsite_prod_email") || ""; } catch (e) { return ""; } }
  function rememberEmail(e) { try { localStorage.setItem("onsite_prod_email", e); } catch (x) {} }

  /* one delegated dispatcher (replaces per-render bind) — sections add cases, not listeners */
  var ACTIONS = {
    login: function () { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); },
    verifyCode: verifyCode,
    // doc-80 §5: sign-out with a non-empty outbox blocks with count + choices — never silent loss,
    // never draining user A's proof under user B's session (attribution is integrity).
    signout: function () {
      refreshPending(function () {
        if (S.pending.total > 0) { S._prevView = S.view; S.view = { name: "signoutGuard" }; S.error = null; render(); }
        else signOut();
      });
    },
    guardSync: function () {
      S.error = null; render();
      var uid = userId();
      OFF.drain(sb, uid, null).then(function () {
        refreshPending(function () {
          if (S.pending.total === 0) { signOut(); }
          else { S.error = "Fikk ikke synket alt (" + S.pending.total + " igjen) — se «usendte» eller prøv igjen."; render(); }
        });
      });
    },
    guardDiscard: function () {
      if (!window.confirm("Forkaste " + S.pending.total + " usendte registreringer? De kan ikke gjenopprettes.")) return;
      if (!window.confirm("Helt sikker? Dette sletter dokumentasjonen som bare finnes på denne enheten.")) return;
      OFF.discardAll(userId()).then(function () { refreshPending(function () { signOut(); }); });
    },
    guardCancel: function () { S.view = S._prevView || { name: "list" }; S.error = null; render(); },
    openOutbox: function () { S._prevView = S.view; S.view = { name: "outbox" }; refreshPending(function () { render(); }); },
    openReview: function () { S._prevView = S.view; S.view = { name: "review" }; refreshPending(function () { render(); }); },
    // «Bruk min likevel»: re-apply the lost fields as a NEW edit on the CURRENT server base — through the
    // outbox, base-version-checked again (if the server moved meanwhile, it lands back here honestly).
    reviewUseMine: function (el) {
      var id = el.getAttribute("data-id");
      var r = (S.review || []).filter(function (x) { return x.reviewId === id; })[0]; if (!r) return;
      if (!r.serverRow || !r.serverUpdatedAt) return;   // button is disabled for these; belt and braces
      var uid = userId(); if (!uid) return;
      var payload = { id: r.recordId }; for (var k in (r.fields || {})) if (k !== "id") payload[k] = r.fields[k];
      OFF.queueOp({ entity: r.entity, op: "update", payload: payload, baseUpdatedAt: r.serverUpdatedAt,
        tenantId: r.tenantId, buildingId: r.buildingId, userId: uid, title: r.recordName || r.entity })
        .then(function () { return OFF.delReview(id); })
        .then(function () { refreshPending(function () { render(); }); drainAll(); });
    },
    reviewDiscard: function (el) {
      OFF.delReview(el.getAttribute("data-id")).then(function () { refreshPending(function () { render(); }); });
    },
    retryHeld: function () { OFF.retryHeld(userId()).then(function () { refreshPending(function () { render(); drainAll(); }); }); },
    discardOp: function (el) {
      if (!window.confirm("Forkaste denne avviste registreringen?")) return;
      OFF.delOp(el.getAttribute("data-id")).then(function () { refreshPending(function () { render(); }); });
    },
    applyUpdate: function () { if (S.updateReg) OFF.applyUpdate(S.updateReg); },
    addBuilding: addBuilding,
    // onboarding A: the registry-prefill wizard
    nbOpen: nbOpen, nbCancel: nbCancel, nbSearch: nbSearch, nbGeocode: nbGeocode, nbManual: nbManual, nbCreate: nbCreate,
    nbModeName: function () { nbSetMode("name"); }, nbModeAddr: function () { nbSetMode("address"); },
    nbPick: function (el) { nbPick(parseInt(el.getAttribute("data-idx"), 10)); },
    openBuilding: function (el) { openBuilding(el.getAttribute("data-id")); },
    back: function () {
      if (S.view.name === "outbox" || S.view.name === "review") { S.view = S._prevView && S._prevView.name === "building" ? S._prevView : { name: "list" }; render(); if (S.view.name === "building") loadBuildingSections(S.view.id); return; }
      closeBuilding();
    },
    // item 1: assets
    assetNew: function () { var d = ASSET_TYPES[0]; S.editAsset = { id: null, type: d.id, label: "", area: d.area, access: "", notes: "", bin: null }; S.secMsg.assets = null; render(); },
    assetEdit: function (el) { var a = (S.assets || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0]; if (a) { S.editAsset = JSON.parse(JSON.stringify(a)); S.secMsg.assets = null; render(); } },
    assetCancel: function () { S.editAsset = null; render(); },
    assetSave: assetSave,
    assetDel: function (el) { assetDelete(el.getAttribute("data-id")); },
    // small pass: contacts — the second class-B table, same dispatcher pattern
    contactNew: function () { S.editContact = { id: null, name: "", role: "", phone: "", email: "" }; S.secMsg.contacts = null; render(); },
    contactEdit: function (el) { var c = (S.contacts || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0]; if (c) { S.editContact = JSON.parse(JSON.stringify(c)); S.secMsg.contacts = null; render(); } },
    contactCancel: function () { S.editContact = null; render(); },
    contactSave: contactSave,
    contactDel: function (el) { contactDelete(el.getAttribute("data-id")); },
    // small pass: add-to-home-screen (doc 81)
    a2hsInstall: function () { var e = S.installEvt; S.installEvt = null; render(); if (e && e.prompt) e.prompt(); },
    a2hsDismiss: function () { try { localStorage.setItem(A2HS_KEY, "1"); } catch (e) {} render(); },
    // item 2: proof
    proofSave: proofSave,
    proofPhotoRemove: function () {
      var p = S.proofPhoto; S.proofPhoto = null;
      if (p) OFF.delPhoto(p.path).then(function () { render(); }); else render();
    },
    // item 3: offers (severability toggle)
    offerModToggle: offerModToggle
  };
  app.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]"); if (!t) return;
    var fn = ACTIONS[t.getAttribute("data-act")]; if (fn) fn(t);
  });
  app.addEventListener("change", function (e) {
    if (e.target && e.target.id === "as_type") {   // type change shows/hides the bin fields — keep typed values
      syncAssetForm();
      if (S.editAsset) { var d = assetTypeDef(S.editAsset.type); if (!S.editAsset.id) S.editAsset.area = d.area; }
      render();
    }
    if (e.target && e.target.id === "pf_photo") attachProofPhoto(e.target);   // findings #1: durable at ATTACH time
  });
  // findings #1 (same wipe class): typed proof text survives background renders via a live state mirror
  app.addEventListener("input", function (e) {
    var id = e.target && e.target.id;
    if (id === "pf_title" || id === "pf_note") {
      S.proofDraft = S.proofDraft || {};
      S.proofDraft[id === "pf_title" ? "title" : "note"] = e.target.value;
    }
  });
  /* findings #2: iPad landscape keyboard leaves a sliver. Scroll the focused field into view after the
   * keyboard animation, and collapse the chrome while typing in landscape so the form owns the height. */
  app.addEventListener("focusin", function (e) {
    var t = e.target;
    if (!t || !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.type === "file") return;
    setTimeout(function () {
      if (document.activeElement === t && t.scrollIntoView) t.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 300);
  });
  (function keyboardChrome() {
    var vv = window.visualViewport; if (!vv) return;   // progressive enhancement — desktop unaffected
    function sync() {
      var kbUp = vv.height < window.innerHeight * 0.75;
      var land = window.innerWidth > window.innerHeight;
      document.body.classList.toggle("kb-land", kbUp && land);
    }
    vv.addEventListener("resize", sync);
    window.addEventListener("orientationchange", function () { setTimeout(sync, 300); });
  })();
  app.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target && ev.target.id === "li_email") { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); }
    if (ev.key === "Enter" && ev.target && ev.target.id === "li_code") { verifyCode(); }
    if (ev.key === "Enter" && ev.target && ev.target.id === "nb_q") { ev.preventDefault(); nbSearch(); }
  });
  function bind() {} // retained no-op — render() calls it; all wiring is delegated above

  /* ============================ boot ============================ */
  // gate item 4 (review-2 T1-4): a failed magic-link redirect (expired/used link, or a link opened in a
  // different browser — the PKCE verifier lives where the link was requested) arrives as error params in
  // the URL. Surface them on the login screen with a send-a-new-link path; never a silent dead end.
  (function surfaceAuthRedirectErrors() {
    try {
      var qs = new URLSearchParams(location.search);
      var hs = new URLSearchParams((location.hash || "").replace(/^#/, ""));
      var code = qs.get("error_code") || hs.get("error_code") || "";
      var desc = qs.get("error_description") || hs.get("error_description") || "";
      var err = qs.get("error") || hs.get("error") || "";
      if (!err && !code && !desc) return;
      if (/otp_expired|expired/i.test(code + " " + desc)) S.error = "Innloggingslenken er utløpt eller allerede brukt — send en ny nedenfor.";
      else if (/access_denied/i.test(err + " " + code)) S.error = "Innloggingen ble avvist" + (desc ? " (" + desc.replace(/\+/g, " ") + ")" : "") + " — send en ny lenke nedenfor. Åpne lenken i samme nettleser som du bestilte den fra.";
      else S.error = "Innlogging feilet" + (desc ? ": " + desc.replace(/\+/g, " ") : "") + " — send en ny lenke nedenfor.";
      try { history.replaceState(null, "", location.pathname); } catch (e) {}
    } catch (e) {}
  })();
  sb.auth.onAuthStateChange(function (event, session) {
    var was = !!S.session, wasUid = S._uid || null;
    var uid = session && session.user ? session.user.id : null;
    S.session = session; S._uid = uid;
    if (session) S.offlineIdent = null;   // a live session supersedes the offline identity
    // gate item 3: re-resolve the tenant on every sign-in AND on user change — never reuse a cached
    // tenant_id across sessions/users (shared-device reality). The outbox is per-user (doc-80 §5):
    // user A's queued ops never drain here under user B — drain() filters by userId.
    if (session && (!was || uid !== wasUid)) {
      S.buildings = null; S.tenant = null; S.noAccess = false;
      S.msg = null; S.error = null; S.otpEmail = null;   // login-screen residue never bleeds into the app view
      loadTenantAndBuildings();
      refreshPending(function () { render(); drainAll(); });   // same user back online → their queue drains
    }
    if (!session && !S.offlineIdent) { S.tenant = null; S.buildings = null; S.noAccess = false; }
    render();
  });
  // OFFLINE SESSION RULE (doc-80 §5): a persisted session that can't refresh because we're OFFLINE still
  // opens the app — reads from cache, writes queue. Never force sign-out in a basement. Applied EARLY so the
  // basement boot paints the cached day instantly (getSession's network-retry takes seconds offline).
  if (!navigator.onLine) {
    var earlyIdent = OFF.persistedIdentity(SB_REF);
    if (earlyIdent) { S.offlineIdent = earlyIdent; S.offline = true; loadTenantAndBuildings(); refreshPending(function () { render(); }); }
  }
  sb.auth.getSession().then(function (r) {
    S.session = (r.data && r.data.session) || null;
    S._uid = S.session && S.session.user ? S.session.user.id : null;
    if (S.session && S.buildings == null && !S.loading) { loadTenantAndBuildings(); refreshPending(function () { render(); drainAll(); }); return; }
    if (!S.session && !navigator.onLine && !S.offlineIdent) {   // late safety net for the same rule
      var ident = OFF.persistedIdentity(SB_REF);
      if (ident) { S.offlineIdent = ident; S.offline = true; loadTenantAndBuildings(); refreshPending(function () { render(); }); return; }
    }
    if (!S.offlineIdent) render();
  });

  /* ---- offline v1 triggers: SW + online/visibility drains (NO Background Sync — iOS reality) ---- */
  OFF.registerSW(function (reg) { S.updateReg = reg; render(); });   // quiet "ny versjon — last på nytt" hint
  window.addEventListener("online", function () {
    S.offline = false;
    // reconnect: if we were riding the offline identity, let supabase-js re-establish the real session
    if (!S.session) { sb.auth.getSession().then(function (r) { if (r.data && r.data.session) { /* onAuthStateChange takes over */ } else { render(); } }); }
    render(); drainAll();
    if (S.session && S.view.name === "building") loadBuildingSections(S.view.id);
  });
  window.addEventListener("offline", function () { S.offline = true; render(); });
  // Android/Chromium install prompt: capture, show the quiet button on the list (doc 81)
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    S.installEvt = e;
    if (S.view.name === "list") render();
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") drainAll(); });

  render(); // immediate paint (login screen / cached shell) while getSession resolves
})();
