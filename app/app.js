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
  var S = { session: null, tenant: null, buildings: null, loading: false, error: null, msg: null, noAccess: false, _uid: null,
    // 1c-2: view routing — the building detail is the container for the per-table sections (assets/proof/offers)
    view: { name: "list" }, assets: null, proof: null, offers: null, editAsset: null, secBusy: {}, secErr: {}, secMsg: {} };

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
    listBuildings: function () { return sb.from("buildings").select("*").order("name", { ascending: true }); },
    createBuilding: function (tenantId, b) { return sb.from("buildings").insert(coreToRow(tenantId, b)).select().single(); },
    updateBuilding: function (id, b) { return sb.from("buildings").update(coreToRow(null, b)).eq("id", id).select().single(); },
    // 1c-2 item 1: assets — RLS scopes to the tenant; tenant_id set from the resolved membership on insert
    listAssets: function (bid) { return sb.from("assets").select("*").eq("building_id", bid).order("created_at", { ascending: true }); },
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
    if (!S.session) return;
    S.loading = true; S.error = null; S.noAccess = false; render();
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
        return prodDb.listBuildings();
      }).then(function (br) {
        if (br.error) throw br.error;
        S.buildings = (br.data || []).map(rowToCore);
        S.loading = false; render();
      });
    }).catch(function (e) { S.loading = false; S.error = friendly(e); render(); });
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
    S.assets = null; S.proof = null; S.offers = null; S.editAsset = null; S.secErr = {}; S.secMsg = {}; S.msg = null; S.error = null;
    render();
    loadBuildingSections(id);   // sections load lazily; each surfaces its own errors (C1)
  }
  function closeBuilding() { S.view = { name: "list" }; S.editAsset = null; S.msg = null; S.error = null; render(); }
  function loadBuildingSections(id) { loadAssets(id); loadProof(id); loadOffers(id); }

  function render() {
    if (!S.session) { renderLogin(); }
    else if (S.noAccess) { renderNoAccess(); }
    else if (S.view.name === "building" && buildingById(S.view.id)) { renderBuilding(buildingById(S.view.id)); }
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
    var email = (S.session.user && S.session.user.email) || "innlogget";
    var head =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + (S.tenant.role ? ' · ' + esc(S.tenant.role) : '') + (S.tenant.count > 1 ? ' · tilgang 1 av ' + S.tenant.count : '') + '</span>' : '')
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
      if (r.error) { S.secErr.assets = friendly(r.error); } else { S.assets = (r.data || []).map(assetRowToCore); }
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

  /* ---- remaining section placeholders (items 2-3 replace these) ---- */
  function sectionProofHTML(b) { return '<div class="card"><div class="ct">📋 Dokumentert arbeid</div><div class="empty">Kommer (1c-2 · completion_proof).</div></div>'; }
  function sectionOffersHTML(b) { return '<div class="card"><div class="ct">💰 Tilbud</div><div class="empty">Kommer (1c-2 · offers).</div></div>'; }
  function loadProof(id) {}
  function loadOffers(id) {}

  /* ============================ building detail (1c-2 item 0) ============================
   * The container for the per-table sections: Eiendeler · Dokumentert arbeid · Tilbud. Tablet-first. */
  function renderBuilding(b) {
    var email = (S.session.user && S.session.user.email) || "";
    var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
    app.innerHTML =
      '<div class="top"><div><span class="logo">● ONSITE</span><span class="prodtag">prod</span>'
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + '</span>' : '')
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>'
      + '<div class="bhead"><button class="btn ghost" data-act="back" style="padding:9px 13px">← Bygg</button>'
      + '<div><h1>🏢 ' + esc(b.name) + '</h1>' + (meta ? '<div class="note">' + esc(meta) + '</div>' : '') + '</div></div>'
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
    signout: signOut,
    addBuilding: addBuilding,
    openBuilding: function (el) { openBuilding(el.getAttribute("data-id")); },
    back: closeBuilding,
    // item 1: assets
    assetNew: function () { var d = ASSET_TYPES[0]; S.editAsset = { id: null, type: d.id, label: "", area: d.area, access: "", notes: "", bin: null }; S.secMsg.assets = null; render(); },
    assetEdit: function (el) { var a = (S.assets || []).filter(function (x) { return x.id === el.getAttribute("data-id"); })[0]; if (a) { S.editAsset = JSON.parse(JSON.stringify(a)); S.secMsg.assets = null; render(); } },
    assetCancel: function () { S.editAsset = null; render(); },
    assetSave: assetSave,
    assetDel: function (el) { assetDelete(el.getAttribute("data-id")); }
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
    // gate item 3: re-resolve the tenant on every sign-in AND on user change — never reuse a cached
    // tenant_id across sessions/users (shared-device reality).
    if (session && (!was || uid !== wasUid)) { S.buildings = null; S.tenant = null; S.noAccess = false; loadTenantAndBuildings(); }
    if (!session) { S.tenant = null; S.buildings = null; S.noAccess = false; }
    render();
  });
  sb.auth.getSession().then(function (r) {
    S.session = (r.data && r.data.session) || null;
    S._uid = S.session && S.session.user ? S.session.user.id : null;
    if (S.session && S.buildings == null && !S.loading) loadTenantAndBuildings();
    render();
  });
  render(); // immediate paint (login screen) while getSession resolves
})();
