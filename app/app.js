/* OnSite PRODUCTION app — slice 1c + gate pass (doc 78/79, review-2). Talks to onsite-prod (real
 * multi-tenant backend). Magic-link auth + tenant-isolated buildings. Everything goes through the
 * authenticated client; RLS scopes reads/writes to the user's tenant. NO service_role in the client.
 * Lives in app/ and deploys as its OWN Vercel project on its OWN ORIGIN (review-2 T1-1) so the prod
 * session token never shares an origin with the demo's innerHTML surface. Demo: onsite-site.vercel.app. */
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
    // offline v1 (doc-80): offline identity + read-cache stamps + pending (outbox) state + SW update hint
    offlineIdent: null, offline: !navigator.onLine, snapTs: null, listTs: null,
    pending: { total: 0, ops: 0, photos: 0, rejected: 0 }, pendingOps: [], pendingPhotos: [], updateReg: null };

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
    listBuildings: function () { return sb.from("buildings").select("*").is("deleted_at", null).order("name", { ascending: true }); },   // v1: tombstones filtered in every pull (doc-80 §3)
    createBuilding: function (tenantId, b) { return sb.from("buildings").insert(coreToRow(tenantId, b)).select().single(); },
    updateBuilding: function (id, b) { return sb.from("buildings").update(coreToRow(null, b)).eq("id", id).select().single(); },
    // 1c-2 item 1: assets — RLS scopes to the tenant; tenant_id set from the resolved membership on insert
    // 1c-2 item 2: completion proof + the private photos bucket (path MUST start with tenant_id — storage RLS)
    listProof: function (bid) { return sb.from("completion_proof").select("*").eq("building_id", bid).order("ts", { ascending: false }); },
    createProof: function (tenantId, bid, p) { p.tenant_id = tenantId; p.building_id = bid; return sb.from("completion_proof").insert(p).select().single(); },
    uploadPhoto: function (path, blob) { return sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false }); },
    removePhoto: function (path) { return sb.storage.from("photos").remove([path]); },
    signPhoto: function (path) { return sb.storage.from("photos").createSignedUrl(path, 3600); },
    // 1c-2 item 3: offers — data jsonb carries the core modules/lines shape; totals re-derived by @onsite/core
    listOffers: function (bid) { return sb.from("offers").select("*").eq("building_id", bid).order("version", { ascending: false }); },
    updateOffer: function (id, patch) { return sb.from("offers").update(patch).eq("id", id).select().single(); },
    listAssets: function (bid) { return sb.from("assets").select("*").eq("building_id", bid).is("deleted_at", null).order("created_at", { ascending: true }); },
    createAsset: function (tenantId, bid, a) { var r = assetToRow(a); r.tenant_id = tenantId; r.building_id = bid; return sb.from("assets").insert(r).select().single(); },
    updateAsset: function (id, a) { return sb.from("assets").update(assetToRow(a)).eq("id", id).select().single(); },
    deleteAsset: function (id) { return sb.from("assets").delete().eq("id", id); }
  };

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
        else { S.msg = "📧 Vi sendte en innloggingslenke til " + email + ". Åpne den på denne enheten."; }
        render();
      });
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
      S.tenant = null; S.buildings = null; S.msg = null; S.error = null; S.noAccess = false; render();
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
        return prodDb.listBuildings();
      }).then(function (br) {
        if (br.error) throw br.error;
        S.buildings = (br.data || []).map(rowToCore); S.listTs = Date.now();
        OFF.cachePut(uid, "buildings", br.data || []);
        S.loading = false; render();
      });
    }).catch(function (e) { S.loading = false; S.error = friendly(e); render(); });
  }
  function snapshotBuilding(bid) {   // write the per-building snapshot after any section refresh
    var uid = userId(); if (!uid) return;
    OFF.cachePut(uid, "b:" + bid, { assets: S.assets, proof: S.proof, offers: S.offers });
    S.snapTs = Date.now();
  }

  function addBuilding() {
    var b = { name: val("nb_name"), addr: val("nb_addr"), gnr: val("nb_gnr"), bnr: val("nb_bnr") };
    if (!b.name) { S.error = "Bygg-navn må fylles ut."; S.msg = null; render(); return; }
    if (!S.tenant || !S.tenant.id) { S.error = "Mangler tenant."; render(); return; }
    S.loading = true; S.error = null; S.msg = null; render();
    prodDb.createBuilding(S.tenant.id, b).then(function (r) {
      S.loading = false;
      if (r.error) { S.error = friendly(r.error); render(); return; }
      S.buildings.push(rowToCore(r.data));
      S.buildings.sort(function (x, y) { return (x.name || "") < (y.name || "") ? -1 : 1; });
      S.msg = "✅ Lagret i onsite-prod: " + r.data.name;
      render();
    });
  }
  function friendly(e) { var m = (e && e.message) || String(e); if (/JWT|not authenticated|session missing|401/i.test(m)) return "Økten er utløpt — logg inn på nytt (arbeidet ble IKKE lagret)."; return m; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  /* ============================ render ============================ */
  function buildingById(id) { return (S.buildings || []).filter(function (b) { return b.id === id; })[0] || null; }
  function openBuilding(id) {
    S.view = { name: "building", id: id };
    S.assets = null; S.proof = null; S.offers = null; S.editAsset = null; S.secErr = {}; S.secMsg = {}; S.msg = null; S.error = null; S.snapTs = null;
    render();
    loadBuildingSections(id);   // cache-first paint, then background refresh; each section surfaces its own errors (C1)
  }
  function closeBuilding() { S.view = { name: "list" }; S.editAsset = null; S.msg = null; S.error = null; render(); }
  function loadBuildingSections(id) {
    var uid = userId();
    var start = function () { refreshPending(); if (!S.session || !navigator.onLine) { render(); return; } loadAssets(id); loadProof(id); loadOffers(id); };
    if (!uid) { start(); return; }
    OFF.cacheGet(uid, "b:" + id).then(function (snap) {
      if (snap && snap.v) { S.assets = snap.v.assets; S.proof = snap.v.proof; S.offers = snap.v.offers; S.snapTs = snap.ts; render(); }
      start();
    }).catch(start);
  }

  /* ---------- offline plumbing: pending state + drain (doc-80 §2/§6) ---------- */
  function refreshPending(cb) {
    var uid = userId(); if (!uid) { S.pending = { total: 0, ops: 0, photos: 0, rejected: 0 }; S.pendingOps = []; S.pendingPhotos = []; if (cb) cb(); return; }
    Promise.all([OFF.countPending(uid), OFF.listOps(uid), OFF.listPhotos(uid)]).then(function (r) {
      S.pending = r[0]; S.pendingOps = r[1]; S.pendingPhotos = r[2];
      if (cb) cb();
    }).catch(function () { if (cb) cb(); });
  }
  function drainAll() {
    var uid = userId();
    if (!uid || !S.session || !navigator.onLine) return;   // draining needs a live token; the offline identity only queues
    OFF.drain(sb, uid, function () { refreshPending(function () { render(); }); }).then(function (changed) {
      refreshPending(function () {
        render();
        if (changed && S.view.name === "building") loadProof(S.view.id);   // acked ops → pull the server rows into timeline/cache
      });
    });
  }
  function headerChipsHTML() {
    var out = "";
    if (S.offline) out += ' <span class="chip q">frakoblet</span>';   // a NORMAL state — neutral, no red panic (doc 62)
    if (S.pending.total > 0) out += ' <button class="chip pendbtn" data-act="openOutbox">● ' + S.pending.total + ' usendte</button>';
    if (S.updateReg) out += ' <button class="chip s pendbtn" data-act="applyUpdate">ny versjon — last på nytt</button>';
    return out;
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
    var prows = (S.pendingPhotos || []).filter(function (p) { return p.status !== "uploaded"; }).map(function (p) {
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
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span></div></div>'
      + '<div class="card"><div class="ct">Logg inn</div>'
      + '<p class="note" style="margin-top:-2px">Produksjonsappen mot <b>onsite-prod</b>. Ingen passord — vi sender en engangslenke til e-posten din (magic link).</p>'
      + '<label>E-post</label><input id="li_email" type="email" inputmode="email" autocomplete="email" placeholder="deg@firma.no" value="' + esc(lastEmail()) + '">'
      + (S.msg ? '<div class="msg ok">' + esc(S.msg) + '</div>' : '')
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + '<div class="bar"><button class="btn" data-act="login"' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? '<span class="spin"></span>Sender…' : 'Send innloggingslenke →') + '</button></div>'
      + '</div>'
      + '<p class="note">Demoen (Ren Dunk) ligger uendret på <a href="https://onsite-site.vercel.app">onsite-site.vercel.app</a>. Denne appen kjører på sitt eget domene (origin-isolert fra demoen) og snakker med den ekte, tenant-isolerte backenden.</p>';
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
      list = S.buildings.map(function (b) {
        var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
        return '<button class="bldg click" data-act="openBuilding" data-id="' + esc(b.id) + '"><span><span class="t">🏢 ' + esc(b.name) + '</span>' + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + '</span><span class="chev">›</span></button>';
      }).join("");
    }

    var buildingsCard =
      '<div class="card"><div class="ct">Bygg <span class="muted" style="font-weight:600">· ' + (S.buildings ? S.buildings.length : '…') + ' · fra onsite-prod (RLS: kun din tenant)</span></div>'
      + (S.msg ? '<div class="msg ok">' + esc(S.msg) + '</div>' : '')
      + (S.error ? '<div class="msg err">' + esc(S.error) + '</div>' : '')
      + list + '</div>';

    var addCard =
      '<div class="card"><div class="ct">＋ Legg til bygg</div>'
      + '<label>Navn *</label><input id="nb_name" placeholder="f.eks. Sameiet Solsiden">'
      + '<label>Adresse</label><input id="nb_addr" placeholder="Gate 1, 0123 Oslo">'
      + '<div class="row2"><div style="flex:1"><label>gnr</label><input id="nb_gnr"></div><div style="flex:1"><label>bnr</label><input id="nb_bnr"></div></div>'
      + '<div class="bar"><button class="btn" data-act="addBuilding"' + (S.loading ? ' disabled' : '') + '>' + (S.loading ? '<span class="spin"></span>Lagrer…' : 'Lagre i onsite-prod →') + '</button></div>'
      + '<p class="note" style="margin-bottom:0">tenant_id settes fra din membership; RLS <code>with check</code> håndhever at det er din tenant.</p>'
      + '</div>';

    var coreCard = '<p class="note">@onsite/core: ' + (coreReady() ? (Object.keys(window.OnSiteCore).length + ' motorer lastet — DB-rader mappes til samme plain-JS-form demoen bruker (rowToCore/coreToRow).') : 'laster…') + '</p>';

    app.innerHTML = head + buildingsCard + addCard + coreCard;
  }
  /* ============================ section: Eiendeler (1c-2 item 1 — assets) ============================ */
  function loadAssets(bid) {
    S.secBusy.assets = true; S.secErr.assets = null;
    prodDb.listAssets(bid).then(function (r) {
      S.secBusy.assets = false;
      if (r.error) { S.secErr.assets = friendly(r.error); } else { S.assets = (r.data || []).map(assetRowToCore); snapshotBuilding(bid); }
      render();
    });
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
    else body = S.assets.map(function (a) {
      var d = assetTypeDef(a.type), bin = a.bin || {};
      var meta = [a.area, bin.fraction, bin.binType, bin.capacity, bin.supplier, a.access].filter(Boolean).join(' · ');
      return '<div class="bldg"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><span class="t">' + d.emoji + ' ' + esc(a.label || d.label) + '</span>'
        + (meta ? '<span class="d">' + esc(meta) + '</span>' : '') + (a.notes ? '<span class="d">' + esc(a.notes) + '</span>' : '') + '</span>'
        + '<span style="display:flex;gap:6px;flex-shrink:0"><button class="btn ghost" style="padding:7px 10px" data-act="assetEdit" data-id="' + esc(a.id) + '">✎</button>'
        + '<button class="btn ghost" style="padding:7px 10px" data-act="assetDel" data-id="' + esc(a.id) + '">🗑</button></span></div></div>';
    }).join("");
    return '<div class="card"><div class="ct">🧰 Eiendeler <span class="muted" style="font-weight:600">· ' + (S.assets ? S.assets.length : '…') + ' · assets (RLS: kun din tenant)</span></div>'
      + (S.secMsg.assets ? '<div class="msg ok">' + esc(S.secMsg.assets) + '</div>' : '')
      + (S.secErr.assets ? '<div class="msg err">' + esc(S.secErr.assets) + '</div>' : '')
      + body
      + (S.editAsset ? assetFormHTML(S.editAsset) : '<div class="bar"><button class="btn ghost" data-act="assetNew">＋ Legg til eiendel</button></div>')
      + '</div>';
  }
  function assetSave() {
    syncAssetForm();
    var a = S.editAsset, b = buildingById(S.view.id); if (!a || !b) return;
    if (!S.tenant || !S.tenant.id) { S.secErr.assets = "Mangler tenant."; render(); return; }
    S.secBusy.assets = true; S.secErr.assets = null; S.secMsg.assets = null; render();
    var q = a.id ? prodDb.updateAsset(a.id, a) : prodDb.createAsset(S.tenant.id, b.id, a);
    q.then(function (r) {
      S.secBusy.assets = false;
      if (r.error) { S.secErr.assets = friendly(r.error); render(); return; }   // C1: nothing fakes success
      S.secMsg.assets = "✅ Lagret i onsite-prod: " + (r.data.label || "eiendel");
      S.editAsset = null;
      loadAssets(b.id);   // re-read from the DB — the list shows what actually persisted
    });
  }
  function assetDelete(id) {
    var a = (S.assets || []).filter(function (x) { return x.id === id; })[0];
    if (!a || !window.confirm("Slette «" + (a.label || "eiendel") + "»?")) return;
    S.secBusy.assets = true; S.secErr.assets = null; render();
    prodDb.deleteAsset(id).then(function (r) {
      S.secBusy.assets = false;
      if (r.error) { S.secErr.assets = friendly(r.error); render(); return; }
      S.secMsg.assets = "Slettet."; loadAssets(S.view.id);
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
    var m = {}; (S.pendingPhotos || []).forEach(function (p) { if (p.status !== "uploaded") m[p.path] = p; }); return m;
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
      + '<label>Bilde (valgfritt — komprimeres til ≤1280px)</label><input type="file" id="pf_photo" accept="image/*">'
      + (d.photoLost ? '<div class="msg err">Velg bildet på nytt (skjemaet ble gjenopprettet etter feil).</div>' : '')
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
    // read EVERYTHING from the live DOM first — a re-render clears the file input
    var title = val("pf_title") || "Utført arbeid", note = val("pf_note"), assetId = val("pf_asset");
    var fileEl = document.getElementById("pf_photo"), file = fileEl && fileEl.files && fileEl.files[0];
    var asset = (S.assets || []).filter(function (a) { return a.id === assetId; })[0] || null;
    S.secBusy.proof = true; S.secErr.proof = null; S.secMsg.proof = null; S.proofDraft = null; render();
    function fail(msg) { S.secBusy.proof = false; S.secErr.proof = msg; S.proofDraft = { title: title, note: note, photoLost: !!file }; render(); }
    function queueIt(photoDataUrl) {
      var rowId = OFF.uuid();
      var photoPath = photoDataUrl ? (tenantId + "/" + b.id + "/" + OFF.uuid() + ".jpg") : null;   // fixed idempotent path (doc-80 §4)
      var payload = { id: rowId, tenant_id: tenantId, building_id: b.id, title: title, note: note || null,
        by_name: userEmail() || "innlogget", service: "prod-app",
        extra: asset ? { asset_id: asset.id, asset_label: asset.label || assetTypeDef(asset.type).label } : null,
        photo_ids: photoPath ? [photoPath] : null,
        captured_at: new Date().toISOString() };   // device time, honest label; server created_at is server-truth
      var op = { entity: "completion_proof", op: "insert", payload: payload, baseUpdatedAt: null,
        tenantId: tenantId, buildingId: b.id, userId: uid, title: title };
      var q = photoPath
        ? OFF.queuePhoto({ path: photoPath, userId: uid, buildingId: b.id, dataUrl: photoDataUrl }).then(function () { return OFF.queueOp(op); })
        : OFF.queueOp(op);
      q.then(function () {
        S.secBusy.proof = false;
        // honesty copy: only `synket ✓` means the board can see it (doc-80 §6)
        S.secMsg.proof = "Lagret på enheten — synlig for styret først når den viser «synket ✓».";
        refreshPending(function () { render(); });
        drainAll();
      }).catch(function (e) {
        // C1 at its hardest: the capture could NOT be durably queued — fail LOUDLY, never a fake ✓
        fail("⚠ Kunne IKKE lagre på enheten (" + ((e && e.message) || "lagringsfeil") + ") — registreringen er IKKE trygg. Frigjør plass og prøv igjen.");
      });
    }
    if (!file) { queueIt(null); return; }
    compressImage(file, function (dataUrl) {
      if (!dataUrl) { fail("Kunne ikke lese/komprimere bildet — prøv et annet."); return; }
      queueIt(dataUrl);
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
      + sectionProofHTML(b)
      + sectionOffersHTML(b);
  }

  function lastEmail() { try { return localStorage.getItem("onsite_prod_email") || ""; } catch (e) { return ""; } }
  function rememberEmail(e) { try { localStorage.setItem("onsite_prod_email", e); } catch (x) {} }

  /* one delegated dispatcher (replaces per-render bind) — sections add cases, not listeners */
  var ACTIONS = {
    login: function () { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); },
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
    retryHeld: function () { OFF.retryHeld(userId()).then(function () { refreshPending(function () { render(); drainAll(); }); }); },
    discardOp: function (el) {
      if (!window.confirm("Forkaste denne avviste registreringen?")) return;
      OFF.delOp(el.getAttribute("data-id")).then(function () { refreshPending(function () { render(); }); });
    },
    applyUpdate: function () { if (S.updateReg) OFF.applyUpdate(S.updateReg); },
    addBuilding: addBuilding,
    openBuilding: function (el) { openBuilding(el.getAttribute("data-id")); },
    back: function () {
      if (S.view.name === "outbox") { S.view = S._prevView && S._prevView.name === "building" ? S._prevView : { name: "list" }; render(); if (S.view.name === "building") loadBuildingSections(S.view.id); return; }
      closeBuilding();
    },
    // item 1: assets
    assetNew: function () { var d = ASSET_TYPES[0]; S.editAsset = { id: null, type: d.id, label: "", area: d.area, access: "", notes: "", bin: null }; S.secMsg.assets = null; render(); },
    assetEdit: function (el) { var a = (S.assets || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0]; if (a) { S.editAsset = JSON.parse(JSON.stringify(a)); S.secMsg.assets = null; render(); } },
    assetCancel: function () { S.editAsset = null; render(); },
    assetSave: assetSave,
    assetDel: function (el) { assetDelete(el.getAttribute("data-id")); },
    // item 2: proof
    proofSave: proofSave,
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
  });
  app.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && ev.target && ev.target.id === "li_email") { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); }
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
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") drainAll(); });

  render(); // immediate paint (login screen / cached shell) while getSession resolves
})();
