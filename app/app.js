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
  var S = { session: null, tenant: null, buildings: null, loading: false, error: null, msg: null };

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
    myMembership: function () { return sb.from("memberships").select("tenant_id, role").limit(1).maybeSingle(); },
    tenantName: function (tid) { return sb.from("tenants").select("name").eq("id", tid).maybeSingle(); },
    listBuildings: function () { return sb.from("buildings").select("*").order("name", { ascending: true }); },
    createBuilding: function (tenantId, b) { return sb.from("buildings").insert(coreToRow(tenantId, b)).select().single(); },
    updateBuilding: function (id, b) { return sb.from("buildings").update(coreToRow(null, b)).eq("id", id).select().single(); }
  };

  /* ============================ auth ============================ */
  function sendMagicLink(email) {
    email = (email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { S.error = "Skriv en gyldig e-postadresse."; S.msg = null; render(); return; }
    S.loading = true; S.error = null; S.msg = null; render();
    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } })
      .then(function (r) {
        S.loading = false;
        if (r.error) { S.error = authHint(r.error); }
        else { S.msg = "📧 Vi sendte en innloggingslenke til " + email + ". Åpne den på denne enheten."; }
        render();
      });
  }
  function authHint(err) {
    var m = (err && err.message) || "ukjent feil";
    if (/not enabled|disabled|provider|signups? not allowed/i.test(m)) return "Innlogging er ikke slått på ennå — den virker straks e-post/magic-link er aktivert. (" + m + ")";
    return "Innlogging feilet: " + m;
  }
  function signOut() { sb.auth.signOut().then(function () { S.tenant = null; S.buildings = null; S.msg = null; S.error = null; render(); }); }

  /* ============================ load-after-login ============================ */
  function loadTenantAndBuildings() {
    if (!S.session) return;
    S.loading = true; S.error = null; render();
    prodDb.myMembership().then(function (mr) {
      if (mr.error) throw mr.error;
      if (!mr.data) { S.tenant = { id: null, role: null, name: null }; S.buildings = []; S.loading = false; S.error = "Ingen tenant-tilknytning for denne brukeren ennå."; render(); return; }
      S.tenant = { id: mr.data.tenant_id, role: mr.data.role, name: null };
      return prodDb.tenantName(mr.data.tenant_id).then(function (tr) {
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
  function friendly(e) { var m = (e && e.message) || String(e); if (/JWT|not authenticated|401/i.test(m)) return "Økten er utløpt — logg inn på nytt."; return m; }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  /* ============================ render ============================ */
  function render() {
    if (!S.session) { renderLogin(); }
    else { renderApp(); }
    bind();
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
      + (S.tenant && S.tenant.name ? ' <span class="tenant">' + esc(S.tenant.name) + (S.tenant.role ? ' · ' + esc(S.tenant.role) : '') + '</span>' : '')
      + '</div><div style="display:flex;gap:8px;align-items:center"><span class="who">' + esc(email) + '</span><button class="btn ghost" data-act="signout" style="padding:8px 12px">Logg av</button></div></div>';

    var list;
    if (S.loading && S.buildings == null) { list = '<div class="empty"><span class="spin"></span>Henter bygg fra onsite-prod…</div>'; }
    else if (!S.buildings || !S.buildings.length) { list = '<div class="empty">Ingen bygg ennå for denne tenanten. Legg til det første nedenfor.</div>'; }
    else {
      list = S.buildings.map(function (b) {
        var meta = [b.addr, (b.gnr ? 'gnr ' + b.gnr : ''), (b.bnr ? 'bnr ' + b.bnr : '')].filter(Boolean).join(' · ');
        return '<div class="bldg"><div class="t">🏢 ' + esc(b.name) + '</div>' + (meta ? '<div class="d">' + esc(meta) + '</div>' : '') + '</div>';
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
  function lastEmail() { try { return localStorage.getItem("onsite_prod_email") || ""; } catch (e) { return ""; } }
  function rememberEmail(e) { try { localStorage.setItem("onsite_prod_email", e); } catch (x) {} }

  function bind() {
    var b;
    if ((b = app.querySelector('[data-act="login"]'))) b.onclick = function () { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); };
    if ((b = app.querySelector('[data-act="signout"]'))) b.onclick = signOut;
    if ((b = app.querySelector('[data-act="addBuilding"]'))) b.onclick = addBuilding;
    var em = document.getElementById("li_email"); if (em) em.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { var e = val("li_email"); rememberEmail(e); sendMagicLink(e); } });
  }

  /* ============================ boot ============================ */
  sb.auth.onAuthStateChange(function (event, session) {
    var was = !!S.session; S.session = session;
    if (session && !was) { S.buildings = null; S.tenant = null; loadTenantAndBuildings(); }
    if (!session) { S.tenant = null; S.buildings = null; }
    render();
  });
  sb.auth.getSession().then(function (r) {
    S.session = (r.data && r.data.session) || null;
    if (S.session && S.buildings == null && !S.loading) loadTenantAndBuildings();
    render();
  });
  render(); // immediate paint (login screen) while getSession resolves
})();
