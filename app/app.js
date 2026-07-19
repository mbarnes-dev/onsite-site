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
    // onboarding B: zones (class B) + the drafted zone photo
    zones: null, editZone: null, zonePhoto: null,
    // onboarding C: the befaring checklist (working copy; persisted on the building row) + offer authoring
    checklist: null, clOpen: {}, offerBusy: false,
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
      lat: row.lat, lon: row.lon, createdAt: row.created_at,
      // onboarding C: the befaring checklist rides the building row (buildings.checklist jsonb) — stored
      // AS the core shape (a plain array of items), so computeOffer reads it with no translation layer.
      checklist: row.checklist || null,
      _row: row };
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
    // onboarding C: offers are READS here too — every offer write (a computed version, a severability
    // toggle, a hand-set price) now goes through the outbox like any other class-B row, so the win flow
    // survives a basement. offers has no deleted_at: a version is inserted, never overwritten (doc-82).
    listOffers: function (bid) { return sb.from("offers").select("*").eq("building_id", bid).order("version", { ascending: false }); }
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
    OFF.cachePut(uid, "b:" + bid, { assets: S.assets, proof: S.proof, offers: S.offers, contacts: S.contacts, zones: S.zones });
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
  // registry-name normalisation (housekeeping, live artifact 14 Jul: "…9a, 9b Og9c" → "…9A, 9B og 9C"):
  // title-case real words, house-number letters UPPER (9a→9A), conjunctions og/i/på/ved lowercase mid-name,
  // split a conjunction glued to a number (Og9c→og 9C), spaces preserved.
  function normOrgName(s) {
    return titleCase(s)
      .replace(/\b(og|i|på|ved)(\d)/gi, function (m, w, d) { return w + " " + d; })
      .replace(/(\d)([a-zæøå])\b/g, function (m, d, c) { return d + c.toUpperCase(); })
      .replace(/(\S\s+)(Og|I|På|Ved)\b/g, function (m, pre, w) { return pre + w.toLowerCase(); });
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
    return { source: "Brønnøysund", name: normOrgName(e.navn), orgnr: e.organisasjonsnummer || "", orgform: (of.beskrivelse || of.kode || ""),
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
    if (S.zonePhoto) { try { OFF.delPhoto(S.zonePhoto.path); } catch (e) {} }
    S.proofPhoto = null; S.proofDraft = null; S.zonePhoto = null;
  }
  function openBuilding(id) {
    discardProofDraft();
    S.view = { name: "building", id: id };
    S.assets = null; S.proof = null; S.offers = null; S.contacts = null; S.zones = null; S.editAsset = null; S.editContact = null; S.editZone = null; S.secErr = {}; S.secMsg = {}; S.msg = null; S.error = null; S.snapTs = null;
    // onboarding C: the befaring is a working copy held in state — a background delta pull replacing the
    // building row must never roll back a tick the rep just made. The row stays the persistence target.
    S.checklist = null; S.clOpen = { 1: true, 3: true }; S.offerBusy = false;
    render();
    loadBuildingSections(id);   // cache-first paint, then background refresh; each section surfaces its own errors (C1)
  }
  function closeBuilding() { flushPendingChecklist(); discardProofDraft(); closeBoardDoc(); S.view = { name: "list" }; S.editAsset = null; S.msg = null; S.error = null; render(); }
  function loadBuildingSections(id) {
    var uid = userId();
    var start = function () { refreshPending(); if (!S.session || !navigator.onLine) { render(); return; } loadAssets(id); loadContacts(id); loadZones(id); loadProof(id); loadOffers(id); };
    if (!uid) { start(); return; }
    OFF.cacheGet(uid, "b:" + id).then(function (snap) {
      if (snap && snap.v) { S.assets = snap.v.assets; S.proof = snap.v.proof; S.offers = snap.v.offers; S.contacts = snap.v.contacts || null; S.zones = snap.v.zones || null; S.snapTs = snap.ts; render(); }
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
  /* Ticks arrive in BURSTS — a befaring is 40 taps in 90 seconds. Draining per tick means a round-trip and
   * a full section reload (and, through render(), a Leaflet teardown/rebuild) forty times over. The write
   * itself is queued immediately — durability is never deferred — but the drain waits for the burst to end. */
  var drainTimer = null;
  function scheduleDrain(ms) {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(function () { drainTimer = null; drainAll(); }, ms || 1200);
  }
  function drainAll() {
    var uid = userId();
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    if (!uid || !S.session || !navigator.onLine) return;   // draining needs a live token; the offline identity only queues
    OFF.drain(sb, uid, function () { refreshPending(function () { render(); }); }).then(function (changed) {
      refreshPending(function () {
        render();
        if (!changed) return;
        // acked (or conflict-resolved) ops → the DELTA pull brings server truth into the cache, chips flip
        if (S.view.name === "building") { loadAssets(S.view.id); loadContacts(S.view.id); loadZones(S.view.id); loadProof(S.view.id); loadOffers(S.view.id); }
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
    role: "Rolle", phone: "Telefon", email: "E-post",
    checklist: "Befaring", data: "Tilbudsinnhold", total_monthly: "Total /mnd", total_yearly: "Total /år",
    version: "Versjon", status: "Status", cover_note: "Følgebrev" };
  function fmtFieldVal(k, v) {
    if (k === "deleted_at") return v ? "slettet" : "ikke slettet";
    if (v == null || v === "") return "—";
    // the two blob columns are not diffable field-by-field — summarise them instead of dumping JSON at a rep
    if (k === "checklist") return (v.length || 0) + " punkter, " + v.filter(function (x) { return x && x.scope && x.scope !== "unknown"; }).length + " avklart";
    if (k === "data") return "tilbud: " + ((v.modules || []).length) + " moduler, " + kr(v.totalMonthly || 0) + "/mnd";
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
            return '<button class="bldg click" data-act="nbPick" data-idx="' + i + '"><span><span class="t">🏢 ' + esc(normOrgName(it.navn || "")) + '</span><span class="d">org ' + esc(it.organisasjonsnummer || "") + (of.beskrivelse ? ' · ' + esc(of.beskrivelse) : '') + '</span></span><span class="chev">›</span></button>';
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
    OFF.queueUpdate(op).then(function () {
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
    OFF.queueUpdate(op).then(function () {
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
    OFF.queueUpdate(op).then(function () {
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
    OFF.queueUpdate(op).then(function () {
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

  /* ============================ section: Kart + soner (onboarding B — zones, class B) ============================
   * The tagged service zone is the product's central object (won→run→grow). Drawn on a Kartverket-tiled
   * Leaflet map, measured with the same geodesic math as the demo/@onsite/core, persisted through the v1.5
   * class-B machinery (outbox/LWW/tombstones/deltas) exactly like assets/contacts — this is UI + geometry,
   * not new sync. Map lifecycle: the app re-renders innerHTML wholesale, so the map rebuilds per render with
   * the view preserved in module vars; draw interaction updates map layers directly (never triggers render). */
  var ZONE_SERVICES = [
    { key: "snow", label: "Snø / vinter", swatch: "❄️", stroke: "#1d4ed8" },
    { key: "grass", label: "Gress / plen", swatch: "🌿", stroke: "#15803d" },
    { key: "greenery", label: "Grønt / bed / hekk", swatch: "🌳", stroke: "#b5790b" },
    { key: "cleaning-ext", label: "Utvendig renhold", swatch: "🧼", stroke: "#0369a1" },
    { key: "other", label: "Annet", swatch: "▫️", stroke: "#6b7670" }
  ];
  var ZONE_METHODS = { snow: [{ key: "machine", label: "Maskin" }, { key: "hand", label: "Hånd / manuell" }],
    grass: [{ key: "mow", label: "Klipping" }, { key: "edge", label: "Kantklipp" }, { key: "gartner", label: "Gartner / bed" }],
    greenery: [{ key: "gartner", label: "Beskjæring / bed" }], "cleaning-ext": [{ key: "wash", label: "Vask" }], other: [] };
  var ZONE_CONSTRAINTS = [{ key: "none", label: "Ingen" }, { key: "delicate", label: "Ømtålig" }, { key: "no-go", label: "Ikke kjør / no-go" }, { key: "access-tight", label: "Trang adkomst" }];
  function zoneSvcDef(k) { return ZONE_SERVICES.filter(function (s) { return s.key === k; })[0] || ZONE_SERVICES[4]; }
  function zoneMethodLabel(z) { var ms = ZONE_METHODS[z.service] || []; var m = ms.filter(function (x) { return x.key === z.method; })[0]; return m ? m.label : ""; }
  function zoneDefaultMethod(s) { var ms = ZONE_METHODS[s] || []; return ms.length ? ms[0].key : null; }
  // geodesic measurement — identical math to @onsite/core's node-tested geoArea/geoLength (kept inline so it
  // never depends on the deferred core bundle's load timing; the demo keeps its own copy for the same reason).
  function zGeoArea(pts) { if (pts.length < 3) return 0; var R = 6378137, lat0 = 0; pts.forEach(function (p) { lat0 += p[0]; }); lat0 = (lat0 / pts.length) * Math.PI / 180;
    var xy = pts.map(function (p) { return [R * (p[1] * Math.PI / 180) * Math.cos(lat0), R * (p[0] * Math.PI / 180)]; });
    var a = 0; for (var i = 0; i < xy.length; i++) { var j = (i + 1) % xy.length; a += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; } return Math.abs(a) / 2; }
  function zHav(a, b) { var R = 6378137, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180, la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.sqrt(h)); }
  function zGeoLength(pts) { var d = 0; for (var i = 1; i < pts.length; i++) d += zHav(pts[i - 1], pts[i]); return d; }
  function ringLL(coords) { return coords.map(function (p) { return [p[1], p[0]]; }); }   // GeoJSON [lng,lat] → Leaflet [lat,lng]
  function toLL(latlngs) { return latlngs.map(function (p) { return [p.lat, p.lng]; }); }
  function centroidLL(ll) { var la = 0, lo = 0; ll.forEach(function (p) { la += p[0]; lo += p[1]; }); return [la / ll.length, lo / ll.length]; }
  function fmtArea(n) { return Math.round(n).toLocaleString("no") + " m²"; }
  function fmtLen(n) { return Math.round(n).toLocaleString("no") + " m"; }
  function zoneRecompute(z) {
    if (z.geometry.type === "Polygon") { z.area_m2 = Math.round(zGeoArea(ringLL(z.geometry.coordinates[0]))); z.length_m = null; }
    else if (z.geometry.type === "LineString") { z.length_m = Math.round(zGeoLength(ringLL(z.geometry.coordinates))); z.area_m2 = null; }
    else { z.area_m2 = null; z.length_m = null; }
    return z;
  }
  function zoneMeasureStr(z) { return z.area_m2 != null ? fmtArea(z.area_m2) : z.length_m != null ? fmtLen(z.length_m) : "punkt"; }
  function ZONE_COLOR(z) {
    if (z.constraint === "no-go") return { stroke: "#b3261e", fill: "#b3261e" };
    if (z.service === "snow") return z.method === "hand" ? { stroke: "#ca8a04", fill: "#eab308" } : { stroke: "#1d4ed8", fill: "#1d4ed8" };
    if (z.service === "grass") return z.method === "edge" ? { stroke: "#0f766e", fill: "#0f766e" } : z.method === "gartner" ? { stroke: "#b5790b", fill: "#f59e0b" } : { stroke: "#15803d", fill: "#22c55e" };
    if (z.service === "greenery") return { stroke: "#b5790b", fill: "#f59e0b" };
    if (z.service === "cleaning-ext") return { stroke: "#0369a1", fill: "#38bdf8" };
    return { stroke: "#6b7670", fill: "#9ca3af" };
  }
  function zoneStyle(z) { var c = ZONE_COLOR(z); var poly = z.geometry.type === "Polygon";
    return { color: c.stroke, weight: 2, opacity: 1, fillColor: c.fill, fillOpacity: poly ? 0.32 : 0, dashArray: (z.constraint === "no-go" || z.constraint === "delicate") ? "6 4" : null }; }
  function zoneSwatchHTML(z) { var c = ZONE_COLOR(z); return '<span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:' + c.fill + ';border:1.5px solid ' + c.stroke + ';vertical-align:-1px"></span>'; }
  /* row ↔ core (note: DB column is constraint_note; the drawn shape uses `constraint`) */
  function zoneRowToCore(row) {
    return { id: row.id, service: row.service || "other", method: row.method || null, geometry: row.geometry || null,
      area_m2: row.area_m2, length_m: row.length_m, priority: row.priority, constraint: row.constraint_note || "none",
      label: row.label || "", notes: row.notes || "", photoIds: row.photo_ids || [], _row: row };
  }
  function zoneToRow(z) {
    return { service: z.service, method: z.method || null, geometry: z.geometry, area_m2: z.area_m2 != null ? z.area_m2 : null,
      length_m: z.length_m != null ? z.length_m : null, priority: z.priority != null ? z.priority : null,
      constraint_note: z.constraint || "none", label: (z.label || "").trim() || null, notes: (z.notes || "").trim() || null,
      photo_ids: (z.photoIds && z.photoIds.length) ? z.photoIds : null };
  }
  /* delta pull, zones (doc-80 §3): per-building watermark wm:zones:<bid>, tombstones ride the delta */
  function loadZones(bid) {
    S.secBusy.zones = true; S.secErr.zones = null;
    var uid = userId();
    var done = function (list) { S.secBusy.zones = false; S.zones = list; snapshotBuilding(bid); render(); };
    var fail = function (e) { S.secBusy.zones = false; S.secErr.zones = friendly(e); render(); };
    var full = function () {
      return sb.from("zones").select("*").eq("building_id", bid).is("deleted_at", null).order("created_at", { ascending: true }).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data || []; var nm = maxUpdatedAt(rows, "");
        if (uid) OFF.cachePut(uid, "wm:zones:" + bid, nm || null);
        done(rows.map(zoneRowToCore));
      });
    };
    if (!uid) { full().catch(fail); return; }
    OFF.cacheGet(uid, "wm:zones:" + bid).then(function (wm) {
      var mark = wm && wm.v;
      if (!validWm(mark) || S.zones == null) return full();
      return sb.from("zones").select("*").eq("building_id", bid).gt("updated_at", mark).then(function (r) {
        if (r.error) return fail(r.error);
        var delta = r.data || [], byId = {}; (S.zones || []).forEach(function (z) { byId[z.id] = z; });
        delta.forEach(function (row) { if (row.deleted_at) delete byId[row.id]; else byId[row.id] = zoneRowToCore(row); });
        var merged = Object.keys(byId).map(function (k) { return byId[k]; });
        merged.sort(function (x, y) { return (((x._row && x._row.created_at) || "")) < (((y._row && y._row.created_at) || "")) ? -1 : 1; });
        var nm = maxUpdatedAt(delta, mark); if (nm !== mark) OFF.cachePut(uid, "wm:zones:" + bid, nm);
        done(merged);
      });
    }).catch(fail);
  }

  /* ---- Leaflet map lifecycle (rebuild-per-render, view preserved) ---- */
  var KARTVERKET = "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png";
  var zmap = null, zmapBid = null, zmapView = null, zoneLayer = null;
  var drawMode = null, drawPts = [], drawTemp = null, drawVert = null;
  function renderZoneLayers() {
    if (!zmap) return;
    if (zoneLayer) zoneLayer.clearLayers(); else zoneLayer = L.layerGroup().addTo(zmap);
    (S.zones || []).forEach(function (z) {
      if (!z.geometry) return;
      if (z.geometry.type === "Polygon") {
        var ll = ringLL(z.geometry.coordinates[0]); var poly = L.polygon(ll, zoneStyle(z)); poly.bindTooltip(zoneTip(z), { sticky: true }); poly.addTo(zoneLayer);
        if (z.service === "snow" && z.priority) L.marker(centroidLL(ll), { interactive: false, icon: L.divIcon({ className: "", html: '<div class="ob-zprio">' + z.priority + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(zoneLayer);
      } else if (z.geometry.type === "LineString") {
        var pl = L.polyline(ringLL(z.geometry.coordinates), zoneStyle(z)); pl.bindTooltip(zoneTip(z), { sticky: true }); pl.addTo(zoneLayer);
      } else if (z.geometry.type === "Point") {
        var p = z.geometry.coordinates; L.marker([p[1], p[0]], { icon: L.divIcon({ className: "", html: '<div class="ob-zpt">📍</div>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).bindTooltip(zoneTip(z), {}).addTo(zoneLayer);
      }
    });
  }
  function zoneTip(z) { return esc(z.label || zoneMethodLabel(z) || z.service) + " · " + zoneMeasureStr(z) + (z.priority ? " · P" + z.priority : ""); }
  function mountKartMap(b) {
    var el = document.getElementById("kart-map");
    if (!el) { if (zmap) { try { zmap.remove(); } catch (e) {} zmap = null; } return; }
    if (b.lat == null || b.lon == null || !window.L) return;   // empty-state / no-leaflet handled in HTML
    if (zmap) { try { zmap.remove(); } catch (e) {} zmap = null; }
    var view = (zmapBid === b.id && zmapView) ? zmapView : { center: [b.lat, b.lon], zoom: 18 };
    zmapBid = b.id;
    try { zmap = L.map(el, { zoomControl: true }).setView(view.center, view.zoom); } catch (e) { zmap = null; return; }
    L.tileLayer(KARTVERKET, { attribution: "© Kartverket", maxZoom: 20, maxNativeZoom: 18 }).addTo(zmap);
    zoneLayer = L.layerGroup().addTo(zmap); renderZoneLayers();
    zmap.on("moveend", function () { try { var c = zmap.getCenter(); zmapView = { center: [c.lat, c.lng], zoom: zmap.getZoom() }; } catch (e) {} });
    zmap.on("click", function (e) { if (drawMode) handleDrawClick(e.latlng); });
    zmap.on("dblclick", function () { if (drawMode && drawMode !== "point") finishDraw(); });
    if (drawMode) { try { zmap.doubleClickZoom.disable(); } catch (e) {} el.style.cursor = "crosshair"; if (drawPts.length) updateDrawTemp(); }
    setTimeout(function () { if (zmap) zmap.invalidateSize(); }, 60);
  }
  /* ---- draw interaction (direct map/DOM updates — never render(), so the map stays stable mid-draw) ---- */
  function setDrawTools() { var el = document.getElementById("kart-drawtools"); if (el) el.innerHTML = drawToolbarHTML(); }
  function drawToolbarHTML() {
    function b(m, l) { return '<button class="chip pendbtn' + (drawMode === m ? " s" : " q") + '" data-act="zoneDraw" data-arg="' + m + '" style="border:none;cursor:pointer">' + l + '</button>'; }
    return '<span class="note" style="margin:0;font-weight:700">✏️ Tegn sone:</span> ' + b("polygon", "▰ Flate") + " " + b("line", "／ Linje") + " " + b("point", "• Punkt");
  }
  function setReadout(html) { var el = document.getElementById("kart-readout"); if (el) el.innerHTML = html || ""; }
  function startDraw(mode) {
    if (!zmap) { S.secErr.zones = "Kartet er ikke klart."; render(); return; }
    cancelDraw(true); drawMode = mode; drawPts = [];
    try { zmap.doubleClickZoom.disable(); } catch (e) {} zmap.getContainer().style.cursor = "crosshair"; setDrawTools();
    if (mode === "point") setReadout('<span class="chip q">Klikk på kartet for å plassere punktet</span> <button class="chip pendbtn q" data-act="zoneDrawCancel" style="border:none;cursor:pointer">Avbryt</button>');
    else setReadout('<span class="chip q">Klikk hjørnene…</span> <button class="chip pendbtn q" data-act="zoneDrawCancel" style="border:none;cursor:pointer">Avbryt</button>');
  }
  function endDrawMode() {
    drawMode = null; drawPts = [];
    if (drawTemp) { try { zmap.removeLayer(drawTemp); } catch (e) {} drawTemp = null; }
    if (drawVert) { try { zmap.removeLayer(drawVert); } catch (e) {} drawVert = null; }
    if (zmap) { zmap.getContainer().style.cursor = ""; try { zmap.doubleClickZoom.enable(); } catch (e) {} }
    setReadout(""); setDrawTools();
  }
  function cancelDraw(silent) { if (drawMode || drawPts.length) endDrawMode(); }
  function handleDrawClick(latlng) {
    if (drawMode === "point") { var geom = { type: "Point", coordinates: [latlng.lng, latlng.lat] }; endDrawMode(); openZoneSheet(null, geom); return; }
    drawPts.push(latlng); updateDrawTemp();
  }
  function updateDrawTemp() {
    if (drawTemp) { try { zmap.removeLayer(drawTemp); } catch (e) {} drawTemp = null; }
    if (drawVert) drawVert.clearLayers(); else drawVert = L.layerGroup().addTo(zmap);
    if (drawMode === "polygon" && drawPts.length >= 3) drawTemp = L.polygon(drawPts, { color: "#0f766e", weight: 2, dashArray: "5 4", fillOpacity: 0.12 }).addTo(zmap);
    else if (drawPts.length >= 1) drawTemp = L.polyline(drawPts, { color: "#0f766e", weight: 2, dashArray: "5 4" }).addTo(zmap);
    drawPts.forEach(function (p) { L.circleMarker(p, { radius: 4, color: "#0f766e", fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(drawVert); });
    var txt;
    if (drawMode === "polygon") txt = drawPts.length >= 3 ? ("Areal: " + fmtArea(zGeoArea(toLL(drawPts)))) : ("Sett " + (3 - drawPts.length) + " punkt(er) til");
    else txt = drawPts.length >= 2 ? ("Lengde: " + fmtLen(zGeoLength(toLL(drawPts)))) : "Sett minst 2 punkter";
    setReadout('<span class="chip s">' + txt + '</span> <button class="chip pendbtn ok" data-act="zoneDrawFinish" style="border:none;cursor:pointer">✓ Fullfør</button> <button class="chip pendbtn q" data-act="zoneDrawCancel" style="border:none;cursor:pointer">Avbryt</button>');
  }
  function finishDraw() {
    if (!drawMode || drawMode === "point") return;
    if (drawMode === "line" && drawPts.length < 2) { setReadout('<span class="chip warn">Linje trenger minst 2 punkter</span>'); return; }
    if (drawMode === "polygon" && drawPts.length < 3) { setReadout('<span class="chip warn">Flate trenger minst 3 punkter</span>'); return; }
    var type = drawMode === "line" ? "LineString" : "Polygon";
    var coords = drawPts.map(function (p) { return [p.lng, p.lat]; });
    var geom = { type: type, coordinates: type === "Polygon" ? [coords.concat([coords[0]])] : coords };
    endDrawMode(); openZoneSheet(null, geom);
  }
  /* ---- tag sheet (inline form in the Kart section) ---- */
  function openZoneSheet(zone, geom) {
    S.editZone = zone ? JSON.parse(JSON.stringify(zone))
      : { id: null, service: "snow", method: zoneDefaultMethod("snow"), priority: null, constraint: "none", label: "", notes: "", geometry: geom, photoIds: [] };
    zoneRecompute(S.editZone); S.zonePhoto = null; S.secErr.zones = null; render();
  }
  function zoneFormHTML(z) {
    var ms = ZONE_METHODS[z.service] || [];
    var methodSel = ms.length ? '<label>Metode</label><select id="z_method">' + ms.map(function (m) { return '<option value="' + m.key + '"' + (z.method === m.key ? " selected" : "") + '>' + esc(m.label) + '</option>'; }).join("") + '</select>' : '';
    var prio = z.service === "snow" ? '<label>Prioritet (ryddrekkefølge)</label><input id="z_priority" type="number" min="1" step="1" value="' + (z.priority || "") + '" placeholder="1">' : '';
    var gtype = { Polygon: "Flate", LineString: "Linje", Point: "Punkt" }[z.geometry.type] || z.geometry.type;
    var measEdit = z.geometry.type === "Polygon" ? '<label>Areal (m²) — målt, kan justeres</label><input id="z_area" type="number" min="0" value="' + (z.area_m2 || 0) + '">'
      : z.geometry.type === "LineString" ? '<label>Lengde (m) — målt, kan justeres</label><input id="z_len" type="number" min="0" value="' + (z.length_m || 0) + '">' : '';
    var thumb = S.zonePhoto ? '<div class="thumbrow"><img class="proofimg" style="margin-top:0" src="' + S.zonePhoto.dataUrl + '" alt="valgt bilde (lagret på enheten)"><button class="btn ghost" style="padding:7px 10px" data-act="zonePhotoRemove">✕ Fjern</button></div>'
      : '<input type="file" id="z_photo" accept="image/*">';
    return '<div class="aform"><div class="note" style="font-weight:800;text-transform:uppercase;font-size:10.5px;letter-spacing:.03em">' + (z.id ? "Rediger sone" : "Ny sone") + ' · ' + gtype + ' · ' + zoneMeasureStr(z) + '</div>'
      + '<label>Tjeneste</label><select id="z_service" data-zsvc="1">' + ZONE_SERVICES.map(function (s) { return '<option value="' + s.key + '"' + (z.service === s.key ? " selected" : "") + '>' + s.swatch + ' ' + esc(s.label) + '</option>'; }).join("") + '</select>'
      + methodSel + prio + measEdit
      + '<label>Begrensning</label><select id="z_constraint">' + ZONE_CONSTRAINTS.map(function (k) { return '<option value="' + k.key + '"' + (z.constraint === k.key ? " selected" : "") + '>' + esc(k.label) + '</option>'; }).join("") + '</select>'
      + '<label>Etikett</label><input id="z_label" value="' + esc(z.label || "") + '" placeholder="f.eks. Hovedplen vest / Deponi">'
      + '<label>Notat</label><input id="z_notes" value="' + esc(z.notes || "") + '" placeholder="metode, art/skjøtsel, adkomst…">'
      + '<label>Bilde (valgfritt)</label>' + thumb
      + '<div class="bar"><button class="btn" data-act="zoneSave">' + (z.id ? "Lagre endringer" : "Lagre sone") + ' →</button><button class="btn ghost" data-act="zoneCancel">Avbryt</button></div></div>';
  }
  function zoneSyncForm() {
    var z = S.editZone; if (!z) return;
    z.service = val("z_service") || z.service;
    var msel = document.getElementById("z_method"); z.method = msel ? msel.value : (ZONE_METHODS[z.service] && ZONE_METHODS[z.service][0] ? null : null);
    var psel = document.getElementById("z_priority"); z.priority = psel && psel.value ? parseInt(psel.value, 10) : null;
    z.constraint = val("z_constraint") || "none"; z.label = val("z_label"); z.notes = val("z_notes");
    zoneRecompute(z);
    var av = val("z_area"); if (av !== "" && z.geometry.type === "Polygon") z.area_m2 = Math.round(parseFloat(av) || 0);
    var lv = val("z_len"); if (lv !== "" && z.geometry.type === "LineString") z.length_m = Math.round(parseFloat(lv) || 0);
  }
  function zoneSave() {
    zoneSyncForm();
    var z = S.editZone, b = buildingById(S.view.id); if (!z || !b) return;
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid) { S.secErr.zones = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    if (S.zonePhoto) { z.photoIds = (z.photoIds || []).concat([S.zonePhoto.path]); }   // append the drafted photo
    var row = zoneToRow(z), op, after, draftPath = S.zonePhoto && S.zonePhoto.path;
    if (z.id) {
      var orig = (S.zones || []).filter(function (x) { return x.id === z.id; })[0];
      var base = (orig && orig._row) || {};
      var merged = {}; for (var mk in base) merged[mk] = base[mk]; for (var rk in row) merged[rk] = row[rk]; merged.id = z.id;
      after = zoneRowToCore(merged);
      if (base.updated_at) {
        var fields = { id: z.id }, changed = false;
        for (var k in row) { if (JSON.stringify(base[k] == null ? null : base[k]) !== JSON.stringify(row[k] == null ? null : row[k])) { fields[k] = row[k]; changed = true; } }
        if (!changed && !draftPath) { S.editZone = null; S.secMsg.zones = "Ingen endringer."; render(); return; }
        op = { entity: "zones", op: "update", payload: fields, baseUpdatedAt: base.updated_at, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: z.label || zoneSvcDef(z.service).label };
      } else {
        var re = {}; for (var pk in row) re[pk] = row[pk]; re.id = z.id; re.tenant_id = S.tenant.id; re.building_id = b.id;
        op = { entity: "zones", op: "insert", payload: re, baseUpdatedAt: null, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: z.label || zoneSvcDef(z.service).label };
      }
    } else {
      row.id = OFF.uuid(); row.tenant_id = S.tenant.id; row.building_id = b.id;
      op = { entity: "zones", op: "insert", payload: row, baseUpdatedAt: null, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: z.label || zoneSvcDef(z.service).label };
      z.id = row.id; after = zoneRowToCore(row);
    }
    var commit = draftPath ? OFF.promotePhoto(draftPath).then(function () { return OFF.queueUpdate(op); }) : OFF.queueUpdate(op);
    commit.then(function () {
      if (z.id && (S.zones || []).some(function (x) { return x.id === z.id; })) S.zones = S.zones.map(function (x) { return x.id === z.id ? after : x; });
      else S.zones = (S.zones || []).concat([after]);
      S.editZone = null; S.zonePhoto = null;
      S.secMsg.zones = "Lagret på enheten: " + (after.label || zoneSvcDef(after.service).label) + " · " + zoneMeasureStr(after) + " — synkes.";
      snapshotBuilding(b.id); refreshPending(function () { render(); }); drainAll();
    }).catch(function (e) { S.secErr.zones = "⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — sonen er IKKE trygg."; render(); });
  }
  function zoneDelete(id) {
    var z = (S.zones || []).filter(function (x) { return x.id === id; })[0];
    if (!z || !window.confirm("Slette sonen «" + (z.label || zoneSvcDef(z.service).label) + "»?")) return;
    var uid = userId(), b = buildingById(S.view.id);
    if (!uid || !b || !S.tenant || !S.tenant.id) return;
    var base = z._row || {}, op, title = "Slett sone: " + (z.label || zoneSvcDef(z.service).label);
    if (base.updated_at) op = { entity: "zones", op: "update", payload: { id: id, deleted_at: new Date().toISOString() }, baseUpdatedAt: base.updated_at, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title };
    else { var row = zoneToRow(z); row.id = id; row.tenant_id = S.tenant.id; row.building_id = b.id; row.deleted_at = new Date().toISOString(); op = { entity: "zones", op: "insert", payload: row, baseUpdatedAt: null, tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: title }; }
    OFF.queueUpdate(op).then(function () {
      S.zones = (S.zones || []).filter(function (x) { return x.id !== id; });
      S.secMsg.zones = "Sone slettet — lagret på enheten, synkes."; snapshotBuilding(b.id); refreshPending(function () { render(); }); drainAll();
    }).catch(function (e) { S.secErr.zones = "⚠ Kunne ikke lagre slettingen (" + ((e && e.message) || "lagringsfeil") + ")."; render(); });
  }
  function attachZonePhoto(el) {
    var b = buildingById(S.view.id); if (!b) return;
    var uid = userId(), tenantId = S.tenant && S.tenant.id, file = el.files && el.files[0];
    if (!file) return;
    if (!uid || !tenantId) { S.secErr.zones = "Mangler tenant/bruker."; render(); return; }
    var oldPath = S.zonePhoto && S.zonePhoto.path; S.secErr.zones = null;
    compressImage(file, function (dataUrl) {
      if (!dataUrl) { S.secErr.zones = "⚠ Kunne IKKE lagre foto — det følger ikke med sonen (kunne ikke lese bildet)."; render(); return; }
      var path = tenantId + "/" + b.id + "/" + OFF.uuid() + ".jpg";
      OFF.queuePhoto({ path: path, userId: uid, buildingId: b.id, dataUrl: dataUrl, status: "draft" })
        .then(function () { return OFF.getPhoto(path); })
        .then(function (stored) { if (!stored || !stored.dataUrl) throw new Error("lagret foto kunne ikke leses tilbake"); S.zonePhoto = { path: path, dataUrl: stored.dataUrl }; if (oldPath) OFF.delPhoto(oldPath); render(); })
        .catch(function (e) { S.zonePhoto = null; S.secErr.zones = "⚠ Kunne IKKE lagre foto — det følger ikke med sonen (" + ((e && e.message) || "lagringsfeil") + ")."; render(); });
    });
  }
  function sectionKartHTML(b) {
    var hasGeo = b.lat != null && b.lon != null;
    var zPend = pendingOpByRecord("zones");
    var mapBox = !hasGeo
      ? '<div class="empty">Ingen koordinater ennå — sett dem via 📍 Geokod i bygg-oppsettet for å tegne soner på kart.</div>'
      : '<div id="kart-drawtools" class="bar" style="margin:0 0 8px">' + drawToolbarHTML() + '</div>'
        + '<div id="kart-readout" style="min-height:20px;margin-bottom:6px"></div>'
        + '<div id="kart-map" class="kart-map"></div>'
        + (S.offline ? '<div class="note" style="margin-top:6px">🗺️ Kartbakgrunn utilgjengelig uten nett — sonelisten under er fullt brukbar; tegning lagres og synkes.</div>' : '')
        + '<div class="note" style="margin-top:6px;font-size:11px">Kartdata © Kartverket</div>';
    var list;
    if (S.secBusy.zones && S.zones == null) list = '<div class="empty"><span class="spin"></span>Henter soner…</div>';
    else if (!S.zones || !S.zones.length) list = '<div class="empty">Ingen tegnede soner ennå — bruk <b>Tegn sone</b> over kartet.</div>';
    else list = ZONE_SERVICES.filter(function (s) { return (S.zones || []).some(function (z) { return z.service === s.key; }); }).map(function (s) {
      var rows = S.zones.filter(function (z) { return z.service === s.key; }).map(function (z) {
        var meta = [zoneMethodLabel(z), z.priority ? "P" + z.priority : "", (z.constraint && z.constraint !== "none" ? z.constraint : ""), (z.photoIds && z.photoIds.length ? "📷 " + z.photoIds.length : "")].filter(Boolean).join(" · ");
        return '<div class="bldg"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><span class="t">' + zoneSwatchHTML(z) + ' ' + esc(z.label || zoneMethodLabel(z) || zoneSvcDef(z.service).label) + ' <span class="muted" style="font-weight:600">· ' + zoneMeasureStr(z) + '</span>' + opChip(zPend[z.id]) + '</span>' + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + '</span>'
          + '<span style="display:flex;gap:6px;flex-shrink:0"><button class="btn ghost" style="padding:7px 10px" data-act="zoneEdit" data-id="' + esc(z.id) + '">✎</button><button class="btn ghost" style="padding:7px 10px" data-act="zoneDel" data-id="' + esc(z.id) + '">🗑</button></span></div></div>';
      }).join("");
      return '<div class="ct" style="color:' + s.stroke + ';margin-top:8px">' + s.swatch + ' ' + esc(s.label) + '</div>' + rows;
    }).join("");
    return '<div class="card"><div class="ct">🗺️ Kart + soner <span class="muted" style="font-weight:600">· ' + (S.zones ? S.zones.length : "…") + ' · zones (RLS: kun din tenant)</span></div>'
      + (S.secMsg.zones ? '<div class="msg ok">' + esc(S.secMsg.zones) + '</div>' : '')
      + (S.secErr.zones ? '<div class="msg err">' + esc(S.secErr.zones) + '</div>' : '')
      + mapBox
      + (S.editZone ? zoneFormHTML(S.editZone) : '')
      + '<div style="margin-top:10px">' + list + '</div></div>';
  }

  /* ============================ section: Befaring (onboarding C — the walkaround checklist) ============================
   * The doc-38 residential-association walk: 10 zones × service lines, four states per item
   * (✅ i scope · ⬆ upsell · ✖ finnes ikke · ⬜ ukjent), plus capture, price, notes and photos.
   *
   * Ported from the demo's CHECKLIST_TEMPLATE (onboarding.js) — item ids/labels/zones/captureTypes are
   * VERBATIM, because @onsite/core's computeOffer reads five of those ids by name. Two deliberate
   * ADDITIONS (marked `added:true`), both of which capture a driver core already reads but the demo could
   * only get from map markers — which /app does not have:
   *   · `innganger` → core's `entryways` (manuell rydding/strøing per inngang). The demo counts `entrance`
   *     MARKERS; Holtet's ground truth is 7 innganger vs 4 oppganger, and without this the snow/hand line
   *     silently falls back to the oppganger count (kr 344 instead of kr 602 — the 16 530 anchor breaks).
   *   · `etasjer`  → core's `floors`. Uncaptured, core defaults to 4 — a fabricated number in a codebase
   *     whose whole discipline is that we don't fabricate. Captured, the trappevask line is honest.
   *
   * The demo has NO price input on the checklist at all — `water`/`mats`/`weeds` prices (kr 4 358/mnd of
   * Holtet's kr 16 530) exist only in its hardcoded seed, unreachable from the UI. PRICE_SRC below makes
   * the money path explicit per item and puts a kr field exactly where core reads `it.price`. */
  var WALK_ZONES = [
    { n: 1, title: "Adkomst og uteareal" }, { n: 2, title: "Avfall" }, { n: 3, title: "Innganger og oppganger" },
    { n: 4, title: "Heis" }, { n: 5, title: "Fellesareal / svalganger / bod" }, { n: 6, title: "Kjeller / teknisk rom" },
    { n: 7, title: "Garasje" }, { n: 8, title: "Dører og adgang" }, { n: 9, title: "Tak" }, { n: 10, title: "Roller og admin" }
  ];
  var CHECKLIST_TEMPLATE = [
    // 1. Adkomst og uteareal
    { id: "lawn", zone: 1, label: "Plen — areal + klippefrekvens", category: "hage", captureType: "area", emoji: "🌿", freq: "Ukentlig i sesong" },
    { id: "hedges", zone: 1, label: "Hekk/busker — antall + maks høyde", category: "hage", captureType: "count", emoji: "🌳", freq: "2×/sesong" },
    { id: "trees", zone: 1, label: "Trær <3,5 m (i scope) vs høye ⬆", category: "hage", captureType: "count", emoji: "🌳" },
    { id: "beds", zone: 1, label: "Staudebed — luking + vårrydding", category: "hage", captureType: "count", emoji: "🌷" },
    { id: "weeds", zone: 1, label: "Ugras/mose/alger — sprøyterunder", category: "hage", captureType: "condition", emoji: "🌿", freq: "3×/sesong" },
    { id: "gravel", zone: 1, label: "Elvestein/grus — eddikbehandling", category: "hage", captureType: "note", emoji: "🪨" },
    { id: "greenwaste", zone: 1, label: "Grøntavfall — rute + deponi", category: "hage", captureType: "note", emoji: "🍂" },
    { id: "taps", zone: 1, label: "Utekraner — åpne/steng vår/høst", category: "drift", captureType: "count", emoji: "🚰" },
    { id: "bootscr", zone: 1, label: "Fotskraperister ved innganger", category: "drift", captureType: "count", emoji: "🚪" },
    { id: "paths", zone: 1, label: "Veier/stier — maskinkost vår (før 17. mai)", category: "anlegg", captureType: "area", emoji: "🧹" },
    { id: "snow", zone: 1, label: "Snø — brøyteareal, dumpested, strøsoner", category: "vinter", captureType: "area", emoji: "❄️", freq: "Per snøfall >5 cm" },
    { id: "roofsnow", zone: 1, label: "Takras/snø → taksikring ⬆", category: "vinter", captureType: "condition", emoji: "🏠", upsell: true },
    // 2. Avfall
    { id: "wells", zone: 2, label: "Avfallsbrønner + bøtter/askebeger — antall", category: "drift", captureType: "count", emoji: "♻️" },
    { id: "binwash", zone: 2, label: "Dunk-/containervask ⬆", category: "service", captureType: "boolean", emoji: "♻️", upsell: true },
    { id: "bulky", zone: 2, label: "Grovavfall — lagringspunkt + henting", category: "drift", captureType: "note", emoji: "📦" },
    // 3. Innganger og oppganger
    { id: "oppganger", zone: 3, label: "Antall oppganger — trappevask", category: "renhold", captureType: "count", emoji: "🧹", freq: "Ukentlig" },
    { id: "etasjer", zone: 3, label: "Antall etasjer per oppgang", category: "renhold", captureType: "count", emoji: "🏢", added: true },
    { id: "innganger", zone: 3, label: "Antall innganger — manuell rydding + strøing", category: "vinter", captureType: "count", emoji: "🚪", freq: "Per snøfall / is", added: true },
    { id: "mats", zone: 3, label: "Inngangsmatter — antall + leverandør", category: "renhold", captureType: "count", emoji: "🧺" },
    { id: "glass", zone: 3, label: "Glass ytterdør / fellesvindu / rekkverk", category: "renhold", captureType: "condition", emoji: "🧼" },
    { id: "lighting", zone: 3, label: "Lysarmatur — type + reservelager (LED)", category: "drift", captureType: "note", emoji: "💡" },
    { id: "facade", zone: 3, label: "Fasade → svertesopp/fasadevask ⬆", category: "renhold", captureType: "condition", emoji: "🧼", upsell: true },
    // 4. Heis
    { id: "heiser", zone: 4, label: "Antall heiser — gulv/speil/metall", category: "renhold", captureType: "count", emoji: "🛗", freq: "Ukentlig" },
    { id: "liftctrl", zone: 4, label: "Heis sikkerhetskontroll (2-årlig) — hvem", category: "drift", captureType: "note", emoji: "🛗", compliance: true },
    // 5. Fellesareal / svalganger / bod
    { id: "svalg", zone: 5, label: "Svalganger — feiing + glassrekkverk (vår)", category: "renhold", captureType: "condition", emoji: "🧹" },
    { id: "bodarea", zone: 5, label: "Bod-/korridorareal", category: "renhold", captureType: "note", emoji: "🧹" },
    // 6. Kjeller / teknisk rom
    { id: "pipes", zone: 6, label: "Synlige rør/kraner — lekkasjer", category: "drift", captureType: "condition", emoji: "🔧" },
    { id: "water", zone: 6, label: "Varmtvann/varmepumpe/sluk åpne", category: "drift", captureType: "condition", emoji: "🔧" },
    { id: "sprinkler", zone: 6, label: "Sprinkler — logg trykk (årskontroll)", category: "drift", captureType: "condition", emoji: "🔧", compliance: true },
    { id: "vent", zone: 6, label: "Ventilasjon vifter/filter — hvem ⬆", category: "service", captureType: "note", emoji: "🌀", upsell: true },
    { id: "firepanel", zone: 6, label: "Brannsentral; rømningsveier; brannutstyr", category: "drift", captureType: "condition", emoji: "🔥" },
    { id: "pumpekum", zone: 6, label: "Pumpekum; varmekabler (sesong)", category: "drift", captureType: "condition", emoji: "🔧" },
    // 7. Garasje
    { id: "garage", zone: 7, label: "Garasje — vask/feiing; rampesluk; porter", category: "drift", captureType: "condition", emoji: "🅿️" },
    // 8. Dører og adgang
    { id: "doors", zone: 8, label: "Dørpumper/el-sluttstykke/låskasse; hengsler", category: "drift", captureType: "condition", emoji: "🚪" },
    { id: "access", zone: 8, label: "Nøkler/adgangskoder — fanget", category: "drift", captureType: "note", emoji: "🔑" },
    // 9. Tak
    { id: "roof", zone: 9, label: "Tak/takrenner/nedløp; vannbord tilstand", category: "anlegg", captureType: "condition", emoji: "🏠" },
    // 10. Roller og admin (+ the always-on upsell scan)
    { id: "round", zone: 10, label: "Ukentlig vaktmesterrunde + tilsyn + rapport", category: "drift", captureType: "note", emoji: "🧰", freq: "Ukentlig" },
    { id: "approver", zone: 10, label: "Styreleder + preferanser", category: "drift", captureType: "note", emoji: "🏛️" },
    { id: "manager", zone: 10, label: "Forvalter + rapportering", category: "drift", captureType: "note", emoji: "🗂️" },
    { id: "vakttlf", zone: 10, label: "Vakttelefon/beredskap 24t", category: "drift", captureType: "boolean", emoji: "📞" },
    { id: "pest", zone: 10, label: "Skadedyr — tegn? ⬆", category: "service", captureType: "boolean", emoji: "🐜", upsell: true },
    { id: "playground", zone: 10, label: "Lekeplass — antall + årskontroll ⬆", category: "drift", captureType: "count", emoji: "🛝", upsell: true },
    { id: "painting", zone: 10, label: "Maling / vannbord / asfalt ⬆", category: "anlegg", captureType: "note", emoji: "🖌️", upsell: true }
  ];
  /* Where each item's money comes from — mirrors computeOffer exactly, so the UI can be honest about which
   * numbers the rep supplies and which the engine derives. `flat` = the captured kr IS the monthly line
   * (core reads it.price); `count`/`zone`/`rate` = core derives the price from a driver × RATES, so we show
   * the driver, never a price box that would go nowhere. Any item set to ⬆ upsell gets a kr box regardless
   * (core turns every upsell with price > 0 into an option line). */
  var PRICE_SRC = {
    water: { kind: "flat", to: "Drift / vaktmester" },
    mats: { kind: "flat", to: "Renhold" },
    weeds: { kind: "flat", to: "Grønt – skjøtsel" },
    oppganger: { kind: "count", why: "prises fra antall oppganger × etasjer × sats" },
    etasjer: { kind: "count", why: "etasjetallet i trappevask-linjen" },
    heiser: { kind: "count", why: "prises fra antall heiser × sats" },
    innganger: { kind: "count", why: "prises fra antall innganger × sats" },
    round: { kind: "rate", why: "fast sats — ukentlig vaktmesterrunde" },
    lawn: { kind: "zone", why: "prises fra tegnet plen-sone (m²)" },
    snow: { kind: "zone", why: "prises fra tegnet brøyte-sone (m²)" },
    hedges: { kind: "zone", why: "prises fra tegnet hekk-linje (m) — opsjon" },
    beds: { kind: "zone", why: "prises fra tegnet bed-flate (m²) — opsjon" }
  };
  function scopeIcon(s) { return ({ "in": "✅", upsell: "⬆", out: "✖", unknown: "⬜" })[s] || "⬜"; }
  function instantiateChecklist() {
    return CHECKLIST_TEMPLATE.map(function (t) {
      return { id: t.id, zone: t.zone, label: t.label, category: t.category, captureType: t.captureType,
        emoji: t.emoji, freq: t.freq || "", upsell: !!t.upsell, compliance: !!t.compliance,
        // subtype is what core prints on an upsell offer line — strip the template's trailing ⬆ marker
        subtype: t.label.replace(/\s*⬆\s*$/, ""),
        value: null, scope: "unknown", price: 0, oneOff: false, notes: "", photoIds: [] };
    });
  }
  // an existing row's checklist is merged over a fresh template, so a template addition appears on buildings
  // captured before it existed (and a removed template item stops rendering) — the row stays the source of truth
  // for everything the rep actually entered.
  function checklistFor(b) {
    var saved = (b && b.checklist && b.checklist.length) ? b.checklist : null;
    var byId = {}; (saved || []).forEach(function (it) { byId[it.id] = it; });
    return instantiateChecklist().map(function (fresh) {
      var s = byId[fresh.id]; if (!s) return fresh;
      var out = fresh;
      ["value", "scope", "price", "oneOff", "notes", "photoIds", "subtype"].forEach(function (k) {
        if (s[k] != null) out[k] = s[k];
      });
      return out;
    });
  }
  function clItem(id) { return (S.checklist || []).filter(function (x) { return x.id === id; })[0] || null; }
  function clNum(id) { var it = clItem(id); var n = it ? parseInt(it.value, 10) : NaN; return isNaN(n) ? null : n; }
  function clPriced(it) {   // does this item get a kr box? exactly when core would read its price
    if (it.scope === "upsell") return true;
    return it.scope === "in" && (PRICE_SRC[it.id] || {}).kind === "flat";
  }
  function walkTotal() {   // the captured recurring kr the rep has ticked ✅ — NOT the offer (core prices that)
    return (S.checklist || []).filter(function (it) { return it.scope === "in"; })
      .reduce(function (s, it) { return s + (it.price || 0); }, 0);
  }
  function clCounts() {
    var n = { "in": 0, upsell: 0, out: 0, unknown: 0 };
    (S.checklist || []).forEach(function (it) { n[it.scope] = (n[it.scope] || 0) + 1; });
    return n;
  }

  /* ---- coalesced WHOLE-ROW writes for the two blob rows (buildings.checklist, offers.data) -------------
   * Both are a single jsonb blob, and both are edited in BURSTS by the one rep who owns them — 40 checklist
   * ticks in a walkaround, a handful of module toggles on a draft. Two consequences, which together decide
   * the write shape:
   *
   * 1. ONE queued op per record, its payload rewritten in place. Otherwise a burst queues N ops for one row.
   *
   * 2. A WHOLE-ROW UPSERT, not a base-checked field update. This is the subtle half, and the acceptance
   *    harness is what caught it: a class-B update takes baseUpdatedAt from the LOCAL row, whose updated_at
   *    only advances once a delta pull brings the server's new value back. Between an op being ACKED and
   *    that pull landing, the local base is stale — so a tick made in that window matches zero rows and the
   *    drain (correctly, by its own rules) files it in «Trenger gjennomsyn» as a conflict with ITSELF. During
   *    a befaring that window is wide open, and the rep would watch their own work pile up as conflicts. An
   *    upsert is idempotent, always applies, and carries the newest whole value — nothing typed can be
   *    dropped, and there is no base left to go stale.
   *
   * The cost is row-level LWW: a concurrent edit from another device is overwritten rather than flagged.
   * That is exactly the granularity doc-82 sanctioned — a befaring is one rep on one device — and nothing
   * else in this app writes a building row (there is no building-edit form) or someone else's draft offer.
   * The base-checked class-B path is UNCHANGED for the form-shaped tables (assets/contacts/zones), where one
   * save is one op and the base is always fresh. */
  function queueCoalesced(spec) {
    return OFF.listOps(spec.userId).then(function (ops) {
      var queued = ops.filter(function (o) {
        return o.entity === spec.entity && o.status === "queued" && o.payload && o.payload.id === spec.id;
      })[0];
      if (queued) { queued.payload = spec.fullRow(); return OFF.setOp(queued); }   // same op, newest whole value
      return OFF.queueOp({ entity: spec.entity, op: "insert", payload: spec.fullRow(), baseUpdatedAt: null,
        tenantId: spec.tenantId, buildingId: spec.buildingId, userId: spec.userId, title: spec.title });
    });
  }

  /* ---- persistence: the checklist rides the building row through the class-B outbox ---- */
  var clSaveTimer = null;
  function saveChecklist(b, immediate) {
    if (clSaveTimer) { clearTimeout(clSaveTimer); clSaveTimer = null; }
    if (immediate) return flushChecklist(b);
    clSaveTimer = setTimeout(function () { clSaveTimer = null; flushChecklist(b); }, 400);
    return Promise.resolve();
  }
  /* A typed value (a price, a count, a note) is debounced — so for up to 400 ms it lives in memory and
   * nowhere else. Every moment that could END that window must close it first: computing an offer (the
   * offer must not be priced from a checklist the server never received), leaving the building, and the
   * device going to sleep or the tab being closed — the last kr a rep types before pocketing the iPad is
   * exactly the one they would never forgive us for dropping. */
  function flushPendingChecklist() {
    if (!clSaveTimer) return;
    clearTimeout(clSaveTimer); clSaveTimer = null;
    var b = buildingById(S.view.id);
    if (b && S.checklist) flushChecklist(b);
  }
  function flushChecklist(b) {
    var uid = userId();
    if (!S.tenant || !S.tenant.id || !uid || !b) { S.secErr.checklist = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return Promise.resolve(); }
    var cl = S.checklist;
    // optimistic: state, the building row and the caches take the edit NOW; the chip stays honest until acked
    b.checklist = cl; if (b._row) b._row.checklist = cl;
    snapshotBuilding(b.id);
    return queueCoalesced({
      entity: "buildings", id: b.id,
      fullRow: function () { var row = {}; for (var k in (b._row || {})) row[k] = b._row[k]; row.id = b.id; row.checklist = cl; return row; },
      tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: "Befaring: " + b.name
    }).then(function () {
      return OFF.cacheGet(uid, "buildings").then(function (c) {
        var rows = ((c && c.v) || []).map(function (r) {
          if (r.id !== b.id) return r;
          var x = {}; for (var k in r) x[k] = r[k]; x.checklist = cl; return x;
        });
        return OFF.cachePut(uid, "buildings", rows);
      });
    }).then(function () {
      S.secErr.checklist = null;
      refreshPending(function () { refreshBefaring(); });   // surgical — never a full paint mid-befaring
      scheduleDrain();                                       // one drain per burst of ticks, not one per tick
    }).catch(function (e) {   // C1: durable queueing failed — loud, never a fake ✓
      S.secErr.checklist = "⚠ Kunne IKKE lagre befaringen på enheten (" + ((e && e.message) || "lagringsfeil") + ") — endringen er IKKE trygg.";
      render();
    });
  }

  function clScopeBtnsHTML(it) {
    return ["in", "upsell", "out", "unknown"].map(function (v) {
      return '<button class="cl-scope s-' + v + (it.scope === v ? ' on' : '') + '" data-act="clScope" data-id="' + esc(it.id) + '" data-arg="' + v + '" title="' + v + '">' + scopeIcon(v) + '</button>';
    }).join("");
  }
  function clCaptureHTML(it) {
    var v = (it.value == null ? "" : it.value);
    if (it.captureType === "count") return '<input type="number" min="0" inputmode="numeric" data-clf="value" data-id="' + esc(it.id) + '" value="' + esc("" + v) + '" placeholder="antall">';
    if (it.captureType === "area") return '<input type="number" min="0" inputmode="numeric" data-clf="value" data-id="' + esc(it.id) + '" value="' + esc("" + v) + '" placeholder="m²">';
    if (it.captureType === "boolean") return '<label class="cl-bool"><input type="checkbox" data-clf="bool" data-id="' + esc(it.id) + '"' + (v === true ? ' checked' : '') + '> ja</label>';
    return '<input data-clf="value" data-id="' + esc(it.id) + '" value="' + esc("" + v) + '" placeholder="' + (it.captureType === "condition" ? 'tilstand' : 'notat') + '">';
  }
  function clPhotosHTML(it) {
    var localByPath = {}; (S.pendingPhotos || []).forEach(function (p) { localByPath[p.path] = p; });
    var thumbs = (it.photoIds || []).map(function (path) {
      var lp = localByPath[path];
      var img = (lp && lp.dataUrl) ? '<img class="cl-thumb" src="' + lp.dataUrl + '" alt="bilde (lokalt)">'
        : '<img class="cl-thumb" data-photo-path="' + esc(path) + '" alt="bilde">';
      return '<span class="cl-thumbwrap">' + img + '<button class="cl-thumbdel" data-act="clPhotoDel" data-id="' + esc(it.id) + '" data-arg="' + esc(path) + '" title="Fjern">✕</button></span>';
    }).join("");
    return '<div class="cl-photos">' + thumbs
      + '<label class="cl-photobtn" title="Ta bilde">📷<input type="file" accept="image/*" data-clphoto="1" data-id="' + esc(it.id) + '"></label></div>';
  }
  function clRowHTML(it) {
    var src = PRICE_SRC[it.id] || {};
    var price = clPriced(it)
      ? '<div class="cl-price"><span class="cl-krlabel">kr</span><input type="number" min="0" step="50" inputmode="numeric" data-clf="price" data-id="' + esc(it.id) + '" value="' + (it.price || 0) + '">'
        + '<span class="cl-per">' + (it.scope === "upsell" && it.oneOff ? "engangs" : "/mnd") + '</span>'
        + (it.scope === "upsell" ? '<label class="cl-bool cl-once"><input type="checkbox" data-clf="oneoff" data-id="' + esc(it.id) + '"' + (it.oneOff ? ' checked' : '') + '> engangs</label>' : '')
        + '</div>'
        + '<div class="cl-why">' + (it.scope === "upsell" ? '→ opsjonslinje, utenfor grunnbeløpet' : '→ ' + esc(src.to || "tilbudslinje")) + '</div>'
      : (it.scope === "in" && src.why ? '<div class="cl-why">' + esc(src.why) + '</div>' : '');
    return '<div class="cl-item' + (it.scope === "upsell" ? ' up' : it.scope === "out" ? ' out' : '') + '">'
      + '<div class="cl-top"><div class="cl-label">' + it.emoji + ' ' + esc(it.label)
      + (it.compliance ? ' <span class="chip warn">lovpålagt</span>' : '')
      + (it.added ? '' : '') + '</div>'
      + '<div class="cl-scopes">' + clScopeBtnsHTML(it) + '</div></div>'
      + '<div class="cl-cap">' + clCaptureHTML(it) + (it.freq ? '<span class="cl-freq">' + esc(it.freq) + '</span>' : '') + '</div>'
      + price
      + '<input class="cl-note" data-clf="notes" data-id="' + esc(it.id) + '" value="' + esc(it.notes || "") + '" placeholder="notat…">'
      + clPhotosHTML(it)
      + '</div>';
  }
  function clZoneSummaryHTML(items) {
    var n = { "in": 0, upsell: 0, out: 0, unknown: 0 };
    items.forEach(function (it) { n[it.scope] = (n[it.scope] || 0) + 1; });
    var s = "";
    if (n["in"]) s += '<span class="chip ok">✅ ' + n["in"] + '</span> ';
    if (n.upsell) s += '<span class="chip warn">⬆ ' + n.upsell + '</span> ';
    if (n.unknown) s += '<span class="chip q">⬜ ' + n.unknown + '</span>';
    return '<span class="cl-zsum">' + s + '</span>';
  }
  function befaringHeadHTML(b) {
    var n = clCounts();
    return '📋 Befaring <span class="muted" style="font-weight:600">· ' + n["in"] + ' i scope · ' + n.upsell
      + ' upsell · ' + n.unknown + ' uavklart</span>' + opChip(pendingOpByRecord("buildings")[b.id]);
  }
  function befaringBodyHTML() {
    var byZone = {}; (S.checklist || []).forEach(function (it) { (byZone[it.zone] = byZone[it.zone] || []).push(it); });
    return WALK_ZONES.map(function (z) {
      var items = byZone[z.n] || []; if (!items.length) return "";
      var open = !!S.clOpen[z.n];
      return '<div class="cl-zone">'
        + '<button class="cl-zhead" data-act="clZone" data-id="' + z.n + '"><span class="cl-zn">' + z.n + '</span>'
        + '<span class="cl-zt">' + esc(z.title) + '</span>' + clZoneSummaryHTML(items)
        + '<span class="cl-zchev">' + (open ? '▾' : '▸') + '</span></button>'
        + (open ? '<div class="cl-zitems">' + items.map(clRowHTML).join("") + '</div>' : '')
        + '</div>';
    }).join("");
  }
  function befaringMsgHTML() {
    return (S.secMsg.checklist ? '<div class="msg ok">' + esc(S.secMsg.checklist) + '</div>' : '')
      + (S.secErr.checklist ? '<div class="msg err">' + esc(S.secErr.checklist) + '</div>' : '');
  }
  function sectionBefaringHTML(b) {
    if (!S.checklist) return '';
    return '<div class="card"><div class="ct" id="cl-head">' + befaringHeadHTML(b) + '</div>'
      + '<div class="note" style="margin-top:-4px">✅ i scope · ⬆ upsell · ✖ finnes ikke · ⬜ ukjent — ticker du ✅ med pris, blir det en tilbudslinje.</div>'
      + '<div id="cl-msg">' + befaringMsgHTML() + '</div>'
      + '<div class="cl-total">Fanget fastpris (✅): <b id="cl-total">' + kr(walkTotal()) + '</b> <span class="muted">/mnd — resten prises av soner og antall</span></div>'
      + '<div id="cl-body">' + befaringBodyHTML() + '</div></div>';
  }
  /* A tick must NOT go through render(): that rebuilds #app wholesale, which tears down and re-creates the
   * Leaflet map (and re-fetches its tiles) — forty times over the course of one befaring. Patch the four
   * nodes that actually changed instead. Same reason the demo has refreshChecklist() rather than a re-render. */
  function refreshBefaring() {
    var b = buildingById(S.view.id);
    if (!b || !S.checklist) return;
    var setH = function (id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; };
    setH("hdr-chips", headerChipsHTML());   // the «usendte» counter stays honest without a full paint
    setH("cl-head", befaringHeadHTML(b));
    setH("cl-msg", befaringMsgHTML());
    setH("cl-body", befaringBodyHTML());
    var tot = document.getElementById("cl-total"); if (tot) tot.textContent = kr(walkTotal());
    hydrateProofPhotos();
    var btn = document.getElementById("of-compute");
    if (btn) btn.disabled = S.offerBusy || !offerComputable();
    var hint = document.getElementById("of-hint");
    if (hint) hint.style.display = offerComputable() ? "none" : "";
  }
  function offerComputable() {
    return coreReady() && (S.checklist || []).some(function (it) { return it.scope === "in" || it.scope === "upsell"; });
  }
  function clPhotoAttach(el) {
    var b = buildingById(S.view.id), it = clItem(el.getAttribute("data-id"));
    var uid = userId(), tenantId = S.tenant && S.tenant.id, file = el.files && el.files[0];
    if (!b || !it || !file) return;
    if (!uid || !tenantId) { S.secErr.checklist = "Mangler tenant/bruker."; render(); return; }
    S.secErr.checklist = null;
    compressImage(file, function (dataUrl) {
      if (!dataUrl) { S.secErr.checklist = "⚠ Kunne IKKE lagre foto — det følger ikke med befaringen (kunne ikke lese bildet)."; render(); return; }
      var path = tenantId + "/" + b.id + "/" + OFF.uuid() + ".jpg";
      // the checklist item IS the form here — there is nothing left to cancel, so the blob is durable and
      // promoted into the upload queue in one step (same read-back proof as the proof/zone pipelines)
      OFF.queuePhoto({ path: path, userId: uid, buildingId: b.id, dataUrl: dataUrl, status: "draft" })
        .then(function () { return OFF.getPhoto(path); })
        .then(function (stored) {
          if (!stored || !stored.dataUrl) throw new Error("lagret foto kunne ikke leses tilbake");
          return OFF.promotePhoto(path);
        })
        .then(function () {
          it.photoIds = (it.photoIds || []).concat([path]);
          return saveChecklist(b, true);
        })
        .catch(function (e) {
          OFF.delPhoto(path);
          S.secErr.checklist = "⚠ Kunne IKKE lagre foto — det følger ikke med befaringen (" + ((e && e.message) || "lagringsfeil") + ").";
          render();
        });
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

  /* ============================ section: Tilbud (onboarding C — offer authoring) ============================
   * The app PRESENTS; @onsite/core PRICES. «Beregn tilbud» maps the building + its drawn zones + the
   * befaring into the plain customer shape computeOffer expects, and the core engine (the one whose Holtet
   * kr 16 530 anchor is a node test) returns severable modules with subtotals, per-line driver math and
   * option lines held outside the recurring total. offers.data stores that shape verbatim; the app never
   * trusts stored totals — it re-derives them through core on every read and shows the match.
   *
   * VERSIONS: a recompute INSERTS the next version and leaves every earlier one intact — a version is never
   * overwritten in place (doc-82; offers has no deleted_at). Editing the draft you are authoring (module in
   * or out, a hand-set price) updates THAT version — it is the same offer, still being written. */
  function loadOffers(bid) {
    S.secBusy.offers = true; S.secErr.offers = null;
    prodDb.listOffers(bid).then(function (r) {
      S.secBusy.offers = false;
      if (r.error) { S.secErr.offers = friendly(r.error); } else { S.offers = mergeQueuedOffers(r.data || [], bid); snapshotBuilding(bid); }
      render();
    });
  }
  /* A draft that is queued but not yet drained must survive a server re-read — otherwise the rep's own
   * offer blinks out of the list until the drain lands. The op's payload is the newest truth we have for
   * that row, so it overlays the server's copy (and wears its «lagret på enheten» chip). */
  function mergeQueuedOffers(rows, bid) {
    var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
    (S.pendingOps || []).forEach(function (o) {
      if (o.entity !== "offers" || o.buildingId !== bid || !o.payload || !o.payload.id) return;
      var p = o.payload, cur = byId[p.id];
      if (!cur) { byId[p.id] = p; return; }
      for (var k in p) if (k !== "id") cur[k] = p[k];
    });
    return sortOffers(Object.keys(byId).map(function (k) { return byId[k]; }));
  }
  function sortOffers(rows) { return rows.slice().sort(function (a, b) { return (b.version || 0) - (a.version || 0); }); }
  function latestOffer() { var r = S.offers || []; return r.length ? r[0] : null; }
  function kr(n) { return "kr " + (Math.round(n) || 0).toLocaleString("no"); }
  function krRate(n) {   // a rate can be sub-krone (snø: 0,48 kr/m²/mnd) — kr() would round it to «kr 0» and the driver line would read as a lie
    if (n == null) return "—";
    var s = (Math.abs(n) < 10 && n % 1 !== 0) ? n.toFixed(2).replace(".", ",") : (Math.round(n) || 0).toLocaleString("no");
    return "kr " + s;
  }
  function fmtNum(n) { return (Math.round(n) || 0).toLocaleString("no"); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function coreDerive(data) {   // re-derive totals from the stored shape via core; null if core not loaded yet
    if (!coreReady() || !data || !data.modules) return null;
    try { var w = { offer: clone(data) }; window.OnSiteCore.rebuildOfferFlat(w); return w.offer; }
    catch (e) { return null; }
  }

  /* ---- DB rows → the customer shape computeOffer reads ---- */
  var CORE_LAYERS = {
    // The only marker layer /app materialises. Verbatim from the demo's LAYERS: recordOnly, rate 0 — an
    // entrance is a DRIVER (core's `entryways`), never a priced line of its own.
    entrance: { emoji: "🚪", cat: "drift", label: "Inngang / adkomst", measure: "count", unit: "dør", rate: 0, freq: "—", recordOnly: true }
  };
  var CAT_LABELS = { drift: "Eiendomsdrift", renhold: "Renhold", hage: "Hage & Gartner", vinter: "Vintertjenester",
    service: "Servicetjenester", handverk: "Håndverkertjenester", anlegg: "Utemiljø, Bygg & Anlegg" };
  function catLabel(k) { return CAT_LABELS[k] || ""; }
  // core calls nowStr() fresh per compute, so each version's createdAt is its own compute moment
  function nowStr() { try { return new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); } catch (e) { return "i dag"; } }
  function buildingToCustomer(b, prevOffer) {
    // core reads `entryways` from `entrance` markers. /app has no marker model (pass B ported zones, not
    // pins), so the befaring's `innganger` count MATERIALISES them — one typed number instead of N map taps.
    var n = clNum("innganger") || 0, markers = [];
    for (var i = 0; i < n; i++) markers.push({ id: "ent" + i, layer: "entrance", inScope: true });
    return {
      id: b.id, name: b.name, addr: b.addr || "", period: "mnd",
      floors: clNum("etasjer"),   // null → core's own default; captured → the honest trappevask line
      checklist: (S.checklist || []).map(function (it) {
        return { id: it.id, scope: it.scope, value: it.value, price: it.price || 0, subtype: it.subtype,
          label: it.label, oneOff: !!it.oneOff, emoji: it.emoji, category: it.category, compliance: !!it.compliance };
      }),
      // plain zone objects, not the app's row-backed ones: computeOffer writes priceLineId back onto whatever
      // it is handed, and app state is not core's to mutate
      zones: (S.zones || []).map(function (z) {
        return { id: z.id, service: z.service, method: z.method, area_m2: z.area_m2, length_m: z.length_m,
          geometry: z.geometry, label: z.label || "", priority: z.priority, constraint: z.constraint };
      }),
      markers: markers, addedLines: [], terms: null,
      offer: prevOffer || null   // withPrev: hand-edited finals + module choices carry across a recompute
    };
  }
  function computeOfferNow() {
    var b = buildingById(S.view.id), uid = userId();
    if (!b) return;
    flushPendingChecklist();   // the offer must never be priced from a tick the server has not been told about
    if (!coreReady()) { S.secErr.offers = "@onsite/core er ikke lastet ennå — vent et øyeblikk og prøv igjen."; render(); return; }
    if (!S.tenant || !S.tenant.id || !uid) { S.secErr.offers = "Mangler tenant/bruker (åpne appen på nett én gang først)."; render(); return; }
    if (!(S.checklist || []).some(function (it) { return it.scope === "in" || it.scope === "upsell"; })) {
      S.secErr.offers = "Ingen befaring ennå — tick av minst én linje (✅ eller ⬆) før du beregner."; render(); return;
    }
    var prev = latestOffer();
    var c = buildingToCustomer(b, prev && prev.data ? clone(prev.data) : null);
    var offer;
    try { offer = window.OnSiteCore.computeOffer(c, { nowStr: nowStr, LAYERS: CORE_LAYERS, catLabel: catLabel }); }
    catch (e) { S.secErr.offers = "Beregningen feilet: " + ((e && e.message) || e); render(); return; }
    if (!offer.modules.length && !offer.optionLines.length) {
      S.secErr.offers = "Ingen prisbærende linjer ennå — tegn soner (snø/gress) og fyll inn antall + priser i befaringen."; render(); return;
    }
    offer.version = prev ? (prev.version || 0) + 1 : 1;   // insert-new-version: the prior version stays untouched
    var row = { id: OFF.uuid(), tenant_id: S.tenant.id, building_id: b.id, version: offer.version,
      period: offer.period || "mnd", total_monthly: offer.totalMonthly, total_yearly: offer.totalYearly,
      status: "draft", cover_note: offer.coverNote || null, data: offer };
    S.offerBusy = true; S.secErr.offers = null; S.secMsg.offers = null; render();
    OFF.queueOp({ entity: "offers", op: "insert", payload: row, baseUpdatedAt: null,
      tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: "Tilbud v" + offer.version })
      .then(function () {
        S.offerBusy = false;
        S.offers = sortOffers((S.offers || []).concat([row]));
        S.secMsg.offers = "Tilbud v" + offer.version + " beregnet — " + kr(offer.totalMonthly) + "/mnd · lagret på enheten, synkes.";
        snapshotBuilding(b.id);
        refreshPending(function () { render(); });
        drainAll();
      })
      .catch(function (e) {   // C1: never a fake ✓
        S.offerBusy = false;
        S.secErr.offers = "⚠ Kunne IKKE lagre tilbudet på enheten (" + ((e && e.message) || "lagringsfeil") + ") — det er IKKE lagret.";
        render();
      });
  }
  /* An edit to the draft you are authoring — module in/out, a hand-set price — mutates THAT version's blob
   * and re-derives every total through core. Class-B, through the outbox: it works in a basement. */
  function offerEdit(rowId, mutate, msg) {
    var b = buildingById(S.view.id), uid = userId();
    var row = (S.offers || []).filter(function (x) { return x.id === rowId; })[0];
    if (!b || !row || !row.data) return;
    if (!coreReady()) { S.secErr.offers = "@onsite/core er ikke lastet — kan ikke beregne."; render(); return; }
    if (!S.tenant || !S.tenant.id || !uid) { S.secErr.offers = "Mangler tenant/bruker."; render(); return; }
    var data = clone(row.data);
    mutate(data);
    var w = { offer: data };
    window.OnSiteCore.rebuildOfferFlat(w);   // core re-derives line prices, module subtotals and the totals
    row.data = data; row.total_monthly = data.totalMonthly; row.total_yearly = data.totalYearly;
    S.secErr.offers = null;
    S.secMsg.offers = msg ? (msg + " · ny total " + kr(data.totalMonthly) + "/mnd") : null;
    snapshotBuilding(b.id);
    queueCoalesced({
      entity: "offers", id: row.id,
      fullRow: function () { var x = {}; for (var k in row) x[k] = row[k]; return x; },
      tenantId: S.tenant.id, buildingId: b.id, userId: uid, title: "Tilbud v" + row.version
    }).then(function () {
      refreshPending(function () { render(); });
      scheduleDrain(600);
    }).catch(function (e) {
      S.secErr.offers = "⚠ Kunne IKKE lagre endringen på enheten (" + ((e && e.message) || "lagringsfeil") + ").";
      render();
    });
  }
  function offerModToggle(el) {
    var svc = el.getAttribute("data-svc"), want = !!el.checked;
    var title = "";
    offerEdit(el.getAttribute("data-id"), function (data) {
      (data.modules || []).forEach(function (m) { if (m.service === svc) { m.included = want; title = m.title; } });
    }, want ? "Modul inkludert" : "Modul valgt bort — kan sies opp separat");
  }
  function offerLineFinal(el) {
    var lineId = el.getAttribute("data-line"), v = Math.round(parseFloat(el.value) || 0);
    offerEdit(el.getAttribute("data-id"), function (data) {
      (data.modules || []).forEach(function (m) {
        m.lines.forEach(function (l) {
          if (l.id !== lineId) return;
          l.final = v;
          // `overridden` is DERIVED, never sticky: typing the computed value back releases the line to the
          // engine again, so the next recompute is free to re-price it from the new measurements.
          l.overridden = (v !== l.computed);
          l.price = v;
        });
      });
    }, "Pris satt manuelt");
  }

  /* ---- the authoring view ---- */
  function offerLineHTML(o, l) {
    var driver = (l.qty != null && l.rate != null)
      ? fmtNum(l.qty) + ' ' + esc(l.unit || "") + ' × ' + krRate(l.rate) + '/' + esc(l.unit || "e") + '/mnd = ' + kr(l.computed)
      // the "no fabricated numbers" rule: an unpriced line says so — it never back-solves a rate it does not have
      : (l.computed > 0 ? 'fastpris (fra befaring) = ' + kr(l.computed) : '<span class="of-unpriced">ikke priset ennå — mangler sats/mengde</span>');
    var partner = l.deliveredBy === "partner" ? ' <span class="chip s">' + esc(l.partnerName || "partner") + ' · partner</span>' : '';
    var over = l.overridden ? '<span class="of-over">endret fra ' + kr(l.computed) + '</span>' : '';
    return '<div class="of-line">'
      + '<div class="of-lmain"><div class="of-llab">' + (l.emoji || "•") + ' ' + esc(l.label) + partner
      + (l.zoneId ? ' <span title="fra tegnet sone">🗺️</span>' : '') + (l.compliance ? ' <span class="chip warn">lovpålagt</span>' : '') + '</div>'
      + '<div class="of-ldrv">' + driver + '</div></div>'
      + '<div class="of-lprice"><input type="number" step="50" inputmode="numeric" data-offf="lineFinal" data-id="' + esc(o.id) + '" data-line="' + esc(l.id) + '" value="' + (l.final || 0) + '">'
      + '<span class="of-lper">/mnd</span>' + over + '</div></div>';
  }
  function offerModuleHTML(o, m) {
    var open = !!S.clOpen["m:" + m.service];
    var cadence = (function () { var seen = {}, out = []; m.lines.forEach(function (l) { if (l.cadence && !seen[l.cadence]) { seen[l.cadence] = 1; out.push(l.cadence); } }); return out.slice(0, 2).join(" · ") || "løpende"; })();
    return '<div class="of-mod' + (m.included ? '' : ' off') + '">'
      + '<div class="of-mhead">'
      + '<button class="of-mtoggle" data-act="offerModExpand" data-id="' + esc(m.service) + '"><span class="of-mchev">' + (open ? '▾' : '▸') + '</span> <b>' + esc(m.title || m.service) + '</b></button>'
      + '<div class="of-mright">'
      + (m.included ? '<span class="of-msub">' + kr(m.subtotal) + '/mnd</span>' : '<span class="chip q">ikke valgt · kan sies opp separat</span>')
      + '<label class="of-mincl"><input type="checkbox" data-act="offerModToggle" data-id="' + esc(o.id) + '" data-svc="' + esc(m.service) + '"' + (m.included ? ' checked' : '') + (coreReady() ? '' : ' disabled') + '> med</label>'
      + '</div></div>'
      + '<div class="of-mmeta">' + esc(cadence) + ' · oppstart ' + esc(m.startDate || "—") + ' · KPI ' + (m.indexationPct != null ? m.indexationPct : 2.5) + '% (maks ' + (m.cap != null ? m.cap : 3) + '%)</div>'
      + (open ? '<div class="of-mlines">' + m.lines.map(function (l) { return offerLineHTML(o, l); }).join("") + '</div>' : '')
      + '</div>';
  }
  function offerOptionsHTML(o, data) {
    var ol = (data.optionLines || []); if (!ol.length) return "";
    return '<div class="of-opts"><div class="ct" style="margin-bottom:6px">Opsjoner / per gang <span class="muted" style="font-weight:600">· utenfor grunnbeløpet</span></div>'
      + ol.map(function (l) {
        var amt = (l.role === "hedge" || l.role === "bed") ? kr(l.final) + '/år' : (l.oneOff ? kr(l.final) + ' eng.' : kr(l.final) + '/mnd');
        var drv = (l.qty != null && l.rate != null) ? ' <span class="muted" style="font-size:11.5px">· ' + fmtNum(l.qty) + ' ' + esc(l.unit || "") + ' × ' + krRate(l.rate) + '</span>' : '';
        return '<div class="of-opt"><span>⬆ ' + (l.emoji || "") + ' ' + esc(l.label) + drv + (l.zoneId ? ' 🗺️' : '') + '</span><b>' + amt + '</b></div>';
      }).join("") + '</div>';
  }
  function sectionOffersHTML(b) {
    var canCompute = offerComputable();
    var computeBar = '<div class="bar"><button class="btn" id="of-compute" data-act="offerCompute"' + (S.offerBusy || !canCompute ? ' disabled' : '') + '>'
      + (S.offerBusy ? '<span class="spin"></span>Beregner…' : '🧮 Beregn tilbud fra soner + befaring →') + '</button>'
      + (latestOffer() ? '<button class="btn ghost" data-act="offerPrint">🖨 Tilbud til styret</button>' : '')
      + '</div>'
      + '<div class="note" id="of-hint" style="margin-top:6px' + (canCompute ? ';display:none' : '') + '">Tick av befaringen (✅/⬆) — så priser @onsite/core bygget fra de målte sonene og de talte enhetene.</div>';

    var body;
    if (S.secBusy.offers && S.offers == null) body = '<div class="empty"><span class="spin"></span>Henter tilbud…</div>';
    else if (!S.offers || !S.offers.length) body = '<div class="empty">Ingen tilbud ennå — beregn det første fra befaringen.</div>';
    else {
      var o = latestOffer(), data = o.data || {};
      var derived = coreDerive(data) || data;
      var pend = pendingOpByRecord("offers")[o.id];
      var verify = coreDerive(data)
        ? (Math.round(derived.totalMonthly) === Math.round(o.total_monthly || 0)
          ? '<div class="msg ok">✓ Totaler verifisert av @onsite/core (' + kr(derived.totalMonthly) + '/mnd)</div>'
          : '<div class="msg err">⚠ Avvik: lagret ' + kr(o.total_monthly) + ' vs core ' + kr(derived.totalMonthly) + '</div>')
        : '<div class="note">@onsite/core laster — totaler vises fra lagret verdi inntil verifisert…</div>';
      var hist = (S.offers.length > 1)
        ? '<div class="note" style="margin-top:8px">Tidligere versjoner beholdt: ' + S.offers.slice(1).map(function (x) { return 'v' + x.version + ' (' + kr(x.total_monthly) + ')'; }).join(' · ') + '</div>'
        : '';
      body = '<div class="of-head"><span class="of-big">' + kr(derived.totalMonthly) + ' <span class="of-unit">/mnd</span>'
        + ' <span class="of-yr">· ' + kr(derived.totalYearly) + ' /år</span></span>'
        + '<span class="chip q">v' + o.version + ' · ' + esc(o.status || "draft") + '</span>' + opChip(pend) + '</div>'
        + '<div class="note" style="margin-top:-2px">Alt de betaler for — synlig. Åpne en modul for driver-matematikken; hver modul kan velges bort separat.</div>'
        + verify
        + (derived.modules || []).map(function (m) { return offerModuleHTML(o, m); }).join("")
        + offerOptionsHTML(o, derived)
        + (o.cover_note ? '<div class="note" style="margin-top:8px">' + esc(o.cover_note) + '</div>' : '')
        + hist;
    }
    return '<div class="card"><div class="ct">💰 Tilbud <span class="muted" style="font-weight:600">· priset av @onsite/core · offers (RLS: kun din tenant)</span></div>'
      + (S.secMsg.offers ? '<div class="msg ok">' + esc(S.secMsg.offers) + '</div>' : '')
      + (S.secErr.offers ? '<div class="msg err">' + esc(S.secErr.offers) + '</div>' : '')
      + body + computeBar + '</div>';
  }

  /* ============================ artifacts (onboarding C — the board leave-behind) ============================
   * The doc-50 one-pager, generated from the LIVE offer, with the operational maps drawn from the zones.
   * Print is VISIBILITY-isolated, not display-isolated: display:none on the siblings is simpler but
   * collapses the Leaflet containers to 0×0, and the maps print blank. visibility:hidden keeps every layout
   * box, so the maps survive onto paper. (Same trick, and the same reason, as the demo's four print paths.) */
  var opMaps = {};
  function destroyOpMaps() { Object.keys(opMaps).forEach(function (k) { try { opMaps[k].remove(); } catch (e) {} delete opMaps[k]; }); }
  function opZones(kind) {
    return (S.zones || []).filter(kind === "snow"
      ? function (z) { return z.service === "snow"; }
      : function (z) { return z.service === "grass" || z.service === "greenery"; });
  }
  function opLegendHTML(kind) {
    var items = kind === "snow"
      ? [["#1d4ed8", "Maskin"], ["#eab308", "Hånd"], ["#b3261e", "No-go"]]
      : [["#22c55e", "Klipping"], ["#0f766e", "Kantklipp"], ["#f59e0b", "Bed / hekk"], ["#b3261e", "No-go / ømtålig"]];
    return '<div class="pd-legend">' + items.map(function (it) {
      return '<span class="pd-lg"><span class="pd-sw" style="background:' + it[0] + '"></span>' + esc(it[1]) + '</span>';
    }).join("") + '</div>';
  }
  function buildOpMap(b, kind, elId) {
    var el = document.getElementById(elId);
    if (!el || !window.L || b.lat == null || b.lon == null) return;
    if (opMaps[elId]) { try { opMaps[elId].remove(); } catch (e) {} delete opMaps[elId]; }
    var m;
    try { m = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false }); } catch (e) { return; }
    opMaps[elId] = m;
    L.tileLayer(KARTVERKET, { attribution: "© Kartverket", maxZoom: 20, maxNativeZoom: 18 }).addTo(m);
    var grp = L.featureGroup().addTo(m);
    opZones(kind).forEach(function (z) {
      if (!z.geometry) return;
      var lyr = null;
      if (z.geometry.type === "Polygon") lyr = L.polygon(ringLL(z.geometry.coordinates[0]), zoneStyle(z));
      else if (z.geometry.type === "LineString") lyr = L.polyline(ringLL(z.geometry.coordinates), zoneStyle(z));
      if (!lyr) return;
      lyr.bindTooltip(zoneTip(z), { permanent: true, direction: "center", className: "pd-ztip" });
      lyr.addTo(grp);
      if (kind === "snow" && z.geometry.type === "Polygon" && z.priority) {
        L.marker(centroidLL(ringLL(z.geometry.coordinates[0])), { interactive: false,
          icon: L.divIcon({ className: "", html: '<div class="ob-zprio">' + z.priority + '</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(grp);
      }
    });
    try { if (grp.getLayers().length) m.fitBounds(grp.getBounds().pad(0.35)); else m.setView([b.lat, b.lon], 17); }
    catch (e) { m.setView([b.lat, b.lon], 17); }
    setTimeout(function () { if (opMaps[elId]) opMaps[elId].invalidateSize(); }, 90);
  }
  function moduleCovers(m) {
    var seen = {}, out = [];
    (m.lines || []).forEach(function (l) { var t = (l.label || "").split(" (")[0]; if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out.slice(0, 4).join(", ");
  }
  function moduleCadence(m) {
    var seen = {}, out = [];
    (m.lines || []).forEach(function (l) { if (l.cadence && !seen[l.cadence]) { seen[l.cadence] = 1; out.push(l.cadence); } });
    return out.slice(0, 2).join(" · ") || "løpende";
  }
  function boardDocHTML(b, o, d) {
    var incl = (d.modules || []).filter(function (m) { return m.included; });
    var rows = incl.map(function (m) {
      return '<tr><td><b>' + esc(m.title) + '</b></td><td>' + esc(moduleCovers(m)) + '</td><td>' + esc(moduleCadence(m))
        + '</td><td class="pd-num">' + kr(m.subtotal) + '</td></tr>';
    }).join("");
    var opts = (d.optionLines || []).map(function (l) {
      var amt = (l.role === "hedge" || l.role === "bed") ? kr(l.final) + '/år' : (l.oneOff ? kr(l.final) + ' engangs' : kr(l.final) + '/mnd');
      return '<li>' + esc(l.label) + ' — <b>' + amt + '</b></li>';
    }).join("");
    var snowN = opZones("snow").length, grassN = opZones("grass").length;
    var maps = (snowN || grassN)
      ? '<h2>Operasjonskart</h2><div class="pd-maps">'
        + (snowN ? '<div class="pd-mapcard"><div class="pd-mt">❄️ Vinter</div><div class="pd-map" id="pd-map-snow"></div>' + opLegendHTML("snow") + '</div>' : '')
        + (grassN ? '<div class="pd-mapcard"><div class="pd-mt">🌿 Grønt</div><div class="pd-map" id="pd-map-grass"></div>' + opLegendHTML("grass") + '</div>' : '')
        + '</div>'
      : '';
    var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr + '/' + b.bnr : '')].filter(Boolean).join(' · ');
    return '<div class="pd-bar"><button class="btn ghost" data-pact="close">✕ Lukk</button>'
      + '<div class="pd-bartitle">Tilbud til styret</div>'
      + '<button class="btn" data-pact="print">🖨 Skriv ut / PDF</button></div>'
      + '<div class="pd-scroll"><div class="pd-doc">'
      + '<h1>Tilbud om eiendomsservice — ' + esc(b.name) + '</h1>'
      + '<div class="pd-meta">' + esc(meta) + (S.tenant && S.tenant.name ? ' · Levert av ' + esc(S.tenant.name) : '')
      + ' · tilbud v' + o.version + ' · ' + esc(o.status || "draft") + '</div>'
      + '<h2>Tjenester og pris <span class="pd-vat">alle priser eks. mva</span></h2>'
      + '<table class="pd-tab"><thead><tr><th>Modul</th><th>Hva det dekker</th><th>Frekvens</th><th class="pd-num">Pris/mnd</th></tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '<tfoot><tr><td colspan="3"><b>Sum fast</b></td><td class="pd-num"><b>' + kr(d.totalMonthly) + '</b></td></tr></tfoot></table>'
      + '<div class="pd-sever">Hver modul er en <b>egen avtale</b> — én tjeneste kan sies opp uten at resten faller. '
      + 'Prisen er regnet ut fra byggets <b>målte arealer og talte enheter</b>, ikke en rundsum.</div>'
      + (opts ? '<h2>Opsjoner <span class="pd-vat">utenfor grunnbeløpet</span></h2><ul class="pd-opts">' + opts + '</ul>' : '')
      + maps
      + '<h2>Slik vet dere at jobben er gjort</h2>'
      + '<p>Hver utført jobb dokumenteres på stedet — tid, sted og bilde. Styret ser dokumentasjonen, ikke bare fakturaen.</p>'
      + '</div></div>';
  }
  function showBoardDoc() {
    var b = buildingById(S.view.id), o = latestOffer();
    if (!b || !o) return;
    var host = document.getElementById("printdoc"); if (!host) return;
    host.innerHTML = boardDocHTML(b, o, coreDerive(o.data) || o.data || {});
    host.classList.add("on");
    buildOpMap(b, "snow", "pd-map-snow");
    buildOpMap(b, "grass", "pd-map-grass");
  }
  function closeBoardDoc() {
    var host = document.getElementById("printdoc"); if (!host) return;
    destroyOpMaps();
    host.classList.remove("on"); host.innerHTML = "";
  }
  function printBoardDoc() {
    // the containers' boxes just changed under the print styles — Leaflet must re-read them, then the tiles
    // need a beat to land before the snapshot. The delay is the fragile part; keep it.
    Object.keys(opMaps).forEach(function (k) { try { opMaps[k].invalidateSize(); } catch (e) {} });
    document.body.classList.add("printing");
    var cleanup = function () { document.body.classList.remove("printing"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(function () { window.print(); }, 220);
  }
  // the leave-behind lives OUTSIDE #app (render() rewrites that wholesale), so it needs its own delegate
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-pact]"); if (!t) return;
    if (t.getAttribute("data-pact") === "close") closeBoardDoc(); else printBoardDoc();
  });

  /* ============================ building detail (1c-2 item 0) ============================
   * The container for the per-table sections: Kart · Befaring · Eiendeler · Kontakter · Arbeid · Tilbud. */
  function renderBuilding(b) {
    var email = userEmail();
    if (!S.checklist) S.checklist = checklistFor(b);   // the row's saved items merged over a fresh template
    var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
    var synk = S.snapTs ? ' · sist synket ' + timeHM(S.snapTs) : (S.offline ? ' · frakoblet — viser lagret kopi' : '');
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + '</span>' : '')
      + '<span id="hdr-chips">' + headerChipsHTML() + '</span>'
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="bhead"><button class="btn ghost" data-act="back" style="padding:9px 13px">← Bygg</button>'
      + '<div><h1>🏢 ' + esc(b.name) + '</h1><div class="note">' + esc(meta) + esc(synk) + '</div></div></div>'
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + sectionKartHTML(b)
      + sectionBefaringHTML(b)
      + sectionAssetsHTML(b)
      + sectionContactsHTML(b)
      + sectionProofHTML(b)
      + sectionOffersHTML(b);
    mountKartMap(b);   // (re)attach Leaflet into the fresh #kart-map node after innerHTML is set
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
    // onboarding B: zones — draw controls do DIRECT map/DOM updates (no render, map stays stable)
    zoneDraw: function (el) { startDraw(el.getAttribute("data-arg")); },
    zoneDrawCancel: function () { cancelDraw(); },
    zoneDrawFinish: function () { finishDraw(); },
    zoneEdit: function (el) { var z = (S.zones || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0]; if (z) openZoneSheet(z, z.geometry); },
    zoneCancel: function () { discardProofDraft(); S.editZone = null; render(); },
    zoneSave: zoneSave,
    zoneDel: function (el) { zoneDelete(el.getAttribute("data-id")); },
    zonePhotoRemove: function () { var p = S.zonePhoto; S.zonePhoto = null; if (p) OFF.delPhoto(p.path).then(function () { render(); }); else render(); },
    // small pass: add-to-home-screen (doc 81)
    a2hsInstall: function () { var e = S.installEvt; S.installEvt = null; render(); if (e && e.prompt) e.prompt(); },
    a2hsDismiss: function () { try { localStorage.setItem(A2HS_KEY, "1"); } catch (e) {} render(); },
    // item 2: proof
    proofSave: proofSave,
    proofPhotoRemove: function () {
      var p = S.proofPhoto; S.proofPhoto = null;
      if (p) OFF.delPhoto(p.path).then(function () { render(); }); else render();
    },
    // onboarding C: befaring (the walkaround checklist) — every handler refreshes SURGICALLY, never render()
    clZone: function (el) { var n = el.getAttribute("data-id"); S.clOpen[n] = !S.clOpen[n]; refreshBefaring(); },
    clScope: function (el) {
      var b = buildingById(S.view.id), it = clItem(el.getAttribute("data-id"));
      if (!b || !it) return;
      it.scope = el.getAttribute("data-arg");
      S.secMsg.checklist = null;
      refreshBefaring();           // the row restyles and the kr box appears/disappears with the scope
      saveChecklist(b, true);      // queued NOW (durable); the drain waits for the burst to end
    },
    clPhotoDel: function (el) {
      var b = buildingById(S.view.id), it = clItem(el.getAttribute("data-id"));
      if (!b || !it) return;
      var path = el.getAttribute("data-arg");
      it.photoIds = (it.photoIds || []).filter(function (p) { return p !== path; });
      refreshBefaring(); saveChecklist(b, true);
    },
    // onboarding C: offer authoring
    offerCompute: computeOfferNow,
    offerModExpand: function (el) { var k = "m:" + el.getAttribute("data-id"); S.clOpen[k] = !S.clOpen[k]; render(); },
    offerModToggle: offerModToggle,
    offerPrint: showBoardDoc
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
    if (e.target && e.target.id === "z_photo") attachZonePhoto(e.target);      // onboarding B: zone photo, same draft pipeline
    if (e.target && e.target.getAttribute && e.target.getAttribute("data-zsvc")) {   // service change → method options change
      if (S.editZone) { S.editZone.service = e.target.value; S.editZone.method = zoneDefaultMethod(e.target.value); render(); }
    }
    var t = e.target; if (!t || !t.getAttribute) return;
    if (t.getAttribute("data-clphoto")) { clPhotoAttach(t); return; }          // onboarding C: befaring photo
    var clf = t.getAttribute("data-clf");
    if (clf === "bool" || clf === "oneoff") {
      var b = buildingById(S.view.id), it = clItem(t.getAttribute("data-id"));
      if (b && it) { if (clf === "bool") it.value = t.checked; else it.oneOff = t.checked; refreshBefaring(); saveChecklist(b, true); }
      return;
    }
    // the hand-set price commits on change (blur/Enter), not per keystroke — one op per real edit
    if (t.getAttribute("data-offf") === "lineFinal") { offerLineFinal(t); return; }
  });
  // findings #1 (same wipe class): typed proof text survives background renders via a live state mirror
  app.addEventListener("input", function (e) {
    var id = e.target && e.target.id;
    if (id === "pf_title" || id === "pf_note") {
      S.proofDraft = S.proofDraft || {};
      S.proofDraft[id === "pf_title" ? "title" : "note"] = e.target.value;
    }
    // befaring capture (antall / m² / kr / notat): mutate state + debounce the class-B write. NEVER render()
    // here — the wholesale innerHTML rebuild would blow away the field being typed into (findings #1's class).
    // Only the total is patched surgically; the scope chips re-render on the next scope tap.
    var t = e.target, clf = t && t.getAttribute && t.getAttribute("data-clf");
    if (clf === "value" || clf === "price" || clf === "notes") {
      var b = buildingById(S.view.id), it = clItem(t.getAttribute("data-id"));
      if (!b || !it) return;
      if (clf === "price") it.price = Math.round(parseFloat(t.value) || 0);
      else if (clf === "notes") it.notes = t.value;
      else it.value = t.value;
      var tot = document.getElementById("cl-total"); if (tot) tot.textContent = kr(walkTotal());
      saveChecklist(b);
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

  /* @onsite/core arrives as a DEFERRED module (boot.mjs), so it can land after app.js's first paint. Anything
   * gated on coreReady() — the Beregn-tilbud button, the totals verification — would then sit disabled until
   * some unrelated state change happened to re-render. Re-render once, the moment core is actually here. */
  (function awaitCore() {
    if (coreReady()) return;
    var tries = 0;
    var t = setInterval(function () {
      if (coreReady()) { clearInterval(t); render(); }
      else if (++tries > 100) clearInterval(t);   // 10 s: core is a static same-origin bundle — if it is not
    }, 100);                                      // here by now it is not coming, and the UI stays honest about it
  })();

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
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") drainAll();
    else flushPendingChecklist();   // backgrounded mid-befaring: the in-flight tick becomes durable NOW
  });
  window.addEventListener("pagehide", flushPendingChecklist);

  render(); // immediate paint (login screen / cached shell) while getSession resolves
})();
