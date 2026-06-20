/* ===========================================================================
   onboarding.js — the sales → onboarding journey (doc 33), Steps 0–5.
   Static, no build. Binds to Leaflet (L) + the day app's shared store
   (window.OnSite). One growing record + one growing map per customer; nothing
   re-entered, only enriched. Stage: Prospect → Surveyed → Offer sent →
   Changes requested → Agreed → Live.
   =========================================================================== */
(function(){
  "use strict";
  if(!window.OnSite){ console.warn("OnSite store missing — onboarding disabled"); return; }
  var hasLeaflet = (typeof L !== "undefined");

  /* ---------- store shortcuts ---------- */
  function S(){ return OnSite.state; }
  function save(){ OnSite.save(); }
  function render(){ OnSite.render(); }
  function toast(m){ OnSite.toast(m); }
  function esc(s){ return OnSite.esc(s); }
  function uid(){ return OnSite.uid(); }
  function kr(n){ return "kr " + (Math.round(n)||0).toLocaleString("no"); }
  function nowStr(){ try{ return new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}); }catch(e){ return "today"; } }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }

  /* ---------- service-type catalog — PHM Norge's 8 categories (doc 36) ----------
     Markable sub-types (map layers) grouped under PHM's published service map.
     `cat` = category key (see CATS). Mechanics unchanged — only set/grouping/labels. */
  var LAYERS = {
    /* 1. Eiendomsdrift (core) */
    tech:      {emoji:"🔧", cat:"drift",   label:"Teknisk rom",        measure:"count", unit:"rom",   rate:4000,  service:"Tilsynsrunde",                  freq:"Månedlig",                       compliance:true},
    fire:      {emoji:"🔥", cat:"drift",   label:"Brannpunkt / HMS",   measure:"count", unit:"punkt", rate:3500,  service:"HMS- og brannvernrunde",        freq:"Kvartalsvis",                    compliance:true, statutory:true},
    lift:      {emoji:"🛗", cat:"drift",   label:"Heis",               measure:"count", unit:"heis",  rate:12000, service:"Sikkerhetskontroll (2-årlig)",  freq:"Annethvert år (sert. partner)",  compliance:true, statutory:true},
    entrance:  {emoji:"🚪", cat:"drift",   label:"Inngang / adkomst",  measure:"count", unit:"dør",   rate:0,     service:"Adkomst, nøkler / koder",       freq:"—",                              recordOnly:true},
    playground:{emoji:"🛝", cat:"drift",   label:"Lekeplass",          measure:"count", unit:"stk",   rate:9000,  service:"Årlig kontroll (NS-EN 1176)",   freq:"Årlig",                          compliance:true, statutory:true},
    /* 2. Renhold (core) */
    stairwell: {emoji:"🧹", cat:"renhold", label:"Trappevask / renhold",measure:"count",unit:"oppgang",rate:14000,service:"Løpende renhold",               freq:"Ukentlig"},
    facade:    {emoji:"🧼", cat:"renhold", label:"Fasadevask",         measure:"area",  unit:"m²",    rate:25,    service:"Fasadevask",                    freq:"Årlig"},
    laundry:   {emoji:"🧺", cat:"renhold", label:"Vaskerom",           measure:"count", unit:"rom",   rate:6000,  service:"Renhold + maskinsjekk",         freq:"Ukentlig"},
    /* 3. Hage & Gartner (core) */
    grass:     {emoji:"🌿", cat:"hage",    label:"Gressklipping",      measure:"area",  unit:"m²",    rate:12,    service:"Klipping (traktor/manuell/kant)",freq:"Ukentlig i sesong",             method:"Traktor"},
    greenery:  {emoji:"🌳", cat:"hage",    label:"Beskjæring / grønt", measure:"count", unit:"område",rate:2500,  service:"Beskjæring og luking",          freq:"Sesong"},
    beds:      {emoji:"🌷", cat:"hage",    label:"Bed / beplantning",  measure:"count", unit:"bed",   rate:1800,  service:"Beplantning og stell",          freq:"Sesong"},
    /* 4. Vintertjenester (core) */
    snow:      {emoji:"❄️", cat:"vinter",  label:"Snøbrøyting",        measure:"area",  unit:"m²",    rate:30,    service:"Brøyting",                      freq:"Per hendelse / sesong"},
    gritting:  {emoji:"🧂", cat:"vinter",  label:"Strøing / salting",  measure:"area",  unit:"m²",    rate:10,    service:"Strøing og salting",            freq:"Per hendelse"},
    roofsafety:{emoji:"🏠", cat:"vinter",  label:"Taksikring",         measure:"count", unit:"tak",   rate:5000,  service:"Takras-sikring / snørydding tak",freq:"Ved behov (vinter)"},
    /* 5. Servicetjenester (module) */
    pest:      {emoji:"🐜", cat:"service", label:"Skadedyrkontroll",   measure:"count", unit:"punkt", rate:0,     service:"Skadedyrkontroll",              freq:"Planlagt"},
    waste:     {emoji:"♻️", cat:"service", label:"Renovasjon / dunk",  measure:"count", unit:"dunk",  rate:0,     service:"Renovasjon / dunkvask",         freq:"—"},
    plumbing:  {emoji:"🚰", cat:"service", label:"Rør & avløp",        measure:"count", unit:"punkt", rate:0,     service:"Rør & avløp",                   freq:"—"},
    /* 6. Håndverkertjenester (module) */
    montering: {emoji:"🔨", cat:"handverk",label:"Montering / installasjon",measure:"count",unit:"jobb",rate:0,   service:"Montering / installasjon",      freq:"Ved behov"},
    oppussing: {emoji:"🛠️", cat:"handverk",label:"Oppussing / prosjekt",measure:"count",unit:"prosjekt",rate:0,   service:"Oppussing / prosjekt",          freq:"—"},
    /* 7. Utemiljø, Bygg & Anlegg (module) */
    grunnarbeid:{emoji:"🧱",cat:"anlegg",  label:"Anleggsgartner / grunnarbeid",measure:"area",unit:"m²",rate:0,  service:"Grunnarbeid (asfalt, drenering)",freq:"Prosjekt"},
    /* interior building-record layers, unlocked in enrichment (Step 5) — under Eiendomsdrift */
    panel:     {emoji:"🔌", cat:"drift",   label:"El-tavle",           measure:"count", unit:"tavle", rate:0,     service:"Plassering + tilsynsnotat",     freq:"—",  recordOnly:true, enrich:true},
    valve:     {emoji:"🔩", cat:"drift",   label:"Ventil / stoppekran",measure:"count", unit:"ventil",rate:0,     service:"Plasseringsnotat",              freq:"—",  recordOnly:true, enrich:true}
  };

  /* PHM Norge's 8 published service categories (phmgroup.no/tjenester). tier:
     core = built now; module = phase-2 ("modul – kommer"); feeds = integrate/out, never markable. */
  var CATS = [
    {key:"drift",      label:"Eiendomsdrift",           tier:"core",   layers:["tech","fire","lift","entrance","playground","panel","valve"]},
    {key:"renhold",    label:"Renhold",                 tier:"core",   layers:["stairwell","facade","laundry"]},
    {key:"hage",       label:"Hage & Gartner",          tier:"core",   layers:["grass","greenery","beds"]},
    {key:"vinter",     label:"Vintertjenester",         tier:"core",   layers:["snow","gritting","roofsafety"]},
    {key:"service",    label:"Servicetjenester",        tier:"module", layers:["pest","waste","plumbing"]},
    {key:"handverk",   label:"Håndverkertjenester",     tier:"module", layers:["montering","oppussing"]},
    {key:"anlegg",     label:"Utemiljø, Bygg & Anlegg", tier:"module", layers:["grunnarbeid"]},
    {key:"forvaltning",label:"Eiendomsforvaltning",     tier:"feeds",  layers:[], feedsNote:"Integreres — OnSite mater forretningsfører/styreportal (PHM Digital · Lettstyrt · OBOS Vibbo). Bygges ikke."}
  ];
  function catOf(key){ var c=null; CATS.forEach(function(x){ if(x.layers.indexOf(key)>=0) c=x; }); return c; }
  function catLabel(key){ var c=catOf(key); return c?c.label:""; }
  function layerTier(key){ var c=catOf(key); return c?c.tier:"core"; }

  var PROFILES = ["Residential — association","Residential — rental","Commercial — office","Commercial — retail","Commercial — warehouse/logistics","Mixed-use"];
  var SCOPE_OPTS = [
    {key:"grass",     label:"🌿 Gressklipping"},
    {key:"snow",      label:"❄️ Snøbrøyting"},
    {key:"laundry",   label:"🧺 Vaskerom / renhold"},
    {key:"stairwell", label:"🧹 Trappevask"},
    {key:"greenery",  label:"🌳 Beskjæring / grønt"}
  ];
  var STAGES = ["Prospect","Surveyed","Offer sent","Changes requested","Agreed","Live"];
  var STEP_NAMES = ["Office prep","Walkaround","Offer","Board review","Updated offer","Go-live"];

  function catKeyLabel(k){ for(var i=0;i<CATS.length;i++){ if(CATS[i].key===k) return CATS[i].label; } return k; }
  function catEmoji(k){ return {drift:"🔧",renhold:"🧹",hage:"🌿",vinter:"❄️",service:"🛠️",handverk:"🔨",anlegg:"🧱",forvaltning:"📋"}[k]||"•"; }

  /* ---------- Step-0 walkaround checklist (doc 38, Part A) ----------
     A checklist template per building profile. The residential-association
     profile = doc-38's 10-zone walk sequence. Each template item:
     {id, zone, label, category(one of the PHM 8 keys), captureType, emoji, freq, upsell, compliance}.
     A client carries an *instantiated* copy with per-item {value, scope, deliveredBy, partnerName, price, subtype}. */
  var ZONES = [
    {n:1,  title:"Approach & grounds"},
    {n:2,  title:"Waste"},
    {n:3,  title:"Entrances & stairwells"},
    {n:4,  title:"Lifts"},
    {n:5,  title:"Common indoor / svalganger / bod"},
    {n:6,  title:"Basement / teknisk rom"},
    {n:7,  title:"Garage"},
    {n:8,  title:"Doors & access"},
    {n:9,  title:"Roof"},
    {n:10, title:"Stakeholders & admin"}
  ];
  var CHECKLIST_TEMPLATE = {
    "Residential — association": [
      // 1. Approach & grounds
      {id:"lawn",      zone:1, label:"Plen — areal + klippefrekvens",            category:"hage",   captureType:"area",      emoji:"🌿", freq:"Ukentlig i sesong"},
      {id:"hedges",    zone:1, label:"Hekk/busker — antall + maks høyde",         category:"hage",   captureType:"count",     emoji:"🌳", freq:"2×/sesong"},
      {id:"trees",     zone:1, label:"Trær <3,5 m (i scope) vs høye ⬆",           category:"hage",   captureType:"count",     emoji:"🌳"},
      {id:"beds",      zone:1, label:"Staudebed — luking + vårrydding",           category:"hage",   captureType:"count",     emoji:"🌷"},
      {id:"weeds",     zone:1, label:"Ugras/mose/alger — sprøyterunder",          category:"hage",   captureType:"condition", emoji:"🌿", freq:"3×/sesong"},
      {id:"gravel",    zone:1, label:"Elvestein/grus — eddikbehandling",          category:"hage",   captureType:"note",      emoji:"🪨"},
      {id:"greenwaste",zone:1, label:"Grøntavfall — rute + deponi",               category:"hage",   captureType:"note",      emoji:"🍂"},
      {id:"taps",      zone:1, label:"Utekraner — åpne/steng vår/høst",           category:"drift",  captureType:"count",     emoji:"🚰"},
      {id:"bootscr",   zone:1, label:"Fotskraperister ved innganger",            category:"drift",  captureType:"count",     emoji:"🚪"},
      {id:"paths",     zone:1, label:"Veier/stier — maskinkost vår (før 17. mai)",category:"anlegg", captureType:"area",      emoji:"🧹"},
      {id:"snow",      zone:1, label:"Snø — brøyteareal, dumpested, strøsoner",   category:"vinter", captureType:"area",      emoji:"❄️", freq:"Per snøfall >5 cm"},
      {id:"roofsnow",  zone:1, label:"Takras/snø → taksikring ⬆",                 category:"vinter", captureType:"condition", emoji:"🏠", upsell:true},
      // 2. Waste
      {id:"wells",     zone:2, label:"Avfallsbrønner + bøtter/askebeger — antall",category:"drift",  captureType:"count",     emoji:"♻️"},
      {id:"binwash",   zone:2, label:"Dunk-/containervask ⬆",                     category:"service",captureType:"boolean",   emoji:"♻️", upsell:true},
      {id:"bulky",     zone:2, label:"Grovavfall — lagringspunkt + henting",      category:"drift",  captureType:"note",      emoji:"📦"},
      // 3. Entrances & stairwells
      {id:"oppganger", zone:3, label:"Antall oppganger — trappevask",             category:"renhold",captureType:"count",     emoji:"🧹", freq:"Ukentlig"},
      {id:"mats",      zone:3, label:"Inngangsmatter — antall + leverandør",      category:"renhold",captureType:"count",     emoji:"🧺"},
      {id:"glass",     zone:3, label:"Glass ytterdør / fellesvindu / rekkverk",   category:"renhold",captureType:"condition", emoji:"🧼"},
      {id:"lighting",  zone:3, label:"Lysarmatur — type + reservelager (LED)",    category:"drift",  captureType:"note",      emoji:"💡"},
      {id:"facade",    zone:3, label:"Fasade → svertesopp/fasadevask ⬆",          category:"renhold",captureType:"condition", emoji:"🧼", upsell:true},
      // 4. Lifts
      {id:"heiser",    zone:4, label:"Antall heiser — gulv/speil/metall",         category:"renhold",captureType:"count",     emoji:"🛗", freq:"Ukentlig"},
      {id:"liftctrl",  zone:4, label:"Heis sikkerhetskontroll (2-årlig) — hvem",  category:"drift",  captureType:"note",      emoji:"🛗", compliance:true},
      // 5. Common indoor / svalganger / bod
      {id:"svalg",     zone:5, label:"Svalganger — feiing + glassrekkverk (vår)", category:"renhold",captureType:"condition", emoji:"🧹"},
      {id:"bodarea",   zone:5, label:"Bod-/korridorareal",                        category:"renhold",captureType:"note",      emoji:"🧹"},
      // 6. Basement / teknisk rom
      {id:"pipes",     zone:6, label:"Synlige rør/kraner — lekkasjer",            category:"drift",  captureType:"condition", emoji:"🔧"},
      {id:"water",     zone:6, label:"Varmtvann/varmepumpe/sluk åpne",            category:"drift",  captureType:"condition", emoji:"🔧"},
      {id:"sprinkler", zone:6, label:"Sprinkler — logg trykk (årskontroll)",      category:"drift",  captureType:"condition", emoji:"🔧", compliance:true},
      {id:"vent",      zone:6, label:"Ventilasjon vifter/filter — hvem ⬆",        category:"service",captureType:"note",      emoji:"🌀", upsell:true},
      {id:"firepanel", zone:6, label:"Brannsentral; rømningsveier; brannutstyr",  category:"drift",  captureType:"condition", emoji:"🔥"},
      {id:"pumpekum",  zone:6, label:"Pumpekum; varmekabler (sesong)",            category:"drift",  captureType:"condition", emoji:"🔧"},
      // 7. Garage
      {id:"garage",    zone:7, label:"Garasje — vask/feiing; rampesluk; porter",  category:"drift",  captureType:"condition", emoji:"🅿️"},
      // 8. Doors & access
      {id:"doors",     zone:8, label:"Dørpumper/el-sluttstykke/låskasse; hengsler",category:"drift", captureType:"condition", emoji:"🚪"},
      {id:"access",    zone:8, label:"Nøkler/adgangskoder — fanget",              category:"drift",  captureType:"note",      emoji:"🔑"},
      // 9. Roof
      {id:"roof",      zone:9, label:"Tak/takrenner/nedløp; vannbord tilstand",   category:"anlegg", captureType:"condition", emoji:"🏠"},
      // 10. Stakeholders & admin
      {id:"round",     zone:10,label:"Ukentlig vaktmesterrunde + tilsyn + rapport",category:"drift", captureType:"note",      emoji:"🧰", freq:"Ukentlig"},
      {id:"approver",  zone:10,label:"Styreleder + preferanser",                  category:"drift",  captureType:"note",      emoji:"🏛️"},
      {id:"manager",   zone:10,label:"Forvalter + rapportering",                  category:"drift",  captureType:"note",      emoji:"🗂️"},
      {id:"vakttlf",   zone:10,label:"Vakttelefon/beredskap 24t",                 category:"drift",  captureType:"boolean",   emoji:"📞"},
      // Always-on upsell scan
      {id:"pest",      zone:10,label:"Skadedyr — tegn? ⬆",                        category:"service",captureType:"boolean",   emoji:"🐜", upsell:true},
      {id:"playground",zone:10,label:"Lekeplass — antall + årskontroll ⬆",        category:"drift",  captureType:"count",     emoji:"🛝", upsell:true},
      {id:"painting",  zone:10,label:"Maling / vannbord / asfalt ⬆",              category:"anlegg", captureType:"note",      emoji:"🖌️", upsell:true}
    ]
  };
  function instantiateChecklist(profile){
    var tpl = CHECKLIST_TEMPLATE[profile] || CHECKLIST_TEMPLATE["Residential — association"];
    return tpl.map(function(it){
      return { id:it.id, zone:it.zone, label:it.label, category:it.category, captureType:it.captureType,
        emoji:it.emoji, freq:it.freq||"", upsell:!!it.upsell, compliance:!!it.compliance,
        value:null, scope:"unknown", deliveredBy:"in-house", partnerName:null, price:0, subtype:it.label };
    });
  }
  function scopeIcon(s){ return {"in":"✅","upsell":"⬆","out":"✖","unknown":"⬜"}[s]||"⬜"; }

  function badgeClass(stage){
    return "ob-badge s-" + ({"Prospect":"prospect","Surveyed":"surveyed","Offer sent":"offer","Changes requested":"changes","Agreed":"agreed","Live":"live"}[stage] || "prospect");
  }
  /* build-year → likely statutory systems (suggested scope) */
  function suggestedFromYear(y){
    if(!y) return [];
    var s = ["fire"];
    if(y <= 2010) s.push("lift");
    if(y >= 1990) s.push("playground");
    return s;
  }
  function defaultStep(c){
    return {"Prospect":1,"Surveyed":1,"Offer sent":3,"Changes requested":4,"Agreed":5,"Live":5}[c.stage] || 0;
  }
  function maxStep(c){
    return {"Prospect":1,"Surveyed":2,"Offer sent":3,"Changes requested":4,"Agreed":5,"Live":5}[c.stage] || 1;
  }

  /* ---------- ui (ephemeral, not persisted) ---------- */
  var ui = { openId:null, step:0, activeLayer:null, draftNew:false, zonesOpen:{}, refMs:null, modOpen:{} };

  /* ---------- record helpers ---------- */
  function customers(){ var st=S(); if(!st.customers) st.customers=[]; return st.customers; }
  function cust(id){ return customers().filter(function(c){return c.id===id;})[0] || null; }
  function cur(){ return ui.openId ? cust(ui.openId) : null; }
  function findMarker(c,id){ return (c.markers||[]).filter(function(m){return m.id===id;})[0]; }
  function findLine(c,id){ return (c.offer&&c.offer.lines||[]).filter(function(l){return l.id===id;})[0]; }
  function findReq(c,id){ return (c.changeRequests||[]).filter(function(r){return r.id===id;})[0]; }
  function logEvent(c,text){ (c.log=c.log||[]).unshift({ts:nowStr(),text:text}); }
  function setStage(c,s){ c.stage=s; }

  function markerPrice(layer, qty){ var d=LAYERS[layer]; return d.recordOnly ? 0 : (d.rate * (qty||0)); }
  function layerTally(c, key){
    var ms=(c.markers||[]).filter(function(m){return m.layer===key;});
    if(!ms.length) return 0;
    if(LAYERS[key].measure==="area") return ms.reduce(function(s,m){return s+(m.qty||0);},0);
    return ms.length;
  }
  function tallyStr(c,key){ var t=layerTally(c,key); return LAYERS[key].measure==="area" ? (t.toLocaleString("no")+" m²") : (""+t); }
  function isUpsell(c,m){ return !m.inScope && !LAYERS[m.layer].recordOnly && m.source!=="caretaker"; }

  /* ===========================================================================
     SEED — one realistic customer (Solbakken Borettslag, Halden) end-to-end
     =========================================================================== */
  // Holtet's pre-filled checklist (doc 37 contract → scope/value/price/delivered-by)
  function holtetChecklist(){
    var cl=instantiateChecklist("Residential — association");
    cl.forEach(function(it){ it.scope="in"; });   // contract covers the standard round
    var O={
      lawn:     {value:"~1 500 m²", price:1400, subtype:"Gressklipping (ukentlig)"},
      hedges:   {value:"maks 180 cm", subtype:"Hekk/busker (2×, maks 180 cm)"},
      trees:    {value:"<3,5 m"},
      weeds:    {price:2667, subtype:"Grøntområde excl. klipping (sprøyting 3×, bed, hekk, trær)"},
      gravel:   {value:"eddik"},
      snow:     {value:">5 cm samme døgn", price:1800, subtype:"Brøyting (>5 cm) + strøing"},
      roofsnow: {scope:"upsell", subtype:"Taksikring"},
      wells:    {value:"brønner + bøtter"},
      binwash:  {scope:"upsell", price:600, subtype:"Dunk-/containervask"},
      oppganger:{value:4, price:4800, subtype:"Trappevask (4 oppg., 4 heis, svalganger)"},
      mats:     {value:8, price:1200, deliveredBy:"partner", partnerName:"Dørmatte Gutta AS", subtype:"Inngangsmatter (8 stk, månedlig)", freq:"Månedlig"},
      facade:   {scope:"upsell", price:45000, oneOff:true, subtype:"Fasadevask (svertesopp)"},
      heiser:   {value:4, subtype:"Heiser (4 stk) — renhold"},
      liftctrl: {value:"bekreft leverandør"},
      svalg:    {value:"vår"},
      water:    {price:491, subtype:"Teknisk rom — tilsyn (varmtvann, varmepumpe, sluk)"},
      sprinkler:{scope:"unknown", value:"logg trykk på stedet"},
      vent:     {scope:"upsell", price:900, subtype:"Ventilasjon — servicekontrakt"},
      access:   {scope:"unknown", value:"hentes på befaring"},
      roof:     {value:"høst-sjekk"},
      garage:   {value:"før st.hans"},
      round:    {price:4200, value:"man–fre 08–16", subtype:"Ukentlig vaktmesterrunde + tilsyn + rapport"},
      approver: {value:"Egil Svoren (styreleder)"},
      manager:  {value:"USBL · rapport: Viscenario → OnSite"},
      vakttlf:  {value:true},
      pest:     {scope:"upsell", price:350, subtype:"Skadedyrkontroll"},
      playground:{scope:"out", value:"ingen lekeplass"},
      painting: {scope:"upsell", price:28000, oneOff:true, subtype:"Vannbord / utvendig maling"}
    };
    cl.forEach(function(it){ var o=O[it.id]; if(o){ for(var k in o){ it[k]=o[k]; } } });
    return cl;
  }
  function holtetZones(){
    var cy=59.89305, cx=10.78000;
    function poly(co){ return {type:"Polygon", coordinates:[co.concat([co[0]])]}; }
    function line(co){ return {type:"LineString", coordinates:co}; }
    function pt(co){ return {type:"Point", coordinates:co}; }
    var defs=[
      {id:"hz1", service:"grass",    method:"mow",     label:"Hovedplen vest",            notes:"Traktorklipp",              geometry:poly([[cx-0.0010,cy-0.0004],[cx-0.0004,cy-0.0004],[cx-0.0004,cy+0.0001],[cx-0.0010,cy+0.0001]])},
      {id:"hz2", service:"grass",    method:"mow",     label:"Plen nordøst",              notes:"Manuell + kantklipp",       geometry:poly([[cx+0.0004,cy+0.0003],[cx+0.0010,cy+0.0003],[cx+0.0010,cy+0.0007],[cx+0.0004,cy+0.0007]])},
      {id:"hz3", service:"greenery", method:"gartner", label:"Hekk sør (maks 180 cm)",    notes:"2×/sesong: mai–medio juli, sep–okt", geometry:line([[cx-0.0010,cy-0.00045],[cx-0.0002,cy-0.00045]])},
      {id:"hz4", service:"snow",     method:"machine", priority:1, label:"Brøyting – vei + parkering", notes:">5 cm samme døgn", geometry:poly([[cx+0.0002,cy-0.0005],[cx+0.0012,cy-0.0005],[cx+0.0012,cy-0.0001],[cx+0.0002,cy-0.0001]])},
      {id:"hz5", service:"snow",     method:"hand",    priority:2, label:"Inngangssoner + trapp",      notes:"Hånd + strøing",  geometry:poly([[cx-0.0001,cy+0.0001],[cx+0.0002,cy+0.0001],[cx+0.0002,cy+0.0004],[cx-0.0001,cy+0.0004]])},
      {id:"hz6", service:"snow",     method:null,      label:"Deponi",                    notes:"Snødeponi sørøst",          geometry:pt([cx+0.0014,cy-0.0006])},
      {id:"hz7", service:"snow",     method:null,      label:"Strøkasse",                 notes:"Sand/grus ved inngang",     geometry:pt([cx-0.00005,cy+0.00006])}
    ];
    return defs.map(function(d){ d.buildingId="holtet-cust"; d.priority=d.priority||null; d.constraint="none"; d.priceLineId=null; d.completionLog=[]; return zoneRecompute(d); });
  }
  function seedHoltet(){
    var cy=59.89305, cx=10.78000;
    var blocks=["A","B","C","D","E","F","G"];
    var markers=blocks.map(function(b,i){
      var ang=(i/blocks.length)*Math.PI*2;
      return { id:"hm"+(i+1), layer:"entrance", lat:cy+Math.sin(ang)*0.00045, lon:cx+Math.cos(ang)*0.00075,
        service:"Inngang "+b, frequency:LAYERS.entrance.freq, equipment:"", method:"",
        qty:1, unit:LAYERS.entrance.unit, price:0, note:"Oppgang "+b, photo:false, inScope:true, source:"sales", accuracy:null };
    });
    return {
      id:"holtet-cust",
      name:"Sameiet Holtet Horisont I", addr:"Kongsveien 82 A–G, 1177 Oslo", gnr:"154", bnr:"53",
      profile:"Residential — association", buildYear:2018, size:0,
      manager:"Boligbyggelaget USBL", revisor:"KPMG AS",
      contacts:[
        {name:"Egil Svoren", role:"Styreleder", email:"styret@holtet-horisont-1.no"},
        {name:"Torill E. Saltnes Hansen", role:"Styremedlem", email:""},
        {name:"Jorunn Marie Nordermoen", role:"Styremedlem", email:""},
        {name:"Sven Røst", role:"Styremedlem", email:""}
      ],
      meetingTime:"Befaring uke 26",
      stage:"Surveyed", period:"mnd",
      requestedScope:["stairwell","grass","greenery","snow","gritting","lift","tech","entrance"],
      layers:["entrance","stairwell","grass","greenery","snow","gritting","lift","fire","tech"],
      systems:["~4 oppganger","~4 heiser","Sprinkleranlegg","Varmepumpe","Ventilasjon","Garasjeanlegg","Pumpekum","Varmekabler"],
      compliance:[{label:"Heiskontroll (2-årlig)"},{label:"Sprinkler — årskontroll"},{label:"Brannvernrunde"}],
      terms:{ total:16558, green:"kr 32 000/sesong (≈ kr 2 667/mnd)", hourly:"kr 610/t",
        consumables:"Forbruksmateriell faktureres (lys, LED, salt, filter, Roundup, deponi)",
        notice:"3 mnd gjensidig oppsigelse", kpi:"Halvårlig KPI-regulering (SSB)", start:"Oppstart 01.01.2024" },
      center:{lat:cy, lon:cx, zoom:17}, baseLayer:"topo",
      accessNote:"Nøkler/koder hentes på befaring. Forvalter: USBL.",
      markers:markers,
      zones:holtetZones(),
      checklist:holtetChecklist(),
      offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:"16 Jun 2026", text:"Step 0 ferdig fra registre — USBL + styret hentet, 7 oppganger pinnet, sjekkliste forhåndsutfylt"},
           {ts:"15 Jun 2026", text:"Prospect opprettet fra Bygårdsservice-kontrakt (Kongsveien 82 A–G)"}]
    };
  }
  function seedSolbakken(){
    var cy=59.12880, cx=11.38730;
    var req=["grass","snow","laundry"];
    function mk(id,layer,dlat,dlon,qty,note){
      var d=LAYERS[layer];
      return {id:id, layer:layer, lat:cy+dlat, lon:cx+dlon,
        service:d.service, frequency:d.freq, equipment:(d.method||""), method:(d.method||""),
        qty:qty, unit:d.unit, price:markerPrice(layer,qty), note:note||"", photo:false,
        inScope:(req.indexOf(layer)>=0), source:"sales", accuracy:null};
    }
    return {
      id:"solbakken-cust",
      name:"Solbakken Borettslag", addr:"Os Allé 12, 1771 Halden", gnr:"62", bnr:"140",
      profile:"Residential — association", buildYear:1998, size:2400,
      contacts:[{name:"Anne Lid", role:"Board chair", email:"anne@solbakken-borettslag.no"}],
      meetingTime:"Tue 10:00",
      stage:"Surveyed",
      requestedScope:req.slice(),
      layers:["grass","snow","laundry","greenery","playground","fire","lift"],
      center:{lat:cy, lon:cx, zoom:18}, baseLayer:"topo",
      accessNote:"Master key #4 at board chair. Gate code 1948.",
      markers:[
        mk("sm1","grass",     0.00045,-0.00060, 1800, "Hovedplen — traktorklipp"),
        mk("sm2","snow",     -0.00030, 0.00075,  650, "Inngangsparti + parkering"),
        mk("sm3","laundry",   0.00012, 0.00022,    1, "Blokk A kjeller"),
        mk("sm4","laundry",  -0.00022,-0.00030,    1, "Blokk B kjeller"),
        mk("sm5","playground",0.00052, 0.00040,    1, "Bak blokk B — finnes, ikke tilbudt"),
        mk("sm6","lift",     -0.00040, 0.00020,    1, "Blokk A — 1998, 2-årlig kontroll"),
        mk("sm7","fire",      0.00020,-0.00042,    1, "Hovedinngang: slukker + detektorer")
      ],
      zones:[],
      offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:"14 Jun 2026", text:"Surveyed on site — 7 zones marked, 3 upsell flags"},
           {ts:"12 Jun 2026", text:"Prospect created from board enquiry (grass + winter + cleaning)"}]
    };
  }
  function seedIfNeeded(){
    var st=S(); if(!st) return;
    if(!st.customers) st.customers=[];
    if(!st.completedInstances) st.completedInstances={};   // schedule-engine completion set (lineId|isoDate)
    if(!st.obSeeded){
      if(!cust("holtet-cust")) st.customers.push(seedHoltet());      // featured real client
      if(!cust("solbakken-cust")) st.customers.push(seedSolbakken()); // demo client
      st.obSeeded=true; save();
    }
  }

  /* ===========================================================================
     MAP (Leaflet)
     =========================================================================== */
  var map=null, markerLayer=null, buildingMarker=null, leafMarkers={};

  function destroyMap(){
    if(map){ try{ map.remove(); }catch(e){} }
    map=null; markerLayer=null; buildingMarker=null; leafMarkers={}; zoneLayer=null; drawTemp=null; drawVertLayer=null; drawMode=null; drawPts=[];
  }
  function buildMap(c){
    if(!hasLeaflet) return;
    var el=document.getElementById("ob-map"); if(!el) return;
    destroyMap();
    var center=[c.center.lat, c.center.lon], zoom=c.center.zoom||17;
    map=L.map(el,{zoomControl:true});
    map.setView(center, zoom);
    var topo=L.tileLayer("https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png",{attribution:"© Kartverket", maxZoom:20});
    var osm=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap contributors", maxZoom:19});
    (c.baseLayer==="osm" ? osm : topo).addTo(map);
    L.control.layers({"Kartverket topo":topo, "OpenStreetMap":osm}, null, {position:"topright"}).addTo(map);
    map.on("baselayerchange", function(e){ var cc=cur(); if(cc){ cc.baseLayer = (e.name.indexOf("Kart")>=0)?"topo":"osm"; save(); } });
    markerLayer=L.layerGroup().addTo(map);
    buildingMarker=L.marker(center,{interactive:false, keyboard:false,
      icon:L.divIcon({className:"", html:'<div class="ob-bpin">🏢</div>', iconSize:[30,30], iconAnchor:[15,15]})}).addTo(map);
    (c.markers||[]).forEach(function(m){ addLeafMarker(c,m); });
    zoneLayer=null; renderZones(c);
    map.on("click", onMapClick);
    map.on("dblclick", function(){ if(drawMode && drawMode!=="point") finishDraw(); });
    setTimeout(function(){ if(map) map.invalidateSize(); }, 60);
  }
  function markerIcon(c,m){
    var d=LAYERS[m.layer];
    var cls="ob-pin"+(isUpsell(c,m)?" upsell":"")+(m.source==="caretaker"?" caretaker":"");
    return L.divIcon({className:"", html:'<div class="'+cls+'"><span>'+d.emoji+'</span></div>',
      iconSize:[34,34], iconAnchor:[17,30], popupAnchor:[0,-28]});
  }
  function addLeafMarker(c,m){
    if(!map) return;
    var mk=L.marker([m.lat,m.lon],{icon:markerIcon(c,m)});
    mk.bindPopup(markerPopupHTML(c,m));
    mk.addTo(markerLayer);
    leafMarkers[m.id]=mk;
  }
  function markerPopupHTML(c,m){
    var d=LAYERS[m.layer];
    var qtyLabel = d.measure==="area" ? "Area (m²)" : "Count / units";
    return '<div class="ob-pop" style="min-width:215px">'
      +'<div style="font-weight:750;margin-bottom:2px">'+d.emoji+' '+esc(d.label)+(isUpsell(c,m)?' <span style="color:#b5790b">· upsell</span>':'')+'</div>'
      +'<label>Service</label><input data-obf="mkservice" data-id="'+m.id+'" value="'+esc(m.service)+'">'
      +'<label>Frequency</label><input data-obf="mkfreq" data-id="'+m.id+'" value="'+esc(m.frequency)+'">'
      +'<label>'+qtyLabel+'</label><input type="number" step="1" min="0" data-obf="mkqty" data-id="'+m.id+'" value="'+(m.qty||0)+'">'
      +'<label>Note</label><input data-obf="mknote" data-id="'+m.id+'" value="'+esc(m.note||"")+'" placeholder="optional">'
      +(d.recordOnly?'':'<div style="margin-top:8px;font-weight:750">'+kr(m.price)+' /år</div>')
      +'<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">'
        +'<button class="ob-mini'+(m.photo?' on':'')+'" data-ob="photo" data-id="'+m.id+'">📷 '+(m.photo?'photo ✓':'add photo')+'</button>'
        +'<button class="ob-mini no on" data-ob="delMarker" data-id="'+m.id+'">🗑 delete</button>'
      +'</div></div>';
  }
  function onMapClick(e){
    if(drawMode){ handleDrawClick(e.latlng); return; }
    var c=cur(); if(!c) return;
    if(!ui.activeLayer){ toast("Pick a layer chip first, then tap the map to drop a marker"); return; }
    dropMarker(c, ui.activeLayer, e.latlng.lat, e.latlng.lng, null);
  }
  function dropMarker(c, layer, lat, lon, accuracy){
    var d=LAYERS[layer];
    var qty = d.measure==="area" ? 100 : 1;
    var live = c.stage==="Live";
    var m={ id:"m"+uid(), layer:layer, lat:lat, lon:lon,
      service:d.service, frequency:d.freq, equipment:(d.method||""), method:(d.method||""),
      qty:qty, unit:d.unit, price:markerPrice(layer,qty), note:"", photo:false,
      inScope:(c.requestedScope||[]).indexOf(layer)>=0, source: live?"caretaker":"sales", accuracy:accuracy };
    (c.markers=c.markers||[]).push(m);
    save();
    addLeafMarker(c,m);
    refreshWalk(c);
    if(isUpsell(c,m)) toast("⚠️ "+d.label+" present but outside requested scope — flagged as upsell");
    else if(live) toast("Added to the building record (interior enrichment)");
    else toast("Marked: "+d.label);
  }

  /* ===========================================================================
     ZONES (Phase 1) — draw & measure service zones; render operational maps
     =========================================================================== */
  var KARTVERKET="https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png";
  var opMaps={}, zoneLayer=null, drawMode=null, drawPts=[], drawTemp=null, drawVertLayer=null, pendingZone=null;
  var SERVICE_LIST=[
    {key:"snow",         label:"Snø / vinter",     stroke:"#1d4ed8", swatch:"❄️"},
    {key:"grass",        label:"Gress / plen",     stroke:"#15803d", swatch:"🌿"},
    {key:"greenery",     label:"Grønt / bed / hekk",stroke:"#b5790b", swatch:"🌳"},
    {key:"cleaning-ext", label:"Utvendig renhold", stroke:"#0369a1", swatch:"🧼"},
    {key:"other",        label:"Annet",            stroke:"#6b7670", swatch:"▫️"}
  ];
  var METHODS={ snow:[{key:"machine",label:"Maskin"},{key:"hand",label:"Hånd / manuell"}],
    grass:[{key:"mow",label:"Klipping"},{key:"edge",label:"Kantklipp"},{key:"gartner",label:"Gartner / bed"}],
    greenery:[{key:"gartner",label:"Beskjæring / bed"}], "cleaning-ext":[{key:"wash",label:"Vask"}], other:[] };
  var CONSTRAINTS=[{key:"none",label:"Ingen"},{key:"delicate",label:"Ømtålig"},{key:"no-go",label:"Ikke kjør / no-go"},{key:"access-tight",label:"Trang adkomst"}];
  function svcDef(k){ return SERVICE_LIST.filter(function(s){return s.key===k;})[0]||SERVICE_LIST[4]; }
  function methodLabel(z){ var ms=METHODS[z.service]||[]; var m=ms.filter(function(x){return x.key===z.method;})[0]; return m?m.label:""; }
  function defaultMethod(service){ var ms=METHODS[service]||[]; return ms.length?ms[0].key:null; }

  /* ---- geodesic measurement (no deps): equirectangular shoelace + haversine ---- */
  function geoArea(pts){ if(pts.length<3) return 0; var R=6378137, lat0=0; pts.forEach(function(p){lat0+=p[0];}); lat0=(lat0/pts.length)*Math.PI/180;
    var xy=pts.map(function(p){ return [R*(p[1]*Math.PI/180)*Math.cos(lat0), R*(p[0]*Math.PI/180)]; });
    var a=0; for(var i=0;i<xy.length;i++){ var j=(i+1)%xy.length; a+=xy[i][0]*xy[j][1]-xy[j][0]*xy[i][1]; } return Math.abs(a)/2; }
  function hav(a,b){ var R=6378137, dLat=(b[0]-a[0])*Math.PI/180, dLon=(b[1]-a[1])*Math.PI/180, la1=a[0]*Math.PI/180, la2=b[0]*Math.PI/180;
    var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)*Math.sin(dLon/2); return 2*R*Math.asin(Math.sqrt(h)); }
  function geoLength(pts){ var d=0; for(var i=1;i<pts.length;i++) d+=hav(pts[i-1],pts[i]); return d; }
  function ringLL(coords){ return coords.map(function(p){ return [p[1],p[0]]; }); }          // [lng,lat] -> [lat,lng]
  function toLL(latlngs){ return latlngs.map(function(p){ return [p.lat,p.lng]; }); }
  function centroidLL(ll){ var la=0,lo=0; ll.forEach(function(p){la+=p[0];lo+=p[1];}); return [la/ll.length, lo/ll.length]; }
  function fmtArea(n){ return Math.round(n).toLocaleString("no")+" m²"; }
  function fmtLen(n){ return Math.round(n).toLocaleString("no")+" m"; }
  function zoneRecompute(z){
    if(z.geometry.type==="Polygon"){ z.area_m2=Math.round(geoArea(ringLL(z.geometry.coordinates[0]))); z.length_m=null; }
    else if(z.geometry.type==="LineString"){ z.length_m=Math.round(geoLength(ringLL(z.geometry.coordinates))); z.area_m2=null; }
    else { z.area_m2=null; z.length_m=null; }
    return z;
  }
  function zoneMeasureStr(z){ return z.area_m2!=null?fmtArea(z.area_m2):z.length_m!=null?fmtLen(z.length_m):"punkt"; }
  function findZone(c,id){ return (c.zones||[]).filter(function(z){return z.id===id;})[0]; }

  /* ---- colours / styling ---- */
  function ZONE_COLOR(z){
    if(z.constraint==="no-go") return {stroke:"#b3261e", fill:"#b3261e"};
    if(z.service==="snow") return z.method==="hand"?{stroke:"#ca8a04",fill:"#eab308"}:{stroke:"#1d4ed8",fill:"#1d4ed8"};
    if(z.service==="grass") return z.method==="edge"?{stroke:"#0f766e",fill:"#0f766e"}:z.method==="gartner"?{stroke:"#b5790b",fill:"#f59e0b"}:{stroke:"#15803d",fill:"#22c55e"};
    if(z.service==="greenery") return {stroke:"#b5790b",fill:"#f59e0b"};
    if(z.service==="cleaning-ext") return {stroke:"#0369a1",fill:"#38bdf8"};
    return {stroke:"#6b7670",fill:"#9ca3af"};
  }
  function zoneStyle(z){ var c=ZONE_COLOR(z); var poly=z.geometry.type==="Polygon";
    return {color:c.stroke, weight:2, opacity:1, fillColor:c.fill, fillOpacity:poly?0.32:0, dashArray:(z.constraint==="no-go"||z.constraint==="delicate")?"6 4":null}; }
  function zoneSwatch(z){ var c=ZONE_COLOR(z); return '<span class="ob-zsw" style="background:'+c.fill+';border-color:'+c.stroke+'"></span>'; }
  function pointIcon(z){ var grit=/strø|grit|salt|kasse/i.test(z.label||""); var snow=z.service==="snow";
    var cls=snow?(grit?"grit":"deponi"):"feat", ic=snow?(grit?"🧂":"❄️"):"📍";
    return L.divIcon({className:"", html:'<div class="ob-zpt '+cls+'">'+ic+'</div>', iconSize:[26,26], iconAnchor:[13,13]}); }
  function prioIcon(p){ return L.divIcon({className:"", html:'<div class="ob-zprio">'+p+'</div>', iconSize:[22,22], iconAnchor:[11,11]}); }
  function bpinIcon(){ return L.divIcon({className:"", html:'<div class="ob-bpin">🏢</div>', iconSize:[30,30], iconAnchor:[15,15]}); }
  function zoneTip(z){ return (esc(z.label||methodLabel(z)||z.service))+' · '+zoneMeasureStr(z)+(z.priority?' · P'+z.priority:'')+(methodLabel(z)?' · '+esc(methodLabel(z)):''); }
  function zoneShort(z){ return (z.priority?'P'+z.priority+' · ':'')+(methodLabel(z)||z.label||'')+(z.area_m2!=null||z.length_m!=null?' · '+zoneMeasureStr(z):''); }
  function zonePopupHTML(z){ return '<div style="min-width:170px"><div style="font-weight:750">'+esc(z.label||methodLabel(z)||z.service)+'</div>'
    +'<div class="muted" style="font-size:12px">'+esc(svcDef(z.service).label)+(methodLabel(z)?' · '+esc(methodLabel(z)):'')+' · '+zoneMeasureStr(z)+'</div>'
    +'<div style="margin-top:8px;display:flex;gap:6px"><button class="ob-mini" data-ob="editZone" data-id="'+z.id+'">✎ Rediger</button><button class="ob-mini no on" data-ob="delZone" data-id="'+z.id+'">🗑 Slett</button></div></div>'; }

  // build Leaflet layers for one zone; opts.interactive => popups (draw map); opts.permanentLabel => permanent tooltip (op maps)
  function zoneToLayers(z, opts){
    opts=opts||{}; var out=[];
    if(z.geometry.type==="Polygon"){
      var ll=ringLL(z.geometry.coordinates[0]); var poly=L.polygon(ll, zoneStyle(z)); out.push(poly);
      if(opts.permanentLabel) poly.bindTooltip(zoneShort(z), {permanent:true, direction:"center", className:"ob-ztip-perm"});
      else poly.bindTooltip(zoneTip(z), {direction:"center", className:"ob-ztip", sticky:true});
      if(z.service==="snow" && z.priority) out.push(L.marker(centroidLL(ll), {interactive:false, icon:prioIcon(z.priority)}));
    } else if(z.geometry.type==="LineString"){
      var lls=ringLL(z.geometry.coordinates); var pl=L.polyline(lls, zoneStyle(z)); out.push(pl);
      pl.bindTooltip(opts.permanentLabel?zoneShort(z):zoneTip(z), {permanent:!!opts.permanentLabel, direction:"top", className:opts.permanentLabel?"ob-ztip-perm":"ob-ztip", sticky:!opts.permanentLabel});
    } else if(z.geometry.type==="Point"){
      var p=z.geometry.coordinates; var mk=L.marker([p[1],p[0]],{interactive:true, icon:pointIcon(z)});
      mk.bindTooltip(zoneTip(z), {direction:"top", className:"ob-ztip"}); out.push(mk);
    }
    if(opts.interactive){ out.forEach(function(layer){ if(layer.bindPopup) layer.bindPopup(zonePopupHTML(z)); }); }
    return out;
  }
  function renderZones(c){
    if(!map) return;
    if(zoneLayer){ zoneLayer.clearLayers(); } else { zoneLayer=L.layerGroup().addTo(map); }
    (c.zones||[]).forEach(function(z){ zoneToLayers(z, {interactive:true}).forEach(function(l){ l.addTo(zoneLayer); }); });
  }
  function refreshZones(c){ renderZones(c); setHTML("ob-zonepanel", zonesPanelHTML(c)); }

  /* ---- draw interaction (inline, no plugin) ---- */
  function drawToolbarHTML(){
    function b(mode,label){ return '<button class="ob-mini'+(drawMode===mode?' on':'')+'" data-ob="drawZone" data-arg="'+mode+'">'+label+'</button>'; }
    return '<span class="ob-drlabel">✏️ Tegn sone:</span>'+b("polygon","▰ Flate")+b("line","／ Linje")+b("point","• Punkt");
  }
  function setDrawTools(){ setHTML("ob-drawtools", drawToolbarHTML()); }
  function startDraw(mode){
    if(!map){ toast("Åpne kartet først"); return; }
    cancelDraw(true); drawMode=mode; drawPts=[];
    try{ map.doubleClickZoom.disable(); }catch(e){} map.getContainer().style.cursor="crosshair"; setDrawTools();
    if(mode==="point"){ setHTML("ob-draw-readout", '<span class="ob-drmeas">Klikk på kartet for å plassere punktet</span><button class="ob-mini" data-ob="drawCancel">Avbryt</button>'); toast("Tegn punkt — klikk på kartet (deponi / strøkasse / feature)"); }
    else { setHTML("ob-draw-readout", '<span class="ob-drmeas">Klikk for å sette punkter…</span><button class="ob-mini" data-ob="drawCancel">Avbryt</button>'); toast(mode==="polygon"?"Tegn flate — klikk hjørnene, dobbeltklikk/Fullfør for å avslutte":"Tegn linje — klikk punkter, dobbeltklikk/Fullfør for å avslutte"); }
  }
  function endDrawMode(){
    drawMode=null; drawPts=[];
    if(drawTemp){ try{map.removeLayer(drawTemp);}catch(e){} drawTemp=null; }
    if(drawVertLayer){ try{map.removeLayer(drawVertLayer);}catch(e){} drawVertLayer=null; }
    if(map){ map.getContainer().style.cursor=""; try{map.doubleClickZoom.enable();}catch(e){} }
    setHTML("ob-draw-readout",""); setDrawTools();
  }
  function cancelDraw(silent){ if(drawMode||drawPts.length){ endDrawMode(); if(!silent) toast("Avbrutt"); } }
  function handleDrawClick(latlng){
    if(drawMode==="point"){ var c=cur(); var geom={type:"Point", coordinates:[latlng.lng, latlng.lat]}; endDrawMode(); openZoneSheet(c, null, geom); return; }
    drawPts.push(latlng); updateDrawTemp();
  }
  function updateDrawTemp(){
    if(drawTemp){ try{map.removeLayer(drawTemp);}catch(e){} drawTemp=null; }
    if(drawVertLayer){ drawVertLayer.clearLayers(); } else { drawVertLayer=L.layerGroup().addTo(map); }
    if(drawMode==="polygon" && drawPts.length>=3) drawTemp=L.polygon(drawPts,{color:"#0f766e",weight:2,dashArray:"5 4",fillOpacity:.12}).addTo(map);
    else if(drawPts.length>=1) drawTemp=L.polyline(drawPts,{color:"#0f766e",weight:2,dashArray:"5 4"}).addTo(map);
    drawPts.forEach(function(p){ L.circleMarker(p,{radius:4,color:"#0f766e",fillColor:"#fff",fillOpacity:1,weight:2}).addTo(drawVertLayer); });
    var txt; if(drawMode==="polygon") txt = drawPts.length>=3?("Areal: "+fmtArea(geoArea(toLL(drawPts)))):("Sett "+(3-drawPts.length)+" punkt(er) til");
    else txt = drawPts.length>=2?("Lengde: "+fmtLen(geoLength(toLL(drawPts)))):"Sett minst 2 punkter";
    setHTML("ob-draw-readout", '<span class="ob-drmeas">'+txt+'</span><button class="ob-mini ok on" data-ob="drawFinish">✓ Fullfør</button><button class="ob-mini" data-ob="drawCancel">Avbryt</button>');
  }
  function finishDraw(){
    if(!drawMode || drawMode==="point") return;
    if(drawMode==="line" && drawPts.length<2){ toast("Linje trenger minst 2 punkter"); return; }
    if(drawMode==="polygon" && drawPts.length<3){ toast("Flate trenger minst 3 punkter"); return; }
    var type=drawMode==="line"?"LineString":"Polygon";
    var coords=drawPts.map(function(p){return [p.lng,p.lat];});
    var geom={type:type, coordinates: type==="Polygon"?[coords.concat([coords[0]])]:coords};
    var c=cur(); endDrawMode(); openZoneSheet(c, null, geom);
  }

  /* ---- tag sheet (uses the shared scrim/sheet DOM) ---- */
  function obSheet(html){ var s=document.getElementById("sheet"); if(!s) return; s.innerHTML=html; document.getElementById("scrim").classList.add("on"); }
  function obCloseSheet(){ var sc=document.getElementById("scrim"); if(sc) sc.classList.remove("on"); }
  function openZoneSheet(c, zone, geom){
    if(!c){ return; }
    pendingZone = zone ? JSON.parse(JSON.stringify(zone)) : { id:null, service:"snow", method:defaultMethod("snow"), priority:null, constraint:"none", label:"", notes:"", geometry:geom, priceLineId:null, completionLog:[] };
    zoneRecompute(pendingZone);
    obSheet(zoneSheetHTML(pendingZone));
  }
  function zoneSheetHTML(pz){
    var ms=METHODS[pz.service]||[];
    var methodSel = ms.length ? '<label>Metode</label><select id="z_method">'+ms.map(function(m){return '<option value="'+m.key+'"'+(pz.method===m.key?' selected':'')+'>'+m.label+'</option>';}).join("")+'</select>' : '';
    var prio = pz.service==="snow" ? '<label>Prioritet (ryddrekkefølge)</label><input id="z_priority" type="number" min="1" step="1" value="'+(pz.priority||"")+'" placeholder="1">' : '';
    var gtype = {Polygon:"Flate",LineString:"Linje",Point:"Punkt"}[pz.geometry.type]||pz.geometry.type;
    return '<h3>'+(pz.id?"Rediger sone":"Ny sone")+' <span class="muted" style="font-size:13px;font-weight:600">· '+gtype+' · '+zoneMeasureStr(pz)+'</span></h3>'
      +'<label>Tjeneste</label><select id="z_service" data-obf="zoneService">'+SERVICE_LIST.map(function(s){return '<option value="'+s.key+'"'+(pz.service===s.key?' selected':'')+'>'+s.swatch+' '+s.label+'</option>';}).join("")+'</select>'
      + methodSel + prio
      + (pz.geometry.type==="Polygon" ? '<label>Areal (m²) — målt, kan justeres (driver til pris)</label><input id="z_area" type="number" min="0" value="'+(pz.area_m2||0)+'">'
         : pz.geometry.type==="LineString" ? '<label>Lengde (m) — målt, kan justeres (driver til pris)</label><input id="z_len" type="number" min="0" value="'+(pz.length_m||0)+'">' : '')
      +'<label>Begrensning</label><select id="z_constraint">'+CONSTRAINTS.map(function(k){return '<option value="'+k.key+'"'+(pz.constraint===k.key?' selected':'')+'>'+k.label+'</option>';}).join("")+'</select>'
      +'<label>Etikett</label><input id="z_label" value="'+esc(pz.label||"")+'" placeholder="f.eks. Hovedplen vest / Deponi">'
      +'<label>Notat</label><textarea id="z_notes" rows="2" placeholder="metode, art/skjøtsel, adkomst…">'+esc(pz.notes||"")+'</textarea>'
      +'<button class="save" data-ob="saveZone">Lagre sone</button>'
      +'<button class="cancel" data-ob="closeObSheet">Avbryt</button>';
  }
  function saveZoneFromSheet(){
    var c=cur(); if(!c || !pendingZone){ obCloseSheet(); return; }
    pendingZone.service = val("z_service") || pendingZone.service;
    var msel=document.getElementById("z_method"); pendingZone.method = msel ? msel.value : null;
    var psel=document.getElementById("z_priority"); pendingZone.priority = psel && psel.value ? parseInt(psel.value,10) : null;
    pendingZone.constraint = val("z_constraint") || "none";
    pendingZone.label = val("z_label"); pendingZone.notes = val("z_notes");
    zoneRecompute(pendingZone);
    // measured quantity is editable (pricing driver) — apply override after geometry recompute
    var av=val("z_area"); if(av!=="" && pendingZone.geometry.type==="Polygon") pendingZone.area_m2=Math.round(parseFloat(av)||0);
    var lv=val("z_len"); if(lv!=="" && pendingZone.geometry.type==="LineString") pendingZone.length_m=Math.round(parseFloat(lv)||0);
    c.zones = c.zones || [];
    var isNew=!pendingZone.id, label=pendingZone.label||svcDef(pendingZone.service).label, meas=zoneMeasureStr(pendingZone);
    if(pendingZone.id){ c.zones = c.zones.map(function(z){ return z.id===pendingZone.id ? pendingZone : z; }); }
    else { pendingZone.id = "z"+uid(); pendingZone.buildingId = c.buildingId || c.id; if(!pendingZone.completionLog) pendingZone.completionLog=[]; c.zones.push(pendingZone); }
    pendingZone=null;
    save(); obCloseSheet(); refreshZones(c);
    // Phase 2: a priced offer recomputes live; a new zone is the one-tap fair upsell
    if(c.offer && c.offer.modules){ recomputeOffer(c); if(ui.step===2) refreshTiered(c);
      toast((isNew?"➕ Lagt til i tilbud: ":"Tilbud oppdatert: ")+label+" · "+meas+" → "+kr(c.offer.totalMonthly)+"/mnd");
    } else { toast("Sone lagret: "+label+" · "+meas); }
  }

  /* ---- zones panel (beside the map) ---- */
  function zonesPanelHTML(c){
    var zs=c.zones||[];
    var body = zs.length ? SERVICE_LIST.filter(function(s){return zs.some(function(z){return z.service===s.key;});}).map(function(s){
      var rows=zs.filter(function(z){return z.service===s.key;}).map(zoneRow).join("");
      return '<div class="ob-zcat" style="color:'+s.stroke+'">'+s.swatch+' '+esc(s.label)+'</div>'+rows;
    }).join("") : '<div class="empty">Ingen tegnede soner ennå — bruk <b>Tegn sone</b> over kartet.</div>';
    return '<div class="card"><div class="ct">Tegnede soner <span class="muted" style="font-weight:600">· målt</span></div>'+body+'</div>';
  }
  function zoneRow(z){
    return '<div class="ob-row"><div class="ob-line-top"><div class="rt">'+zoneSwatch(z)+' '+esc(z.label||methodLabel(z)||z.service)
      +(z.priority?' <span class="chip blue">P'+z.priority+'</span>':'')+(z.constraint&&z.constraint!=="none"?' <span class="chip amber">'+esc(z.constraint)+'</span>':'')+'</div>'
      +'<div class="rp">'+zoneMeasureStr(z)+'</div></div>'
      +'<div class="rd">'+(methodLabel(z)?esc(methodLabel(z)):"—")+(z.notes?' · '+esc(z.notes):'')+'</div>'
      +'<div class="ob-acts"><button class="ob-mini" data-ob="editZone" data-id="'+z.id+'">✎ Rediger</button><button class="ob-mini no on" data-ob="delZone" data-id="'+z.id+'">🗑 Slett</button></div></div>';
  }
  function editZone(id){ var c=cur(); if(!c) return; var z=findZone(c,id); if(!z) return;
    if(map){ try{ var b=L.geoJSON(z.geometry).getBounds(); map.panTo(b.getCenter()); }catch(e){} }
    openZoneSheet(c, z, z.geometry); }
  function delZone(id){ var c=cur(); if(!c) return; c.zones=(c.zones||[]).filter(function(z){return z.id!==id;}); save(); refreshZones(c); toast("Sone slettet"); }

  /* ---- operational maps (read-only, board-grade) ---- */
  function destroyOpMaps(){ for(var k in opMaps){ try{ opMaps[k].remove(); }catch(e){} } opMaps={}; }
  function snowCaption(c){
    var snowItem=(c.checklist||[]).filter(function(it){return it.id==="snow";})[0];
    var fr = snowItem && snowItem.value ? snowItem.value : ">5 cm samme døgn";
    return "Utløser: "+fr+" · brøyting + strøing · prioritert rekkefølge (lavest P-nummer først)";
  }
  function opLegend(kind){
    var items = kind==="snow"
      ? [["#1d4ed8","Maskin"],["#eab308","Hånd"],["#ec4899","Deponi"],["#f97316","Strøkasse"]]
      : [["#22c55e","Klipping"],["#0f766e","Kantklipp"],["#f59e0b","Bed / gartner"],["#b3261e","No-go / ømtålig"]];
    return '<div class="ob-oplegend">'+items.map(function(it){return '<span class="ob-lg"><span class="ob-lgsw" style="background:'+it[0]+'"></span>'+it[1]+'</span>';}).join("")+'</div>';
  }
  function opCardHTML(c, kind, prefix){
    var elId=prefix+"-opmap-"+kind, cardId=prefix+"-opcard-"+kind;
    var title=kind==="snow"?"Operasjonskart – Vinter":"Operasjonskart – Grønt";
    return '<div class="card ob-opcard" id="'+cardId+'">'
      +'<div class="ob-ophead"><div><div class="ob-optitle">'+esc(title)+'</div><div class="ob-opsub">'+esc(c.name)+' · '+esc(c.addr||"")+'</div></div>'
      +'<button class="ob-mini" data-ob="printMap" data-arg="'+cardId+'">🖨 Skriv ut</button></div>'
      +'<div class="ob-opmap" id="'+elId+'"></div>'
      +(kind==="snow"?'<div class="ob-opcap">'+esc(snowCaption(c))+'</div>':'')
      + opLegend(kind)+'</div>';
  }
  function opMapsRow(c, prefix){
    if(!(c.zones && c.zones.length)) return "";
    return '<div class="ob-opmaps">'+opCardHTML(c,"snow",prefix)+opCardHTML(c,"grass",prefix)+'</div>';
  }
  function buildOpMap(c, kind, elId){
    if(!hasLeaflet) return; var el=document.getElementById(elId); if(!el) return;
    if(opMaps[elId]){ try{opMaps[elId].remove();}catch(e){} delete opMaps[elId]; }
    var m=L.map(el,{zoomControl:true, attributionControl:true});
    opMaps[elId]=m;
    L.tileLayer(KARTVERKET,{attribution:"© Kartverket", maxZoom:20}).addTo(m);
    L.marker([c.center.lat,c.center.lon],{interactive:false, keyboard:false, icon:bpinIcon()}).addTo(m);
    var zones=(c.zones||[]).filter(kind==="snow" ? function(z){return z.service==="snow";} : function(z){return z.service==="grass"||z.service==="greenery";});
    var grp=L.featureGroup().addTo(m);
    zones.forEach(function(z){ zoneToLayers(z, {permanentLabel:true}).forEach(function(l){ l.addTo(grp); }); });
    try{ if(grp.getLayers().length) m.fitBounds(grp.getBounds().pad(0.35)); else m.setView([c.center.lat,c.center.lon], c.center.zoom||17); }
    catch(e){ m.setView([c.center.lat,c.center.lon], c.center.zoom||17); }
    setTimeout(function(){ if(opMaps[elId]) opMaps[elId].invalidateSize(); }, 90);
  }
  function printMapCard(cardId){
    var card=document.getElementById(cardId); if(!card) return;
    for(var k in opMaps){ try{ if(card.contains(opMaps[k].getContainer())) opMaps[k].invalidateSize(); }catch(e){} }
    document.body.classList.add("ob-printing"); card.classList.add("ob-print-target");
    var cleanup=function(){ document.body.classList.remove("ob-printing"); card.classList.remove("ob-print-target"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(function(){ window.print(); }, 180);
  }

  /* ---------- geocode + geotag ---------- */
  function geocode(addr, cb){
    if(!addr){ cb(null); return; }
    var url="https://ws.geonorge.no/adresser/v1/sok?sok="+encodeURIComponent(addr)+"&treffPerSide=1";
    fetch(url).then(function(r){return r.json();}).then(function(j){
      var a=j&&j.adresser&&j.adresser[0];
      if(a&&a.representasjonspunkt){ cb({lat:a.representasjonspunkt.lat, lon:a.representasjonspunkt.lon, label:a.adressetekst||addr}); }
      else nominatim(addr,cb);
    }).catch(function(){ nominatim(addr,cb); });
  }
  function nominatim(addr, cb){
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q="+encodeURIComponent(addr))
      .then(function(r){return r.json();}).then(function(j){ cb(j&&j[0]?{lat:+j[0].lat, lon:+j[0].lon, label:j[0].display_name}:null); })
      .catch(function(){ cb(null); });
  }
  function locate(c, addr){
    toast("Looking up address…");
    geocode(addr || c.addr, function(res){
      if(!res){ toast("Geocode failed — pan/zoom the map and tap to place the building manually"); return; }
      c.center={lat:res.lat, lon:res.lon, zoom:18}; save();
      if(map){ map.setView([res.lat,res.lon],18); if(buildingMarker) buildingMarker.setLatLng([res.lat,res.lon]); }
      toast("Centred on "+(res.label||c.addr));
    });
  }
  function geotag(c){
    if(!navigator.geolocation){ toast("Geolocation not supported — tap the map instead"); return; }
    if(!ui.activeLayer){ toast("Pick a layer chip first, then use your location"); return; }
    toast("Requesting your location…");
    navigator.geolocation.getCurrentPosition(function(pos){
      var la=pos.coords.latitude, lo=pos.coords.longitude, acc=Math.round(pos.coords.accuracy||0);
      if(map) map.setView([la,lo], 19);
      dropMarker(c, ui.activeLayer, la, lo, acc);
      toast("📍 Dropped at your location (±"+acc+" m)");
    }, function(err){
      toast("Location unavailable ("+(err&&err.message?err.message:"denied")+") — tap the map to place it manually");
    }, {enableHighAccuracy:true, timeout:8000, maximumAge:0});
  }

  /* ===========================================================================
     OFFER
     =========================================================================== */
  function perL(offer){ return (offer && offer.period==="mnd") ? "mnd" : "år"; }
  // resolve display fields for an offer line (marker-derived lines use LAYERS; checklist lines carry their own)
  function lineDef(l){
    var b=LAYERS[l.layer]||{};
    return { emoji:l.emoji||b.emoji||"•", measure:l.measure||b.measure||"count", unit:l.unit||b.unit||"",
      recordOnly:!!b.recordOnly, compliance:l.compliance||b.compliance||false, statutory:l.statutory||b.statutory||false };
  }
  function checklistLine(it, asUpsell){
    return { id:"L"+uid(), src:"checklist", itemId:it.id, layer:it.layer||null, emoji:it.emoji||catEmoji(it.category),
      category:catKeyLabel(it.category), subtype:it.subtype||it.label,
      scope:it.subtype||it.label, frequency:it.freq||"", qty:(it.value==null?"":it.value), unit:"", measure:"count",
      price:it.price||0, recurring:!it.oneOff, oneOff:!!it.oneOff, inScope:!asUpsell,
      compliance:!!it.compliance, deliveredBy:it.deliveredBy||"in-house", partnerName:it.partnerName||null,
      review:{decision:null, comment:""} };
  }
  /* ===========================================================================
     PRICING ENGINE (Phase 2, docs 46/47) — drive price from measured zones + counts
     RATES = the editable "blue input cells"; reverse-engineered so Holtet's drivers
     compute ≈ kr 16 558/mnd (doc 37 signed price = the QA anchor).
     =========================================================================== */
  var RATES = {
    snow:     { machine_m2_mnd: 0.48, hand_per_entry_mnd: 86 },   // source: Holtet vinter ≈ kr 1 800/mnd over 2 486 m² maskin + 7 innganger hånd
    grass:    { mow_m2_mnd: 0.42, edge_m_mnd: 6 },                // source: Holtet klipp ≈ kr 1 400/mnd over 3 357 m²; kant nominell
    greenery: { hedge_m_year: 200, gartner_bed_m2_year: 90 },     // source: hekk 45 m × 200 ≈ kr 9 000/år (2×/sesong); bed nominell
    cleaning: { per_oppgang_floor_week: 60, per_heis_week: 35 },  // source: Holtet renhold ≈ kr 4 800/mnd — 4 oppg × 4 etg ukentlig + 4 heis
    base:     { vaktmester_round_mnd: 4200 }                      // source: Holtet ukentlig vaktmesterrunde + tilsyn (doc 37)
  };
  var WPM = 52/12;  // weeks per month
  var MOD_TITLES = { base:"Drift / vaktmester", cleaning:"Renhold", snow:"Vintertjeneste", grass:"Grønt – klipp", greenery:"Grønt – skjøtsel", other:"Annet" };
  var MOD_ORDER = ["base","cleaning","snow","grass","greenery","other"];
  function layerToService(layer){ return ({grass:"grass", snow:"snow", gritting:"snow", laundry:"cleaning", stairwell:"cleaning", facade:"cleaning",
    greenery:"greenery", beds:"greenery", tech:"base", fire:"base", lift:"base", entrance:"base", playground:"base", panel:"base", valve:"base"})[layer] || "other"; }
  function ckVal(c,id){ var it=(c.checklist||[]).filter(function(x){return x.id===id;})[0]; return it?it.value:null; }
  function keptVal(c,id,fb){ var it=(c.checklist||[]).filter(function(x){return x.id===id;})[0]; return (it&&it.price)?it.price:fb; }
  function driverCounts(c){
    var entry=(c.markers||[]).filter(function(m){return m.layer==="entrance";}).length;
    return { oppganger: parseInt(ckVal(c,"oppganger"),10) || entry || 4,
             heiser: parseInt(ckVal(c,"heiser"),10) || 0,
             entryways: entry || parseInt(ckVal(c,"oppganger"),10) || 4,
             floors: c.floors || 4 };
  }
  function zoneAgg(c){
    var z=c.zones||[];
    function sa(f){ return z.filter(f).reduce(function(s,x){return s+(x.area_m2||0);},0); }
    function sl(f){ return z.filter(f).reduce(function(s,x){return s+(x.length_m||0);},0); }
    return { snowMachine:sa(function(x){return x.service==="snow"&&x.method==="machine";}),
      mow:sa(function(x){return x.service==="grass"&&(x.method==="mow"||!x.method);}),
      edge:sl(function(x){return x.service==="grass"&&x.method==="edge";}),
      hedgeZones:z.filter(function(x){return x.service==="greenery"&&x.geometry.type==="LineString";}),
      bedZones:z.filter(function(x){return x.service==="greenery"&&x.geometry.type==="Polygon";}),
      firstId:function(svc,meth){ var m=z.filter(function(x){return x.service===svc&&(!meth||x.method===meth);})[0]; return m?m.id:null; } };
  }
  // line factory. price === final (kept in sync; getters don't survive JSON round-trips).
  function oLine(o){
    return { id:o.id, src:o.src||"computed", service:o.service, role:o.role||"", label:o.label, subtype:o.label,
      category:o.category||MOD_TITLES[o.service]||"", emoji:o.emoji||"•", layer:o.layer||null, zoneId:o.zoneId||null,
      qty:(o.qty==null?null:o.qty), unit:o.unit||"", rate:(o.rate==null?null:o.rate), cadence:o.cadence||"",
      computed:Math.round(o.computed||0), final:Math.round((o.final!=null?o.final:o.computed)||0), overridden:!!o.overridden,
      price:Math.round((o.final!=null?o.final:o.computed)||0),
      frequency:o.frequency||o.cadence||"", inScope:(o.inScope!==false), deliveredBy:o.deliveredBy||"in-house", partnerName:o.partnerName||null,
      compliance:!!o.compliance, oneOff:!!o.oneOff, measure:o.measure||"count", review:{decision:null, comment:""} };
  }
  function computeOffer(c){
    var prev=c.offer, per=c.period||"år";
    var prevLine={}, prevMod={};
    if(prev&&prev.modules){ prev.modules.forEach(function(m){ prevMod[m.service]={included:m.included, startDate:m.startDate, indexationPct:m.indexationPct, cap:m.cap};
      m.lines.forEach(function(l){ prevLine[l.id]={final:l.final, overridden:l.overridden}; }); }); }
    function withPrev(l){ var p=prevLine[l.id]; if(p&&p.overridden){ l.final=p.final; l.price=p.final; l.overridden=true; } return l; }
    var lines=[], optionLines=[];

    if(c.checklist && c.checklist.length){
      // ---- driver model (zones + counts + kept non-spatial checklist lines) ----
      var n=driverCounts(c), z=zoneAgg(c), id=c.id+":";
      // base
      lines.push(withPrev(oLine({id:id+"base:round", service:"base", role:"round", label:"Ukentlig vaktmesterrunde + tilsyn", emoji:"🧰", qty:1, unit:"runde", rate:RATES.base.vaktmester_round_mnd, cadence:"Ukentlig", computed:RATES.base.vaktmester_round_mnd})));
      lines.push(withPrev(oLine({id:id+"base:teknisk", service:"base", role:"teknisk", label:"Teknisk rom – tilsyn", emoji:"🔧", cadence:"Månedlig", computed:keptVal(c,"water",491)})));
      // cleaning (computed from counts) + mats (kept, partner)
      var cl=Math.round(n.oppganger*n.floors*RATES.cleaning.per_oppgang_floor_week*WPM);
      lines.push(withPrev(oLine({id:id+"cleaning:opp", service:"cleaning", role:"opp", label:"Trappevask "+n.oppganger+" oppg × "+n.floors+" etg", emoji:"🧹", qty:n.oppganger*n.floors, unit:"etg/uke", rate:RATES.cleaning.per_oppgang_floor_week, cadence:"Ukentlig", computed:cl})));
      if(n.heiser>0){ var he=Math.round(n.heiser*RATES.cleaning.per_heis_week*WPM);
        lines.push(withPrev(oLine({id:id+"cleaning:heis", service:"cleaning", role:"heis", label:"Heisrenhold "+n.heiser+" heis", emoji:"🛗", qty:n.heiser, unit:"heis/uke", rate:RATES.cleaning.per_heis_week, cadence:"Ukentlig", computed:he}))); }
      lines.push(withPrev(oLine({id:id+"cleaning:mats", service:"cleaning", role:"mats", label:"Inngangsmatter (8 stk)", emoji:"🧺", cadence:"Månedlig", computed:keptVal(c,"mats",1200), deliveredBy:"partner", partnerName:"Dørmatte Gutta AS"})));
      // snow (machine zone + hand by entryways)
      if(z.snowMachine>0){ lines.push(withPrev(oLine({id:id+"snow:machine", service:"snow", role:"machine", label:"Maskinell brøyting", emoji:"❄️", qty:z.snowMachine, unit:"m²", rate:RATES.snow.machine_m2_mnd, cadence:"Per snøfall >5 cm", computed:z.snowMachine*RATES.snow.machine_m2_mnd, zoneId:z.firstId("snow","machine")}))); }
      lines.push(withPrev(oLine({id:id+"snow:hand", service:"snow", role:"hand", label:"Manuell rydding + strøing ("+n.entryways+" innganger)", emoji:"🧂", qty:n.entryways, unit:"inngang", rate:RATES.snow.hand_per_entry_mnd, cadence:"Per snøfall / is", computed:n.entryways*RATES.snow.hand_per_entry_mnd, zoneId:z.firstId("snow","hand")})));
      // grass (mow zones + edge)
      if(z.mow>0){ lines.push(withPrev(oLine({id:id+"grass:mow", service:"grass", role:"mow", label:"Gressklipping", emoji:"🌿", qty:z.mow, unit:"m²", rate:RATES.grass.mow_m2_mnd, cadence:"Ukentlig i vekstsesong", computed:z.mow*RATES.grass.mow_m2_mnd, zoneId:z.firstId("grass","mow")}))); }
      if(z.edge>0){ lines.push(withPrev(oLine({id:id+"grass:edge", service:"grass", role:"edge", label:"Kantklipp", emoji:"✂️", qty:z.edge, unit:"m", rate:RATES.grass.edge_m_mnd, cadence:"Sesong", computed:z.edge*RATES.grass.edge_m_mnd, zoneId:z.firstId("grass","edge")}))); }
      // greenery (kept spraying portion recurring; hedge/beds → option lines)
      lines.push(withPrev(oLine({id:id+"greenery:ovrig", service:"greenery", role:"ovrig", label:"Grøntområde – sprøyting, bed, trær", emoji:"🌳", cadence:"Sesong", computed:keptVal(c,"weeds",2667)})));
      z.hedgeZones.forEach(function(zz,i){ var yr=Math.round((zz.length_m||0)*RATES.greenery.hedge_m_year);
        optionLines.push(oLine({id:id+"opt:hedge"+i, service:"greenery", role:"hedge", label:"Beskjæring hekk ("+zz.label+")", emoji:"🌳", qty:zz.length_m, unit:"m", rate:RATES.greenery.hedge_m_year, cadence:"2×/år", computed:yr, oneOff:false, zoneId:zz.id})); zz.priceLineId=id+"opt:hedge"+i; });
      z.bedZones.forEach(function(zz,i){ var yr=Math.round((zz.area_m2||0)*RATES.greenery.gartner_bed_m2_year);
        optionLines.push(oLine({id:id+"opt:bed"+i, service:"greenery", role:"bed", label:"Gartner bed ("+zz.label+")", emoji:"🌷", qty:zz.area_m2, unit:"m²", rate:RATES.greenery.gartner_bed_m2_year, cadence:"Sesong", computed:yr, zoneId:zz.id})); zz.priceLineId=id+"opt:bed"+i; });
      // checklist upsells → option/per-gang lines (separate from recurring total)
      (c.checklist||[]).filter(function(it){return it.scope==="upsell" && (it.price||0)>0;}).forEach(function(it,i){
        optionLines.push(oLine({id:id+"opt:up"+i, service:layerToService(it.id)||"other", role:"upsell", label:it.subtype||it.label, emoji:it.emoji||"⬆", qty:null, computed:it.price, oneOff:!!it.oneOff, cadence:it.oneOff?"engangs":"løpende"})); });
      // link zone priceLineId for the recurring zone-driven lines
      lines.forEach(function(l){ if(l.zoneId){ var zz=findZone(c,l.zoneId); if(zz) zz.priceLineId=l.id; } });

    } else {
      // ---- marker model (Solbakken etc.) — keep existing prices, grouped into modules ----
      (c.markers||[]).filter(function(m){ return !LAYERS[m.layer].recordOnly; }).forEach(function(m){
        var d=LAYERS[m.layer];
        lines.push(withPrev(oLine({id:c.id+":mk:"+m.id, service:layerToService(m.layer), role:"marker", label:d.label, category:catLabel(m.layer), emoji:d.emoji,
          qty:m.qty, unit:(m.unit||d.unit), rate:d.rate, cadence:m.frequency||d.freq, computed:m.price, frequency:m.frequency||d.freq, inScope:m.inScope, measure:d.measure, compliance:d.compliance })));
      });
    }

    // group into modules
    var modules=MOD_ORDER.map(function(svc){
      var ml=lines.filter(function(l){return l.service===svc;}); if(!ml.length) return null;
      var pm=prevMod[svc]||{};
      return { service:svc, title:MOD_TITLES[svc], lines:ml,
        included:(pm.included!=null?pm.included:true),
        startDate:pm.startDate||(svc==="snow"?"15.11.2026":"01.01.2026"),
        indexationPct:(pm.indexationPct!=null?pm.indexationPct:2.5), cap:(pm.cap!=null?pm.cap:3), subtotal:0 };
    }).filter(Boolean);

    c.offer = { version:(prev?prev.version:1), createdAt:nowStr(), period:per, modules:modules, optionLines:optionLines,
      lines:[], upsells:optionLines, totalMonthly:0, totalYearly:0, travel:0, terms:c.terms||null,
      coverNote:(prev&&prev.coverNote) ? prev.coverNote : (per==="mnd"
        ? "Månedlig serviceavtale for "+c.name+" — priset fra bygningens målte arealer og talte enheter (ikke rundsum). Hver tjeneste er en egen modul som kan velges bort separat. Opsjoner holdes utenfor grunnbeløpet."
        : "Service plan for "+c.name+" — computed from measured zones + counts; each service is a severable module.") };
    if(!c.offerHistory) c.offerHistory=[];
    rebuildOfferFlat(c);
    return c.offer;
  }
  function rebuildOfferFlat(c){
    var o=c.offer; if(!o||!o.modules) return;
    o.modules.forEach(function(m){ m.lines.forEach(function(l){ l.price=l.final; }); m.subtotal=m.lines.reduce(function(s,l){return s+(l.final||0);},0); });
    var incl=o.modules.filter(function(m){return m.included;});
    o.lines=[]; incl.forEach(function(m){ m.lines.forEach(function(l){ if(l.review.decision!=="remove") o.lines.push(l); }); });
    var sum=incl.reduce(function(s,m){return s+m.subtotal;},0);
    if(o.period==="mnd"){ o.totalMonthly=Math.round(sum); o.totalYearly=Math.round(sum*12); }
    else { o.totalYearly=Math.round(sum); o.totalMonthly=Math.round(sum/12); }
  }
  function recomputeOffer(c){ if(c&&c.offer&&c.offer.modules){ computeOffer(c); save(); } }
  function generateOffer(c){
    computeOffer(c);
    logEvent(c,"Tilbud v"+c.offer.version+" beregnet — "+c.offer.modules.length+" moduler, "+kr(c.offer.totalMonthly)+"/mnd ("+kr(c.offer.totalYearly)+"/år)");
    save();
  }
  function offerTotal(offer){
    if(!offer) return 0;
    return offer.lines.filter(function(l){return l.review.decision!=="remove";}).reduce(function(s,l){return s+(l.price||0);},0)+(offer.travel||0);
  }
  function upsellTotal(offer){
    if(!offer) return 0;
    return offer.lines.filter(function(l){return !l.inScope && l.review.decision!=="remove";}).reduce(function(s,l){return s+(l.price||0);},0);
  }
  function sendOffer(c){
    if(!c.offer) generateOffer(c);
    setStage(c,"Offer sent");
    // snapshot the version the board sees (baseline for the diff)
    c.offerHistory=[{version:c.offer.version, at:nowStr(), lines:clone(c.offer.lines), total:offerTotal(c.offer), diff:[]}];
    logEvent(c,"Offer sent + board access granted to "+(c.contacts[0]?c.contacts[0].email:"the board"));
    save();
    toast("Offer sent — board access granted (email + magic link)");
    ui.openId=c.id; ui.step=3;
    OnSite.go("board");
  }

  /* ---------- board review (two channels) ---------- */
  function setDecision(c, lineId, decision){
    var l=findLine(c,lineId); if(!l) return;
    l.review.decision = (l.review.decision===decision ? null : decision);
    save();
    repaintBoard(c);
  }
  function approveAll(c){
    c.offer.lines.forEach(function(l){ l.review.decision="approve"; });
    save(); repaintBoard(c);
    toast("All lines marked approved — send your response to confirm");
  }
  function submitBoard(c){
    var reqs=[];
    c.offer.lines.forEach(function(l){
      var d=l.review.decision;
      if(d && d!=="approve"){
        reqs.push({ id:"R"+uid(), lineId:l.id, layer:l.layer, scope:l.scope, type:d,
          comment:l.review.comment||"", source:"in-app", status:"open", ts:nowStr() });
      }
    });
    if(!reqs.length){ agree(c, "Board approved the offer as sent (in-app)"); return; }
    c.changeRequests=(c.changeRequests||[]).concat(reqs);
    setStage(c,"Changes requested");
    logEvent(c,"Board responded in-app — "+reqs.length+" change request(s)");
    save();
    toast("Sent to office — "+reqs.length+" change request(s) raised");
    ui.openId=c.id; ui.step=4; OnSite.go("sales");
  }
  function ingestEmail(c, text){
    text=(text||"").trim(); if(!text){ toast("Paste the board's email reply first"); return; }
    var lc=text.toLowerCase();
    var KW={ playground:["playground","lekeplass","lekeapparat"], lift:["lift","elevator","heis"],
      snow:["snow","brøyt","snø","winter","vinter"], grass:["grass","lawn","gress","plen","mow","mowing","klipp"],
      laundry:["laundry","vaskeri","vaskerom"], stairwell:["trappevask","trapp","renhold","cleaning","clean"],
      facade:["fasade","facade"], fire:["fire","brann","extinguisher","slukker","detector","hms"],
      tech:["tech","teknisk"], greenery:["hedge","hekk","beskjær","greenery","busk","shrub"],
      beds:["bed","beplantning","blomst","plant"], gritting:["strø","salt","grit"], roofsafety:["tak","taksikring","roof"] };
    function tone(){
      if(/remove|drop|don'?t need|ikke behov|fjern|cut from|take.*off/.test(lc)) return "remove";
      if(/cheap|expensive|too high|price|pris|dyrt|reduce|lower|discount|rabatt/.test(lc)) return "change";
      if(/\?|why|how come|hvorfor|question|wonder|lurer/.test(lc)) return "question";
      return "change";
    }
    var t=tone();
    var reqs=[], matched={};
    c.offer.lines.forEach(function(l){
      var kws=KW[l.layer]||[];
      for(var i=0;i<kws.length;i++){ if(lc.indexOf(kws[i])>=0){ if(matched[l.id]) break; matched[l.id]=1;
        reqs.push({id:"R"+uid(), lineId:l.id, layer:l.layer, scope:l.scope, type:t, comment:'From email: "'+text.slice(0,140)+(text.length>140?'…':'')+'"', source:"email", status:"open", ts:nowStr()}); break; } }
    });
    var approveish = /\bapprove|approved|accept|greit|ok\b|fine|good|går bra|enig|happy|looks good/.test(lc);
    if(!reqs.length){
      if(approveish){ agree(c,"Board approved via email reply"); return; }
      reqs.push({id:"R"+uid(), lineId:null, layer:null, scope:"General", type:"change", comment:'From email: "'+text.slice(0,160)+(text.length>160?'…':'')+'"', source:"email", status:"open", ts:nowStr()});
    }
    c.changeRequests=(c.changeRequests||[]).concat(reqs);
    setStage(c,"Changes requested");
    logEvent(c,"Email reply ingested — "+reqs.length+" change request(s) created");
    save();
    toast("Email parsed into "+reqs.length+" change request(s)");
    ui.openId=c.id; ui.step=4; OnSite.go("sales");
  }

  /* ---------- updated offer (v2) + diff ---------- */
  function declineReq(c, reqId){
    var r=findReq(c,reqId); if(!r) return;
    var reason=window.prompt("Decline this request — reason for the board:", "Outside agreed scope");
    if(reason===null) return;
    r.status="declined"; r.reason=reason; save(); repaintSales();
  }
  function removeLine(c, lineId){
    if(!c.offer) return;
    c.offer.lines=c.offer.lines.filter(function(l){return l.id!==lineId;});
    (c.changeRequests||[]).forEach(function(r){ if(r.lineId===lineId && r.status==="open"){ r.status="resolved"; } });
    save(); repaintSales(); toast("Line removed from the offer");
  }
  function resolveReq(c, reqId){ var r=findReq(c,reqId); if(r){ r.status="resolved"; save(); repaintSales(); } }
  function computeDiff(oldLines, newLines){
    var out=[], oldById={}, newById={};
    oldLines.forEach(function(l){oldById[l.id]=l;});
    newLines.forEach(function(l){newById[l.id]=l;});
    newLines.forEach(function(l){
      var o=oldById[l.id], nm=l.subtype||l.scope;
      if(!o){ out.push({type:"add", text:"Lagt til — "+lineDef(l).emoji+" "+nm+" ("+kr(l.price)+")"}); return; }
      var ch=[];
      if((o.price||0)!==(l.price||0)) ch.push("pris "+kr(o.price)+" → "+kr(l.price));
      if((o.qty||0)!==(l.qty||0)) ch.push("antall "+o.qty+" → "+l.qty);
      if((o.scope||"")!==(l.scope||"")) ch.push("scope “"+o.scope+"” → “"+l.scope+"”");
      if((o.frequency||"")!==(l.frequency||"")) ch.push("freq “"+o.frequency+"” → “"+l.frequency+"”");
      if(ch.length) out.push({type:"ch", text:lineDef(l).emoji+" "+nm+": "+ch.join(", ")});
    });
    oldLines.forEach(function(o){ if(!newById[o.id]) out.push({type:"rm", text:"Fjernet — "+lineDef(o).emoji+" "+(o.subtype||o.scope)+" ("+kr(o.price)+")"}); });
    return out;
  }
  function issueV2(c){
    var base=c.offerHistory[c.offerHistory.length-1];
    var diff=computeDiff(base.lines, c.offer.lines);
    if(!diff.length){ toast("No changes yet — edit the affected lines first"); return; }
    c.offer.version = (c.offer.version||1)+1;
    c.offer.createdAt = nowStr();
    c.offer.lines.forEach(function(l){ l.review={decision:null, comment:""}; });
    c.offerHistory.push({version:c.offer.version, at:nowStr(), lines:clone(c.offer.lines), total:offerTotal(c.offer), diff:diff});
    (c.changeRequests||[]).forEach(function(r){ if(r.status==="open") r.status="resolved"; });
    setStage(c,"Offer sent");
    logEvent(c,"Tilbud v"+c.offer.version+" sendt på nytt ("+diff.length+" endring(er), nå "+kr(offerTotal(c.offer))+"/"+perL(c.offer)+")");
    save();
    toast("Offer v"+c.offer.version+" issued and re-sent to the board");
    ui.step=3; OnSite.go("board");
  }
  function agree(c, why){
    setStage(c,"Agreed");
    logEvent(c, why||"Board agreed the offer");
    save();
    toast("✅ Agreed — ready to go live");
    ui.openId=c.id; ui.step=5; OnSite.go("sales");
  }

  /* ===========================================================================
     GO-LIVE — derive tasks / plans / compliance / building (zero re-entry)
     =========================================================================== */
  function goLive(c){
    var st=S();
    // 1. building record (reuse existing by name, else create)
    var b=(st.buildings||[]).filter(function(x){return x.name.toLowerCase()===c.name.toLowerCase();})[0];
    if(!b){
      b={ id:(c.id+"-bld"), name:c.name, addr:c.addr, code:(c.accessNote||"").replace(/\D/g,"").slice(0,4)||"0000",
          note:(c.accessNote||"")+" "+(c.contacts[0]?("Contact: "+c.contacts[0].name):"") };
      (st.buildings=st.buildings||[]).push(b);
    }
    c.buildingId=b.id;
    var active=c.offer.lines.filter(function(l){return l.review.decision!=="remove";});
    var nPlan=0, nTask=0, nComp=0, opCount=0;
    // 2. day-1 walkthrough task
    st.items.push({id:uid(), kind:"task", bld:b.id, title:"🔑 Day 1 — key handover & site walkthrough", detail:"Onboarding from agreed offer for "+c.name+". Meet "+(c.contacts[0]?c.contacts[0].name:"the board")+".", status:"todo", billable:false, hours:1, time:"08:00", who:"Martin", proof:null});
    nTask++;
    // 3. each recurring zone → service plan (+ compliance routine / day-1 task)
    var per = c.offer.period==="mnd" ? "mnd" : "år";
    active.forEach(function(l){
      var d=lineDef(l), cl=l.category||catLabel(l.layer), sub=l.subtype||d.emoji;
      var deliv = l.deliveredBy==="partner" ? (" · levert av "+(l.partnerName||"partner")) : (l.inScope?"":" · lagt til som upsell");
      st.items.push({ id:uid(), kind:"plan", bld:b.id,
        title:d.emoji+" "+cl+" → "+sub, detail:(l.frequency||"")+" · "+kr(l.price)+"/"+per+deliv+" — fra avtalt tilbud",
        status:"approved", billable:true, cost:l.price, hours:0, time:"—", who:"System", proof:null });
      nPlan++;
      if(d.compliance){
        st.items.push({ id:uid(), kind:"task", bld:b.id,
          title:"📋 "+sub, detail:"Statutory routine"+(d.statutory?" (NS / certified partner)":"")+" — schedule first inspection.",
          status:"todo", billable:true, hours:0.5, time:"—", who:"System", proof:null });
        nComp++;
      } else if(opCount<2){
        st.items.push({ id:uid(), kind:"task", bld:b.id,
          title:"▶ Day-1: "+sub, detail:"Day-1 occurrence from the service plan ("+(l.frequency||"løpende")+").",
          status:"todo", billable:true, hours:1, time:"09:00", who:"Martin", proof:null });
        nTask++; opCount++;
      }
    });
    // statutory compliance routines auto-loaded in Step 0 (lift 2-yr, sprinkler annual, fire round)
    (c.compliance||[]).forEach(function(r){
      st.items.push({ id:uid(), kind:"task", bld:b.id, title:"📋 "+r.label,
        detail:"Lovpålagt rutine (auto-lastet i Step 0) — planlegg første kontroll.",
        status:"todo", billable:true, hours:0.5, time:"—", who:"System", proof:null });
      nComp++;
    });
    // 4. handover pack
    c.handover={ createdAt:nowStr(), building:b.name, addr:c.addr, access:c.accessNote||"",
      contacts:c.contacts.slice(), planValue:offerTotal(c.offer),
      zones:active.length, systems:active.filter(function(l){return lineDef(l).compliance;}).length,
      plans:nPlan, tasks:nTask, compliance:nComp };
    setStage(c,"Live"); c.enrichment=true;
    logEvent(c,"🚀 Went live — "+nPlan+" service plans, "+(nTask+nComp)+" day-1 tasks, building record created");
    save();
    toast("🚀 Live! "+nPlan+" plans + "+(nTask+nComp)+" tasks now in the Field/Office day app");
    ui.step=5; render();
  }

  /* ===========================================================================
     RENDER — pipeline + wizard
     =========================================================================== */
  /* ===========================================================================
     SKJØTSELSPLAN / FREQUENCY ENGINE (doc 19) — expand line cadences into dated instances
     =========================================================================== */
  var VEKST_START=[4,20], VEKST_END=[10,15];          // vekstsesong ≈ 20 Apr – 15 Oct
  var EVT_SNOW={type:"event", season:"winter", events:[{name:"Snøbrøyting (>5 cm)", trigger:"Registrer snøfall >5 cm"},{name:"Strøing ved is", trigger:"Registrer is / glatt føre"}]};
  // explicit cadence map for the doc-38 residential-template line ids
  var SCHEDULE_MAP = {
    round:    {type:"weekly"},
    oppganger:{type:"weekly"},
    heiser:   {type:"weekly"},
    glass:    {type:"weekly"},
    mats:     {type:"monthly"},
    weeds:    {type:"nPerYear", count:3, season:true},          // spraying 3×/sesong
    beds:     {type:"seasonal", windows:[[[4,1],[4,30]]]},       // vårrydding
    svalg:    {type:"seasonal", windows:[[[4,1],[4,30]]]},       // svalganger vår
    taps:     {type:"seasonal", windows:[[[4,10],[4,20]],[[10,1],[10,10]]]}, // vår/høst
    hedges:   {type:"seasonal", windows:[[[5,1],[7,15]],[[9,1],[10,31]]]},   // mai–medio juli, sep–okt
    lawn:     {type:"growingSeason"},                            // mowing ukentlig i vekstsesong
    paths:    {type:"dateAnchored", anchor:"before17mai"},
    garage:   {type:"dateAnchored", anchor:"beforeSthans"},
    roof:     {type:"dateAnchored", anchor:"autumn"},
    snow:     EVT_SNOW
  };
  var COMPLIANCE_DUE = {
    "Heiskontroll (2-årlig)":  {month:9,  day:15, type:"intervalYears", years:2},
    "Sprinkler — årskontroll": {month:5,  day:5,  type:"annual"},
    "Brannvernrunde":          {month:11, day:10, type:"annual"}
  };
  function layerSchedule(layer){
    return ({
      grass:{type:"growingSeason"}, snow:EVT_SNOW, gritting:{type:"event", season:"winter", events:[{name:"Strøing ved is", trigger:"Registrer is / glatt føre"}]},
      laundry:{type:"weekly"}, stairwell:{type:"weekly"}, facade:{type:"seasonal", windows:[[[5,1],[5,31]]]},
      greenery:{type:"seasonal", windows:[[[5,1],[7,15]],[[9,1],[10,31]]]}, beds:{type:"seasonal", windows:[[[4,1],[4,30]]]},
      tech:{type:"monthly"}, fire:{type:"annual", dueMonth:11, dueDay:10},
      lift:{type:"intervalYears", years:2, dueMonth:9, dueDay:15}, playground:{type:"annual", dueMonth:5, dueDay:1}
    })[layer] || {type:"monthly"};
  }
  function freqText(s){
    switch(s.type){
      case "weekly": return "ukentlig"; case "monthly": return "månedlig"; case "nPerYear": return s.count+"×/år";
      case "seasonal": return "sesong ("+s.windows.length+" vindu)"; case "growingSeason": return "ukentlig i vekstsesong";
      case "dateAnchored": return {before17mai:"før 17. mai", beforeSthans:"før st.hans", autumn:"høst", spring:"vår"}[s.anchor]||"årlig";
      case "intervalYears": return s.years+"-årlig"; case "annual": return "årlig"; case "event": return "beredskap";
    } return "";
  }
  /* ---- date helpers (browser Date is fine here) ---- */
  function refDate(){ return ui.refMs!=null ? new Date(ui.refMs) : new Date(); }
  function pad2(n){ return (n<10?"0":"")+n; }
  function iso(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
  function addDays(d,n){ var x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
  function mondayOf(d){ return addDays(d, -((d.getDay()+6)%7)); }
  function ymd(y,m,day){ return new Date(y, m-1, day); }
  function inRange(d,from,to){ return d.getTime()>=from.getTime() && d.getTime()<=to.getTime(); }
  var MON_NO=["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"];
  function dateLabel(d){ return d.getDate()+". "+MON_NO[d.getMonth()]; }
  function inGrowing(d){ var m=d.getMonth()+1, day=d.getDate();
    return ((m>VEKST_START[0])||(m===VEKST_START[0]&&day>=VEKST_START[1])) && ((m<VEKST_END[0])||(m===VEKST_END[0]&&day<=VEKST_END[1])); }
  function isoWeek(d){ var x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); var dn=(x.getUTCDay()+6)%7; x.setUTCDate(x.getUTCDate()-dn+3); var f=new Date(Date.UTC(x.getUTCFullYear(),0,4)); return 1+Math.round(((x-f)/86400000-3+((f.getUTCDay()+6)%7))/7); }

  function expandLine(line, from, to){
    var s=line.schedule, out=[], y0=from.getFullYear(), y1=to.getFullYear();
    function push(d){ if(inRange(d,from,to)) out.push({lineId:line.lineId, building:line.building, title:line.title, category:line.category, zone:line.zone, partner:line.partner, statutory:line.statutory, date:iso(d), freq:freqText(s)}); }
    if(s.type==="weekly"){ for(var d=mondayOf(from); d.getTime()<=to.getTime(); d=addDays(d,7)) push(addDays(d,2)); }
    else if(s.type==="growingSeason"){ for(var d2=mondayOf(from); d2.getTime()<=to.getTime(); d2=addDays(d2,7)){ var w=addDays(d2,2); if(inGrowing(w)) push(w); } }
    else if(s.type==="monthly"){ for(var y=y0;y<=y1;y++) for(var m=1;m<=12;m++) push(ymd(y,m,1)); }
    else if(s.type==="nPerYear"){ for(var y3=y0;y3<=y1;y3++){ var st0=s.season?ymd(y3,VEKST_START[0],VEKST_START[1]):ymd(y3,1,1), en=s.season?ymd(y3,VEKST_END[0],VEKST_END[1]):ymd(y3,12,31); for(var i=0;i<s.count;i++) push(new Date(st0.getTime()+((i+0.5)/s.count)*(en.getTime()-st0.getTime()))); } }
    else if(s.type==="seasonal"){ for(var y4=y0;y4<=y1;y4++) s.windows.forEach(function(wd){ push(ymd(y4,wd[0][0],wd[0][1])); }); }
    else if(s.type==="dateAnchored"){ var a={before17mai:[5,10], beforeSthans:[6,20], autumn:[10,10], spring:[4,15]}[s.anchor]||[6,1]; for(var y5=y0;y5<=y1;y5++) push(ymd(y5,a[0],a[1])); }
    else if(s.type==="annual"||s.type==="intervalYears"){ for(var y6=y0;y6<=y1;y6++) push(ymd(y6, s.dueMonth||6, s.dueDay||1)); }
    return out;
  }
  function scheduleLines(client){
    var out=[], bld=client.name;
    if(client.checklist&&client.checklist.length){
      client.checklist.filter(function(it){return it.scope==="in" && SCHEDULE_MAP[it.id];}).forEach(function(it){
        out.push({ lineId:client.id+":"+it.id, building:bld, title:it.subtype||it.label, category:catKeyLabel(it.category), zone:it.zone, schedule:SCHEDULE_MAP[it.id], partner:(it.deliveredBy==="partner"?it.partnerName:null) });
      });
    } else {
      (client.markers||[]).filter(function(m){return m.inScope && !LAYERS[m.layer].recordOnly;}).forEach(function(m){
        out.push({ lineId:client.id+":"+m.id, building:bld, title:LAYERS[m.layer].label, category:catLabel(m.layer), zone:0, schedule:layerSchedule(m.layer), partner:null });
      });
    }
    (client.compliance||[]).forEach(function(r,i){
      var due=COMPLIANCE_DUE[r.label]||{month:6,day:1,type:"annual"};
      out.push({ lineId:client.id+":comp"+i, building:bld, title:r.label, category:"Eiendomsdrift", zone:6, statutory:true, schedule:{type:due.type, years:due.years, dueMonth:due.month, dueDay:due.day} });
    });
    return out;
  }
  function liveClients(){ return customers().filter(function(c){return c.stage==="Live";}); }
  function liveLines(){ var a=[]; liveClients().forEach(function(c){ a=a.concat(scheduleLines(c)); }); return a; }
  function generateInstances(lines, from, to){ var out=[]; lines.filter(function(l){return l.schedule.type!=="event";}).forEach(function(l){ out=out.concat(expandLine(l,from,to)); }); return out; }
  function instKey(i){ return i.lineId+"|"+i.date; }
  function isDone(i){ var st=S(); return !!(st.completedInstances&&st.completedInstances[instKey(i)]); }
  function clientOf(lineId){ return cust(lineId.split(":")[0]); }
  function completeInstance(inst){
    var st=S(); st.completedInstances=st.completedInstances||{}; st.completedInstances[instKey(inst)]=true;
    var c=clientOf(inst.lineId); var bldId=(c&&c.buildingId)?c.buildingId:(st.buildings[0]&&st.buildings[0].id);
    st.items.push({ id:uid(), kind:"task", bld:bldId, title:inst.title, detail:"Fra skjøtselsplan ("+inst.freq+") · "+inst.building, status:"done", billable:true, hours:0.5, time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), who:"Martin", proof:{photo:true, note:"Utført på plan"} });
    save(); render(); toast("✓ Utført — dokumentert (Board) og fakturerbart (Office)");
  }
  function spawnEvent(name){
    var st=S(); var c=liveClients()[0]; var bldId=(c&&c.buildingId)?c.buildingId:(st.buildings[0]&&st.buildings[0].id);
    st.items.push({ id:uid(), kind:"task", bld:bldId, title:name+" — utløst i dag", detail:"Beredskap utløst (snø/is) — utfør i dag.", status:"todo", billable:true, hours:1, time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), who:"Martin", proof:null });
    save(); render(); toast("❄️ "+name+" lagt i dagens oppgaver");
  }
  function groupByBuilding(list){ var m={}, order=[]; list.forEach(function(i){ if(!m[i.building]){m[i.building]=[];order.push(i.building);} m[i.building].push(i); }); return order.map(function(b){return {building:b, items:m[b]};}); }

  /* ---- Field: scheduled work ---- */
  function weekStepperHTML(today){
    return '<div class="card"><div class="ob-stepbar">'
      +'<span class="ct" style="margin:0">Skjøtselsplan · uke '+isoWeek(today)+' · '+dateLabel(today)+' '+today.getFullYear()+'</span><span style="flex:1"></span>'
      +'<button class="ob-mini" data-ob="weekStep" data-arg="-4">◀◀</button>'
      +'<button class="ob-mini" data-ob="weekStep" data-arg="-1">◀ uke</button>'
      +'<button class="ob-mini" data-ob="weekStep" data-arg="1">uke ▶</button>'
      +'<button class="ob-mini" data-ob="weekStep" data-arg="4">▶▶</button>'
      +'<button class="ob-mini" data-ob="jumpTo" data-arg="winter">❄️ Vinter</button>'
      +'<button class="ob-mini" data-ob="jumpTo" data-arg="spring">🌿 Vår</button>'
      +'<button class="ob-mini" data-ob="jumpTo" data-arg="today">I dag</button>'
      +'</div></div>';
  }
  function planRow(i, completable){
    return '<div class="ob-row"><div class="ob-line-top"><div class="rt">'+esc(i.title)
      +(i.partner?' <span class="chip blue">'+esc(i.partner)+' · partner</span>':'')+(i.statutory?' <span class="chip blue">lovpålagt</span>':'')+'</div>'
      +(completable?'<button class="ob-mini ok on" data-ob="planDone" data-arg="'+i.lineId+'|'+i.date+'|'+encodeURIComponent(i.title)+'|'+encodeURIComponent(i.freq)+'|'+encodeURIComponent(i.building)+'">✓ Utført</button>':'')+'</div>'
      +'<div class="rd">'+esc(i.category)+(i.zone?' · sone '+i.zone:'')+' · fra plan: '+esc(i.freq)+' · '+dateLabel(new Date(i.date))+'</div></div>';
  }
  function planSection(title, list, completable){
    var inner = list.length ? groupByBuilding(list).map(function(g){
      return '<div class="ob-plan-bld">📍 '+esc(g.building)+'</div>'+g.items.map(function(i){return planRow(i,completable);}).join("");
    }).join("") : '<div class="empty">Ingenting planlagt her.</div>';
    return '<div class="card"><div class="ct">'+esc(title)+' <span class="chip grey">'+list.length+'</span></div>'+inner+'</div>';
  }
  function planCondensed(title, list){
    var rows=list.slice(0,40).map(function(i){ return '<div class="ob-kom"><span class="ob-komdate">'+dateLabel(new Date(i.date))+'</span> '+esc(i.title)+' <span class="muted">· '+esc(i.building)+'</span></div>'; }).join("");
    return '<div class="card"><div class="ct">'+esc(title)+' <span class="chip grey">'+list.length+'</span></div>'+rows+'</div>';
  }
  function beredskapHTML(month){
    var winter=(month>=11||month<=4), bered=[];
    liveLines().filter(function(l){return l.schedule.type==="event";}).forEach(function(l){
      if(l.schedule.season==="winter" && !winter) return;
      (l.schedule.events||[{name:l.title, trigger:"Registrer"}]).forEach(function(ev){ bered.push({line:l, ev:ev}); });
    });
    // de-dupe identical event names across lines
    var seen={}, uniq=[]; bered.forEach(function(b){ if(!seen[b.ev.name]){seen[b.ev.name]=1; uniq.push(b);} });
    var body=uniq.length? uniq.map(function(b){
      return '<div class="ob-row"><div class="ob-line-top"><div class="rt">⚡ '+esc(b.ev.name)+'</div>'
        +'<button class="ob-mini warn on" data-ob="spawnEvt" data-arg="'+encodeURIComponent(b.ev.name)+'">'+esc(b.ev.trigger)+'</button></div>'
        +'<div class="rd">utløses ved forhold · ikke kalenderstyrt</div></div>';
    }).join("") : '<div class="empty">Ingen beredskapstjenester i denne sesongen.</div>';
    return '<div class="card"><div class="ct">Beredskap · utløses ved forhold '+(winter?'<span class="chip blue">vintersesong</span>':'')+'</div>'+body+'</div>';
  }
  function renderFieldExtras(cols){
    if(!liveClients().length) return;
    var today=refDate(), ws=mondayOf(today), we=addDays(ws,6), tIso=iso(today), month=today.getMonth()+1;
    var inst=generateInstances(liveLines(), ws, addDays(today,28)).filter(function(i){return !isDone(i);});
    var todayL=inst.filter(function(i){return i.date===tIso;});
    var weekL=inst.filter(function(i){return i.date>=iso(ws)&&i.date<=iso(we)&&i.date!==tIso;});
    var komL=inst.filter(function(i){return i.date>iso(we);}).sort(function(a,b){return a.date<b.date?-1:1;});
    var zc=liveClients().filter(function(c){return c.zones&&c.zones.length;})[0];
    var host=document.createElement("div"); host.className="lane"; host.style.gridColumn="1 / -1";
    host.innerHTML = (zc?opMapsRow(zc,"fld"):"")
      + weekStepperHTML(today)
      + planSection("I dag · "+dateLabel(today), todayL, true)
      + planSection("Denne uka", weekL, true)
      + (komL.length? planCondensed("Kommende (4 uker)", komL) : "")
      + beredskapHTML(month);
    cols.insertBefore(host, cols.firstChild);
    if(zc){ buildOpMap(zc,"snow","fld-opmap-snow"); buildOpMap(zc,"grass","fld-opmap-grass"); }
  }

  /* ---- Office: Årsplan (doc 19 year planner, light) ---- */
  function yearPlan(client, year){
    var lines=scheduleLines(client), inst=generateInstances(lines, ymd(year,1,1), ymd(year,12,31));
    var months=[]; for(var m=1;m<=12;m++) months.push({m:m, count:0, statutory:[]});
    inst.forEach(function(i){ months[parseInt(i.date.split("-")[1],10)-1].count++; });
    lines.filter(function(l){return l.statutory;}).forEach(function(l){ months[(l.schedule.dueMonth||6)-1].statutory.push(l.title); });
    return months;
  }
  var MON_ABBR=["Jan","Feb","Mar","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Des"];
  function arsplanHTML(client){
    var year=refDate().getFullYear(), mp=yearPlan(client,year);
    var counts=mp.map(function(x){return x.count;});
    var max=Math.max.apply(null, counts.concat([1]));
    var avg=counts.reduce(function(s,x){return s+x;},0)/12;
    var sorted=counts.slice().sort(function(a,b){return b-a;});
    var thr=Math.max(sorted[Math.min(3,sorted.length-1)]||1, avg*1.05);  // top-load months (≈ top 4, spring/early-summer)
    var bars=mp.map(function(x,i){
      var peak=x.count>0 && x.count>=thr;
      return '<div class="ob-mcol'+(peak?' peak':'')+'">'+(x.statutory.length?'<div class="ob-mstat" title="'+esc(x.statutory.join(", "))+'">📋</div>':'<div class="ob-mstat" style="visibility:hidden">·</div>')
        +'<div class="ob-mbar" style="height:'+(Math.round((x.count/max)*64)+3)+'px" title="'+x.count+' planlagte"></div>'
        +'<div class="ob-mcount">'+x.count+'</div><div class="ob-mname">'+MON_ABBR[i]+'</div></div>';
    }).join("");
    return '<div class="card"><div class="ct">Årsplan '+year+' — '+esc(client.name)+' <span class="muted" style="font-weight:600">· planlagte oppgaver/mnd</span></div>'
      +'<div class="ob-year">'+bars+'</div>'
      +'<div class="ob-yearlegend"><span class="ob-sw peak"></span> topp-måneder (vår/forsommer) · 📋 lovpålagt: heis (2-årlig) · sprinkler + brann (årlig)</div>'
      +'<div class="ob-stepbar" style="margin-top:8px"><span style="flex:1"></span><button class="ob-mini" data-ob="yearStep" data-arg="-1">◀ '+(year-1)+'</button><button class="ob-mini" data-ob="yearStep" data-arg="1">'+(year+1)+' ▶</button></div></div>';
  }

  function renderExtras(view, cols){
    seedIfNeeded();
    destroyMap();
    destroyOpMaps();
    if(view==="sales"){ renderSales(cols); }
    else if(view==="board"){ renderBoardExtras(cols); }
    else if(view==="office"){ renderOfficeExtras(cols); }
    else if(view==="field"){ renderFieldExtras(cols); }
  }

  function renderSales(cols){
    cols.className="cols";
    var c=cur();
    if(!c){ cols.innerHTML=pipelineHTML(); return; }
    cols.innerHTML=wizardHTML(c);
    if(ui.step===1 || (ui.step===5 && c.stage==="Live")) buildMap(c);
    if(ui.step===2 && c.offer){ buildOpMap(c,"snow","off-opmap-snow"); buildOpMap(c,"grass","off-opmap-grass"); }
  }
  function repaintSales(){ var cols=document.getElementById("cols"); if(cols) renderSales(cols); }

  function pipelineHTML(){
    var list=customers();
    var cards = list.length ? list.map(function(c){
      var up = (c.markers||[]).filter(function(m){return isUpsell(c,m);}).length;
      return '<div class="ob-cust" data-ob="open" data-id="'+c.id+'">'
        +'<div class="nm">'+esc(c.name)+'</div>'
        +'<div class="ad">'+esc(c.addr||"")+'</div>'
        +'<div class="meta"><span class="'+badgeClass(c.stage)+'">'+c.stage+'</span>'
          +'<span class="chip grey">'+(c.markers?c.markers.length:0)+' zones</span>'
          +(up?'<span class="chip amber">'+up+' upsell</span>':'')
          +(c.offer?'<span class="chip blue">'+kr(offerTotal(c.offer))+'/'+perL(c.offer)+'</span>':'')
        +'</div></div>';
    }).join("") : '<div class="empty">No customers yet. Start one with “＋ New customer”.</div>';
    return '<div class="ob-head"><div class="dot">🧭</div><div><h2>Sales → Onboarding</h2>'
      +'<div class="sub">One growing record + one growing map per client. Prospect → Live.</div></div>'
      +'<div class="spacer"></div>'
      +'<button class="ob-btn primary" data-ob="new">＋ New customer</button>'
      +'<button class="ob-btn ghost" data-ob="reseed">↺ Demo client</button>'
      +(list.length?'<button class="ob-btn ghost" data-ob="clearCustomers">🗑 Clear</button>':'')
      +'</div>'
      +'<div class="ob-pipe">'+cards+'</div>';
  }

  function stagesRailHTML(c){
    var here=STAGES.indexOf(c.stage);
    return '<div class="ob-stages">'+STAGES.map(function(s,i){
      var cls = i<here?"done" : i===here?"cur" : "";
      return '<span class="ob-stage '+cls+'"><span class="n">'+(i<here?"✓":(i+1))+'</span>'+s+'</span>';
    }).join("")+'</div>';
  }
  function stepperHTML(c){
    var mx=maxStep(c);
    return '<div class="ob-stages">'+STEP_NAMES.map(function(nm,i){
      var reach=i<=mx;
      var cls = i===ui.step?"cur" : (i<ui.step?"done":"");
      return '<span class="ob-stage '+cls+'" '+(reach?'data-ob="step" data-id="'+i+'" style="cursor:pointer"':'style="opacity:.4"')+'><span class="n">'+i+'</span>'+nm+'</span>';
    }).join("")+'</div>';
  }
  function wizardHTML(c){
    var body;
    switch(ui.step){
      case 0: body=stepPrep(c); break;
      case 1: body=stepWalk(c); break;
      case 2: body=stepOffer(c); break;
      case 3: body=stepBoard(c); break;
      case 4: body=stepUpdate(c); break;
      case 5: body=stepGoLive(c); break;
      default: body=stepWalk(c);
    }
    return '<div class="ob-wiz">'
      +'<button class="ob-back" data-ob="back">← All customers</button>'
      +'<div class="ob-title"><h2>'+esc(c.name)+'</h2><span class="'+badgeClass(c.stage)+'">'+c.stage+'</span>'
        +'<span class="ob-step">Step '+ui.step+' · '+STEP_NAMES[ui.step]+'</span></div>'
      +stepperHTML(c)
      +body+'</div>';
  }

  /* ---- Step 0: office prep ---- */
  function managerCardHTML(c){
    var board=(c.contacts||[]).map(function(p){ return '<div class="ob-tot"><span class="muted">'+esc(p.role||"Kontakt")+'</span><span class="v" style="font-size:13px">'+esc(p.name)+'</span></div>'; }).join("");
    return '<div class="card"><div class="ct">Forvaltning & styre <span class="muted" style="font-weight:600">· offentlig register</span></div>'
      +(c.manager?'<div class="ob-tot"><span class="muted">Forvalter</span><span class="v" style="font-size:13px">'+esc(c.manager)+'</span></div>':'')
      +(c.revisor?'<div class="ob-tot"><span class="muted">Revisor</span><span class="v" style="font-size:13px">'+esc(c.revisor)+'</span></div>':'')
      +board+'</div>';
  }
  function systemsCardHTML(c){
    return '<div class="card"><div class="ct">Foreslåtte systemer <span class="muted" style="font-weight:600">· uavklart (bekreftes på befaring)</span></div>'
      +'<div class="ob-syschips">'+(c.systems||[]).map(function(s){return '<span class="ob-sys">'+esc(s)+'</span>';}).join("")+'</div>'
      +(c.compliance&&c.compliance.length?('<div style="margin-top:10px;font-weight:700;font-size:11.5px;color:var(--muted)">Lovpålagt (auto-lastet)</div><div class="ob-syschips">'+c.compliance.map(function(r){return '<span class="ob-sys comp">📋 '+esc(r.label)+'</span>';}).join("")+'</div>'):'')
      +'</div>';
  }
  function stepPrep(c){
    var isNew=ui.draftNew;
    var scope=c.requestedScope||[];
    var sugg=suggestedFromYear(c.buildYear);
    var scopeBoxes=SCOPE_OPTS.map(function(o){
      return '<label style="display:flex;align-items:center;gap:8px;font-weight:600;color:var(--ink)"><input type="checkbox" data-obf="scope" data-id="'+o.key+'" '+(scope.indexOf(o.key)>=0?'checked':'')+' style="width:auto"> '+o.label+'</label>';
    }).join("");
    var ct=c.contacts[0]||{name:"",role:"Board chair",email:""};
    return '<div class="ob-grid split">'
      +'<div class="card"><div class="ct">Prospect shell</div>'
        +'<button class="ob-btn ghost" data-ob="prefill" style="margin-bottom:6px">⤓ Pre-fill from registry (Matrikkel / Kartverket — mocked)</button>'
        +'<label>Name</label><input id="p_name" value="'+esc(c.name||"")+'" placeholder="e.g. Solbakken Borettslag">'
        +'<label>Address</label><div class="row2" style="display:flex;gap:8px"><input id="p_addr" value="'+esc(c.addr||"")+'" placeholder="Street, postcode, town" style="flex:1"><button class="ob-btn ghost" data-ob="locatePrep">📍 Locate</button></div>'
        +'<div class="row2" style="display:flex;gap:10px"><div style="flex:1"><label>gnr</label><input id="p_gnr" value="'+esc(c.gnr||"")+'"></div><div style="flex:1"><label>bnr</label><input id="p_bnr" value="'+esc(c.bnr||"")+'"></div></div>'
        +'<label>Building profile</label><select id="p_profile">'+PROFILES.map(function(p){return '<option'+(c.profile===p?' selected':'')+'>'+p+'</option>';}).join("")+'</select>'
        +'<div class="row2" style="display:flex;gap:10px"><div style="flex:1"><label>Build year</label><input id="p_year" type="number" value="'+(c.buildYear||"")+'" placeholder="1998"></div><div style="flex:1"><label>Lot size (m²)</label><input id="p_size" type="number" value="'+(c.size||"")+'" placeholder="2400"></div></div>'
        +'<label>Board contact</label><input id="p_cname" value="'+esc(ct.name)+'" placeholder="Name">'
        +'<input id="p_cemail" value="'+esc(ct.email)+'" placeholder="email@board.no" style="margin-top:6px">'
        +'<label>Meeting time</label><input id="p_meet" value="'+esc(c.meetingTime||"")+'" placeholder="Tue 10:00">'
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="savePrep">'+(isNew?"Create prospect →":"Save shell")+'</button></div>'
      +'</div>'
      +'<div>'
        + (c.manager||(c.contacts&&c.contacts.length>1) ? managerCardHTML(c) : '')
        + (c.systems&&c.systems.length ? systemsCardHTML(c) : '')
        +'<div class="card"><div class="ct">Requested-scope checklist</div>'
          +'<p class="muted" style="font-size:12.5px;margin:0 0 10px">What the board asked us to quote — tick so we arrive prepared.</p>'
          +'<div style="display:flex;flex-direction:column;gap:9px">'+scopeBoxes+'</div></div>'
        +'<div class="card"><div class="ct">Map-layer set (loaded for the walkaround)</div>'
          +'<p class="muted" style="font-size:12.5px;margin:0 0 10px">Pre-selected from profile + requested scope, ready to mark on site.</p>'
          +'<div class="ob-layers">'+(c.layers||[]).map(function(k){return layerChip(c,k,false);}).join("")+'</div>'
          +(sugg.length?'<div class="ob-callout"><b>Suggested from build year '+(c.buildYear||"?")+':</b> likely '+sugg.map(function(k){return LAYERS[k].emoji+" "+LAYERS[k].label;}).join(", ")+'. Added to the layer set.</div>':'')
        +'</div>'
        +(c.stage?'<div class="ob-bar"><button class="ob-btn primary" data-ob="step" data-id="1">Go to walkaround →</button></div>':'')
      +'</div></div>';
  }

  /* ---- Step 1: walkaround ---- */
  function layerChip(c,key,selectable){
    var d=LAYERS[key]; var n=tallyStr(c,key);
    var on=(c.layers||[]).indexOf(key)>=0;
    var active=ui.activeLayer===key;
    var module=layerTier(key)==="module";
    var cls="ob-layer"+(on&&!module?" on":"")+(active?" active":"")+(module?" modul":"");
    var attr=(selectable&&!module)?'data-ob="pick" data-id="'+key+'"':'disabled';
    var badge=module?'<span class="c modul">modul</span>':'<span class="c">'+n+'</span>';
    return '<button class="'+cls+'" '+attr+'>'+d.emoji+' '+d.label+' '+badge+'</button>';
  }
  // grouped picker — the 8 PHM categories; core active, module disabled ("modul – kommer"),
  // forvaltning shown as a non-markable "integreres / feeds" chip. mode: "sales" | "enrich".
  function layerPickerHTML(c, mode){
    return CATS.map(function(cat){
      if(cat.tier==="feeds"){
        return '<div class="ob-cat feeds"><div class="ob-cat-h"><span class="ob-cat-name">'+esc(cat.label)
          +'</span><span class="ob-tier feeds">integreres</span></div>'
          +'<div class="ob-feeds-chip">⚙️ '+esc(cat.feedsNote)+'</div></div>';
      }
      var keys=cat.layers.filter(function(k){ var d=LAYERS[k]; if(!d) return false; if(d.enrich && mode!=="enrich") return false; return true; });
      if(!keys.length) return "";
      var tag = cat.tier==="module" ? '<span class="ob-tier modul">modul – kommer</span>' : '';
      return '<div class="ob-cat '+cat.tier+'"><div class="ob-cat-h"><span class="ob-cat-name">'+esc(cat.label)+'</span>'+tag+'</div>'
        +'<div class="ob-cat-chips">'+keys.map(function(k){return layerChip(c,k,cat.tier==="core");}).join("")+'</div></div>';
    }).join("");
  }
  function stepWalk(c){
    var hasZones=(c.markers||[]).some(function(m){return !LAYERS[m.layer].recordOnly;}) || (c.checklist||[]).some(function(it){return it.scope==="in";});
    var perWord = c.period==="mnd" ? "måned" : "år";
    return '<div class="ob-grid split">'
      +'<div>'
        +'<div class="ob-hint">Pick a layer, then <b>tap the map</b> to drop a marker. Counts tally per layer. Anything outside the requested scope auto-flags as an <b>upsell</b>. Categories follow PHM Norge\'s service map — <b>modul</b> lines are phase-2.</div>'
        +'<div class="ob-picker" id="ob-layers">'+layerPickerHTML(c,"sales")+'</div>'
        +'<div class="ob-maptools"><span class="ob-active-note" id="ob-active">'+activeNote()+'</span><span class="spacer" style="flex:1"></span>'
          +'<button class="ob-btn ghost" data-ob="locateWalk">📍 Locate address</button>'
          +'<button class="ob-btn ghost" data-ob="geotag">📍 Use my location</button></div>'
        +'<div class="ob-drawbar" id="ob-drawtools">'+drawToolbarHTML()+'</div>'
        +'<div class="ob-drawread" id="ob-draw-readout"></div>'
        +'<div id="ob-map"></div>'
      +'</div>'
      +'<div>'
        + (c.checklist&&c.checklist.length ? '<div id="ob-checkwrap">'+checklistPanelHTML(c)+'</div>' : '')
        +'<div id="ob-zonepanel">'+zonesPanelHTML(c)+'</div>'
        +'<div class="card"><div class="ct">Zones captured</div><div id="ob-zones">'+zonesHTML(c)+'</div></div>'
        +'<div id="ob-upsell">'+upsellHTML(c)+'</div>'
        +'<div class="card"><div class="ct">Recurring value so far</div><div class="ob-tot grand"><span>Per '+perWord+'</span><span class="v" id="ob-walktotal">'+kr(walkTotal(c))+'</span></div></div>'
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="genOffer" '+(hasZones?'':'disabled')+'>Generate offer →</button></div>'
      +'</div></div>';
  }
  function activeNote(){ return ui.activeLayer ? ('Active layer: '+LAYERS[ui.activeLayer].emoji+' '+LAYERS[ui.activeLayer].label+' — tap the map') : 'No layer selected — pick one above'; }
  function walkTotal(c){
    var t=(c.markers||[]).reduce(function(s,m){return s+(m.price||0);},0);
    t += (c.checklist||[]).filter(function(it){return it.scope==="in";}).reduce(function(s,it){return s+(it.price||0);},0);
    return t;
  }
  function zonesHTML(c){
    if(!(c.markers||[]).length) return '<div class="empty">No zones yet — tap the map to mark what you see.</div>';
    return CATS.map(function(cat){
      var keys=cat.layers.filter(function(k){return (c.markers||[]).some(function(m){return m.layer===k;});});
      if(!keys.length) return "";
      var inner=keys.map(function(k){
        var d=LAYERS[k];
        var rows=(c.markers||[]).filter(function(m){return m.layer===k;}).map(function(m){
          return '<div class="ob-row'+(isUpsell(c,m)?' up':'')+'"><div class="ob-line-top"><div class="rt">'+d.emoji+' '+esc(m.service)
            +(isUpsell(c,m)?' <span class="chip amber">upsell</span>':'')+(m.source==="caretaker"?' <span class="chip blue">interiør</span>':'')
            +(m.photo?' <span class="chip grey">📷</span>':'')+'</div>'
            +(d.recordOnly?'':'<div class="rp">'+kr(m.price)+'</div>')+'</div>'
            +'<div class="rd">'+esc(m.frequency)+' · '+(d.measure==="area"?(m.qty+" m²"):(m.qty+" "+d.unit))+(m.note?' · '+esc(m.note):'')+(m.accuracy?' · 📍±'+m.accuracy+'m':'')+'</div></div>';
        }).join("");
        return '<div class="ob-zgroup"><div class="ob-zlabel">'+d.emoji+' '+d.label+' · '+tallyStr(c,k)+'</div>'+rows+'</div>';
      }).join("");
      return '<div class="ob-zcat">'+esc(cat.label)+'</div>'+inner;
    }).join("");
  }
  function upsellHTML(c){
    var ups=(c.markers||[]).filter(function(m){return isUpsell(c,m);});
    if(!ups.length) return "";
    return '<div class="ob-callout"><b>⚠️ '+ups.length+' upsell opportunit'+(ups.length>1?'ies':'y')+'</b> — present but outside requested scope: '
      +ups.map(function(m){return LAYERS[m.layer].emoji+" "+LAYERS[m.layer].label;}).join(", ")+'. Nothing seen is lost.</div>';
  }
  /* ---- walkaround checklist panel (doc 38) ---- */
  function checklistPanelHTML(c){
    if(!(c.checklist&&c.checklist.length)) return "";
    return '<div class="card"><div class="ct">Walkaround-sjekkliste <span class="muted" style="font-weight:600">· '+esc(c.profile)+'</span></div>'
      +'<div class="ob-clhint">✅ i scope · ⬆ upsell · ✖ ikke til stede · ⬜ avklares · ticking ✅ med pris → tilbudslinje</div>'
      +'<div id="ob-checklist">'+checklistRowsHTML(c)+'</div></div>';
  }
  function checklistRowsHTML(c){
    var byZone={}; c.checklist.forEach(function(it){ (byZone[it.zone]=byZone[it.zone]||[]).push(it); });
    return ZONES.map(function(z){
      var items=byZone[z.n]; if(!items||!items.length) return "";
      var open=!!ui.zonesOpen[z.n];
      return '<div class="ob-zoneblock"><button class="ob-zonehead" data-ob="cliZone" data-id="'+z.n+'">'
        +'<span class="ob-zn">'+z.n+'</span><span class="ob-zt">'+esc(z.title)+'</span>'+scopeSummary(items)+'<span class="ob-zchev">'+(open?'▾':'▸')+'</span></button>'
        +(open?'<div class="ob-zoneitems">'+items.map(checklistRow).join("")+'</div>':'')+'</div>';
    }).join("");
  }
  function scopeSummary(items){
    var n={"in":0,upsell:0,out:0,unknown:0}; items.forEach(function(it){ n[it.scope]=(n[it.scope]||0)+1; });
    var s='';
    if(n["in"]) s+='<span class="chip green">✅ '+n["in"]+'</span>';
    if(n.upsell) s+='<span class="chip amber">⬆ '+n.upsell+'</span>';
    if(n.unknown) s+='<span class="chip grey">⬜ '+n.unknown+'</span>';
    return '<span class="ob-zsum">'+s+'</span>';
  }
  function checklistRow(it){
    var sc=it.scope;
    function sb(val){ return '<button class="ob-scope s-'+val+(sc===val?' on':'')+'" data-ob="cliScope" data-id="'+it.id+'" data-arg="'+val+'" title="'+val+'">'+scopeIcon(val)+'</button>'; }
    var partner=(it.deliveredBy==="partner")?' <span class="chip blue">'+esc(it.partnerName||"partner")+' · partner</span>':'';
    var price=(it.price>0)?' <span class="ob-clprice">'+kr(it.price)+'</span>':'';
    return '<div class="ob-clitem'+(sc==="upsell"?' up':sc==="out"?' out':'')+'">'
      +'<div class="ob-cltop"><div class="ob-cllabel">'+it.emoji+' '+esc(it.subtype||it.label)+price+partner+'</div>'
      +'<div class="ob-scopes">'+sb("in")+sb("upsell")+sb("out")+sb("unknown")+'</div></div>'
      +'<div class="ob-clcap">'+captureField(it)+(it.freq?'<span class="ob-clfreq">'+esc(it.freq)+'</span>':'')+'</div></div>';
  }
  function captureField(it){
    var v=(it.value==null?"":it.value);
    if(it.captureType==="count") return '<input type="number" min="0" data-obf="clival" data-id="'+it.id+'" value="'+esc(""+v)+'" placeholder="antall">';
    if(it.captureType==="area")  return '<input type="number" min="0" data-obf="clival" data-id="'+it.id+'" value="'+esc(""+v)+'" placeholder="m²">';
    if(it.captureType==="boolean") return '<label class="ob-clbool"><input type="checkbox" data-obf="clibool" data-id="'+it.id+'" '+(v===true?'checked':'')+'> ja</label>';
    return '<input data-obf="clival" data-id="'+it.id+'" value="'+esc(""+v)+'" placeholder="'+(it.captureType==="condition"?'tilstand / notat':'notat')+'">';
  }
  function refreshChecklist(c){
    setHTML("ob-checklist", checklistRowsHTML(c));
    setText("ob-walktotal", kr(walkTotal(c)));
    var gen=document.querySelector('[data-ob="genOffer"]'); if(gen && ((c.checklist||[]).some(function(it){return it.scope==="in";})||walkTotal(c)>0)) gen.removeAttribute("disabled");
  }
  function refreshWalk(c){
    setHTML("ob-layers", layerPickerHTML(c, c.stage==="Live"?"enrich":"sales"));
    setHTML("ob-zones", zonesHTML(c));
    setHTML("ob-upsell", upsellHTML(c));
    setText("ob-walktotal", kr(walkTotal(c)));
    setText("ob-active", activeNote());
    if(c.checklist&&c.checklist.length) setHTML("ob-checklist", checklistRowsHTML(c));
    var gen=document.querySelector('[data-ob="genOffer"]'); if(gen){ if((c.markers||[]).some(function(m){return !LAYERS[m.layer].recordOnly;})||(c.checklist||[]).some(function(it){return it.scope==="in";})) gen.removeAttribute("disabled"); }
  }

  /* ---- Step 2: offer ---- */
  function stepOffer(c){
    if(!c.offer){
      return '<div class="card"><div class="ct">Step 2 — offer</div>'
        +'<p class="muted" style="font-size:13.5px">Prisen <b>beregnes</b> fra bygningens målte soner + talte enheter (ikke rundsum). Generer for å se modulene og driver-mattematikken.</p>'
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="genOffer">Beregn tilbud fra målte soner →</button></div></div>';
    }
    var sent = STAGES.indexOf(c.stage) >= STAGES.indexOf("Offer sent");
    return offerHeadlineHTML(c)
      + opMapsRow(c,"off")
      + '<div class="ob-grid split">'
      +   '<div id="ob-tiered">'+modulesHTML(c)+optionLinesHTML(c)+'</div>'
      +   '<div>'
      +     offerTermsHTML(c)
      +     '<div class="card"><div class="ct">Cover note</div><textarea data-obf="cover" rows="4">'+esc(c.offer.coverNote||"")+'</textarea></div>'
      +     '<div class="card"><div class="ct">Én relasjon, valgbare moduler</div>'
      +       '<p class="muted" style="font-size:12.5px;margin:0 0 10px">Hver tjeneste prises og kan sies opp <b>separat</b> — misnøye med snø feller ikke hele avtalen. Board får PDF + live tilbud.</p>'
      +       '<div class="ob-bar"><button class="ob-btn ghost" data-ob="printOffer">🖨 Print / Save as PDF</button></div></div>'
      +     (sent
            ? '<div class="ob-ok">✅ Sendt — board reviewer i <b>Board</b>-visningen.</div>'+boardEmailCard(c)
              +'<div class="ob-bar"><button class="ob-btn amber" data-ob="openBoard">Åpne board-visningen →</button></div>'
            : '<div class="ob-bar"><button class="ob-btn primary" data-ob="sendOffer">Send tilbud &amp; gi board tilgang →</button></div>')
      +   '</div>'
      + '</div>';
  }
  /* ---- tiered offer (headline → modules → per-line driver math) ---- */
  function fmtNum(n){ return (Math.round(n)||0).toLocaleString("no"); }
  function findOfferLine(c,id){ var o=c.offer; if(!o) return null; for(var i=0;i<o.modules.length;i++){ var l=o.modules[i].lines.filter(function(x){return x.id===id;})[0]; if(l) return l; } return null; }
  function headlineAmtHTML(c){
    var o=c.offer, mnd=c.period!=="år";
    return mnd
      ? '<div class="ob-hl-big">'+kr(o.totalMonthly)+' <span class="ob-hl-unit">/mnd</span> <span class="ob-hl-yr">· '+kr(o.totalYearly)+' /år</span></div>'
      : '<div class="ob-hl-big">'+kr(o.totalYearly)+' <span class="ob-hl-unit">/år</span> <span class="ob-hl-yr">· '+kr(o.totalMonthly)+' /mnd</span></div>';
  }
  function offerHeadlineHTML(c){
    return '<div class="card ob-headline"><div class="ob-hl-top"><span id="ob-headline-amt">'+headlineAmtHTML(c)+'</span><span class="ob-ver">v'+c.offer.version+'</span></div>'
      +'<div class="ob-hl-sub">Alt du betaler for — synlig. Utvid en tjeneste for driver-mattematikken; hver modul kan velges bort separat.</div></div>';
  }
  function modulesHTML(c){ return '<div class="ob-mods">'+c.offer.modules.map(function(m){return moduleCardHTML(c,m);}).join("")+'</div>'; }
  function moduleCadence(m){ var seen={},out=[]; m.lines.forEach(function(l){ if(l.cadence && !seen[l.cadence]){ seen[l.cadence]=1; out.push(l.cadence);} }); return out.slice(0,2).join(" · ")||"løpende"; }
  function moduleCardHTML(c,m){
    var open=!!(ui.modOpen&&ui.modOpen[m.service]), per=perL(c.offer);
    var lines = open ? '<div class="ob-modlines">'+m.lines.map(function(l){return moduleLineHTML(c,l);}).join("")+'</div>' : '';
    return '<div class="ob-modcard'+(m.included?'':' excluded')+'">'
      +'<div class="ob-modhead">'
        +'<button class="ob-modtoggle" data-ob="modExpand" data-id="'+m.service+'"><span class="ob-modchev">'+(open?'▾':'▸')+'</span> <b>'+esc(m.title)+'</b></button>'
        +'<div class="ob-modright">'
          +(m.included?'<span class="ob-modsub">'+kr(m.subtotal)+'/'+per+'</span>':'<span class="chip grey">ikke valgt · kan sies opp separat</span>')
          +'<label class="ob-modincl" title="Inkluder modulen"><input type="checkbox" data-obf="modIncl" data-id="'+m.service+'" '+(m.included?'checked':'')+'> med</label>'
        +'</div>'
      +'</div>'
      +'<div class="ob-modmeta">'+esc(moduleCadence(m))+' · oppstart <input class="ob-modstart" data-obf="modStart" data-id="'+m.service+'" value="'+esc(m.startDate)+'"> · KPI '+m.indexationPct+'% (maks '+m.cap+'%)</div>'
      + lines
      +'</div>';
  }
  function moduleLineHTML(c,l){
    var per=perL(c.offer);
    var driver = (l.qty!=null && l.rate!=null)
      ? esc(fmtNum(l.qty))+' '+esc(l.unit||"")+' × '+kr(l.rate)+'/'+esc(l.unit||"e")+'/'+per+' = '+kr(l.computed)
      : 'fastpris (fra kontrakt/befaring) = '+kr(l.computed);
    var partner = l.deliveredBy==="partner" ? ' <span class="chip blue">'+esc(l.partnerName)+' · partner</span>' : '';
    var over = l.overridden ? '<span class="ob-overnote">endret fra '+kr(l.computed)+'</span>' : '';
    return '<div class="ob-modline'+(l.zoneId?' has-zone':'')+'"'+(l.zoneId?' data-zone="'+l.zoneId+'"':'')+'>'
      +'<div class="ob-mlmain"><div class="ob-mllab">'+l.emoji+' '+esc(l.label)+partner+(l.zoneId?' <span class="ob-zlink" title="fra tegnet sone">🗺️</span>':'')+'</div>'
        +'<div class="ob-mldriver">'+driver+'</div></div>'
      +'<div class="ob-mlprice"><input type="number" step="50" class="ob-finput" data-obf="lineFinal" data-id="'+l.id+'" value="'+l.final+'"><span class="ob-mlper">/'+per+'</span>'+over+'</div>'
    +'</div>';
  }
  function optionLinesHTML(c){
    var ol=(c.offer&&c.offer.optionLines)||[]; if(!ol.length) return "";
    var per=perL(c.offer);
    return '<div class="card"><div class="ct">Opsjoner / per gang <span class="muted" style="font-weight:600">· utenfor grunnbeløpet</span></div>'
      +ol.map(function(l){
        var amt = (l.role==="hedge"||l.role==="bed") ? kr(l.final)+'/år' : (l.oneOff?kr(l.final)+' eng.':kr(l.final)+'/'+per);
        var driver = (l.qty!=null&&l.rate!=null) ? ' <span class="muted" style="font-size:11.5px">· '+fmtNum(l.qty)+' '+esc(l.unit||"")+' × '+kr(l.rate)+'</span>' : '';
        return '<div class="ob-row"><div class="ob-line-top"><div class="rt">⬆ '+(l.emoji||"")+' '+esc(l.label)+driver+(l.zoneId?' <span class="ob-zlink">🗺️</span>':'')+'</div><div class="rp">'+amt+'</div></div></div>';
      }).join("")+'</div>';
  }
  function refreshTiered(c){ setHTML("ob-tiered", modulesHTML(c)+optionLinesHTML(c)); setHTML("ob-headline-amt", headlineAmtHTML(c)); }
  function offerLinesHTML(c, editable){
    var per=perL(c.offer);
    return c.offer.lines.map(function(l){
      var d=lineDef(l), cl=l.category||catLabel(l.layer), sub=l.subtype||d.emoji;
      var removed=l.review.decision==="remove";
      var partner = l.deliveredBy==="partner" ? ' <span class="chip blue">'+esc(l.partnerName||"partner")+' · partner</span>' : '';
      var qtyStr = (l.qty===""||l.qty==null) ? "" : (d.measure==="area"?(l.qty+" m²"):(l.qty+(d.unit?(" "+d.unit):"")));
      return '<div class="ob-row'+(!l.inScope?' up':'')+'" style="'+(removed?'opacity:.5':'')+'"><div class="ob-line-top">'
        +'<div class="rt">'+d.emoji+' '+esc(sub)+' <span class="ob-catmini">'+esc(cl)+'</span>'+partner+(!l.inScope?' <span class="chip amber">upsell</span>':'')+'</div>'
        +'<div class="rp">'+kr(l.price)+'/'+per+'</div></div>'
        +'<div class="rd">'+esc(l.frequency||l.scope||"")+(qtyStr?' · '+esc(qtyStr):'')+'</div></div>';
    }).join("");
  }
  function offerUpsellsHTML(c){
    if(!c.offer.upsells || !c.offer.upsells.length) return "";
    var per=perL(c.offer);
    var rows=c.offer.upsells.map(function(l){
      var d=lineDef(l);
      return '<div class="ob-row up"><div class="ob-line-top"><div class="rt">⬆ '+d.emoji+' '+esc(l.subtype)+' <span class="ob-catmini">'+esc(l.category)+'</span></div>'
        +'<div class="rp">'+kr(l.price)+(l.oneOff?' eng.':'/'+per)+'</div></div></div>';
    }).join("");
    return '<div class="card"><div class="ct">Upsell / tillegg <span class="muted" style="font-weight:600">· utenfor grunnbeløpet</span></div>'+rows+'</div>';
  }
  function offerTermsHTML(c){
    var t=c.offer.terms; if(!t) return "";
    function row(k,v){ return v?'<div class="ob-tot"><span class="muted">'+k+'</span><span class="v" style="font-size:13px">'+esc(v)+'</span></div>':''; }
    return '<div class="card"><div class="ct">Vilkår</div>'
      +row("Grøntområde",t.green)+row("Utenfor avtale",t.hourly)+row("Forbruk",t.consumables)
      +row("Oppsigelse",t.notice)+row("Regulering",t.kpi)+row("Oppstart",t.start)+'</div>';
  }
  function boardEmailCard(c){
    var em=c.contacts[0]?c.contacts[0].email:"board@example.no";
    return '<div class="ob-email"><div class="from">To: '+esc(em)+' · From: OnSite</div>'
      +'<div style="font-weight:700;margin-top:4px">Your service offer for '+esc(c.name)+' is ready</div>'
      +'<div class="muted" style="font-size:12.5px;margin-top:3px">Everything runs in OnSite — open your building, see the annotated map, and approve line by line.</div>'
      +'<button class="link" data-ob="openBoard">🔗 Open the offer in OnSite</button></div>';
  }

  /* ---- Step 3: board review (mirrors the Board view) ---- */
  function stepBoard(c){
    if(!c.offer || STAGES.indexOf(c.stage) < STAGES.indexOf("Offer sent")){
      return '<div class="card"><div class="ct">Step 3 — board review</div><p class="muted">Send the offer first (Step 2) to grant board access.</p></div>';
    }
    return '<div class="ob-ok">This is exactly what the board sees in the <b>Board</b> view — both channels update the same offer.</div>'
      + boardReviewHTML(c);
  }
  function boardReviewHTML(c){
    var lines=c.offer.lines.map(function(l){
      var d=lineDef(l), cl=l.category||catLabel(l.layer), sub=l.subtype||d.emoji; var dec=l.review.decision;
      var partner = l.deliveredBy==="partner" ? ' <span class="chip blue">'+esc(l.partnerName||"partner")+' · partner</span>' : '';
      function b(act,label,cls){ return '<button class="ob-mini '+cls+(dec===act?' on':'')+'" data-ob="dec" data-id="'+l.id+'" data-arg="'+act+'">'+label+'</button>'; }
      return '<div class="ob-row'+(!l.inScope?' up':'')+'">'
        +'<div class="ob-line-top"><div class="rt">'+d.emoji+' '+esc(sub)+' <span class="ob-catmini">'+esc(cl)+'</span>'+partner+(!l.inScope?' <span class="chip amber">new / upsell</span>':'')+'</div><div class="rp">'+kr(l.price)+'/'+perL(c.offer)+'</div></div>'
        +'<div class="rd">'+esc(l.frequency||l.scope||"")+'</div>'
        +'<div class="ob-acts">'+b("approve","✓ Approve","ok")+b("question","? Question","")+b("change","✎ Change","warn")+b("remove","✕ Remove","no")+'</div>'
        +'<textarea class="ob-cmt'+(dec&&dec!=="approve"?' show':'')+'" data-obf="bcomment" data-id="'+l.id+'" placeholder="Add a comment for the office…">'+esc(l.review.comment||"")+'</textarea>'
      +'</div>';
    }).join("");
    return '<div class="ob-grid split"><div class="card"><div class="ct">Your offer — line by line <span class="ob-ver">v'+c.offer.version+'</span></div>'
      +lines
      +'<div class="ob-tot grand"><span>Total / '+(perL(c.offer)==="mnd"?"mnd + mva":"år")+'</span><span class="v">'+kr(offerTotal(c.offer))+'</span></div>'
      +'<div class="ob-bar"><button class="ob-btn ghost" data-ob="approveAll">✓ Approve all</button><button class="ob-btn green" data-ob="submitBoard">Send response to office →</button></div></div>'
      +'<div><div class="card"><div class="ct">Channel 2 — just reply by email</div>'
        +'<p class="muted" style="font-size:12.5px;margin:0 0 8px">Prefer email? Paste the board\'s reply and OnSite turns it into change requests on the right lines.</p>'
        +'<textarea id="ob-emailbox" rows="6" placeholder="e.g. “Looks good but the playground inspection is too expensive, and we don\'t need the lift line — please remove it.”"></textarea>'
        +'<div class="ob-bar"><button class="ob-btn ink" data-ob="ingestEmail">Ingest email reply →</button></div></div>'
        +logCard(c)+'</div></div>';
  }
  function repaintBoard(c){
    // re-render whichever surface is showing the board review
    var cols=document.getElementById("cols");
    if(!cols) return;
    var sales=cur();
    OnSite.render();
  }

  /* ---- Step 4: updated offer + diff ---- */
  function stepUpdate(c){
    var open=(c.changeRequests||[]).filter(function(r){return r.status==="open";});
    var reqHTML = (c.changeRequests&&c.changeRequests.length) ? c.changeRequests.map(function(r){
      var l=r.lineId?findLine(c,r.lineId):null;
      var head=(l?lineDef(l).emoji+" "+esc(l.subtype||l.scope):"General")+' <span class="chip '+(r.type==="remove"?"red":r.type==="question"?"blue":"amber")+'">'+r.type+'</span>'
        +' <span class="chip grey">'+r.source+'</span>'+(r.status!=="open"?' <span class="chip '+(r.status==="declined"?"red":"green")+'">'+r.status+'</span>':'');
      var edit = (l && r.status==="open") ? '<div class="row2" style="display:flex;gap:8px;margin-top:8px">'
          +'<div style="flex:2"><label>Scope</label><input data-obf="linescope" data-id="'+l.id+'" value="'+esc(l.scope)+'"></div>'
          +'<div style="flex:1"><label>Pris</label><input type="number" data-obf="lineprice" data-id="'+l.id+'" value="'+l.price+'"></div></div>'
          +'<div class="ob-acts"><button class="ob-mini ok on" data-ob="resolveReq" data-id="'+r.id+'">✓ Resolve</button>'
          +'<button class="ob-mini no on" data-ob="removeLine" data-id="'+l.id+'">✕ Remove line</button>'
          +'<button class="ob-mini" data-ob="declineReq" data-id="'+r.id+'">Decline w/ reason</button></div>'
        : (r.reason?'<div class="rd">Declined: '+esc(r.reason)+'</div>':'');
      return '<div class="ob-row"><div class="rt">'+head+'</div>'+(r.comment?'<div class="rd">'+esc(r.comment)+'</div>':'')+edit+'</div>';
    }).join("") : '<div class="empty">No change requests — the board approved as sent.</div>';

    return '<div class="ob-grid split">'
      +'<div class="card"><div class="ct">Change requests ('+open.length+' open)</div>'+reqHTML
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="issueV2">Issue updated offer v'+((c.offer.version||1)+1)+' &amp; re-send →</button></div></div>'
      +'<div>'+historyHTML(c)+logCard(c)+'</div></div>';
  }
  function historyHTML(c){
    if(!c.offerHistory || c.offerHistory.length<2){
      return '<div class="card"><div class="ct">Version history</div><p class="muted" style="font-size:12.5px">v1 sent '+(c.offerHistory&&c.offerHistory[0]?c.offerHistory[0].at:nowStr())+'. Edits will appear here as a diff once you issue v2.</p></div>';
    }
    return '<div class="card"><div class="ct">Version history &amp; diff</div>'+c.offerHistory.map(function(h){
      var diff = (h.diff&&h.diff.length) ? '<div class="ob-diff">'+h.diff.map(function(x){return '<div class="'+(x.type==="add"?"add":x.type==="rm"?"rm":"ch")+'">'+(x.type==="add"?"＋ ":x.type==="rm"?"－ ":"~ ")+esc(x.text)+'</div>';}).join("")+'</div>' : '<div class="muted" style="font-size:12.5px">Baseline as sent.</div>';
      return '<div class="ob-row"><div class="ob-line-top"><div class="rt"><span class="ob-ver">v'+h.version+'</span> '+h.at+'</div><div class="rp">'+kr(h.total)+'/'+perL(c.offer)+'</div></div>'+diff+'</div>';
    }).join("")+'</div>';
  }

  /* ---- Step 5: go-live + enrichment ---- */
  function stepGoLive(c){
    if(c.stage==="Agreed"){
      var active=c.offer.lines.filter(function(l){return l.review.decision!=="remove";});
      var comp=active.filter(function(l){return lineDef(l).compliance;}).length + ((c.compliance||[]).length);
      return '<div class="ob-grid split">'
        +'<div class="card"><div class="ct">Ready to go live</div>'
          +'<p class="muted" style="font-size:13.5px">On go-live, everything derives from the agreed offer — zero re-entry:</p>'
          +'<div class="ob-row"><div class="rt">🔁 '+active.length+' recurring zones → service plans + tasks</div></div>'
          +'<div class="ob-row"><div class="rt">📋 '+comp+' systems → statutory compliance routines</div></div>'
          +'<div class="ob-row"><div class="rt">🏢 Building record created · 🔑 day-1 tasks scheduled · 📦 handover pack</div></div>'
          +'<div class="ob-tot grand"><span>Plan value locked</span><span class="v">'+kr(offerTotal(c.offer))+'/'+perL(c.offer)+'</span></div>'
          +'<div class="ob-bar"><button class="ob-btn green" data-ob="goLive">🚀 Go live — convert &amp; populate the day app</button></div></div>'
        +'<div>'+historyHTML(c)+logCard(c)+'</div></div>';
    }
    // Live → enrichment mode
    var h=c.handover||{};
    return '<div class="ob-ok">🚀 <b>'+esc(c.name)+' is live.</b> '+ (h.plans||0) +' service plans and day-1 tasks are now in the Field &amp; Office day app — switch the view above to see them.</div>'
      +'<div class="ob-grid split">'
      +'<div>'
        +'<div class="ob-callout" style="border-color:var(--blue);background:var(--blue-l);color:var(--blue)"><b>🧭 Learn the building (enrichment).</b> The sales walk caught the outside &amp; obvious. Now add interior items room by room — tech/laundry rooms, 🔌 panels, 🚰 valves/shut-offs — and correct counts. The record keeps thickening.</div>'
        +'<div class="ob-picker" id="ob-layers">'+layerPickerHTML(c,"enrich")+'</div>'
        +'<div class="ob-maptools"><span class="ob-active-note" id="ob-active">'+activeNote()+'</span><span style="flex:1"></span>'
          +'<button class="ob-btn ghost" data-ob="geotag">📍 Use my location</button></div>'
        +'<div class="ob-drawbar" id="ob-drawtools">'+drawToolbarHTML()+'</div>'
        +'<div class="ob-drawread" id="ob-draw-readout"></div>'
        +'<div id="ob-map"></div>'
      +'</div>'
      +'<div>'
        +'<div id="ob-zonepanel">'+zonesPanelHTML(c)+'</div>'
        +'<div class="card"><div class="ct">Handover pack</div>'
          +'<div class="ob-tot"><span>Building</span><span class="v" style="font-size:14px">'+esc(h.building||c.name)+'</span></div>'
          +'<div class="ob-tot"><span>Access</span><span class="v" style="font-size:13px">'+esc(h.access||"—")+'</span></div>'
          +'<div class="ob-tot"><span>Service plans</span><span class="v">'+(h.plans||0)+'</span></div>'
          +'<div class="ob-tot"><span>Day-1 tasks</span><span class="v">'+((h.tasks||0)+(h.compliance||0))+'</span></div>'
          +'<div class="ob-tot grand"><span>Plan value</span><span class="v">'+kr(h.planValue||offerTotal(c.offer))+'/'+perL(c.offer)+'</span></div>'
          +'<div class="ob-bar"><button class="ob-btn ghost" data-ob="printOffer">🖨 Print handover / offer</button></div></div>'
        +'<div class="card"><div class="ct">Zones &amp; interior (live record)</div><div id="ob-zones">'+zonesHTML(c)+'</div></div>'
        +logCard(c)
      +'</div></div>';
  }

  function logCard(c){
    if(!c.log||!c.log.length) return "";
    return '<div class="card"><div class="ct">Activity &amp; decision log</div>'+c.log.map(function(e){
      return '<div class="ob-row"><div class="rd"><b style="color:var(--ink)">'+esc(e.ts)+'</b> — '+esc(e.text)+'</div></div>';
    }).join("")+'</div>';
  }

  /* ---- Board view augmentation (reuse the Board role for review) ---- */
  function renderBoardExtras(cols){
    var awaiting=customers().filter(function(c){ return c.offer && (c.stage==="Offer sent"||c.stage==="Changes requested"); });
    if(!awaiting.length) return;
    var host=document.createElement("div"); host.className="lane"; host.style.gridColumn="1 / -1";
    var c=awaiting[0];
    host.innerHTML='<div class="ob-board-banner"><h3>📋 New service offer to review — '+esc(c.name)+'</h3>'
      +'<p>OnSite granted you access to your building. Review the offer line by line, or just reply by email.</p>'
      +'<button class="open" data-ob="reviewNow" data-id="'+c.id+'">Review the offer ▾</button></div>'
      + (ui.boardOpen===c.id ? boardReviewHTML(c) : "");
    cols.insertBefore(host, cols.firstChild);
  }

  /* ---- Office view augmentation (pipeline summary + new) ---- */
  function renderOfficeExtras(cols){
    var list=customers();
    var host=document.createElement("div"); host.className="lane"; host.style.gridColumn="1 / -1";
    var rows=list.length?list.map(function(c){
      var up=(c.markers||[]).filter(function(m){return isUpsell(c,m);}).length;
      return '<div class="ob-row" data-ob="open" data-id="'+c.id+'" style="cursor:pointer"><div class="ob-line-top">'
        +'<div class="rt">'+esc(c.name)+' <span class="'+badgeClass(c.stage)+'">'+c.stage+'</span></div>'
        +'<div class="rp">'+(c.offer?kr(offerTotal(c.offer))+'/'+perL(c.offer):'—')+'</div></div>'
        +'<div class="rd">'+(c.markers?c.markers.length:0)+' zones'+(up?' · '+up+' upsell':'')+(c.buildingId?' · live building':'')+'</div></div>';
    }).join(""):'<div class="empty">No customers in the pipeline yet.</div>';
    var ars=liveClients().map(function(c){return arsplanHTML(c);}).join("");
    host.innerHTML='<div class="card"><div class="ct">Sales pipeline — new customers</div>'+rows
      +'<button class="ob-newbtn" data-ob="new">＋ Set up a new client (sales → onboarding)</button></div>'+ars;
    cols.insertBefore(host, cols.firstChild);
  }

  /* ===========================================================================
     PRINT (formal offer / handover — browser Save-as-PDF)
     =========================================================================== */
  function printOffer(c){
    if(!c.offer){ toast("Generate the offer first"); return; }
    var per=perL(c.offer);
    var lines=c.offer.lines.filter(function(l){return l.review.decision!=="remove";}).map(function(l){
      var d=lineDef(l), cl=l.category||catLabel(l.layer), sub=l.subtype||d.emoji;
      var partner = l.deliveredBy==="partner" ? ' — '+esc(l.partnerName||"partner")+' (partner)' : '';
      var qtyStr = (l.qty===""||l.qty==null)?"":(d.measure==="area"?(l.qty+" m²"):(l.qty+(d.unit?(" "+d.unit):"")));
      return '<div class="docrow"><div><div class="sc">'+d.emoji+' '+esc(cl)+' › '+esc(sub)+partner+(!l.inScope?' <span class="upsell-tag">NY</span>':'')+'</div>'
        +'<div class="fr">'+esc(l.frequency||l.scope||"")+(qtyStr?' · '+esc(qtyStr):'')+'</div></div>'
        +'<div class="pr">'+kr(l.price)+'/'+per+'</div></div>';
    }).join("");
    var ups=(c.offer.upsells||[]).map(function(l){
      return '<div class="docrow"><div><div class="sc">⬆ '+esc(l.category)+' › '+esc(l.subtype)+'</div></div><div class="pr">'+kr(l.price)+(l.oneOff?' eng.':'/'+per)+'</div></div>';
    }).join("");
    var t=c.offer.terms;
    var terms = t ? '<div class="note"><b>Vilkår.</b> '
        +[t.green&&("Grøntområde: "+t.green), t.hourly&&("Utenfor avtale: "+t.hourly), t.consumables, t.notice, t.kpi, t.start].filter(Boolean).map(esc).join(" · ")+'</div>' : '';
    var ct=c.contacts[0]||{};
    var html='<div class="ob-doc">'
      +'<h1>Serviceavtale — '+esc(c.name)+'</h1>'
      +'<div class="docsub">'+esc(c.addr||"")+(c.gnr?(' · gnr '+esc(c.gnr)+'/bnr '+esc(c.bnr)):'')+' · Tilbud v'+c.offer.version+' · '+c.offer.createdAt+' · OnSite</div>'
      +'<div class="docsub">Til: '+esc(ct.name||"Styret")+(ct.email?' &lt;'+esc(ct.email)+'&gt;':'')+(c.manager?(' · Forvalter: '+esc(c.manager)):'')+'</div>'
      +lines
      +'<div class="doctot"><span>Total / '+(per==="mnd"?"mnd + mva":"år")+'</span><span>'+kr(offerTotal(c.offer))+'</span></div>'
      +(ups?'<div class="docsub" style="margin-top:14px;font-weight:700">Upsell / tillegg (utenfor grunnbeløp)</div>'+ups:'')
      +'<div class="note">'+esc(c.offer.coverNote||"")+'</div>'
      +terms
      +'<div class="sig"><div>_______________________<br>For '+esc(c.name)+'</div><div>_______________________<br>OnSite</div></div>'
      +'</div>';
    var pa=document.getElementById("ob-print"); if(!pa) return;
    pa.innerHTML=html;
    document.body.classList.add("ob-print-offer");
    var cleanup=function(){ document.body.classList.remove("ob-print-offer"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(function(){ window.print(); }, 60);
  }

  /* ===========================================================================
     DOM helpers
     =========================================================================== */
  function setHTML(id,h){ var el=document.getElementById(id); if(el) el.innerHTML=h; }
  function setText(id,t){ var el=document.getElementById(id); if(el) el.textContent=t; }

  /* ===========================================================================
     EVENTS
     =========================================================================== */
  document.addEventListener("click", function(e){
    var t=e.target.closest("[data-ob]"); if(!t) return;
    var act=t.getAttribute("data-ob"), id=t.getAttribute("data-id"), arg=t.getAttribute("data-arg");
    var c=cur();
    switch(act){
      case "open": ui.openId=id; var co=cust(id); ui.step=co?defaultStep(co):0; ui.draftNew=false; ui.activeLayer=null; ui.zonesOpen={1:true,3:true}; ui.modOpen={}; OnSite.go("sales"); break;
      case "modExpand": { if(c&&c.offer){ ui.modOpen=ui.modOpen||{}; ui.modOpen[id]=!ui.modOpen[id]; refreshTiered(c); } break; }
      case "cliScope": { if(c){ var cit=(c.checklist||[]).filter(function(x){return x.id===id;})[0]; if(cit){ cit.scope=arg; save(); refreshChecklist(c); if(arg==="in" && ({lawn:1,hedges:1,beds:1,snow:1,paths:1,garage:1,facade:1})[cit.id]) toast("Tips: tegn denne sonen på kartet med «Tegn sone»"); } } break; }
      case "cliZone": { ui.zonesOpen[id]=!ui.zonesOpen[id]; if(c) setHTML("ob-checklist", checklistRowsHTML(c)); break; }
      case "weekStep": { var base=(ui.refMs!=null?ui.refMs:Date.now()); ui.refMs=base+parseInt(arg,10)*7*86400000; render(); break; }
      case "jumpTo": { var rd=refDate(), yy=rd.getFullYear(); ui.refMs = arg==="winter"?new Date(yy,0,15).getTime() : arg==="spring"?new Date(yy,4,6).getTime() : null; render(); break; }
      case "yearStep": { var rd2=refDate(); ui.refMs=new Date(rd2.getFullYear()+parseInt(arg,10), rd2.getMonth(), rd2.getDate()).getTime(); render(); break; }
      case "planDone": { var p=(arg||"").split("|"); completeInstance({lineId:p[0], date:p[1], title:decodeURIComponent(p[2]||""), freq:decodeURIComponent(p[3]||""), building:decodeURIComponent(p[4]||"")}); break; }
      case "spawnEvt": spawnEvent(decodeURIComponent(arg||"")); break;
      case "back": ui.openId=null; ui.draftNew=false; repaintSales(); break;
      case "step": { var n=parseInt(id,10); if(c && n<=maxStep(c)){ ui.step=n; ui.activeLayer=null; repaintSales(); } break; }
      case "new": startNew(); break;
      case "prefill": prefillForm(); break;
      case "savePrep": savePrep(); break;
      case "locatePrep": { var a=val("p_addr"); var cc=cur(); if(cc){ cc.addr=a; locate(cc,a);} break; }
      case "locateWalk": if(c) locate(c, c.addr); break;
      case "geotag": if(c) geotag(c); break;
      case "pick": if(c){ pickLayer(c,id); } break;
      case "drawZone": startDraw(arg); break;
      case "drawFinish": finishDraw(); break;
      case "drawCancel": cancelDraw(); break;
      case "saveZone": saveZoneFromSheet(); break;
      case "editZone": editZone(id); break;
      case "delZone": delZone(id); break;
      case "closeObSheet": obCloseSheet(); pendingZone=null; break;
      case "printMap": printMapCard(arg); break;
      case "genOffer": if(c){ if(!c.offer) generateOffer(c); if(c.stage==="Prospect"||c.stage==="Surveyed") setStage(c,"Surveyed"); ui.step=2; repaintSales(); } break;
      case "sendOffer": if(c) sendOffer(c); break;
      case "openBoard": ui.boardOpen=(c?c.id:null); OnSite.go("board"); break;
      case "reviewNow": ui.boardOpen=(ui.boardOpen===id?null:id); OnSite.render(); break;
      case "printOffer": if(c) printOffer(c); break;
      case "dec": { var bc=boardCustomer(); if(bc) setDecision(bc, id, arg); break; }
      case "approveAll": { var bc2=boardCustomer(); if(bc2) approveAll(bc2); break; }
      case "submitBoard": { var bc3=boardCustomer(); if(bc3) submitBoard(bc3); break; }
      case "ingestEmail": { var bc4=boardCustomer(); if(bc4) ingestEmail(bc4, val("ob-emailbox")); break; }
      case "resolveReq": if(c) resolveReq(c,id); break;
      case "removeLine": if(c) removeLine(c,id); break;
      case "declineReq": if(c) declineReq(c,id); break;
      case "issueV2": if(c) issueV2(c); break;
      case "goLive": if(c) goLive(c); break;
      case "photo": togglePhoto(id); break;
      case "delMarker": deleteMarker(id); break;
      case "clearCustomers": if(window.confirm("Clear all sales customers? (the day app is unaffected)")){ S().customers=[]; S().obSeeded=true; save(); ui.openId=null; repaintSales(); toast("Customers cleared — add a real one with ＋ New customer"); } break;
      case "reseed": { var rst=S(); rst.customers=(rst.customers||[]).filter(function(x){return x.id!=="holtet-cust"&&x.id!=="solbakken-cust";}); rst.customers.unshift(seedSolbakken()); rst.customers.unshift(seedHoltet()); rst.obSeeded=true; save(); ui.openId=null; repaintSales(); toast("Seed-klienter tilbakestilt (Holtet + Solbakken)"); break; }
    }
  });

  // which customer is the board review acting on (board view uses ui.boardOpen; sales step3 uses ui.openId)
  function boardCustomer(){ return cur() || (ui.boardOpen?cust(ui.boardOpen):null) || customers().filter(function(c){return c.offer&&(c.stage==="Offer sent"||c.stage==="Changes requested");})[0] || null; }

  document.addEventListener("change", function(e){ handleField(e.target); });
  document.addEventListener("input", function(e){ if(e.target.getAttribute && e.target.getAttribute("data-obf")==="bcomment") handleField(e.target); });
  function handleField(f){
    if(!f || !f.getAttribute) return;
    var name=f.getAttribute("data-obf"); if(!name) return;
    var id=f.getAttribute("data-id"), val=f.value, c=cur()||boardCustomer();
    if(name==="scope"){ var cc=cur(); if(!cc) return; cc.requestedScope=cc.requestedScope||[]; var i=cc.requestedScope.indexOf(id);
      if(f.checked && i<0) cc.requestedScope.push(id); if(!f.checked && i>=0) cc.requestedScope.splice(i,1);
      // ensure scoped layer is in the layer set; recompute upsell flags on markers
      if(f.checked && cc.layers.indexOf(id)<0) cc.layers.push(id);
      (cc.markers||[]).forEach(function(m){ m.inScope=(cc.requestedScope.indexOf(m.layer)>=0); });
      save(); return; }
    if(name==="zoneService"){ if(pendingZone){ pendingZone.service=val; pendingZone.method=defaultMethod(val); obSheet(zoneSheetHTML(pendingZone)); } return; }
    if(!c) return;
    if(name==="cover"){ if(c.offer){ c.offer.coverNote=val; save(); } return; }
    if(name==="modIncl"){ if(c.offer){ var mm=c.offer.modules.filter(function(x){return x.service===id;})[0]; if(mm){ mm.included=f.checked; rebuildOfferFlat(c); save(); refreshTiered(c); toast(mm.included?(mm.title+" inkludert"):(mm.title+" valgt bort — kan sies opp separat")); } } return; }
    if(name==="modStart"){ if(c.offer){ var msd=c.offer.modules.filter(function(x){return x.service===id;})[0]; if(msd){ msd.startDate=val; save(); } } return; }
    if(name==="lineFinal"){ if(c.offer){ var lf=findOfferLine(c,id); if(lf){ var v=Math.round(parseFloat(val)||0); lf.final=v; lf.overridden=(v!==lf.computed); lf.price=v; rebuildOfferFlat(c); save(); refreshTiered(c); } } return; }
    if(name==="clival"){ var ci=(c.checklist||[]).filter(function(x){return x.id===id;})[0]; if(ci){ ci.value=val; save(); } return; }
    if(name==="clibool"){ var cb=(c.checklist||[]).filter(function(x){return x.id===id;})[0]; if(cb){ cb.value=f.checked; save(); } return; }
    if(name==="bcomment"){ var l=findLine(c,id); if(l){ l.review.comment=val; save(); } return; }
    if(name.indexOf("mk")===0){ var m=findMarker(c,id); if(!m) return;
      if(name==="mkservice") m.service=val;
      else if(name==="mkfreq") m.frequency=val;
      else if(name==="mknote") m.note=val;
      else if(name==="mkqty"){ m.qty=parseFloat(val)||0; m.price=markerPrice(m.layer,m.qty); }
      save(); refreshWalk(c);
      var lm=leafMarkers[m.id]; if(lm){ lm.setPopupContent(markerPopupHTML(c,m)); }
      return; }
    if(name.indexOf("line")===0){ var ln=findLine(c,id); if(!ln) return;
      if(name==="lineprice") ln.price=parseFloat(val)||0;
      else if(name==="lineqty") ln.qty=parseFloat(val)||0;
      else if(name==="linescope") ln.scope=val;
      else if(name==="linefreq") ln.frequency=val;
      save(); return; }
  }
  function val(id){ var el=document.getElementById(id); return el?el.value.trim():""; }

  /* ---- interactions that must not rebuild the map ---- */
  function pickLayer(c, key){
    if((c.layers||[]).indexOf(key)<0){ (c.layers=c.layers||[]).push(key); save(); }
    ui.activeLayer = (ui.activeLayer===key ? null : key);
    // toggle chip highlight + active note without full re-render (keeps map stable)
    var box=document.getElementById("ob-layers");
    // re-render the grouped picker to reflect "on" set + active (keeps the map stable)
    if(box){ box.innerHTML = layerPickerHTML(c, c.stage==="Live"?"enrich":"sales"); }
    setText("ob-active", activeNote());
  }
  function togglePhoto(id){
    var c=cur(); if(!c) return; var m=findMarker(c,id); if(!m) return;
    m.photo=!m.photo; save(); refreshWalk(c);
    var lm=leafMarkers[m.id]; if(lm){ lm.setPopupContent(markerPopupHTML(c,m)); }
    toast(m.photo?"📷 Photo attached (simulated)":"Photo removed");
  }
  function deleteMarker(id){
    var c=cur(); if(!c) return;
    c.markers=c.markers.filter(function(m){return m.id!==id;});
    save();
    var lm=leafMarkers[id]; if(lm&&markerLayer){ markerLayer.removeLayer(lm); delete leafMarkers[id]; }
    refreshWalk(c); toast("Marker deleted");
  }

  /* ---- new / prep ---- */
  function startNew(){
    var c={ id:"cust"+uid(), name:"", addr:"", gnr:"", bnr:"", profile:PROFILES[0], buildYear:"", size:"",
      contacts:[{name:"",role:"Board chair",email:""}], meetingTime:"", stage:"Prospect",
      requestedScope:[], layers:[], center:{lat:59.9139, lon:10.7522, zoom:13}, baseLayer:"topo",
      accessNote:"", markers:[], zones:[], offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:nowStr(), text:"Prospect created"}] };
    customers().push(c); save();
    ui.openId=c.id; ui.step=0; ui.draftNew=true; ui.activeLayer=null;
    OnSite.go("sales");
  }
  function prefillForm(){
    // mock Matrikkel/Kartverket registry pre-fill
    setVal("p_year","1998"); setVal("p_size","2400");
    var sel=document.getElementById("p_profile"); if(sel) sel.value="Residential — association";
    if(!val("p_gnr")) setVal("p_gnr","62"); if(!val("p_bnr")) setVal("p_bnr","140");
    toast("Registry pre-fill applied (mocked): 1998 · 2 400 m² · association");
  }
  function setVal(id,v){ var el=document.getElementById(id); if(el) el.value=v; }
  function savePrep(){
    var c=cur(); if(!c) return;
    var name=val("p_name"); if(!name){ toast("Enter a name first"); var el=document.getElementById("p_name"); if(el) el.focus(); return; }
    c.name=name; c.addr=val("p_addr"); c.gnr=val("p_gnr"); c.bnr=val("p_bnr");
    c.profile=val("p_profile")||c.profile; c.buildYear=parseInt(val("p_year"),10)||""; c.size=parseInt(val("p_size"),10)||"";
    c.meetingTime=val("p_meet");
    c.contacts=[{name:val("p_cname"), role:"Board chair", email:val("p_cemail")}];
    // load the layer set from requested scope + suggested-from-year
    var set={}; (c.requestedScope||[]).forEach(function(k){set[k]=1;});
    suggestedFromYear(c.buildYear).forEach(function(k){set[k]=1;});
    if(c.profile.indexOf("Residential")>=0){ set.greenery=1; }
    c.layers=Object.keys(set);
    (c.markers||[]).forEach(function(m){ m.inScope=(c.requestedScope.indexOf(m.layer)>=0); });
    if(c.stage==="Prospect"){ logEvent(c,"Office prep saved — "+(c.requestedScope.length)+" scope items, "+c.layers.length+" layers loaded"); }
    ui.draftNew=false; ui.step=1; save();
    toast("Saved — walkaround layers loaded");
    repaintSales();
  }

  /* ---------- register hook with the day app ---------- */
  OnSite.renderExtras = renderExtras;
  // if the app is already showing (e.g. hot reload), refresh once
  try{ seedIfNeeded(); }catch(e){ console.error(e); }
})();
