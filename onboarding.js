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
  function save(){ return OnSite.save(); } // C1: propagate success/failure so writers can gate their success toast
  function render(){ OnSite.render(); }
  function toast(m){ OnSite.toast(m); }
  function esc(s){ return OnSite.esc(s); }
  function uid(){ return OnSite.uid(); }
  function kr(n){ return "kr " + (Math.round(n)||0).toLocaleString("no"); }
  function nowStr(){ try{ return new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}); }catch(e){ return "today"; } }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  var FM_SELSKAP = "Bygårdsservice AS"; // placeholder FM company on board leave-behind (doc 50)

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
    // derived from SERVICE_CATALOGUE (checklist:true entries, in catalogue order) — Phase 8 single source.
    var out=[];
    for(var id in SERVICE_CATALOGUE){ var e=SERVICE_CATALOGUE[id]; if(!e.checklist) continue;
      out.push({ id:id, zone:e.zone, label:e.label, category:e.cat, captureType:e.captureType, emoji:e.emoji,
        freq:e.freq||"", upsell:!!e.upsell, compliance:!!e.compliance,
        value:null, scope:"unknown", deliveredBy:"in-house", partnerName:null, price:0, subtype:e.label });
    }
    return out;
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
  var ui = { openId:null, step:0, activeLayer:null, draftNew:false, zonesOpen:{}, refMs:null, modOpen:{}, newBuilding:null, cockMode:"route", cockMapId:null };

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
      profile:"Residential — association", buildYear:2018, size:0, units:35,
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
      upcoming:holtetUpcoming(),  // Phase 7: known upcoming maintenance (data; the while-here engine recomputes suggestions from it)
      assets:holtetAssets(),      // Phase 10: location-tagged building-asset registry (the moat layer)
      offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:"16 Jun 2026", text:"Step 0 ferdig fra registre — USBL + styret hentet, 7 oppganger pinnet, sjekkliste forhåndsutfylt"},
           {ts:"15 Jun 2026", text:"Prospect opprettet fra Bygårdsservice-kontrakt (Kongsveien 82 A–G)"}]
    };
  }
  // Phase 7 demo seed — known upcoming maintenance with co-located/co-timed/co-equipment hooks.
  // offsetDays = days from "today" (evergreen demo; a real task would carry an absolute due date — same engine).
  function holtetUpcoming(){
    return [
      {id:"u-roof-today",   title:"Tak – visuell inspeksjon etter vind",          area:"tak",     method:"stige",   service:"other",      equipment:["stige"],        offsetDays:0},
      {id:"u-facade-today", title:"Fasade sokkel – spotvask svertesopp",          area:"fasade",  method:"lift",    service:"cleaning",   equipment:["lift","spyler"],offsetDays:0},
      {id:"u-gutter",       title:"Takrennerens (løv + nedløp)",                  area:"tak",     method:"stige",   service:"other",      equipment:["stige"],        offsetDays:9},
      {id:"u-vannbord",     title:"Vannbord + beslag – sjekk og fest",            area:"tak",     method:"stige",   service:"other",      equipment:["stige"],        offsetDays:17},
      {id:"u-hedge",        title:"Beskjæring høy hekk + tre (>3 m)",             area:"ute",     method:"lift",    service:"greenery",   equipment:["hekksaks","lift"],offsetDays:13},
      {id:"u-brann",        title:"Brannvern: slokkere + røykvarslere (kvartal)", area:"teknisk", method:"manuell", service:"compliance", statutory:true, equipment:[], offsetDays:6}
    ];
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
    seedEquipmentIfNeeded();   // Phase 9: equipment/storage registry (also backfills migrated users)
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
    // M19: Kartverket topo only — OSM public tiles removed (commercial-use terms compliance)
    L.tileLayer(KARTVERKET,{attribution:"© Kartverket", maxZoom:20}).addTo(map);
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
  function zoneShort(z){ return (z.priority?'P'+z.priority+' · ':'')+esc(methodLabel(z)||z.label||'')+(z.area_m2!=null||z.length_m!=null?' · '+zoneMeasureStr(z):''); } // M7: escape user-entered label (permanent tooltip → innerHTML)
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
  function refreshZones(c){ renderZones(c); setHTML("ob-zonepanel", zonesPanelHTML(c)); hydratePhotos(document.getElementById("ob-zonepanel")); }

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
    if(drawMode==="point"){ var c=cur(); endDrawMode();
      if(assetPinMode){ assetPinMode=false; if(pendingAsset){ pendingAsset.geo={lat:latlng.lat, lon:latlng.lng}; } reopenAssetSheet(); toast("📍 Punkt plassert"); return; }  // Phase 10 asset pin
      openZoneSheet(c, null, {type:"Point", coordinates:[latlng.lng, latlng.lat]}); return; }
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
      +photoStripHTML("zone", z.id, z.photoIds)
      +'<div class="ob-acts"><button class="ob-mini" data-ob="editZone" data-id="'+z.id+'">✎ Rediger</button><button class="ob-mini no on" data-ob="delZone" data-id="'+z.id+'">🗑 Slett</button></div></div>';
  }
  function editZone(id){ var c=cur(); if(!c) return; var z=findZone(c,id); if(!z) return;
    if(map){ try{ var b=L.geoJSON(z.geometry).getBounds(); map.panTo(b.getCenter()); }catch(e){} }
    openZoneSheet(c, z, z.geometry); }
  function delZone(id){ var c=cur(); if(!c) return; var dz=findZone(c,id); if(dz) zonePhotoIds(dz).forEach(photoDel); // M13: free the deleted zone's orphaned photo blobs
    c.zones=(c.zones||[]).filter(function(z){return z.id!==id;}); save(); refreshZones(c); toast("Sone slettet"); }

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
    // M19: geonorge only — Nominatim removed (OSM commercial-use policy). On failure → null (caller falls back to manual placement).
    var url="https://ws.geonorge.no/adresser/v1/sok?sok="+encodeURIComponent(addr)+"&treffPerSide=1";
    fetch(url).then(function(r){return r.json();}).then(function(j){
      var a=j&&j.adresser&&j.adresser[0];
      cb(a&&a.representasjonspunkt ? {lat:a.representasjonspunkt.lat, lon:a.representasjonspunkt.lon, label:a.adressetekst||addr} : null);
    }).catch(function(){ cb(null); });
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
     PUBLIC REGISTRY (Phase 3) — geonorge + Brønnøysund, no key, CORS-open.
     Probed shapes 2026-06; all parsers tolerate missing fields, cb(null) on error.
     =========================================================================== */
  var BRREG="https://data.brreg.no/enhetsregisteret/api/enheter";
  function titleCase(s){ return (s||"").toLowerCase()
    .replace(/\b([a-zæøå])/g,function(m,c){return c.toUpperCase();})
    .replace(/\bAs\b/g,"AS").replace(/\bUsbl\b/g,"USBL").replace(/\bObos\b/g,"OBOS").replace(/\bKpmg\b/g,"KPMG").replace(/\bBbl\b/g,"BBL").replace(/\bSa\b/g,"SA").replace(/\bDa\b/g,"DA"); }
  function personName(p){ var n=(p&&p.navn)||{}; return [n.fornavn,n.mellomnavn,n.etternavn].filter(Boolean).join(" "); }
  function brregSearch(name, cb){
    fetch(BRREG+"?navn="+encodeURIComponent(name)+"&size=10").then(function(r){return r.json();})
      .then(function(j){ cb(((j._embedded||{}).enheter)||[]); }).catch(function(){ cb(null); });
  }
  function brregRoles(orgnr, cb){
    fetch(BRREG+"/"+encodeURIComponent(orgnr)+"/roller").then(function(r){return r.json();})
      .then(function(j){ cb(parseRoles(j)); }).catch(function(){ cb(null); });
  }
  // names only — never retain fodselsdato (privacy / data minimization)
  function parseRoles(j){
    var out={forvalter:null, styreleder:null, styremedlemmer:[], revisor:null};
    (((j||{}).rollegrupper)||[]).forEach(function(g){
      var gk=((g.type||{}).kode)||"";
      (g.roller||[]).forEach(function(r){
        var rk=((r.type||{}).kode)||"";
        var nm = r.enhet ? titleCase((r.enhet.navn||[]).join(" ")) : r.person ? personName(r.person) : null;
        if(!nm) return;
        if(gk==="FFØR" && !out.forvalter) out.forvalter=nm;
        else if(gk==="STYR" && rk==="LEDE" && !out.styreleder) out.styreleder=nm;
        else if(gk==="STYR" && rk==="MEDL") out.styremedlemmer.push(nm);
        else if(gk==="REVI" && !out.revisor) out.revisor=nm;
      });
    });
    return out;
  }
  function geoSearch(q, cb){
    fetch("https://ws.geonorge.no/adresser/v1/sok?sok="+encodeURIComponent(q)+"&treffPerSide=10&fuzzy=true")
      .then(function(r){return r.json();}).then(function(j){ cb((j.adresser)||[]); }).catch(function(){ cb(null); });
  }
  function parseAddr(a){
    return { adressetekst:a.adressetekst||"", postnummer:a.postnummer||"", poststed:a.poststed||"",
      kommunenavn:a.kommunenavn||"", kommunenummer:a.kommunenummer||"",
      gnr:(a.gardsnummer!=null?String(a.gardsnummer):""), bnr:(a.bruksnummer!=null?String(a.bruksnummer):""),
      lat:(a.representasjonspunkt||{}).lat, lon:(a.representasjonspunkt||{}).lon,
      units:((a.bruksenhetsnummer)||[]).length };
  }
  function geoLookup(q, cb){ geoSearch(q, function(list){ cb(list===null?null:(list[0]?parseAddr(list[0]):false)); }); }
  // brreg forretningsadresse is often the c/o-forvalter address — strip c/o lines for a cleaner geocode
  function brregStreet(fa){ if(!fa) return ""; var lines=(fa.adresse||[]).filter(function(s){return !/^c\/o/i.test(s||"");}); return (lines[lines.length-1]||"")+(fa.postnummer?(", "+fa.postnummer+" "+(fa.poststed||"")):""); }

  // Norway · residential CompliancePack (doc 23) — derived on create, not fetched
  var COMPLIANCE_PACK_NO_RESIDENTIAL = [
    {label:"Brannvern – HMS-runde",            interval:"Kvartalsvis"},
    {label:"El-kontroll (NEK 405)",            interval:"~5 år"},
    {label:"Lekeplasskontroll (NS-EN 1176)",   interval:"Årlig"},
    {label:"Heiskontroll",                     interval:"2-årlig"},
    {label:"Legionella – risikovurdering",     interval:"Årlig (ved fellesdusj)"},
    {label:"Radonmåling",                      interval:"Hvert 5. år"},
    {label:"Oljetank – kontroll/sanering",     interval:"Ved behov"}
  ];
  function complianceClone(){ return COMPLIANCE_PACK_NO_RESIDENTIAL.map(function(r){ return {label:r.label, interval:r.interval}; }); }

  /* ===========================================================================
     PHOTOS (Phase 5) — camera capture pinned to zones + checklist items.
     Blobs live OUTSIDE the customer record: the record keeps only photoIds[].
     Store = IndexedDB (big quota) with a capped-localStorage fallback that never
     throws. Images downscaled+compressed (≤1280px, JPEG ~0.6 → ~100–200 KB).
     // PROD: offload to object storage; this is the prototype-local approximation.
     =========================================================================== */
  var photoCache = {};                 // id → dataUrl (in-memory; renders read this synchronously)
  var PHOTO_DB="onsite_photos_db", PHOTO_STORE="photos", _idb=null, _idbNoIDB=false, _idbOpening=false, _idbWaiters=[];
  // M16: robust open — handles onblocked/onerror/version-change + an open-timeout, coalesces concurrent
  // opens, and (unlike before) does NOT permanently latch after a transient failure — it retries next call,
  // falling back to the localStorage photo store for the calls that hit the failure.
  function idbOpen(cb){
    if(_idb) return cb(_idb);
    if(_idbNoIDB || !window.indexedDB){ _idbNoIDB=true; return cb(null); }  // permanent: this browser has no IndexedDB
    _idbWaiters.push(cb); if(_idbOpening) return; _idbOpening=true;
    var settled=false;
    function done(db){ if(settled) return; settled=true; _idbOpening=false; var ws=_idbWaiters; _idbWaiters=[]; ws.forEach(function(w){ try{ w(db); }catch(e){} }); }
    try{ var rq=indexedDB.open(PHOTO_DB,1);
      rq.onupgradeneeded=function(){ try{ rq.result.createObjectStore(PHOTO_STORE,{keyPath:"id"}); }catch(e){} };
      rq.onsuccess=function(){ _idb=rq.result; try{ _idb.onversionchange=function(){ try{_idb.close();}catch(e){} _idb=null; }; }catch(e){} done(_idb); };
      rq.onerror=function(){ done(null); };    // transient → LS fallback this round, retry next call (no latch)
      rq.onblocked=function(){ try{ toast("Bildelagring midlertidig blokkert (annen fane) — lagrer lokalt"); }catch(e){} done(null); };
      setTimeout(function(){ done(null); }, 3000);  // open-timeout (Safari/private-mode hang) → LS fallback
    }catch(e){ done(null); }
  }
  var PHOTO_LS="onsite_photos", PHOTO_CAP=50;
  function lsAll(){ try{ return JSON.parse(localStorage.getItem(PHOTO_LS)||"{}"); }catch(e){ return {}; } }
  function lsPut(rec, cb){
    var m=lsAll(); m[rec.id]={id:rec.id, dataUrl:rec.dataUrl, caption:rec.caption||"", ts:rec.ts};
    var ids=Object.keys(m);
    if(ids.length>PHOTO_CAP){ ids.sort(function(a,b){return (m[a].ts||0)-(m[b].ts||0);}); while(Object.keys(m).length>PHOTO_CAP) delete m[ids.shift()]; }
    try{ localStorage.setItem(PHOTO_LS, JSON.stringify(m)); cb&&cb(true); }
    catch(e){
      try{ ids=Object.keys(m).sort(function(a,b){return (m[a].ts||0)-(m[b].ts||0);}); delete m[ids[0]]; if(ids[1]) delete m[ids[1]]; localStorage.setItem(PHOTO_LS, JSON.stringify(m)); }catch(e2){}
      toast("⚠️ Lite lagringsplass — eldste bilde fjernet (prototype lagrer lokalt)"); cb&&cb(false);
    }
  }
  function lsGet(id){ var m=lsAll(); return m[id]||null; }
  function lsDel(id){ var m=lsAll(); delete m[id]; try{ localStorage.setItem(PHOTO_LS, JSON.stringify(m)); }catch(e){} }
  function photoPut(rec, cb){
    photoCache[rec.id]=rec.dataUrl;
    idbOpen(function(db){ if(!db) return lsPut(rec,cb);
      try{ var tx=db.transaction(PHOTO_STORE,"readwrite"); tx.objectStore(PHOTO_STORE).put({id:rec.id, dataUrl:rec.dataUrl, caption:rec.caption||"", ts:rec.ts, kb:rec.kb});
        tx.oncomplete=function(){ cb&&cb(true); }; tx.onerror=function(){ lsPut(rec,cb); };
      }catch(e){ lsPut(rec,cb); }
    });
  }
  function photoGet(id, cb){
    if(photoCache[id]) return cb({id:id, dataUrl:photoCache[id]});
    idbOpen(function(db){ if(!db){ var r=lsGet(id); if(r) photoCache[id]=r.dataUrl; return cb(r); }
      try{ var rq=db.transaction(PHOTO_STORE,"readonly").objectStore(PHOTO_STORE).get(id);
        rq.onsuccess=function(){ var r=rq.result; if(r){ photoCache[id]=r.dataUrl; cb(r); } else { var l=lsGet(id); if(l) photoCache[id]=l.dataUrl; cb(l); } };
        rq.onerror=function(){ cb(lsGet(id)); };
      }catch(e){ cb(lsGet(id)); }
    });
  }
  function photoSetCaption(id, caption){ if(photoCache[id]!=null){} idbOpen(function(db){ if(!db){ var m=lsAll(); if(m[id]){ m[id].caption=caption; try{localStorage.setItem(PHOTO_LS,JSON.stringify(m));}catch(e){} } return; }
    try{ var st=db.transaction(PHOTO_STORE,"readwrite").objectStore(PHOTO_STORE); var rq=st.get(id); rq.onsuccess=function(){ var r=rq.result; if(r){ r.caption=caption; st.put(r); } }; }catch(e){} }); }
  function photoGetCaption(id, cb){ idbOpen(function(db){ if(!db){ var l=lsGet(id); return cb(l?l.caption||"":""); }
    try{ var rq=db.transaction(PHOTO_STORE,"readonly").objectStore(PHOTO_STORE).get(id); rq.onsuccess=function(){ cb(rq.result?(rq.result.caption||""):""); }; rq.onerror=function(){ cb(""); }; }catch(e){ cb(""); } }); }
  function photoDel(id){ delete photoCache[id]; lsDel(id); idbOpen(function(db){ if(!db) return;  // delete from BOTH stores (no split-brain orphan)
    try{ db.transaction(PHOTO_STORE,"readwrite").objectStore(PHOTO_STORE).delete(id); }catch(e){} }); }
  // M13: reclaim orphaned photo blobs. zonePhotoIds = a zone's own + its completionLog photos.
  function zonePhotoIds(z){ var out=(z&&z.photoIds)?z.photoIds.slice():[]; if(z&&z.completionLog) z.completionLog.forEach(function(e){ (e.photoIds||[]).forEach(function(p){ out.push(p); }); }); return out; }
  function collectLivePhotoIds(){ var live={}; (customers()||[]).forEach(function(c){
    (c.zones||[]).forEach(function(z){ (z.photoIds||[]).forEach(function(p){live[p]=1;}); (z.completionLog||[]).forEach(function(e){(e.photoIds||[]).forEach(function(p){live[p]=1;});}); });
    (c.checklist||[]).forEach(function(it){ (it.photoIds||[]).forEach(function(p){live[p]=1;}); });
    (c.completionLog||[]).forEach(function(e){ (e.photoIds||[]).forEach(function(p){live[p]=1;}); });
    (c.assets||[]).forEach(function(a){ (a.photoIds||[]).forEach(function(p){live[p]=1;}); });  // Phase 10: keep asset photos
  }); return live; }
  function photoGC(){   // delete IndexedDB + LS blobs no longer referenced by any record (reconcile after bulk removals)
    var live=collectLivePhotoIds();
    try{ var m=lsAll(), changed=false; Object.keys(m).forEach(function(k){ if(!live[k]){ delete m[k]; delete photoCache[k]; changed=true; } }); if(changed) localStorage.setItem(PHOTO_LS, JSON.stringify(m)); }catch(e){}
    idbOpen(function(db){ if(!db) return; try{ var st=db.transaction(PHOTO_STORE,"readwrite").objectStore(PHOTO_STORE);
      if(st.getAllKeys){ var rq=st.getAllKeys(); rq.onsuccess=function(){ (rq.result||[]).forEach(function(k){ if(!live[k]){ try{st.delete(k);}catch(e){} delete photoCache[k]; } }); }; } }catch(e){} });
  }

  // downscale + compress a File → dataUrl (no deps; canvas)
  function compressImage(file, cb){
    var reader=new FileReader();
    reader.onload=function(e){
      var img=new Image();
      img.onload=function(){
        var max=1280, w=img.width||max, h=img.height||max;
        if(w>=h && w>max){ h=Math.round(h*max/w); w=max; } else if(h>w && h>max){ w=Math.round(w*max/h); h=max; }
        try{ var cv=document.createElement("canvas"); cv.width=w; cv.height=h; cv.getContext("2d").drawImage(img,0,0,w,h);
          var d=cv.toDataURL("image/jpeg",0.6); cb({dataUrl:d, w:w, h:h, kb:Math.round(d.length*0.75/1024)});
        }catch(err){ cb(null); }
      };
      img.onerror=function(){ cb(null); };
      img.src=e.target.result;
    };
    reader.onerror=function(){ cb(null); };
    reader.readAsDataURL(file);
  }

  // ---- UI ----
  function photoStripHTML(kind, id, photoIds){
    var thumbs=(photoIds||[]).map(function(pid){
      return '<span class="ob-thumb" data-ob="photoView" data-arg="'+pid+'">'
        +'<img alt="bilde" '+(photoCache[pid]?'src="'+photoCache[pid]+'"':'data-photo-id="'+pid+'"')+'>'
        +'<button class="ob-thumbdel" data-ob="photoDel" data-arg="'+kind+'|'+id+'|'+pid+'" title="Slett">✕</button></span>';
    }).join("");
    return '<div class="ob-photos">'+thumbs
      +'<label class="ob-photobtn" title="Ta bilde / velg fra album">📷<input type="file" accept="image/*" capture="environment" data-photocap="'+kind+'" data-id="'+id+'"></label></div>';
  }
  function hydratePhotos(root){
    var imgs=(root||document).querySelectorAll('img[data-photo-id]');
    [].forEach.call(imgs, function(img){ if(img.getAttribute("src")) return; var pid=img.getAttribute("data-photo-id");
      if(photoCache[pid]){ img.src=photoCache[pid]; return; }
      photoGet(pid, function(r){ if(r&&r.dataUrl){ img.src=r.dataUrl; } }); });
  }
  function photoTarget(c, kind, id){ return kind==="zone" ? findZone(c,id) : kind==="item" ? (c.checklist||[]).filter(function(x){return x.id===id;})[0] : null; }
  function handlePhotoCapture(input){
    var kind=input.getAttribute("data-photocap"), id=input.getAttribute("data-id");
    var files=input.files; if(!files||!files.length) return;
    var c=cur();
    var t = (kind==="proof") ? pendingProof : (kind==="asset") ? pendingAsset : (c&&photoTarget(c,kind,id));
    if(!t){ input.value=""; return; }
    var n=files.length, done=0, totalKb=0;
    toast("Komprimerer "+n+" bilde"+(n>1?"r":"")+"…");
    [].forEach.call(files, function(file){
      compressImage(file, function(res){
        if(res){ var pid="ph"+uid(); t.photoIds=t.photoIds||[]; t.photoIds.push(pid); totalKb+=res.kb; photoPut({id:pid, dataUrl:res.dataUrl, caption:"", ts:Date.now(), kb:res.kb}); }
        done++; if(done===n){
          if(kind==="proof"){ syncProofFromDOM(); reRenderProofSheet(); }   // photo blob already in IndexedDB; draft holds the id until confirm
          else if(kind==="asset"){ syncAssetFromDOM(); reRenderAssetSheet(); }  // Phase 10: draft holds the id until confirm
          else { save(); afterPhotoChange(c); }
          toast("📷 "+n+" bilde"+(n>1?"r":"")+" lagret (~"+totalKb+" KB)");
        }
      });
    });
    input.value="";
  }
  function afterPhotoChange(c){
    if(document.getElementById("ob-checklist")) setHTML("ob-checklist", checklistRowsHTML(c));
    if(document.getElementById("ob-zonepanel")) setHTML("ob-zonepanel", zonesPanelHTML(c));
    if(document.getElementById("ob-tiered")) refreshTiered(c);
    hydratePhotos(document);
  }
  function photoDelHandler(arg){
    var p=(arg||"").split("|"); var kind=p[0], id=p[1], pid=p[2];
    if(kind==="asset"){ if(pendingAsset){ pendingAsset.photoIds=(pendingAsset.photoIds||[]).filter(function(x){return x!==pid;}); photoDel(pid); reRenderAssetSheet(); } return; }
    var c=cur(); var t=c&&photoTarget(c,kind,id); if(!t) return;
    t.photoIds=(t.photoIds||[]).filter(function(x){return x!==pid;}); photoDel(pid); save(); afterPhotoChange(c); toast("Bilde slettet");
  }
  function photoView(pid){
    photoGet(pid, function(r){
      photoGetCaption(pid, function(cap){
        var src=(r&&r.dataUrl)||photoCache[pid]||"";
        obSheet('<h3>Bilde</h3><img class="ob-lightbox" src="'+src+'" alt="bilde">'
          +'<label>Bildetekst</label><input id="ph_cap" value="'+esc(cap||"")+'" placeholder="kort beskrivelse (valgfritt)">'
          +'<button class="save" data-ob="photoCapSave" data-arg="'+pid+'">Lagre bildetekst</button>'
          +'<button class="cancel" data-ob="closeObSheet">Lukk</button>');
      });
    });
  }
  function galleryView(zoneId){
    var c=cur(); if(!c) return; var z=findZone(c,zoneId); if(!z||!z.photoIds||!z.photoIds.length){ toast("Ingen bilder"); return; }
    var thumbs=z.photoIds.map(function(pid){ return '<span class="ob-thumb lg" data-ob="photoView" data-arg="'+pid+'"><img alt="bilde" '+(photoCache[pid]?'src="'+photoCache[pid]+'"':'data-photo-id="'+pid+'"')+'></span>'; }).join("");
    obSheet('<h3>Vedlegg · '+esc(z.label||z.service)+' <span class="muted" style="font-size:13px;font-weight:600">· '+z.photoIds.length+' bilde'+(z.photoIds.length>1?'r':'')+'</span></h3>'
      +'<div class="ob-gallery">'+thumbs+'</div><button class="cancel" data-ob="closeObSheet">Lukk</button>');
    setTimeout(function(){ hydratePhotos(document.getElementById("sheet")); }, 30);
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
      // base — the standard vaktmester round is always offered; teknisk only when captured/priced
      lines.push(withPrev(oLine({id:id+"base:round", service:"base", role:"round", label:"Ukentlig vaktmesterrunde + tilsyn", emoji:"🧰", qty:1, unit:"runde", rate:RATES.base.vaktmester_round_mnd, cadence:"Ukentlig", computed:RATES.base.vaktmester_round_mnd})));
      var tek=keptVal(c,"water",0); if(tek>0) lines.push(withPrev(oLine({id:id+"base:teknisk", service:"base", role:"teknisk", label:"Teknisk rom – tilsyn", emoji:"🔧", cadence:"Månedlig", computed:tek})));
      // counts only when actually captured (a fresh building stays low/empty until the rep enters them — no fabricated fallbacks)
      var oppCaptured = ckVal(c,"oppganger")!=null && ckVal(c,"oppganger")!=="";
      var entryCaptured = (c.markers||[]).some(function(m){return m.layer==="entrance";}) || oppCaptured;
      if(oppCaptured){
        var cl=Math.round(n.oppganger*n.floors*RATES.cleaning.per_oppgang_floor_week*WPM);
        lines.push(withPrev(oLine({id:id+"cleaning:opp", service:"cleaning", role:"opp", label:"Trappevask "+n.oppganger+" oppg × "+n.floors+" etg", emoji:"🧹", qty:n.oppganger*n.floors, unit:"etg/uke", rate:RATES.cleaning.per_oppgang_floor_week, cadence:"Ukentlig", computed:cl})));
        if(n.heiser>0){ var he=Math.round(n.heiser*RATES.cleaning.per_heis_week*WPM);
          lines.push(withPrev(oLine({id:id+"cleaning:heis", service:"cleaning", role:"heis", label:"Heisrenhold "+n.heiser+" heis", emoji:"🛗", qty:n.heiser, unit:"heis/uke", rate:RATES.cleaning.per_heis_week, cadence:"Ukentlig", computed:he}))); }
      }
      var mats=keptVal(c,"mats",0); if(mats>0) lines.push(withPrev(oLine({id:id+"cleaning:mats", service:"cleaning", role:"mats", label:"Inngangsmatter (8 stk)", emoji:"🧺", cadence:"Månedlig", computed:mats, deliveredBy:"partner", partnerName:"Dørmatte Gutta AS"})));
      // snow: machine always priced from zone area; hand only when entryways captured
      if(z.snowMachine>0){ lines.push(withPrev(oLine({id:id+"snow:machine", service:"snow", role:"machine", label:"Maskinell brøyting", emoji:"❄️", qty:z.snowMachine, unit:"m²", rate:RATES.snow.machine_m2_mnd, cadence:"Per snøfall >5 cm", computed:z.snowMachine*RATES.snow.machine_m2_mnd, zoneId:z.firstId("snow","machine")}))); }
      if(entryCaptured) lines.push(withPrev(oLine({id:id+"snow:hand", service:"snow", role:"hand", label:"Manuell rydding + strøing ("+n.entryways+" innganger)", emoji:"🧂", qty:n.entryways, unit:"inngang", rate:RATES.snow.hand_per_entry_mnd, cadence:"Per snøfall / is", computed:n.entryways*RATES.snow.hand_per_entry_mnd, zoneId:z.firstId("snow","hand")})));
      // grass (mow + edge zones)
      if(z.mow>0){ lines.push(withPrev(oLine({id:id+"grass:mow", service:"grass", role:"mow", label:"Gressklipping", emoji:"🌿", qty:z.mow, unit:"m²", rate:RATES.grass.mow_m2_mnd, cadence:"Ukentlig i vekstsesong", computed:z.mow*RATES.grass.mow_m2_mnd, zoneId:z.firstId("grass","mow")}))); }
      if(z.edge>0){ lines.push(withPrev(oLine({id:id+"grass:edge", service:"grass", role:"edge", label:"Kantklipp", emoji:"✂️", qty:z.edge, unit:"m", rate:RATES.grass.edge_m_mnd, cadence:"Sesong", computed:z.edge*RATES.grass.edge_m_mnd, zoneId:z.firstId("grass","edge")}))); }
      // greenery kept spraying only when captured/priced; hedge/beds → option lines
      var grnt=keptVal(c,"weeds",0); if(grnt>0) lines.push(withPrev(oLine({id:id+"greenery:ovrig", service:"greenery", role:"ovrig", label:"Grøntområde – sprøyting, bed, trær", emoji:"🌳", cadence:"Sesong", computed:grnt})));
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
  function lineRemoved(l){ return !!(l && l.review && l.review.decision==="remove"); } // C2: guards old-shape lines missing .review
  // M4: module subtotals + grand totals exclude removed lines (+ travel), so module "Sum fast", the headline,
  // the offer-detail total and the leave-behind all read ONE consistent number. Does NOT touch o.lines.
  function syncOfferTotals(c){
    var o=c.offer; if(!o||!o.modules) return;
    o.modules.forEach(function(m){ m.lines.forEach(function(l){ l.price=l.final; }); m.subtotal=m.lines.reduce(function(s,l){return s+(lineRemoved(l)?0:(l.final||0));},0); });
    var sum=o.modules.filter(function(m){return m.included;}).reduce(function(s,m){return s+m.subtotal;},0)+(o.travel||0);
    if(o.period==="mnd"){ o.totalMonthly=Math.round(sum); o.totalYearly=Math.round(sum*12); }
    else { o.totalYearly=Math.round(sum); o.totalMonthly=Math.round(sum/12); }
  }
  function rebuildOfferFlat(c){
    var o=c.offer; if(!o||!o.modules) return;
    syncOfferTotals(c);
    // rebuild the flat included-module mirror (removed lines excluded). Board review (setDecision) uses
    // syncOfferTotals instead, so it does NOT rebuild this mirror — a removed line stays visible+togglable there.
    var incl=o.modules.filter(function(m){return m.included;});
    o.lines=[]; incl.forEach(function(m){ m.lines.forEach(function(l){ if(!lineRemoved(l)) o.lines.push(l); }); });
  }
  function recomputeOffer(c){ if(c&&c.offer&&c.offer.modules){ computeOffer(c); save(); } }
  function generateOffer(c){
    computeOffer(c);
    logEvent(c,"Tilbud v"+c.offer.version+" beregnet — "+c.offer.modules.length+" moduler, "+kr(c.offer.totalMonthly)+"/mnd ("+kr(c.offer.totalYearly)+"/år)");
    save();
  }
  function offerTotal(offer){
    if(!offer || !offer.lines) return 0;
    return offer.lines.filter(function(l){return !lineRemoved(l);}).reduce(function(s,l){return s+(l.price||0);},0)+(offer.travel||0);
  }
  function upsellTotal(offer){
    if(!offer || !offer.lines) return 0;
    return offer.lines.filter(function(l){return !l.inScope && !lineRemoved(l);}).reduce(function(s,l){return s+(l.price||0);},0);
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
    syncOfferTotals(c); // M4: recompute subtotals + totals (keeps o.lines intact so the board can still toggle the line) so a "remove" reads consistently everywhere
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
  /* ===========================================================================
     SERVICE_CATALOGUE (doc 54, Phase 8) — SINGLE SOURCE for a task/service's
     cross-cutting facets, keyed by checklist/task id. Replaces the scattered
     SCHEDULE_MAP (cadence) + AREA_OF_ITEM (area) + METHOD_OF_ITEM (method) +
     serviceOfTask/byCat (service). Display facets (label/zone/emoji/captureType/
     compliance/upsell) live on CHECKLIST_TEMPLATE; rates live in RATES, referenced
     by `rateKey`. Read only via the cat*() accessors below. See BACKBONE.md.
       cadence  — schedule cadence (omit = not on the calendar plan)
       area     — doc-38 walkaround area (default "ute")
       method   — equipment heuristic (omit = none)
       service  — pricing/classification bucket (snow|grass|cleaning|technical|compliance|other)
       rateKey  — dotted path into RATES (informational link; computeOffer reads RATES)
     =========================================================================== */
  var SERVICE_CATALOGUE = {
    // grounds / green
    lawn:      {cadence:{type:"growingSeason"},                                       area:"ute",     method:"maskin",  service:"grass",     rateKey:"grass.mow_m2_mnd", equipment:["gressklipper"]},
    hedges:    {cadence:{type:"seasonal", windows:[[[5,1],[7,15]],[[9,1],[10,31]]]},   area:"ute",     method:"manuell", service:"grass",     rateKey:"greenery.hedge_m_year", equipment:["hekksaks","lift"]},
    trees:     {                                                                       area:"ute",                       service:"grass"},
    beds:      {cadence:{type:"seasonal", windows:[[[4,1],[4,30]]]},                   area:"ute",                       service:"grass"},
    weeds:     {cadence:{type:"nPerYear", count:3, season:true},                       area:"ute",                       service:"grass"},
    gravel:    {                                                                       area:"ute",                       service:"grass"},
    greenwaste:{                                                                       area:"ute",                       service:"grass"},
    taps:      {cadence:{type:"seasonal", windows:[[[4,10],[4,20]],[[10,1],[10,10]]]}, area:"teknisk",                   service:"technical"},
    bootscr:   {                                                                       area:"teknisk",                   service:"technical"},
    paths:     {cadence:{type:"dateAnchored", anchor:"before17mai"},                   area:"ute",     method:"maskin",  service:"technical", equipment:["traktor"]},
    snow:      {cadence:EVT_SNOW,                                                      area:"ute",     method:"maskin",  service:"snow",      rateKey:"snow.machine_m2_mnd", equipment:["snofreser"]},
    roofsnow:  {                                                                       area:"ute",                       service:"snow"},
    // waste
    wells:     {                                                                       area:"teknisk",                   service:"technical"},
    binwash:   {                                                                       area:"ute",                       service:"other"},
    bulky:     {                                                                       area:"avfall",                    service:"technical"},
    // entrances & stairwells
    oppganger: {cadence:{type:"weekly"},                                              area:"oppgang",                   service:"cleaning",  rateKey:"cleaning.per_oppgang_floor_week"},
    mats:      {cadence:{type:"monthly"},                                             area:"oppgang",                   service:"cleaning"},
    glass:     {cadence:{type:"weekly"},                                              area:"fasade",                    service:"cleaning"},
    lighting:  {                                                                       area:"teknisk",                   service:"technical"},
    facade:    {                                                                       area:"ute",                       service:"cleaning",  equipment:["lift"]},
    // lifts
    heiser:    {cadence:{type:"weekly"},                                              area:"heis",                      service:"cleaning",  rateKey:"cleaning.per_heis_week"},
    liftctrl:  {                                                                       area:"heis",                      service:"technical"},
    // common indoor / svalganger / bod
    svalg:     {cadence:{type:"seasonal", windows:[[[4,1],[4,30]]]},                   area:"oppgang",                   service:"cleaning"},
    bodarea:   {                                                                       area:"oppgang",                   service:"cleaning"},
    // basement / teknisk rom
    pipes:     {                                                                       area:"teknisk",                   service:"technical"},
    water:     {                                                                       area:"teknisk",                   service:"technical"},
    sprinkler: {                                                                       area:"teknisk",                   service:"technical"},
    vent:      {                                                                       area:"ute",                       service:"other"},
    firepanel: {                                                                       area:"teknisk",                   service:"technical"},
    pumpekum:  {                                                                       area:"teknisk",                   service:"technical"},
    // garage
    garage:    {cadence:{type:"dateAnchored", anchor:"beforeSthans"},                  area:"garasje", method:"maskin",  service:"technical", equipment:["spyler","blaser","kjegler"]},
    // doors & access
    doors:     {                                                                       area:"dorer",                     service:"technical"},
    access:    {                                                                       area:"ute",                       service:"technical"},
    // roof
    roof:      {cadence:{type:"dateAnchored", anchor:"autumn"},                        area:"tak",     method:"stige",   service:"technical", equipment:["stige"]},
    // stakeholders & admin
    round:     {cadence:{type:"weekly"},                                              area:"ute",                       service:"technical"},
    approver:  {                                                                       area:"ute",                       service:"technical"},
    manager:   {                                                                       area:"ute",                       service:"technical"},
    vakttlf:   {                                                                       area:"ute",                       service:"technical"},
    pest:      {                                                                       area:"ute",                       service:"other"},
    playground:{                                                                       area:"ute",                       service:"technical"},
    painting:  {                                                                       area:"ute",                       service:"technical"}
  };
  function catEntry(id){ return SERVICE_CATALOGUE[id] || null; }
  function catCadence(id){ var e=SERVICE_CATALOGUE[id]; return e?e.cadence:null; }   // was SCHEDULE_MAP[id]
  function catArea(id){ var e=SERVICE_CATALOGUE[id]; return e&&e.area?e.area:"ute"; } // was AREA_OF_ITEM[id]||"ute"
  function catMethod(id){ var e=SERVICE_CATALOGUE[id]; return e&&e.method?e.method:null; } // was METHOD_OF_ITEM[id]
  function catService(id){ var e=SERVICE_CATALOGUE[id]; return e&&e.service?e.service:null; } // was serviceOfTask byCat
  function catEquipment(id){ var e=SERVICE_CATALOGUE[id]; return (e&&e.equipment)?e.equipment:[]; } // Phase 9: equipment types a task needs
  // fold the checklist template's display facets into the catalogue → it becomes the single RUNTIME source for the
  // walkaround too. Adding one catalogue entry (with checklist facets) makes it appear in the walkaround (acceptance #1).
  (function foldChecklistIntoCatalogue(){
    (CHECKLIST_TEMPLATE["Residential — association"]||[]).forEach(function(it){
      var e=SERVICE_CATALOGUE[it.id] || (SERVICE_CATALOGUE[it.id]={area:"ute", service:"other"});
      e.checklist=true; e.label=it.label; e.zone=it.zone; e.cat=it.category; e.captureType=it.captureType;
      e.emoji=it.emoji; e.freq=it.freq||""; e.upsell=!!it.upsell; e.compliance=!!it.compliance;
    });
  })();

  /* ===========================================================================
     EQUIPMENT / RESOURCE INTELLIGENCE (doc 10, Phase 9 — wedge 2).
     Track THINGS, not people (doc 10 §5): equipment + vehicles have location/state;
     person location stays the voluntary cockpit check-in only. Tier-0 manual state
     (no QR/BLE/GPS hardware this phase — // TODO Tier1 BLE / Tier2 GPS).
       equipment[] : {id,name,type,owned,purchaseValue,state,location,usageCount}
       storage[]   : {id,name,kind:"lager"|"bil",geo?,team?}  (a vehicle = mobile storage tied to a team)
       state ∈ lager | bil | påSted | medPerson | leidUt | leidInn | service | mangler
     =========================================================================== */
  var EQUIP_TYPE_LABEL={ stige:"Stige", lift:"Lift", spyler:"Høytrykkspyler", blaser:"Løvblåser", kjegler:"Kjegler", snofreser:"Snøfreser", gressklipper:"Gressklipper", hekksaks:"Hekksaks", traktor:"Traktor", tilhenger:"Tilhenger" };
  var EQUIP_TYPE_EMOJI={ stige:"🪜", lift:"🏗️", spyler:"💦", blaser:"🍃", kjegler:"🚧", snofreser:"❄️", gressklipper:"🚜", hekksaks:"✂️", traktor:"🚜", tilhenger:"🛻" };
  var EQUIP_STATE_LABEL={ lager:"På lager", bil:"I bil", påSted:"På sted", medPerson:"Med person", leidUt:"Leid ut", leidInn:"Leid inn", service:"På service", mangler:"Mangler" };
  function equipTypeLabel(t){ return EQUIP_TYPE_LABEL[t]||cap(t||""); }
  function equipTypeEmoji(t){ return EQUIP_TYPE_EMOJI[t]||"🔧"; }
  function equipList(){ var st=S(); if(!Array.isArray(st.equipment)) st.equipment=[]; return st.equipment; }
  function storageList(){ var st=S(); if(!Array.isArray(st.storage)) st.storage=[]; return st.storage; }
  function equipById(id){ return equipList().filter(function(e){return e.id===id;})[0]; }
  function equipByType(t){ return equipList().filter(function(e){return e.type===t;}); }
  function storageById(id){ return storageList().filter(function(s){return s.id===id;})[0]; }
  function teamVehicle(team){ return storageList().filter(function(s){return s.kind==="bil" && s.team===team;})[0]; }
  function equipLocLabel(e){
    if(!e) return "";
    if(e.state==="bil"){ var v=storageById(e.location); return "I bil"+(v?(" · "+v.name):""); }
    if(e.state==="lager"){ var s=storageById(e.location); return s?s.name:"Lager"; }
    if(e.state==="påSted"){ var c=cust(e.location); return "På sted"+(c?(" · "+c.name):""); }
    return EQUIP_STATE_LABEL[e.state]||e.state;
  }
  function seedStorage(){
    return [
      {id:"lagerA", name:"Lager A — Halden sentrum", kind:"lager", geo:{lat:59.1242, lon:11.3875}},
      {id:"lagerB", name:"Lager B — Os/nord",        kind:"lager", geo:{lat:59.1350, lon:11.3600}},
      {id:"bil-vaktmester", name:"Servicebil 1", kind:"bil", team:"vaktmester"},
      {id:"bil-snow",       name:"Brøytebil",   kind:"bil", team:"snow"},
      {id:"bil-grass",      name:"Hagebil",     kind:"bil", team:"grass"}
    ];
  }
  function seedEquipment(){
    return [
      {id:"eq-stige1",    name:"Stige 6 m",              type:"stige",       owned:true,  purchaseValue:4000,  state:"lager",   location:"lagerA",         usageCount:18},
      {id:"eq-lift1",     name:"Personløfter (lift)",    type:"lift",        owned:false, purchaseValue:0,     state:"leidInn", location:"lagerA",         usageCount:11},
      {id:"eq-spyler1",   name:"Høytrykkspyler #1",      type:"spyler",      owned:true,  purchaseValue:9000,  state:"lager",   location:"lagerA",         usageCount:34},
      {id:"eq-spyler2",   name:"Høytrykkspyler #2",      type:"spyler",      owned:true,  purchaseValue:9000,  state:"bil",     location:"bil-vaktmester", usageCount:9},
      {id:"eq-blaser1",   name:"Løvblåser",              type:"blaser",      owned:true,  purchaseValue:3500,  state:"lager",   location:"lagerB",         usageCount:22},
      {id:"eq-kjegler1",  name:"Kjeglesett (10 stk)",    type:"kjegler",     owned:true,  purchaseValue:1200,  state:"lager",   location:"lagerA",         usageCount:15},
      {id:"eq-snofreser1",name:"Snøfreser",              type:"snofreser",   owned:true,  purchaseValue:22000, state:"lager",   location:"lagerB",         usageCount:7},
      {id:"eq-klipper1",  name:"Gressklipper (traktor)", type:"gressklipper",owned:true,  purchaseValue:48000, state:"bil",     location:"bil-grass",      usageCount:40},
      {id:"eq-hekksaks1", name:"Hekksaks (teleskop)",    type:"hekksaks",    owned:true,  purchaseValue:2800,  state:"lager",   location:"lagerB",         usageCount:12},
      {id:"eq-tilhenger2",name:"Tilhenger #2",           type:"tilhenger",   owned:true,  purchaseValue:18000, state:"lager",   location:"lagerA",         usageCount:4}
    ];
  }
  function seedEquipmentIfNeeded(){ var st=S(); if(!Array.isArray(st.storage)||!st.storage.length) st.storage=seedStorage(); if(!Array.isArray(st.equipment)||!st.equipment.length) st.equipment=seedEquipment(); }
  function equipSetState(id, state, location){ var e=equipById(id); if(!e) return; e.state=state; if(location!==undefined) e.location=location; save(); } // Tier-0 manual; // TODO Tier1 BLE / Tier2 GPS
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
      client.checklist.filter(function(it){return it.scope==="in" && catCadence(it.id);}).forEach(function(it){
        out.push({ lineId:client.id+":"+it.id, building:bld, title:it.subtype||it.label, category:catKeyLabel(it.category), zone:it.zone, schedule:catCadence(it.id), partner:(it.deliveredBy==="partner"?it.partnerName:null) });
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
  function completeInstance(inst, opts){
    opts=opts||{};
    var st=S(); st.completedInstances=st.completedInstances||{}; st.completedInstances[instKey(inst)]=true;
    var c=clientOf(inst.lineId); var bldId=(c&&c.buildingId)?c.buildingId:(st.buildings[0]&&st.buildings[0].id);
    st.items.push({ id:uid(), kind:"task", bld:bldId, title:inst.title, detail:"Fra skjøtselsplan ("+inst.freq+") · "+inst.building, status:"done", billable:true, hours:0.5, time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), who:opts.by||currentUser(), proof:{photo:!!opts.hasPhoto, note:opts.note||"Utført på plan", proofId:opts.proofId||null} });
    if(opts.noSave) return;   // C1: caller (proofConfirm) owns the gated save + rollback
    var ok=save();
    if(opts.silent) return;   // proof flow renders + toasts itself
    render(); toast(ok ? "✓ Utført — dokumentert (Board) og fakturerbart (Office)" : "⚠️ Ikke lagret — lagringen er full. Oppgaven er IKKE markert utført.");
  }
  function spawnEvent(name){
    var st=S(); var c=liveClients()[0]; var bldId=(c&&c.buildingId)?c.buildingId:(st.buildings[0]&&st.buildings[0].id);
    st.items.push({ id:uid(), kind:"task", bld:bldId, title:name+" — utløst i dag", detail:"Beredskap utløst (snø/is) — utfør i dag.", status:"todo", billable:true, hours:1, time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), who:"Martin", proof:null });
    save(); render(); toast("❄️ "+name+" lagt i dagens oppgaver");
  }
  function groupByBuilding(list){ var m={}, order=[]; list.forEach(function(i){ if(!m[i.building]){m[i.building]=[];order.push(i.building);} m[i.building].push(i); }); return order.map(function(b){return {building:b, items:m[b]};}); }

  /* ---- completion proof (doc 52, Phase 6a): ts + who + geo + photo → completionLog ---- */
  var SERVICE_ICON={ snow:"❄️", grass:"🌿", cleaning:"🧹", technical:"🔧", compliance:"📋", other:"✅" };
  var WD_NO=["søndag","mandag","tirsdag","onsdag","torsdag","fredag","lørdag"];
  function currentUser(){ var st=S(); return st.currentUser||"Martin"; } // 6c: replace with team/individual cockpit context
  function setCurrentUser(v){ var st=S(); st.currentUser=(v||"").trim()||"Martin"; save(); }
  function serviceOfTask(c, lineId){
    var key=(lineId||"").split(":").slice(1).join(":");
    if(/^comp/.test(key)) return "compliance";
    if(key==="snow"||key==="gritting") return "snow";   // explicit winter items
    var cs=catService(key); if(cs) return cs;           // SERVICE_CATALOGUE (was byCat on the checklist item's category)
    // marker/legacy fallback by id (markers aren't in the catalogue)
    var idMap={ lawn:"grass", grass:"grass", hedges:"grass", beds:"grass", greenery:"grass", trees:"grass",
                stairwell:"cleaning", laundry:"cleaning", facade:"cleaning", mats:"cleaning",
                tech:"technical", fire:"compliance", lift:"compliance", playground:"compliance" };
    return idMap[key]||"other";
  }
  function proofZoneChoices(c, service){
    var zs=c.zones||[];
    var match=zs.filter(function(z){
      if(service==="snow") return z.service==="snow";
      if(service==="grass") return z.service==="grass"||z.service==="greenery"||z.service==="beds";
      if(service==="cleaning") return z.service==="cleaning-ext";
      return false;
    });
    return match.length?match:zs;
  }
  var pendingProof=null;
  function openProofSheet(inst){
    var c=clientOf(inst.lineId); if(!c){ completeInstance(inst); return; }
    pendingProof={ id:"cl"+uid(), ts:null, by:cockpitWho(), team:cockpitTeam(), service:serviceOfTask(c, inst.lineId),
      title:inst.title, building:inst.building, taskInstanceId:instKey(inst), zoneId:"", geo:null, photoIds:[], note:"", _inst:inst };
    obSheet(proofSheetHTML(c));
    setTimeout(function(){ hydratePhotos(document.getElementById("sheet")); }, 20);
  }
  function proofSheetHTML(c){
    var p=pendingProof; if(!p) return "";
    var zs=proofZoneChoices(c, p.service);
    var zonePick = zs.length ? '<label>Sone (valgfritt)</label><select id="pf_zone" data-obf="proofZone"><option value="">(ingen spesifikk sone)</option>'
      + zs.map(function(z){ return '<option value="'+z.id+'"'+(p.zoneId===z.id?' selected':'')+'>'+esc(z.label||z.service)+'</option>'; }).join("") + '</select>' : '';
    var geoBlock = p.geo
      ? '<div class="ob-proofgeook">📍 Posisjon lagt ved · '+p.geo.lat.toFixed(5)+', '+p.geo.lon.toFixed(5)+' (±'+p.geo.acc+' m) <button class="ob-mini" data-ob="proofGeoClear">fjern</button></div>'
      : '<button class="ob-mini" data-ob="proofGeo">📍 Legg ved posisjon</button>';
    return '<h3>Marker utført · '+esc(p.title)+'</h3>'
      +'<div class="muted" style="font-size:12.5px;margin:-4px 0 12px">'+esc(p.building)+' · '+(SERVICE_ICON[p.service]||"✅")+' '+esc(p.service)+'</div>'
      +'<label>Utført av</label><input id="pf_by" data-obf="proofBy" value="'+esc(p.by)+'" placeholder="navn / initialer">'
      +'<label>Posisjon (valgfritt)</label>'+geoBlock
      +'<label style="margin-top:10px">Bilde (valgfritt)</label>'+photoStripHTML("proof", p.id, p.photoIds)
      +'<label>Notat (valgfritt)</label><textarea id="pf_note" data-obf="proofNote" rows="2" placeholder="kort beskrivelse">'+esc(p.note)+'</textarea>'
      + zonePick
      +'<button class="save" data-ob="proofConfirm">✓ Bekreft utført</button>'
      +'<button class="cancel" data-ob="proofCancel">Avbryt</button>';
  }
  function syncProofFromDOM(){
    if(!pendingProof) return;
    var by=document.getElementById("pf_by"); if(by) pendingProof.by=by.value.trim()||currentUser();
    var note=document.getElementById("pf_note"); if(note) pendingProof.note=note.value;
    var z=document.getElementById("pf_zone"); if(z) pendingProof.zoneId=z.value;
  }
  function reRenderProofSheet(){
    if(!pendingProof) return;
    obSheet(proofSheetHTML(clientOf(pendingProof._inst.lineId)));
    setTimeout(function(){ hydratePhotos(document.getElementById("sheet")); }, 20);
  }
  function proofAddGeo(){
    if(!pendingProof) return;
    if(!navigator.geolocation){ toast("Geolokasjon støttes ikke — lagrer uten"); return; }
    syncProofFromDOM();
    toast("Henter posisjon…");
    navigator.geolocation.getCurrentPosition(function(pos){
      pendingProof.geo={ lat:pos.coords.latitude, lon:pos.coords.longitude, acc:Math.round(pos.coords.accuracy||0) };
      reRenderProofSheet();
      toast("📍 Posisjon lagt ved (±"+pendingProof.geo.acc+" m)");
    }, function(err){
      toast("Posisjon utilgjengelig ("+((err&&err.message)||"avslått")+") — lagrer uten");
    }, {enableHighAccuracy:true, timeout:8000, maximumAge:0});
  }
  function proofClearGeo(){ if(pendingProof){ pendingProof.geo=null; reRenderProofSheet(); } }
  function proofCleanup(){ if(pendingProof){ (pendingProof.photoIds||[]).forEach(function(pid){ photoDel(pid); }); pendingProof=null; } }
  function proofCancel(){ proofCleanup(); obCloseSheet(); }
  function proofConfirm(){
    var p=pendingProof; if(!p) return;
    syncProofFromDOM();
    var inst=p._inst, c=clientOf(inst.lineId); if(!c){ proofCleanup(); obCloseSheet(); return; }
    p.ts=new Date().toISOString();
    var entry={ id:p.id, ts:p.ts, by:p.by||cockpitWho(), team:p.team||cockpitTeam()||null, service:p.service, title:p.title, building:p.building,
      taskInstanceId:p.taskInstanceId, zoneId:p.zoneId||null, geo:p.geo||null, photoIds:p.photoIds||[], note:p.note||"" };
    // C1: mutate, then persist ONCE and only confirm if the write succeeded (no false "dokumentert" on quota failure)
    var st=S(), prevUser=st.currentUser, itemsLen=(st.items||[]).length, instK=instKey(inst),
        hadInst=!!(st.completedInstances&&st.completedInstances[instK]);
    st.currentUser=entry.by;
    c.completionLog=c.completionLog||[]; c.completionLog.push(entry);
    var z=entry.zoneId?findZone(c,entry.zoneId):null; if(z){ z.completionLog=z.completionLog||[]; z.completionLog.push(entry); } // Phase-1 zone hook
    completeInstance(inst, { by:entry.by, note:entry.note, hasPhoto:entry.photoIds.length>0, proofId:entry.id, silent:true, noSave:true });
    if(!save()){   // roll back every mutation so nothing is half-confirmed; keep the sheet open for retry
      c.completionLog.pop(); if(z) z.completionLog.pop();
      if(!hadInst && st.completedInstances) delete st.completedInstances[instK];
      if((st.items||[]).length>itemsLen) st.items.length=itemsLen;
      st.currentUser=prevUser;
      render();
      toast("⚠️ Ikke lagret — lagringen er full. Oppgaven er IKKE markert utført.");
      return;
    }
    pendingProof=null; obCloseSheet();
    render();
    if(ui.cockMapId){ var ch=document.getElementById("ob-cockmap"); if(ch && ch.classList.contains("on")) showCockMap(ui.cockMapId); } // refresh in-cab map (render() destroyed op-maps)
    var what = entry.photoIds.length ? ("bilde"+(entry.geo?" + 📍":"")) : (entry.geo?"📍 posisjon":"bekreftelse");
    toast("✓ Utført — dokumentert ("+what+")");
  }
  var geoMini=null;
  function proofGeoView(arg){
    var pp=(arg||"").split(","), lat=parseFloat(pp[0]), lon=parseFloat(pp[1]), acc=parseFloat(pp[2])||0;
    if(geoMini){ try{ geoMini.remove(); }catch(e){} geoMini=null; }
    obSheet('<h3>📍 Posisjon ved utførelse</h3><div class="ob-opmap" id="ob-geomap" style="height:300px"></div>'
      +'<div class="muted" style="margin-top:8px;font-size:12.5px">'+lat.toFixed(5)+', '+lon.toFixed(5)+' · nøyaktighet ±'+acc+' m</div>'
      +'<button class="cancel" data-ob="closeObSheet">Lukk</button>');
    setTimeout(function(){
      if(!hasLeaflet) return; var el=document.getElementById("ob-geomap"); if(!el) return;
      geoMini=L.map(el,{zoomControl:true, attributionControl:true});
      L.tileLayer(KARTVERKET,{attribution:"© Kartverket", maxZoom:20}).addTo(geoMini);
      L.circleMarker([lat,lon],{radius:7, color:"#2f6fed", weight:2, fillColor:"#2f6fed", fillOpacity:.9}).addTo(geoMini);
      if(acc>0) L.circle([lat,lon],{radius:acc, color:"#2f6fed", weight:1, fillOpacity:.10}).addTo(geoMini);
      geoMini.setView([lat,lon], 18);
      setTimeout(function(){ if(geoMini) geoMini.invalidateSize(); }, 60);
    }, 40);
  }
  /* ---- board proof surfacing ---- */
  function completionEntries(){
    var all=[];
    customers().forEach(function(c){ (c.completionLog||[]).forEach(function(e){ all.push(e); }); });
    all.sort(function(a,b){ return a.ts<b.ts?1:(a.ts>b.ts?-1:0); });
    return all;
  }
  function proofThumbsHTML(photoIds){
    if(!photoIds||!photoIds.length) return "";
    return '<div class="ob-photos board">'+photoIds.map(function(pid){
      return '<span class="ob-thumb" data-ob="photoView" data-arg="'+pid+'"><img alt="bilde" '+(photoCache[pid]?'src="'+photoCache[pid]+'"':'data-photo-id="'+pid+'"')+'></span>';
    }).join("")+'</div>';
  }
  function proofEntryHTML(e){
    var d=new Date(e.ts), time=d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
    var geo = e.geo ? '<button class="ob-proofgeo" data-ob="proofGeoView" data-arg="'+e.geo.lat+','+e.geo.lon+','+(e.geo.acc||0)+'" title="vis posisjon">📍</button>' : '';
    return '<div class="ob-proofrow"><div class="ob-proofic">'+(SERVICE_ICON[e.service]||"✅")+'</div>'
      +'<div class="ob-proofmain"><div class="ob-prooftop">'+esc(e.title||"Utført")+' <span class="muted">· '+time+'</span> '+geo+'</div>'
      +'<div class="ob-proofsub">'+esc(e.by||"")+(e.building?' · '+esc(e.building):'')+(e.note?' · '+esc(e.note):'')+'</div>'
      + proofThumbsHTML(e.photoIds)
      +'</div></div>';
  }
  function boardProofHTML(){
    var entries=completionEntries(); if(!entries.length) return "";
    var groups=[], idx={};
    entries.forEach(function(e){ var k=iso(new Date(e.ts)); if(!idx[k]){ idx[k]={key:k, items:[]}; groups.push(idx[k]); } idx[k].items.push(e); }); // M5: group by LOCAL date (ts is UTC ISO) — matches the Brøyterapport so a late-evening completion files on the right day
    var body=groups.map(function(g){
      var d=new Date(g.key+"T00:00:00"), lbl=WD_NO[d.getDay()]+" "+d.getDate()+". "+MON_NO[d.getMonth()];
      return '<div class="ob-proofday">'+lbl.charAt(0).toUpperCase()+lbl.slice(1)+'</div>'+g.items.map(proofEntryHTML).join("");
    }).join("");
    return '<div class="card ob-proofcard"><div class="ct">Utført arbeid · dokumentasjon <span class="chip grey">'+entries.length+'</span></div>'
      +'<p class="muted" style="font-size:12px;margin:-2px 0 10px">Hver jobb logget med tidspunkt, hvem og bevis (bilde/posisjon) — styret ser at det ble gjort, uten å spørre.</p>'
      + body +'</div>';
  }

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
        +'<div style="display:flex;gap:6px"><button class="ob-mini warn on" data-ob="spawnEvt" data-arg="'+encodeURIComponent(b.ev.name)+'">'+esc(b.ev.trigger)+'</button>'
        +'<button class="ob-mini ok on" data-ob="eventDone" data-arg="'+b.line.lineId+'|'+encodeURIComponent(b.ev.name)+'|'+encodeURIComponent(b.line.building)+'">✓ Utført</button></div></div>'
        +'<div class="rd">utløses ved forhold · ikke kalenderstyrt</div></div>';
    }).join("") : '<div class="empty">Ingen beredskapstjenester i denne sesongen.</div>';
    return '<div class="card"><div class="ct">Beredskap · utløses ved forhold '+(winter?'<span class="chip blue">vintersesong</span>':'')+'</div>'+body+'</div>';
  }
  /* ---- team cockpit / in-cab view (doc 51/52, Phase 6c) ---- */
  var TEAMS=[
    {key:"vaktmester", label:"Vaktmester",    icon:"🔧", services:["other","cleaning","technical"]},
    {key:"snow",       label:"Snø",           icon:"❄️", services:["snow"]},
    {key:"grass",      label:"Grønt",         icon:"🌿", services:["grass"]},
    {key:"brann",      label:"Brannvern/HMS", icon:"🧯", services:["compliance"]}
  ];
  function teamDef(key){ for(var i=0;i<TEAMS.length;i++){ if(TEAMS[i].key===key) return TEAMS[i]; } return null; }
  function cockpit(){ var st=S(); return st.cockpit||{team:null, individual:null}; }
  function cockpitTeam(){ return cockpit().team; }
  function cockpitWho(){ return cockpit().individual || currentUser(); } // 6c: real individual (was the 6a placeholder)
  function setCockpit(team, individual){ var st=S(); st.cockpit={team:team, individual:individual||null}; if(individual) st.currentUser=individual; save(); }
  function clearCockpit(){ var st=S(); st.cockpit={team:null, individual:null}; save(); }
  function defaultRosters(){ return { vaktmester:["Martin","Geir H."], snow:["Tony B.","Per S."], grass:["Kari N.","Ola V."], brann:["HMS-ansvarlig"] }; }
  function rosters(){ var st=S(); if(!st.rosters) st.rosters=defaultRosters(); return st.rosters; }
  function addToRoster(team, name){ name=(name||"").trim(); if(!name) return; var r=rosters(); r[team]=r[team]||[]; if(r[team].indexOf(name)<0) r[team].push(name); save(); }
  function teamMapKind(team){ return team==="snow"?"snow":"grass"; }   // snow→Vinter, grass→Grønt
  function teamHasMap(team){ return team==="snow"||team==="grass"; }
  function teamZones(c, team){ return teamMapKind(team)==="snow"
      ? (c.zones||[]).filter(function(z){return z.service==="snow";})
      : (c.zones||[]).filter(function(z){return z.service==="grass"||z.service==="greenery"||z.service==="beds";}); }
  function syncCockpitChip(){
    var inner=document.querySelector(".topbar .inner"); if(!inner) return;
    var chip=document.getElementById("ob-cockchip"), ctx=cockpit();
    if(!ctx.team){ if(chip&&chip.parentNode) chip.parentNode.removeChild(chip); return; }
    var td=teamDef(ctx.team);
    if(!chip){ chip=document.createElement("button"); chip.id="ob-cockchip"; chip.className="ob-cockchip"; chip.setAttribute("data-ob","cockSwitch");
      inner.insertBefore(chip, inner.querySelector(".spacer")); }
    chip.innerHTML=(td?td.icon:"")+' '+esc(td?td.label:"")+' · '+esc(ctx.individual||"—")+' <span class="ob-cockchip-x">⇄</span>';
  }
  function cockpitRosterSheet(team){
    var td=teamDef(team); var names=(rosters()[team]||[]);
    obSheet('<h3>'+td.icon+' '+esc(td.label)+' — hvem kjører i dag?</h3>'
      +'<p class="muted" style="font-size:12.5px;margin:-6px 0 12px">Delt nettbrett i bilen — ingen pålogging. Velg deg selv fra laget.</p>'
      +'<div class="ob-rosterlist">'+(names.length? names.map(function(n){ return '<button class="ob-rosterbtn" data-ob="cockPick" data-arg="'+team+'|'+encodeURIComponent(n)+'">'+esc(n)+'</button>'; }).join("") : '<div class="empty">Ingen på laget ennå.</div>')+'</div>'
      +'<label>+ Legg til person</label><div style="display:flex;gap:8px"><input id="cock_newname" placeholder="navn / initialer"><button class="ob-mini ok on" data-ob="cockAddPerson" data-arg="'+team+'">Legg til</button></div>'
      +'<button class="cancel" data-ob="closeObSheet">Avbryt</button>');
  }
  function cockpitSwitchSheet(){
    obSheet('<h3>Bytt lag / person</h3>'
      +'<p class="muted" style="font-size:12.5px;margin:-6px 0 12px">Ett nettbrett = én bil/ett lag. Bytt lag eller logg av.</p>'
      +'<div class="ob-teamchips">'+TEAMS.map(function(t){ return '<button class="ob-teamchip" data-ob="cockTeam" data-arg="'+t.key+'">'+t.icon+' '+esc(t.label)+'</button>'; }).join("")+'</div>'
      +'<button class="cancel" data-ob="cockLogoff">Logg av cockpit</button>');
  }
  function cockpitBarHTML(){
    var ctx=cockpit();
    if(!ctx.team){
      return '<div class="card ob-cockboot"><div class="ct">🚗 Cockpit — bilens nettbrett</div>'
        +'<p class="muted" style="font-size:12.5px;margin:-2px 0 10px">Velg lag for å starte dagens rute. Hver bil = ett lag (doc 51).</p>'
        +'<div class="ob-teamchips">'+TEAMS.map(function(t){ return '<button class="ob-teamchip" data-ob="cockTeam" data-arg="'+t.key+'">'+t.icon+' '+esc(t.label)+'</button>'; }).join("")+'</div></div>';
    }
    var td=teamDef(ctx.team), mode=ui.cockMode||"route";
    return '<div class="card ob-cockbar"><div class="ob-cockid"><span class="ob-cockteam">'+td.icon+' '+esc(td.label)+'</span> <span class="ob-cockwho">· '+esc(ctx.individual||"—")+'</span>'
      +' <button class="ob-mini" data-ob="cockSwitch">⇄ bytt</button></div>'
      +'<div class="ob-cockmodes"><button class="ob-mini'+(mode==="route"?' on':'')+'" data-ob="cockMode" data-arg="route">🧭 Min rute</button>'
      +'<button class="ob-mini'+(mode==="building"?' on':'')+'" data-ob="cockMode" data-arg="building">📋 Alle bygg</button></div></div>';
  }
  function cockpitRouteHTML(){
    var ctx=cockpit(), td=teamDef(ctx.team); if(!td) return "";
    var today=refDate(), tIso=iso(today);
    var blocks=liveClients().map(function(c){
      var lines=scheduleLines(c), rows=[];
      generateInstances(lines, mondayOf(today), addDays(today,6)).filter(function(i){ return i.date===tIso && !isDone(i) && td.services.indexOf(serviceOfTask(c, i.lineId))>=0; })
        .forEach(function(i){ rows.push(planRow(i, true)); });
      if(td.services.indexOf("snow")>=0){
        lines.filter(function(l){return l.schedule.type==="event" && serviceOfTask(c,l.lineId)==="snow";}).forEach(function(l){
          (l.schedule.events||[]).forEach(function(ev){
            rows.push('<div class="ob-row"><div class="ob-line-top"><div class="rt">⚡ '+esc(ev.name)+'</div>'
              +'<button class="ob-mini ok on" data-ob="eventDone" data-arg="'+l.lineId+'|'+encodeURIComponent(ev.name)+'|'+encodeURIComponent(c.name)+'">✓ Utført</button></div>'
              +'<div class="rd">beredskap · utløses ved forhold</div></div>');
          });
        });
      }
      var zN=teamZones(c, ctx.team).length;
      if(!rows.length && !zN) return null;
      var mapBtn=(teamHasMap(ctx.team) && zN) ? '<button class="ob-mini ok on" data-ob="openCockMap" data-arg="'+c.id+'">🗺️ Åpne kart · '+zN+' soner</button>' : '';
      var block='<div class="card ob-routeblock"><div class="ob-routehead"><div><div class="ob-routebldg">📍 '+esc(c.name)+'</div><div class="ob-routeaddr">'+esc(c.addr||"")+'</div></div>'+mapBtn+'</div>'
        +(rows.length? '<div class="ob-routerows">'+rows.join("")+'</div>' : '<div class="empty" style="margin-top:6px">Ingen planlagte oppgaver i dag — kartet er klart ved behov.</div>')+'</div>';
      return block + emergencyMiniHTML(c) + whileHereHTML(c, {team:ctx.team, teamServices:td.services}); // Phase 7 suggestions + Phase 10 in-cab urgent access
    }).filter(Boolean);
    var head='<div class="card ob-routeintro"><div class="ct">🧭 Min rute i dag · '+td.icon+' '+esc(td.label)+' <span class="chip grey">'+blocks.length+' bygg</span></div>'
      +'<p class="muted" style="font-size:12px;margin:-2px 0 0">Dagens oppgaver for laget ditt, samlet per bygg. Åpne kartet som kjøreguide og marker utført rett fra sonen. <span style="opacity:.6">// later: ruterekkefølge/nav</span></p></div>';
    return head + morningManifestHTML(ctx) + (blocks.length? blocks.join("") : '<div class="card"><div class="empty">Ingen aktive oppgaver for '+esc(td.label)+' i dag — sjekk «Alle bygg» eller kartet.</div></div>');
  }
  /* ---- morning manifest (doc 10, Phase 9): the day's load-list writes itself ---- */
  function svcToTeamBucket(s){ return ({greenery:"grass", grass:"grass", snow:"snow", cleaning:"cleaning", compliance:"compliance", technical:"technical", other:"other"})[s]||"other"; }
  function teamNeedsType(team, type){
    var td=teamDef(team); if(!td) return false; var today=refDate(), found=false;
    liveClients().forEach(function(c){
      (c.upcoming||[]).forEach(function(u){ if((u.equipment||[]).indexOf(type)>=0 && td.services.indexOf(svcToTeamBucket(u.service))>=0) found=true; });
      generateInstances(scheduleLines(c), today, addDays(today,7)).forEach(function(i){ if(!isDone(i) && catEquipment(itemKeyOf(i.lineId)).indexOf(type)>=0 && td.services.indexOf(serviceOfTask(c,i.lineId))>=0) found=true; });
    });
    return found;
  }
  function teamManifest(team){
    var td=teamDef(team); if(!td) return null;
    var today=refDate(), tIso=iso(today), needTypes={}, bld={};
    liveClients().forEach(function(c){
      generateInstances(scheduleLines(c), today, today).filter(function(i){ return i.date===tIso && !isDone(i) && td.services.indexOf(serviceOfTask(c,i.lineId))>=0; })
        .forEach(function(i){ var eq=catEquipment(itemKeyOf(i.lineId)); if(eq.length){ eq.forEach(function(t){needTypes[t]=1;}); bld[c.name]=1; } });
      (c.upcoming||[]).filter(function(u){ return (u.offsetDays||0)<=1 && !isDone({lineId:c.id+":up:"+u.id, date:tIso}) && td.services.indexOf(svcToTeamBucket(u.service))>=0; })
        .forEach(function(u){ var eq=u.equipment||[]; if(eq.length){ eq.forEach(function(t){needTypes[t]=1;}); bld[c.name]=1; } });
    });
    var types=Object.keys(needTypes); if(!types.length) return null;
    var items=types.map(function(t){ var its=equipByType(t); return its.length? its[0] : {id:null, name:equipTypeLabel(t), type:t, state:"mangler", location:null}; });
    // start storage = the lager holding the most of the needed items (else the team vehicle)
    var lagerCount={}; items.forEach(function(e){ if(e.state==="lager" && e.location) lagerCount[e.location]=(lagerCount[e.location]||0)+1; });
    var startId=Object.keys(lagerCount).sort(function(a,b){return lagerCount[b]-lagerCount[a];})[0] || (teamVehicle(team)?teamVehicle(team).id:null);
    // end-of-day drop: another team needs one of these items next
    var drop=null, otherTeams=TEAMS.filter(function(t){return t.key!==team;});
    for(var i=0;i<items.length && !drop;i++){ var e=items[i]; if(!e.id) continue;
      var needer=otherTeams.filter(function(t){ return teamNeedsType(t.key, e.type); })[0];
      if(needer){ var dropTo=(storageById(e.location)&&storageById(e.location).id==="lagerB")?"lagerA":"lagerB"; drop={equip:e, team:needer, storage:dropTo}; }
    }
    return { team:team, items:items, startId:startId, buildings:Object.keys(bld), drop:drop };
  }
  function morningManifestHTML(ctx){
    var m=teamManifest(ctx.team); if(!m) return "";
    var td=teamDef(ctx.team), start=storageById(m.startId), veh=teamVehicle(ctx.team);
    var loadRows=m.items.map(function(e){
      var inVeh = e.state==="bil" && veh && e.location===veh.id;
      var miss = e.state==="mangler";
      var btn = inVeh ? '<span class="chip green">✓ i bilen</span>'
        : miss ? '<span class="chip amber">⚠️ mangler</span>'
        : '<button class="ob-mini ok on" data-ob="equipLoad" data-arg="'+esc(e.id)+'">Last</button>';
      return '<div class="ob-loadrow'+(inVeh?' done':'')+'"><div class="ob-loadmain">'+equipTypeEmoji(e.type)+' <b>'+esc(e.name)+'</b> <span class="muted">· '+esc(equipLocLabel(e))+'</span></div>'+btn+'</div>';
    }).join("");
    var drop="";
    if(m.drop){ var dropTo=storageById(m.drop.storage), dt=teamDef(m.drop.team.key);
      drop='<div class="ob-manifest-drop">📦 <b>Etter jobben:</b> lever <b>'+esc(m.drop.equip.name)+'</b> til '+esc(dropTo?dropTo.name:"Lager B")+' — '+(dt?dt.icon+' '+esc(dt.label):"")+' trenger den neste. '
        +'<button class="ob-mini" data-ob="equipDrop" data-arg="'+esc(m.drop.equip.id)+'|'+esc(m.drop.storage)+'">Levert</button></div>'; }
    return '<div class="card ob-manifest"><div class="ct">🌅 Din dag</div>'
      +'<div class="ob-manifest-start">Start på <b>'+esc(start?start.name:(veh?veh.name:"bilen"))+'</b> · '+m.buildings.length+' bygg på ruta</div>'
      +'<div class="ob-manifest-loadhd">Last med deg:</div>'+loadRows+drop
      +'<p class="muted" style="font-size:11px;margin:8px 0 0">Trykk «Last»/«Levert» når du flytter utstyret — oppdaterer hvor det er. <span style="opacity:.6">// Tier-0 manuelt; BLE/GPS senere. Vi sporer utstyr, ikke folk.</span></p></div>';
  }
  /* ---- Office fleet view (doc 10 §3 conflict + handoff, §6 rent-vs-buy) — rules + counters, no solver ---- */
  function teamsNeedingType(type){ return TEAMS.filter(function(t){ return teamNeedsType(t.key, type); }); }
  function fleetConflicts(){
    var seen={}, out=[]; equipList().forEach(function(e){ if(seen[e.type]) return; seen[e.type]=1;
      var needers=teamsNeedingType(e.type), n=equipByType(e.type).length;
      if(needers.length>=2 && n<needers.length) out.push({type:e.type, teams:needers, items:n});
    }); return out;
  }
  function fleetHTML(){
    var eq=equipList(); if(!eq.length) return "";
    var rows=eq.map(function(e){
      return '<div class="ob-equiprow"><div>'+equipTypeEmoji(e.type)+' <b>'+esc(e.name)+'</b> <span class="ob-equiploc">· '+esc(equipLocLabel(e))+(e.owned?'':' · leid')+' · brukt '+(e.usageCount||0)+'×</span></div>'
        +'<span class="ob-equipstate '+e.state+'">'+esc(EQUIP_STATE_LABEL[e.state]||e.state)+'</span></div>';
    }).join("");
    var conf=fleetConflicts().map(function(c){
      var names=c.teams.map(function(t){return t.icon+" "+esc(t.label);}).join(" + ");
      return '<div class="ob-fleetflag warn"><span>⚠️</span><div><b>'+esc(equipTypeLabel(c.type))+' i konflikt</b> — '+names+' trenger den samme uke, men dere har '+c.items+'. Lei en til, eller flytt en oppgave.</div></div>'
        +'<div class="ob-fleetflag hand"><span>💡</span><div>Handoff: avslutt '+esc(c.teams[0].label)+' på Lager B og legg igjen '+esc(equipTypeLabel(c.type))+' der — '+esc(c.teams[1].label)+' tar den derfra.</div></div>';
    }).join("");
    var rvb=eq.map(function(e){ var u=e.usageCount||0;
      if(!e.owned && u>=10) return '<div class="ob-fleetflag buy"><span>💡</span><div>Leid <b>'+esc(e.name)+'</b> '+u+'× i år — vurder å kjøpe (binder opp leie).</div></div>';
      if(e.owned && u<=5)  return '<div class="ob-fleetflag sell"><span>📉</span><div><b>'+esc(e.name)+'</b> brukt bare '+u+'× — vurder å selge eller dele.</div></div>';
      return "";
    }).filter(Boolean).join("");
    return '<div class="card ob-fleetcard"><div class="ct">🧰 Utstyr & ressurser <span class="chip grey">'+eq.length+'</span> <span class="muted" style="font-weight:600;font-size:11.5px">· vi sporer utstyr, ikke folk (doc 10 §5)</span></div>'
      + rows + (conf||rvb? '<div style="margin-top:6px"></div>':'') + conf + rvb +'</div>';
  }
  function zoneDoneToday(c, z){ var tIso=iso(refDate()); return (z.completionLog||[]).filter(function(e){return iso(new Date(e.ts))===tIso;}).slice(-1)[0] || null; }
  function cockZoneRowHTML(c, z){
    var done=zoneDoneToday(c,z), prio=z.priority?'<span class="ob-prio">P'+z.priority+'</span> ':'', ml=methodLabel(z);
    return '<div class="ob-ckzone'+(done?' done':'')+'"><div class="ob-ckzmain">'+prio+'<b>'+esc(z.label||z.service)+'</b>'+(ml?' <span class="muted">· '+esc(ml)+'</span>':'')+'</div>'
      +(done?'<span class="chip green">✓ '+esc(done.by||"")+' '+repTime(done.ts)+'</span>':'<button class="ob-mini ok on" data-ob="cockZoneDone" data-arg="'+c.id+'|'+z.id+'">✓ Utført</button>')+'</div>';
  }
  function showCockMap(custId){
    var c=cust(custId), ctx=cockpit(), td=teamDef(ctx.team); if(!c||!td) return;
    ui.cockMapId=custId;
    var kind=teamMapKind(ctx.team), zones=teamZones(c, ctx.team);
    var host=document.getElementById("ob-cockmap"); if(!host) return;
    host.innerHTML='<div class="ob-cockmap-bar"><button class="ob-btn ghost" data-ob="closeCockMap">✕ Lukk</button>'
      +'<div class="ob-board-title">'+(kind==="snow"?"❄️ Operasjonskart – Vinter":"🌿 Operasjonskart – Grønt")+' · '+esc(c.name)+'</div>'
      +'<span class="ob-cockmapwho">'+td.icon+' '+esc(ctx.individual||td.label)+'</span></div>'
      +'<div class="ob-board-scroll"><div class="ob-opmap" id="cock-opmap"></div>'+opLegend(kind)
      +(kind==="snow"?'<div class="ob-opcap">'+esc(snowCaption(c))+'</div>':'')
      +'<div class="ob-cockzones"><div class="ob-cockzoneshd">Marker utført rett fra sonen — logges med tid'+(' og hvem')+'</div>'
      + zones.map(function(z){return cockZoneRowHTML(c,z);}).join("") +'</div></div>';
    host.classList.add("on"); host.setAttribute("aria-hidden","false");
    buildOpMap(c, kind, "cock-opmap");
    hydratePhotos(host);
  }
  function closeCockMap(){
    var host=document.getElementById("ob-cockmap"); if(!host) return;
    if(opMaps["cock-opmap"]){ try{opMaps["cock-opmap"].remove();}catch(e){} delete opMaps["cock-opmap"]; }
    ui.cockMapId=null; host.classList.remove("on"); host.setAttribute("aria-hidden","true"); host.innerHTML="";
  }
  function openZoneProof(custId, zoneId){
    var c=cust(custId); if(!c) return; var z=findZone(c, zoneId); if(!z) return;
    var service = z.service==="snow" ? "snow" : (z.service==="grass"||z.service==="greenery"||z.service==="beds") ? "grass" : "other";
    var title=(service==="snow"?"Snørydding":"Grøntarbeid")+" – "+(z.label||z.service);
    var lineKey=service==="snow"?"snow":"lawn";
    pendingProof={ id:"cl"+uid(), ts:null, by:cockpitWho(), team:cockpitTeam(), service:service,
      title:title, building:c.name, taskInstanceId:c.id+":zone:"+z.id, zoneId:z.id, geo:null, photoIds:[], note:"",
      _inst:{ lineId:c.id+":"+lineKey, date:iso(refDate()), title:title, freq:"sone", building:c.name } };
    obSheet(proofSheetHTML(c));
    setTimeout(function(){ hydratePhotos(document.getElementById("sheet")); }, 20);
  }

  /* ===========================================================================
     WHILE-HERE SUGGESTION ENGINE (doc 01 §4.1, Phase 7) — rule-based, explainable.
     "You're on the roof anyway; gutter clean is due in 9 days — do it now."
     Batches work by place (area) / timing (due-soon) / equipment (method).
     =========================================================================== */
  var WHILE_WINDOW=21; // co-timing pull-forward window (days)
  var AREA_LABEL={ ute:"Grunn / ute", tak:"Tak", garasje:"Garasje", teknisk:"Teknisk rom", kjeller:"Kjeller", oppgang:"Oppganger", heis:"Heis", fasade:"Fasade", avfall:"Avfall", dorer:"Dører" };
  function areaLabel(a){ return AREA_LABEL[a]||cap(a||"ute"); }

  /* ===========================================================================
     PHASE 10 — building-asset registry (the moat layer, doc 01 §4.4 / doc 33 Step-5).
     Structured, location-tagged knowledge of every technical installation: where the
     shut-off is, with a photo + access note, so the knowledge lives in the system —
     not one veteran's head. Reuses the area taxonomy (above), the Phase-5 photo
     pipeline, and the compliance pack. Things, not people: assets carry an optional
     map pin, never a person. // TODO P3: Boligmappa / byggets dokumentasjon write-back.
     =========================================================================== */
  var ASSET_TYPE = {
    "hovedstoppekran": {label:"Hovedstoppekran (vann)", emoji:"🚰", area:"kjeller",  emergency:true},
    "el-skap":         {label:"Hovedtavle (el-skap)",   emoji:"⚡",  area:"teknisk",  emergency:true},
    "sikringsskap":    {label:"Sikringsskap",           emoji:"🔌", area:"oppgang",  emergency:true},
    "brannsentral":    {label:"Brannsentral",           emoji:"🔥", area:"oppgang",  emergency:true, complianceHint:"Brannvernrunde"},
    "avstengning-gass":{label:"Gass-avstengning",       emoji:"🟡", area:"ute",      emergency:true},
    "sprinkler-sentral":{label:"Sprinklersentral",      emoji:"💧", area:"teknisk",  complianceHint:"Sprinkler — årskontroll"},
    "ventilasjon":     {label:"Ventilasjonsaggregat",   emoji:"🌀", area:"tak"},
    "varmekilde":      {label:"Varmekilde (varmepumpe/fjernvarme/fyr)", emoji:"♨️", area:"teknisk"},
    "heismaskinrom":   {label:"Heismaskinrom",          emoji:"🛗", area:"heis",     complianceHint:"Heiskontroll (2-årlig)"},
    "nøkkelboks":      {label:"Nøkkelboks",             emoji:"🔑", area:"oppgang"},
    "kum/pumpe":       {label:"Kum / pumpe",            emoji:"🕳️", area:"ute"},
    "annet":           {label:"Annet anlegg",           emoji:"🔧", area:"teknisk"}
  };
  // ordered for the type picker — emergency-critical first
  var ASSET_TYPE_ORDER = ["hovedstoppekran","el-skap","sikringsskap","brannsentral","avstengning-gass","sprinkler-sentral","ventilasjon","varmekilde","heismaskinrom","nøkkelboks","kum/pumpe","annet"];
  function assetTypeDef(t){ return ASSET_TYPE[t]||ASSET_TYPE["annet"]; }
  function assetTypeLabel(t){ return assetTypeDef(t).label; }
  function assetTypeEmoji(t){ return assetTypeDef(t).emoji; }
  function assetTypeIsEmergency(t){ return !!assetTypeDef(t).emergency; }
  function assetList(c){ return (c&&c.assets)?c.assets:[]; }
  function assetById(c,id){ return assetList(c).filter(function(a){return a.id===id;})[0]||null; }
  function emergencyAssets(c){ return assetList(c).filter(function(a){return assetTypeIsEmergency(a.type);}); }
  // next statutory due for a compliance routine label (reuses the schedule engine, both directions)
  function nextComplianceDue(c, label){
    if(!c||!label) return null;
    var line=scheduleLines(c).filter(function(l){return l.statutory && l.title===label;})[0];
    if(!line) return null;
    var from=refDate(), inst=expandLine(line, from, addDays(from, 366*3)).filter(function(i){return i.date>=iso(from);});
    inst.sort(function(a,b){return a.date<b.date?-1:1;});
    return inst[0]?inst[0].date:null;
  }
  function dueLabel(isoStr){ if(!isoStr) return ""; var p=isoStr.split("-"); var d=new Date(parseInt(p[0],10),parseInt(p[1],10)-1,parseInt(p[2],10)); return dateLabel(d)+" "+d.getFullYear(); }
  // Holtet seed — a realistic, location-tagged asset set so Bygg-info is live from day one.
  function holtetAssets(){
    var cy=59.89305, cx=10.78000;
    function A(o){ o.id="as"+(holtetAssets._n=(holtetAssets._n||0)+1); o.buildingId="holtet-cust"; o.photoIds=o.photoIds||[]; o.geo=o.geo||null; return o; }
    holtetAssets._n=0;
    return [
      A({type:"hovedstoppekran", label:"Hovedstoppekran", area:"kjeller", geo:{lat:cy-0.00012, lon:cx-0.00010},
         access:"Kjeller oppgang B, ved heissjakt — fritt tilgjengelig", notes:"Stengeventil + reduksjonsventil. Vannlekkasje → steng her FØRST, deretter kurs i el-skap.", complianceLink:null}),
      A({type:"el-skap", label:"Hovedtavle", area:"teknisk", geo:{lat:cy+0.00008, lon:cx+0.00006},
         access:"Teknisk rom K1 — nøkkel B3 i nøkkelboks", notes:"Hovedsikring + kursfortegnelse på innsiden av døra. Jordfeilbryter merket «felles».", complianceLink:null}),
      A({type:"brannsentral", label:"Brannsentral (Autronica)", area:"oppgang", geo:{lat:cy+0.00018, lon:cx+0.00030},
         access:"Hovedinngang A — display ved postkassene", notes:"Nullstill etter test. Orienteringsplan henger ved siden av. Direktevarsling 110.", complianceLink:"Brannvernrunde"}),
      A({type:"sprinkler-sentral", label:"Sprinklersentral", area:"teknisk",
         access:"Teknisk rom K1, ved hovedtavle", notes:"Alarmventil + trykkmåler. Trykk logges ved årskontroll.", complianceLink:"Sprinkler — årskontroll"}),
      A({type:"heismaskinrom", label:"Heismaskinrom (2 heiser)", area:"heis",
         access:"Toppetasje oppgang A — eget rom, nøkkel B3", notes:"Nødtelefon + nøkkel for manuell nødåpning på vegg. KONE serviceavtale.", complianceLink:"Heiskontroll (2-årlig)"}),
      A({type:"varmekilde", label:"Varmepumpe luft/vann", area:"teknisk",
         access:"Teknisk rom K1", notes:"Hovedkilde oppvarming + varmtvann. Serviceavtale leverandør 1×/år.", complianceLink:null}),
      A({type:"ventilasjon", label:"Ventilasjonsaggregat", area:"tak",
         access:"Takhus mot nord — luke fra loft oppgang D", notes:"Balansert vent. m/varmegjenvinning. Filterbytte 2×/år (vår + høst).", complianceLink:null}),
      A({type:"nøkkelboks", label:"Nøkkelboks (felles)", area:"oppgang",
         access:"Hovedinngang A — kode hos forvalter USBL", notes:"Master + sylindernøkler til fellesdører, teknisk rom og tak.", complianceLink:null})
    ];
  }

  /* ---- Bygg-info: query & surface (the "hvor er…?" moment) + enrichment sheet ---- */
  var pendingAsset=null, assetCtx=null, assetPinMode=false;
  // areas being worked today for this client → powers the "Nærmest" sort (area-based, NOT indoor positioning)
  function todayAreas(c){
    var areas={}, tIso=iso(refDate());
    generateInstances(scheduleLines(c), refDate(), refDate()).forEach(function(i){ if(i.date===tIso) areas[i.statutory?areaOfComplianceTitle(i.title):areaOfLineId(i.lineId)]=1; });
    (c.upcoming||[]).forEach(function(u){ if((u.offsetDays||0)===0 && u.area) areas[u.area]=1; });
    return areas;
  }
  function assetMatches(a, q){
    if(!q) return true; q=q.toLowerCase();
    return [a.label, assetTypeLabel(a.type), areaLabel(a.area), a.access, a.notes, a.complianceLink].filter(Boolean).join(" ").toLowerCase().indexOf(q)>=0;
  }
  function sortedAssets(c, mode){
    var list=assetList(c).slice();
    if(mode==="type"){
      list.sort(function(a,b){ var ai=ASSET_TYPE_ORDER.indexOf(a.type), bi=ASSET_TYPE_ORDER.indexOf(b.type); return (ai-bi)||(a.label<b.label?-1:1); });
    } else if(mode==="naermest"){
      var here=todayAreas(c);
      list.sort(function(a,b){ var ah=here[a.area]?0:1, bh=here[b.area]?0:1; var ae=assetTypeIsEmergency(a.type)?0:1, be=assetTypeIsEmergency(b.type)?0:1; return (ah-bh)||(ae-be)||(a.label<b.label?-1:1); });
    } else { // alle — emergency first, then by area
      list.sort(function(a,b){ var ae=assetTypeIsEmergency(a.type)?0:1, be=assetTypeIsEmergency(b.type)?0:1; return (ae-be)||(areaLabel(a.area)<areaLabel(b.area)?-1:1)||(a.label<b.label?-1:1); });
    }
    return list;
  }
  function assetRowHTML(c, a){
    var due=a.complianceLink?nextComplianceDue(c, a.complianceLink):null;
    var meta=['<span class="ob-asset-area">'+esc(areaLabel(a.area))+'</span>'];
    if(a.access) meta.push(esc(a.access.length>42?a.access.slice(0,40)+"…":a.access));
    if(a.complianceLink) meta.push('📋 '+(due?esc(dueLabel(due)):"lovpålagt"));
    var tags=(a.photoIds&&a.photoIds.length?' <span class="ob-asset-tag">📷'+a.photoIds.length+'</span>':'')+(a.geo?' <span class="ob-asset-tag">📍</span>':'');
    return '<button class="ob-asset-row" data-ob="assetCard" data-arg="'+c.id+'|'+a.id+'">'
      +'<span class="ob-asset-ic">'+assetTypeEmoji(a.type)+'</span>'
      +'<span class="ob-asset-main"><span class="ob-asset-title">'+esc(a.label||assetTypeLabel(a.type))+(assetTypeIsEmergency(a.type)?' <span class="ob-asset-emtag">akutt</span>':'')+tags+'</span>'
      +'<span class="ob-asset-meta">'+meta.join(' · ')+'</span></span><span class="ob-asset-go">›</span></button>';
  }
  function emergencyStripHTML(c){
    var em=emergencyAssets(c); if(!em.length) return "";
    return '<div class="ob-emerg"><div class="ob-emerg-h">🚨 Akutt — ett trykk til avstengning</div><div class="ob-emerg-chips">'
      + em.map(function(a){ return '<button class="ob-emergchip" data-ob="assetCard" data-arg="'+c.id+'|'+a.id+'">'+assetTypeEmoji(a.type)+' '+esc(a.label||assetTypeLabel(a.type))+'<span class="ob-emergloc">'+esc(areaLabel(a.area))+'</span></button>'; }).join("")
      +'</div></div>';
  }
  function assetListInnerHTML(c){
    var mode=ui.assetFilter||"naermest", q=(ui.assetQuery||{})[c.id]||"";
    var rows=sortedAssets(c, mode).filter(function(a){return assetMatches(a, q);});
    if(!rows.length) return '<div class="empty" style="margin:6px 0">'+(q?'Ingen anlegg matcher «'+esc(q)+'».':'Ingen anlegg kartlagt ennå — legg til det første.')+'</div>';
    return rows.map(function(a){return assetRowHTML(c, a);}).join("");
  }
  function byggInfoHTML(c){
    if(!c) return "";
    var n=assetList(c).length;
    var modes=[["naermest","Nærmest"],["alle","Alle"],["type","Etter type"]], cur=ui.assetFilter||"naermest";
    var tabs=modes.map(function(m){ return '<button class="ob-assettab'+(cur===m[0]?' on':'')+'" data-ob="assetFilter" data-arg="'+m[0]+'">'+m[1]+'</button>'; }).join("");
    var q=(ui.assetQuery||{})[c.id]||"";
    return '<div class="card ob-bygg">'
      +'<div class="ct">🏢 Bygg-info — '+esc(c.name)+' <span class="muted" style="font-weight:600">· '+n+' anlegg kartlagt</span></div>'
      +'<div class="ob-bygg-sub">Hvor er avstengning, tavle, sentral? Samlet og stedfestet — kunnskapen blir i systemet, ikke i hodet til én. Ny vaktmester er produktiv dag én.</div>'
      +emergencyStripHTML(c)
      +'<div class="ob-assetfind-wrap"><input class="ob-assetfind" id="assetfind-'+c.id+'" data-obf="assetFind" data-id="'+c.id+'" placeholder="🔎 Hvor er hovedstoppekranen?" value="'+esc(q)+'" autocomplete="off"></div>'
      +'<div class="ob-assetfilter">'+tabs+'</div>'
      +'<div id="ob-assetlist-'+c.id+'" class="ob-assetlist">'+assetListInnerHTML(c)+'</div>'
      +'<button class="ob-newbtn ob-assetadd" data-ob="assetAdd" data-arg="'+c.id+'">＋ Legg til anlegg</button>'
      +'</div>';
  }
  // compact in-cab emergency strip (cockpit route) — urgent access without the full card
  function emergencyMiniHTML(c){
    var em=emergencyAssets(c); if(!em.length) return "";
    return '<div class="ob-emergmini">🚨 '+em.map(function(a){ return '<button class="ob-emergchip sm" data-ob="assetCard" data-arg="'+c.id+'|'+a.id+'">'+assetTypeEmoji(a.type)+' '+esc(a.label||assetTypeLabel(a.type))+'</button>'; }).join("")+'</div>';
  }

  function assetCardSheet(custId, assetId){
    var c=cust(custId); if(!c) return; var a=assetById(c, assetId); if(!a){ toast("Anlegget finnes ikke"); return; }
    var due=a.complianceLink?nextComplianceDue(c, a.complianceLink):null;
    var photos=(a.photoIds||[]).map(function(pid){ return '<img class="ob-acard-photo" data-ob="photoView" data-arg="'+pid+'" '+(photoCache[pid]?'src="'+photoCache[pid]+'"':'data-photo-id="'+pid+'"')+' alt="bilde">'; }).join("");
    obSheet('<h3>'+assetTypeEmoji(a.type)+' '+esc(a.label||assetTypeLabel(a.type))+'</h3>'
      +'<div class="ob-acard-area">'+esc(areaLabel(a.area))+(assetTypeIsEmergency(a.type)?' · <span class="ob-asset-emtag">akutt</span>':'')+'</div>'
      +(photos?'<div class="ob-acard-photos">'+photos+'</div>':'')
      +'<div class="ob-acard-sec"><div class="ob-acard-lbl">🔑 Tilgang</div><div>'+esc(a.access||"—")+'</div></div>'
      +'<div class="ob-acard-sec"><div class="ob-acard-lbl">📝 Notat</div><div>'+esc(a.notes||"—")+'</div></div>'
      +(a.complianceLink?'<div class="ob-acard-sec"><div class="ob-acard-lbl">📋 Lovpålagt kontroll</div><div>'+esc(a.complianceLink)+(due?' · neste: '+esc(dueLabel(due)):'')+'</div></div>':'')
      +(a.geo?'<button class="ob-mini" data-ob="assetGeoView" data-arg="'+a.geo.lat+','+a.geo.lon+'">📍 Vis på kart</button> ':'')
      +'<button class="save" data-ob="assetEdit" data-arg="'+custId+'|'+assetId+'">✏️ Rediger</button>'
      +'<button class="cancel" data-ob="closeObSheet">Lukk</button>');
    hydratePhotos(document.getElementById("sheet"));
  }
  function assetGeoView(arg){
    var pp=(arg||"").split(","), lat=parseFloat(pp[0]), lon=parseFloat(pp[1]);
    if(geoMini){ try{ geoMini.remove(); }catch(e){} geoMini=null; }
    obSheet('<h3>📍 Plassering</h3><div class="ob-opmap" id="ob-geomap" style="height:300px"></div>'
      +'<div class="muted" style="margin-top:8px;font-size:12.5px">'+lat.toFixed(5)+', '+lon.toFixed(5)+'</div>'
      +'<button class="cancel" data-ob="closeObSheet">Lukk</button>');
    setTimeout(function(){ if(!hasLeaflet) return; var el=document.getElementById("ob-geomap"); if(!el) return;
      geoMini=L.map(el,{zoomControl:true, attributionControl:true}); L.tileLayer(KARTVERKET,{attribution:"© Kartverket", maxZoom:20}).addTo(geoMini);
      L.circleMarker([lat,lon],{radius:8, color:"#b45309", weight:2, fillColor:"#f59e0b", fillOpacity:.9}).addTo(geoMini);
      geoMini.setView([lat,lon], 18); setTimeout(function(){ if(geoMini) geoMini.invalidateSize(); }, 60); }, 40);
  }

  function openAssetSheet(c, asset){
    if(!c) return;
    assetCtx={custId:c.id};
    pendingAsset = asset ? JSON.parse(JSON.stringify(asset))
      : {id:"as"+uid(), buildingId:(c.buildingId||c.id), type:"hovedstoppekran", label:"", area:assetTypeDef("hovedstoppekran").area, geo:null, photoIds:[], notes:"", access:"", complianceLink:null, _isNew:true};
    pendingAsset._origPhotoIds=(pendingAsset.photoIds||[]).slice();
    obSheet(assetSheetHTML(c, pendingAsset)); hydratePhotos(document.getElementById("sheet"));
  }
  function assetSheetHTML(c, pa){
    var typeOpts=ASSET_TYPE_ORDER.map(function(t){ return '<option value="'+t+'"'+(pa.type===t?' selected':'')+'>'+assetTypeEmoji(t)+' '+esc(assetTypeLabel(t))+'</option>'; }).join("");
    var areaOpts=Object.keys(AREA_LABEL).map(function(k){ return '<option value="'+k+'"'+(pa.area===k?' selected':'')+'>'+esc(AREA_LABEL[k])+'</option>'; }).join("");
    var compOpts='<option value="">— ingen —</option>'+(c.compliance||[]).map(function(r){ return '<option value="'+esc(r.label)+'"'+(pa.complianceLink===r.label?' selected':'')+'>'+esc(r.label)+'</option>'; }).join("");
    return '<h3>'+(pa._isNew?'Nytt anlegg':'Rediger anlegg')+'</h3>'
      +'<label>Type</label><select id="as_type" data-obf="assetType">'+typeOpts+'</select>'
      +'<label>Navn / merking</label><input id="as_label" data-obf="assetLabel" value="'+esc(pa.label||"")+'" placeholder="'+esc(assetTypeLabel(pa.type))+'">'
      +'<label>Område</label><select id="as_area" data-obf="assetArea">'+areaOpts+'</select>'
      +'<label>Tilgang — nøkkel / kode / hvor</label><input id="as_access" data-obf="assetAccess" value="'+esc(pa.access||"")+'" placeholder="f.eks. nøkkel B3 / kode i nøkkelboks">'
      +'<label>Notat</label><textarea id="as_notes" data-obf="assetNotes" rows="3" placeholder="hvordan finne / betjene; hva å passe på">'+esc(pa.notes||"")+'</textarea>'
      +'<label>Lovpålagt kontroll (valgfritt)</label><select id="as_comp" data-obf="assetCompliance">'+compOpts+'</select>'
      +'<label>Bilde</label>'+photoStripHTML("asset", pa.id, pa.photoIds)
      +'<label>Kart (valgfritt)</label><div class="ob-assetpin"><button class="ob-mini" data-ob="assetPin">📍 '+(pa.geo?'Flytt punkt':'Sett punkt på kart')+'</button>'+(pa.geo?'<span class="ob-pinok">✓ plassert</span>':'')+'</div>'
      +'<button class="save" data-ob="assetSave">Lagre anlegg</button>'
      +(pa._isNew?'':'<button class="cancel ob-del" data-ob="assetDel" data-arg="'+c.id+'|'+pa.id+'">Slett anlegg</button>')
      +'<button class="cancel" data-ob="assetCancel">Avbryt</button>';
  }
  function reopenAssetSheet(){ var c=assetCtx&&cust(assetCtx.custId); if(c&&pendingAsset){ obSheet(assetSheetHTML(c, pendingAsset)); } }
  function reRenderAssetSheet(){ reopenAssetSheet(); hydratePhotos(document.getElementById("sheet")); }
  function syncAssetFromDOM(){
    if(!pendingAsset) return;
    var t=document.getElementById("as_type"); if(t) pendingAsset.type=t.value;
    var l=document.getElementById("as_label"); if(l) pendingAsset.label=l.value;
    var a=document.getElementById("as_area"); if(a) pendingAsset.area=a.value;
    var ac=document.getElementById("as_access"); if(ac) pendingAsset.access=ac.value;
    var n=document.getElementById("as_notes"); if(n) pendingAsset.notes=n.value;
    var cp=document.getElementById("as_comp"); if(cp) pendingAsset.complianceLink=cp.value||null;
  }
  function startAssetPin(){
    syncAssetFromDOM();
    if(!map){ toast("Åpne kartet (befaring / steg 5) for å plassere punkt — anlegget lagres uansett"); return; }
    obCloseSheet(); assetPinMode=true; startDraw("point");
  }
  function saveAssetFromSheet(){
    syncAssetFromDOM();
    var c=assetCtx&&cust(assetCtx.custId); if(!c||!pendingAsset){ obCloseSheet(); return; }
    if(!pendingAsset.label) pendingAsset.label=assetTypeLabel(pendingAsset.type);
    var isNew=pendingAsset._isNew; delete pendingAsset._isNew; delete pendingAsset._origPhotoIds;
    c.assets=c.assets||[];
    var existing=assetById(c, pendingAsset.id), idx=existing?c.assets.indexOf(existing):-1;
    if(existing){ c.assets[idx]=pendingAsset; } else { c.assets.push(pendingAsset); }
    if(!save()){ if(existing){ c.assets[idx]=existing; } else { c.assets.pop(); } return; }  // C1: honest rollback on failed write
    pendingAsset=null; assetCtx=null; assetPinMode=false; obCloseSheet(); render(); toast("🏢 Anlegg lagret");
  }
  function assetCancel(){ assetCleanup(); obCloseSheet(); }
  function assetCleanup(){
    if(pendingAsset){ var orig=pendingAsset._origPhotoIds||[]; (pendingAsset.photoIds||[]).forEach(function(pid){ if(orig.indexOf(pid)<0) photoDel(pid); }); }  // drop photos taken this session only
    pendingAsset=null; assetCtx=null; assetPinMode=false;
  }
  function delAsset(custId, assetId){
    var c=cust(custId); if(!c) return; var a=assetById(c, assetId); if(!a) return;
    if(!window.confirm("Slette «"+(a.label||assetTypeLabel(a.type))+"»? Bilder og notat fjernes.")) return;
    var keepPhotos=(a.photoIds||[]).slice();
    c.assets=(c.assets||[]).filter(function(x){return x.id!==assetId;});
    if(!save()){ c.assets.push(a); return; }  // rollback on failed write
    keepPhotos.forEach(function(pid){ photoDel(pid); }); photoGC();
    pendingAsset=null; assetCtx=null; obCloseSheet(); render(); toast("Anlegg slettet");
  }
  // area derived from the doc-38 walkaround taxonomy via the checklist/line item id
  // area + method now live in SERVICE_CATALOGUE (read via catArea/catMethod) — Phase 8 consolidation
  var METHOD_LABEL={ maskin:"Maskin", manuell:"Manuell", lift:"Lift", stige:"Stige", traktor:"Traktor" };
  function methodLabelOf(m){ return METHOD_LABEL[m]||cap(m||""); }
  function itemKeyOf(lineId){ return (lineId||"").split(":").slice(1).join(":"); }
  function areaOfLineId(lineId){ var k=itemKeyOf(lineId); if(/^comp/.test(k)) return "teknisk"; return catArea(k); }
  function methodOfLineId(lineId){ return catMethod(itemKeyOf(lineId)); }
  function areaOfComplianceTitle(t){ t=(t||"").toLowerCase(); if(/heis/.test(t)) return "heis"; if(/lekeplass/.test(t)) return "ute"; return "teknisk"; }
  function candService(c,s){
    if(s.kind==="sched") return serviceOfTask(c, s.lineId);
    return ({greenery:"grass", grass:"grass", snow:"snow", cleaning:"cleaning", compliance:"compliance", technical:"technical", other:"other"})[s.service]||"other";
  }
  // the heart: ranked, explainable suggestions for a building right now
  function suggestWhileHere(c, ctx){
    ctx=ctx||{};
    var today=refDate(), tIso=iso(today);
    // 1) what's being worked HERE today → in-use areas + EQUIPMENT (co-location / co-equipment context — Phase 9: real equipment, not the method heuristic)
    var hereAreas={}, hereEquip={};
    generateInstances(scheduleLines(c), today, today).filter(function(i){return i.date===tIso && !isDone(i);}).forEach(function(i){
      hereAreas[i.statutory?areaOfComplianceTitle(i.title):areaOfLineId(i.lineId)]=1; catEquipment(itemKeyOf(i.lineId)).forEach(function(t){ hereEquip[t]=1; }); });
    (c.upcoming||[]).filter(function(u){return (u.offsetDays||0)===0 && !isDone({lineId:c.id+":up:"+u.id, date:tIso});}).forEach(function(u){ if(u.area) hereAreas[u.area]=1; (u.equipment||[]).forEach(function(t){ hereEquip[t]=1; }); });
    if(ctx.area) hereAreas[ctx.area]=1;
    (ctx.equipment||[]).forEach(function(t){ hereEquip[t]=1; });
    // 2) candidates within the pull-forward window (not today, not done)
    var cand=[];
    (c.upcoming||[]).forEach(function(u){ var d=(u.offsetDays==null?99:u.offsetDays);
      if(d<=0 || d>WHILE_WINDOW) return; if(isDone({lineId:c.id+":up:"+u.id, date:tIso})) return;
      cand.push({ key:"up:"+u.id, kind:"upcoming", upId:u.id, title:u.title, area:u.area||"ute", equipment:u.equipment||[], statutory:!!u.statutory, service:u.service||"other", daysUntil:d, dueIso:tIso }); });
    generateInstances(scheduleLines(c), addDays(today,1), addDays(today,WHILE_WINDOW)).forEach(function(i){
      if(isDone(i)) return; var d=Math.round((new Date(i.date+"T00:00:00")-new Date(tIso+"T00:00:00"))/86400000);
      if(d<=0 || d>WHILE_WINDOW) return;
      cand.push({ key:"sc:"+instKey(i), kind:"sched", lineId:i.lineId, title:i.title, area:i.statutory?areaOfComplianceTitle(i.title):areaOfLineId(i.lineId), equipment:catEquipment(itemKeyOf(i.lineId)), statutory:!!i.statutory, freq:i.freq, daysUntil:d, dueIso:i.date }); });
    // dedupe by title+area
    var seen={}, uniq=[]; cand.forEach(function(s){ var k=s.title+"|"+s.area; if(!seen[k]){ seen[k]=1; uniq.push(s); } });
    // optional team scope (cockpit)
    if(ctx.teamServices){ uniq=uniq.filter(function(s){ return ctx.teamServices.indexOf(candService(c,s))>=0; }); }
    // 3) reasons + score (co-located+due-soon highest; then equipment; then compliance; nearer-due wins ties)
    uniq.forEach(function(s){
      var coLoc=!!hereAreas[s.area], matchedEq=null;
      (s.equipment||[]).some(function(t){ if(hereEquip[t]){ matchedEq=t; return true; } return false; });   // real equipment on site today
      var coEq=!!matchedEq;
      s.reasons=[];
      if(coLoc) s.reasons.push({k:"loc", icon:"📍", text:"Samme område — "+areaLabel(s.area)});
      s.reasons.push({k:"time", icon:"⏰", text:"Forfaller om "+s.daysUntil+" dag"+(s.daysUntil===1?"":"er")});
      if(coEq) s.reasons.push({k:"equip", icon:"🔧", text:equipTypeLabel(matchedEq)+" er på stedet i dag"});
      if(s.statutory) s.reasons.push({k:"comp", icon:"✅", text:"Lovpålagt — forfaller nå"});
      var score=300; if(coLoc) score+=200; if(coEq) score+=60; if(s.statutory) score+=40; score+=Math.max(0,(WHILE_WINDOW-s.daysUntil));
      s.score=score; s.coLoc=coLoc;
    });
    uniq.sort(function(a,b){ return b.score-a.score; });
    return uniq;
  }
  function whileHereHTML(c, ctx){
    var sugs=suggestWhileHere(c, ctx); if(!sugs.length) return "";
    var top=sugs.slice(0,5);
    var rows=top.map(function(s){
      var chips=s.reasons.map(function(r){ return '<span class="ob-whyc ob-whyc-'+r.k+'">'+r.icon+' '+esc(r.text)+'</span>'; }).join("");
      var lineId=s.kind==="sched"?s.lineId:(c.id+":up:"+s.upId), date=s.dueIso, freq=s.kind==="sched"?(s.freq||"plan"):"vedlikehold";
      return '<div class="ob-sugrow"><div class="ob-sugmain"><div class="ob-sugtitle">'+esc(s.title)+' <span class="ob-sugarea">'+esc(areaLabel(s.area))+'</span></div>'
        +'<div class="ob-sugwhy">'+chips+'</div></div>'
        +'<button class="ob-mini ok on" data-ob="planDone" data-arg="'+lineId+'|'+date+'|'+encodeURIComponent(s.title)+'|'+encodeURIComponent(freq)+'|'+encodeURIComponent(c.name)+'">⚡ Gjør nå</button></div>';
    }).join("");
    return '<div class="card ob-sugcard"><div class="ct">💡 Mens du er her · '+esc(c.name)+' <span class="chip grey">'+top.length+'</span></div>'
      +'<p class="muted" style="font-size:12px;margin:-2px 0 9px">Smart å ta nå — samme sted, samme tur, samme utstyr. Hver én spart utrykning teller.</p>'
      + rows +'</div>';
  }
  function whileHereCards(ctx){ return liveClients().map(function(c){ return whileHereHTML(c, ctx||{}); }).filter(Boolean).join(""); }

  function renderFieldExtras(cols){
    if(!liveClients().length) return;
    var ctx=cockpit();
    if(ctx.team && (ui.cockMode||"route")==="route"){
      var rh=document.createElement("div"); rh.className="lane"; rh.style.gridColumn="1 / -1";
      rh.innerHTML=cockpitBarHTML()+cockpitRouteHTML();
      cols.insertBefore(rh, cols.firstChild);
      return;
    }
    var today=refDate(), ws=mondayOf(today), we=addDays(ws,6), tIso=iso(today), month=today.getMonth()+1;
    var inst=generateInstances(liveLines(), ws, addDays(today,28)).filter(function(i){return !isDone(i);});
    var todayL=inst.filter(function(i){return i.date===tIso;});
    var weekL=inst.filter(function(i){return i.date>=iso(ws)&&i.date<=iso(we)&&i.date!==tIso;});
    var komL=inst.filter(function(i){return i.date>iso(we);}).sort(function(a,b){return a.date<b.date?-1:1;});
    var zc=liveClients().filter(function(c){return c.zones&&c.zones.length;})[0];
    var host=document.createElement("div"); host.className="lane"; host.style.gridColumn="1 / -1";
    host.innerHTML = cockpitBarHTML()
      + (zc?opMapsRow(zc,"fld"):"")
      + weekStepperHTML(today)
      + planSection("I dag · "+dateLabel(today), todayL, true)
      + planSection("Denne uka", weekL, true)
      + whileHereCards({})   // doc-01 ordering: dagens oppgaver → 💡 Mens du er her → kommende
      + (komL.length? planCondensed("Kommende (4 uker)", komL) : "")
      + beredskapHTML(month)
      + liveClients().map(function(c){return byggInfoHTML(c);}).join("");  // Phase 10: building-asset registry per live bygg
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
    syncCockpitChip(); // 6c: keep the device's team/individual chip in the header across views
    if(view==="sales"){ renderSales(cols); }
    else if(view==="board"){ renderBoardExtras(cols); }
    else if(view==="office"){ renderOfficeExtras(cols); }
    else if(view==="field"){ renderFieldExtras(cols); }
  }

  function renderSales(cols){
    cols.className="cols";
    if(ui.newBuilding){ cols.innerHTML=renderNewBuilding(); return; }
    var c=cur();
    if(!c){ cols.innerHTML=pipelineHTML(); return; }
    cols.innerHTML=wizardHTML(c);
    if(ui.step===1 || (ui.step===5 && c.stage==="Live")) buildMap(c);
    if(ui.step===2 && c.offer){ buildOpMap(c,"snow","off-opmap-snow"); buildOpMap(c,"grass","off-opmap-grass"); }
    hydratePhotos(cols);
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
      +'<button class="ob-btn primary" data-ob="newBuilding">➕ Sett opp nytt bygg</button>'
      +'<button class="ob-btn ghost" data-ob="new">＋ Tomt (manuelt)</button>'
      +'<button class="ob-btn ghost" data-ob="reseed">↺ Demo</button>'
      +(list.length?'<button class="ob-btn ghost" data-ob="clearCustomers">🗑 Clear</button>':'')
      +'</div>'
      +'<div class="ob-pipe">'+cards+'</div>';
  }

  /* ===== Phase 3: "Sett opp nytt bygg" — live registry intake ===== */
  function startNewBuilding(){ ui.newBuilding={mode:"name", query:"", results:null, loading:false, error:null, prefill:null}; ui.openId=null; OnSite.go("sales"); }
  function renderNewBuilding(){
    var nb=ui.newBuilding;
    var tab=function(m,label){ return '<button class="ob-mini'+(nb.mode===m?' on':'')+'" data-ob="nbMode" data-arg="'+m+'">'+label+'</button>'; };
    var ph = nb.mode==="name" ? "f.eks. Holtet Horisont, Solbakken borettslag…" : "f.eks. Kongsveien 82A, Oslo";
    var resultsBlock="";
    if(nb.loading) resultsBlock='<div class="empty">Henter fra offentlig register…</div>';
    else if(nb.error) resultsBlock='<div class="ob-callout">⚠️ '+esc(nb.error)+' <button class="ob-mini" data-ob="nbManual">Fyll inn manuelt</button></div>';
    else if(nb.results) resultsBlock=nbResultsHTML(nb);
    return '<div class="ob-wiz">'
      +'<button class="ob-back" data-ob="nbCancel">← Tilbake til kunder</button>'
      +'<div class="ob-title"><h2>Sett opp nytt bygg</h2><span class="ob-step">offentlig register</span></div>'
      +'<div class="ob-grid split">'
      +  '<div class="card"><div class="ct">Søk opp bygget</div>'
      +    '<p class="muted" style="font-size:12.5px;margin:0 0 9px">Fra navn eller adresse henter vi org, forvalter, styre, gnr/bnr og koordinater (geonorge + Brønnøysund) — alt redigerbart, du bekrefter på befaring.</p>'
      +    '<div class="ob-cat-chips" style="margin-bottom:8px">'+tab("name","🏢 Søk på navn")+tab("address","📍 Søk på adresse")+'</div>'
      +    '<div style="display:flex;gap:8px"><input id="nb_q" value="'+esc(nb.query||"")+'" placeholder="'+ph+'" style="flex:1"><button class="ob-btn primary" data-ob="nbSearch">Søk</button></div>'
      +    '<div class="ob-bar" style="margin-top:8px"><button class="ob-btn ghost" data-ob="nbManual">Fyll inn manuelt →</button></div>'
      +    resultsBlock
      +  '</div>'
      +  '<div>'+ (nb.prefill ? nbConfirmHTML(nb.prefill) : '<div class="card"><div class="empty">Velg et treff til venstre — eller «Fyll inn manuelt».</div></div>') +'</div>'
      +'</div></div>';
  }
  function nbResultsHTML(nb){
    var items=nb.results.items||[];
    if(!items.length) return '<div class="empty" style="margin-top:8px">Ingen treff. Prøv et annet søk eller «Fyll inn manuelt».</div>';
    if(nb.results.type==="brreg"){
      return '<div class="ob-nbres">'+items.map(function(e,i){
        var of=(e.organisasjonsform||{}); var nk=(e.naeringskode1||{}).kode||"";
        var resident = nk==="97.001";
        return '<button class="ob-nbrow'+(resident?'':' faint')+'" data-ob="nbPick" data-arg="'+i+'">'
          +'<div class="nm">'+esc(titleCase(e.navn))+'</div>'
          +'<div class="ad">org '+esc(e.organisasjonsnummer)+' · '+esc(of.beskrivelse||of.kode||"")+(nk?' · '+esc(nk):'')+'</div></button>';
      }).join("")+'</div>';
    }
    return '<div class="ob-nbres">'+items.map(function(a,i){
      return '<button class="ob-nbrow" data-ob="nbPick" data-arg="'+i+'">'
        +'<div class="nm">'+esc(a.adressetekst)+'</div>'
        +'<div class="ad">'+esc((a.postnummer||"")+" "+(a.poststed||""))+' · '+esc(a.kommunenavn||"")+' · gnr '+esc(String(a.gardsnummer||"?"))+'/bnr '+esc(String(a.bruksnummer||"?"))+' · '+(((a.bruksenhetsnummer)||[]).length)+' enh.</div></button>';
    }).join("")+'</div>';
  }
  function nbConfirmHTML(p){
    function f(id,label,val,ph){ return '<label>'+label+'</label><input id="'+id+'" value="'+esc(val==null?"":String(val))+'"'+(ph?' placeholder="'+ph+'"':'')+'>'; }
    var board = (p.styremedlemmer&&p.styremedlemmer.length) ? '<div class="ob-nbboard">Styremedlemmer: '+p.styremedlemmer.map(esc).join(", ")+'</div>' : '';
    return '<div class="card"><div class="ct">Bekreft & rediger <span class="muted" style="font-weight:600">· '+esc(p.source||"register")+'</span></div>'
      + f("nb_name","Navn",p.name)
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:1">'+f("nb_orgnr","Org.nr",p.orgnr)+'</div><div style="flex:1.4">'+f("nb_orgform","Org.form",p.orgform)+'</div></div>'
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:2">'+f("nb_addr","Adresse",p.addr,"gate + husnr")+'</div><button class="ob-btn ghost" data-ob="nbGeocode" style="align-self:flex-end">📍 Geokod</button></div>'
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:1">'+f("nb_postnr","Postnr",p.postnummer)+'</div><div style="flex:1.6">'+f("nb_poststed","Poststed",p.poststed)+'</div></div>'
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:1.6">'+f("nb_kommune","Kommune",p.kommunenavn)+'</div><div style="flex:1">'+f("nb_gnr","gnr",p.gnr)+'</div><div style="flex:1">'+f("nb_bnr","bnr",p.bnr)+'</div></div>'
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:1">'+f("nb_lat","Lat",p.lat!=null?(+p.lat).toFixed(5):"")+'</div><div style="flex:1">'+f("nb_lon","Lon",p.lon!=null?(+p.lon).toFixed(5):"")+'</div><div style="flex:1">'+f("nb_units","Enheter (ca.)",p.units||"")+'</div></div>'
      + f("nb_forvalter","Forvalter (FFØR)",p.forvalter,"OBOS / USBL / annen")
      + '<div class="row2" style="display:flex;gap:8px"><div style="flex:1.4">'+f("nb_styreleder","Styreleder",p.styreleder)+'</div><div style="flex:1">'+f("nb_revisor","Revisor",p.revisor)+'</div></div>'
      + board
      + f("nb_year","Byggeår (manuelt — ikke i API)",p.buildYear,"f.eks. 2018")
      + '<div class="ob-callout" style="font-size:11.5px">📋 Compliance-pakke (Norge · bolig) seedes automatisk: brann, el-kontroll ~5 år, lekeplass årlig, heis 2-årlig, legionella, radon, oljetank.</div>'
      + '<div class="ob-bar"><button class="ob-btn green" data-ob="nbCreate">Opprett bygg → befaring</button></div></div>';
  }
  function nbRender(){ var cols=document.getElementById("cols"); if(cols && ui.newBuilding) cols.innerHTML=renderNewBuilding(); }
  function nbSearch(){
    var nb=ui.newBuilding; if(!nb) return;
    var q=val("nb_q"); if(!q){ toast("Skriv et navn eller en adresse"); return; }
    nb.query=q; nb.results=null; nb.error=null; nb.prefill=null; nb.loading=true; nbRender();
    if(nb.mode==="name"){
      brregSearch(q, function(list){ nb.loading=false; if(list===null) nb.error="Brønnøysund utilgjengelig (CORS/nett) — søk på adresse eller fyll inn manuelt"; else nb.results={type:"brreg", items:list}; nbRender(); });
    } else {
      geoSearch(q, function(list){ nb.loading=false; if(list===null) nb.error="geonorge utilgjengelig — fyll inn manuelt"; else nb.results={type:"geo", items:list}; nbRender(); });
    }
  }
  function prefillFromGeo(a){ var p=parseAddr(a); return { source:"geonorge", name:"", orgnr:"", orgform:"Eierseksjonssameie",
    addr:p.adressetekst, postnummer:p.postnummer, poststed:p.poststed, kommunenavn:p.kommunenavn, kommunenummer:p.kommunenummer,
    gnr:p.gnr, bnr:p.bnr, lat:p.lat, lon:p.lon, units:p.units, forvalter:"", styreleder:"", styremedlemmer:[], revisor:"", naering:"", buildYear:"" }; }
  function prefillFromBrreg(e){ var of=(e.organisasjonsform||{}), fa=e.forretningsadresse||{};
    return { source:"Brønnøysund", name:titleCase(e.navn), orgnr:e.organisasjonsnummer, orgform:(of.beskrivelse||of.kode||""),
      naering:(e.naeringskode1||{}).kode||"", addr:"", postnummer:fa.postnummer||"", poststed:fa.poststed||"",
      kommunenavn:fa.kommune||"", kommunenummer:fa.kommunenummer||"", gnr:"", bnr:"", lat:null, lon:null, units:0,
      forvalter:"", styreleder:"", styremedlemmer:[], revisor:"", buildYear:"", _street:brregStreet(fa) }; }
  function applyAddr(p,res){ p.addr=res.adressetekst; p.postnummer=res.postnummer; p.poststed=res.poststed; p.kommunenavn=res.kommunenavn||p.kommunenavn; p.kommunenummer=res.kommunenummer||p.kommunenummer; p.gnr=res.gnr; p.bnr=res.bnr; p.lat=res.lat; p.lon=res.lon; p.units=res.units; }
  function nbPick(idx){
    var nb=ui.newBuilding; if(!nb||!nb.results) return; var it=(nb.results.items||[])[idx]; if(!it) return;
    if(nb.results.type==="geo"){ nb.prefill=prefillFromGeo(it); nbRender(); return; }
    var p=prefillFromBrreg(it); nb.prefill=p; nb.loading=false; nbRender();
    brregRoles(it.organisasjonsnummer, function(roles){
      if(roles){ p.forvalter=roles.forvalter||""; p.styreleder=roles.styreleder||""; p.styremedlemmer=roles.styremedlemmer||[]; p.revisor=roles.revisor||""; }
      if(p._street){ geoLookup(p._street, function(res){ if(res) applyAddr(p,res); nbRender(); }); } else nbRender();
    });
  }
  function syncPrefillFromForm(){
    var nb=ui.newBuilding; if(!nb||!nb.prefill) return; var p=nb.prefill;
    p.name=val("nb_name")||p.name; p.orgnr=val("nb_orgnr"); p.orgform=val("nb_orgform"); p.addr=val("nb_addr");
    p.postnummer=val("nb_postnr"); p.poststed=val("nb_poststed"); p.kommunenavn=val("nb_kommune"); p.gnr=val("nb_gnr"); p.bnr=val("nb_bnr");
    var la=parseFloat(val("nb_lat")), lo=parseFloat(val("nb_lon")); if(!isNaN(la)) p.lat=la; if(!isNaN(lo)) p.lon=lo;
    p.units=parseInt(val("nb_units"),10)||p.units; p.forvalter=val("nb_forvalter"); p.styreleder=val("nb_styreleder"); p.revisor=val("nb_revisor"); p.buildYear=val("nb_year");
  }
  function nbGeocode(){
    var nb=ui.newBuilding; if(!nb||!nb.prefill) return; syncPrefillFromForm();
    var q=val("nb_addr"); if(!q){ toast("Skriv en adresse å geokode"); return; }
    toast("Geokoder…");
    geoLookup(q, function(res){
      if(res===null){ toast("geonorge utilgjengelig"); return; }
      if(!res){ toast("Fant ikke adressen — prøv med husnummer/bokstav"); return; }
      applyAddr(nb.prefill,res); nbRender(); toast("📍 "+res.adressetekst+" · gnr "+res.gnr+"/"+res.bnr+" · "+res.units+" enh.");
    });
  }
  function nbManual(){ var nb=ui.newBuilding; if(!nb) return; nb.error=null; nb.results=null; nb.loading=false;
    nb.prefill={source:"manuelt", name:"", orgnr:"", orgform:"Borettslag", addr:"", postnummer:"", poststed:"", kommunenavn:"", kommunenummer:"", gnr:"", bnr:"", lat:59.9139, lon:10.7522, units:"", forvalter:"", styreleder:"", styremedlemmer:[], revisor:"", naering:"", buildYear:""}; nbRender(); }
  function nbCreate(){
    var nb=ui.newBuilding; if(!nb) return; syncPrefillFromForm(); var p=nb.prefill||{};
    if(!p.name){ toast("Navn må fylles ut"); var e=document.getElementById("nb_name"); if(e) e.focus(); return; }
    var lat=(p.lat!=null&&!isNaN(p.lat))?p.lat:59.9139, lon=(p.lon!=null&&!isNaN(p.lon))?p.lon:10.7522;
    var contacts=[]; if(p.styreleder) contacts.push({name:p.styreleder, role:"Styreleder", email:""});
    (p.styremedlemmer||[]).forEach(function(nm){ contacts.push({name:nm, role:"Styremedlem", email:""}); });
    if(!contacts.length) contacts.push({name:"", role:"Styreleder", email:""});
    var addr=p.addr+(p.postnummer?(", "+p.postnummer+" "+(p.poststed||"")):"");
    var c={ id:"cust"+uid(), name:p.name, addr:addr, gnr:p.gnr||"", bnr:p.bnr||"",
      profile:"Residential — association", buildYear:parseInt(p.buildYear,10)||"", size:0,
      orgnr:p.orgnr||"", orgform:p.orgform||"", naering:p.naering||"", kommune:p.kommunenavn||"", kommunenummer:p.kommunenummer||"", units:parseInt(p.units,10)||0,
      manager:p.forvalter||"", revisor:p.revisor||"",
      contacts:contacts, meetingTime:"", stage:"Surveyed", period:"mnd",
      requestedScope:[], layers:["entrance","stairwell","grass","greenery","snow","gritting","tech","fire"],
      systems:[], compliance:complianceClone(), terms:null,
      center:{lat:lat, lon:lon, zoom:18}, baseLayer:"topo", accessNote:"",
      markers:[], zones:[], checklist:instantiateChecklist("Residential — association"),
      offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:nowStr(), text:"Opprettet fra offentlig register ("+(p.source||"register")+") — verifiseres på befaring"}] };
    customers().push(c); save();
    ui.newBuilding=null; ui.openId=c.id; ui.step=1; ui.draftNew=false; ui.activeLayer=null; ui.zonesOpen={1:true,3:true}; ui.modOpen={};
    toast("✅ Bygg opprettet: "+p.name+" — klar for befaring"); OnSite.go("sales");
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
    var hasZones=(c.markers||[]).some(function(m){return !LAYERS[m.layer].recordOnly;}) || (c.checklist&&c.checklist.length) || (c.zones&&c.zones.length);
    var perWord = c.period==="mnd" ? "måned" : "år";
    var mp = ui.mobilePane||"map";
    return '<div class="ob-mobtoggle"><button class="ob-mini'+(mp==="map"?" on":"")+'" data-ob="mobilePane" data-arg="map">🗺️ Kart</button><button class="ob-mini'+(mp==="list"?" on":"")+'" data-ob="mobilePane" data-arg="list">📋 Sjekkliste / soner</button></div>'
      +'<div class="ob-grid split ob-walkgrid pane-'+mp+'" id="ob-walkgrid">'
      +'<div class="ob-walkpane map">'
        +'<div class="ob-hint">Tablet-befaring: velg en kategori, så <b>tapp på kartet</b> (finger/penn) for å sette markør, eller <b>Tegn sone</b> for å måle. Alt utenfor forespurt scope flagges som <b>upsell</b>. 📷 fester bilder til soner og sjekkpunkter.</div>'
        +'<div class="ob-picker" id="ob-layers">'+layerPickerHTML(c,"sales")+'</div>'
        +'<div class="ob-maptools"><span class="ob-active-note" id="ob-active">'+activeNote()+'</span><span class="spacer" style="flex:1"></span>'
          +'<button class="ob-btn ghost" data-ob="locateWalk">📍 Finn adresse</button>'
          +'<button class="ob-btn ghost" data-ob="geotag">📍 Min posisjon</button></div>'
        +'<div class="ob-drawbar" id="ob-drawtools">'+drawToolbarHTML()+'</div>'
        +'<div class="ob-drawread" id="ob-draw-readout"></div>'
        +'<div id="ob-map"></div>'
      +'</div>'
      +'<div class="ob-walkpane list">'
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
      +'<div class="ob-clcap">'+captureField(it)+(it.freq?'<span class="ob-clfreq">'+esc(it.freq)+'</span>':'')+'</div>'
      +photoStripHTML("item", it.id, it.photoIds)+'</div>';
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
    hydratePhotos(document.getElementById("ob-checklist"));
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
      +       '<div class="ob-bar"><button class="ob-btn primary" data-ob="boardDoc">📄 Tilbud til styret</button><button class="ob-btn ghost" data-ob="printOffer">🖨 Print / Save as PDF</button></div></div>'
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
    var zph = l.zoneId ? findZone(c,l.zoneId) : null; var nph = (zph&&zph.photoIds)?zph.photoIds.length:0;
    var photoBadge = nph ? ' <button class="ob-linephoto" data-ob="lineGallery" data-arg="'+l.zoneId+'" title="vedlegg / bilder fra sonen">📷 '+nph+'</button>' : '';
    return '<div class="ob-modline'+(l.zoneId?' has-zone':'')+'"'+(l.zoneId?' data-zone="'+l.zoneId+'"':'')+'>'
      +'<div class="ob-mlmain"><div class="ob-mllab">'+l.emoji+' '+esc(l.label)+partner+(l.zoneId?' <span class="ob-zlink" title="fra tegnet sone">🗺️</span>':'')+photoBadge+'</div>'
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
    var snowreps=snowReportsListHTML();
    var proof=boardProofHTML();
    if(!awaiting.length && !proof && !snowreps) return;
    var host=document.createElement("div"); host.className="lane"; host.style.gridColumn="1 / -1";
    var html="";
    if(awaiting.length){ var c=awaiting[0];
      html+='<div class="ob-board-banner"><h3>📋 New service offer to review — '+esc(c.name)+'</h3>'
        +'<p>OnSite granted you access to your building. Review the offer line by line, or just reply by email.</p>'
        +'<button class="open" data-ob="reviewNow" data-id="'+c.id+'">Review the offer ▾</button></div>'
        + (ui.boardOpen===c.id ? boardReviewHTML(c) : "");
    }
    html += snowreps;
    html += proof;
    host.innerHTML=html;
    cols.insertBefore(host, cols.firstChild);
    hydratePhotos(host);
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
      +'<button class="ob-newbtn" data-ob="new">＋ Set up a new client (sales → onboarding)</button></div>'+fleetHTML()+ars
      +liveClients().map(function(c){return byggInfoHTML(c);}).join("");  // Phase 10: Bygg-info visible in Office too
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

  /* ---- board leave-behind (doc 50): one-pager generated from offer + record ---- */
  function moduleCovers(m){
    var seen={}, out=[];
    (m.lines||[]).forEach(function(l){ var lab=l.label||""; if(lab && !seen[lab]){ seen[lab]=1; out.push(lab); } });
    return out.slice(0,4).join(", ") || "etter avtalt plan";
  }
  function boardOpCard(c, kind){
    var elId="bs-opmap-"+kind, title=kind==="snow"?"Operasjonskart – Vinter":"Operasjonskart – Grønt";
    return '<div class="ob-bopcard"><div class="ob-optitle">'+esc(title)+'</div>'
      +'<div class="ob-opmap" id="'+elId+'"></div>'
      +(kind==="snow"?'<div class="ob-opcap">'+esc(snowCaption(c))+'</div>':'')
      + opLegend(kind)+'</div>';
  }
  function boardDocHTML(c){
    var o=c.offer;
    var meta=[];
    if(c.addr) meta.push('<b>'+esc(c.addr)+'</b>');
    if(c.gnr) meta.push('gnr '+esc(c.gnr)+'/bnr '+esc(c.bnr));
    if(c.units) meta.push('~'+esc(String(c.units))+' boenheter');
    if(c.manager) meta.push('forvalter: '+esc(c.manager));
    var ct=(c.contacts&&c.contacts[0])||null;
    var deliv='Levert av <b>'+esc(FM_SELSKAP)+'</b> · '+esc(nowStr())+(ct&&ct.name?(' · kontakt '+esc(ct.name)):'');

    var incl=o.modules.filter(function(m){return m.included;});
    var rows=incl.map(function(m){
      return '<tr><td><b>'+esc(m.title)+'</b></td><td>'+esc(moduleCovers(m))+'</td><td>'+esc(moduleCadence(m))+'</td><td class="r">'+kr(m.subtotal)+'/mnd</td></tr>';
    }).join("");
    var table='<table class="ob-btab"><thead><tr><th>Modul</th><th>Hva det dekker</th><th>Frekvens</th><th class="r">Pris/mnd</th></tr></thead><tbody>'
      +rows
      +'<tr class="sum"><td><b>Sum fast</b></td><td></td><td></td><td class="r"><b>'+kr(o.totalMonthly)+'/mnd</b></td></tr>'
      +'</tbody></table>';

    var ol=(o.optionLines||[]);
    var opt = ol.length ? '<p class="ob-bopt"><i>Opsjoner (faktureres ved bestilling): '
      + ol.map(function(l){ var amt=(l.role==="hedge"||l.role==="bed")?(kr(l.final)+'/år'):(l.oneOff?(kr(l.final)+' pr gang'):(kr(l.final)+'/mnd')); return esc(l.label)+' '+amt; }).join(", ")
      + '.</i></p>' : '';

    var snowZones=(c.zones||[]).filter(function(z){return z.service==="snow";});
    var grassZones=(c.zones||[]).filter(function(z){return z.service==="grass"||z.service==="greenery";});
    var cards=(snowZones.length?boardOpCard(c,"snow"):"")+(grassZones.length?boardOpCard(c,"grass"):"");
    var opSection = cards ? '<h2>Operasjonskart</h2>'
      +'<p class="ob-bnote">Vedlagt: '+(snowZones.length?'Vinterkart — hvor vi brøyter maskinelt/for hånd og hvor snøen legges.':'')
      +(grassZones.length?(snowZones.length?' ':'')+'Grøntkart — hva som klippes og hvilke bed gartner steller.':'')
      +' Dette sikrer at <b>enhver som møter opp gjør jobben riktig første gang.</b></p>'
      +'<div class="ob-bopmaps">'+cards+'</div>' : '';

    return '<div class="ob-bdoc">'
      +'<h1>Tilbud om eiendomsservice — '+esc(c.name)+'</h1>'
      +'<div class="ob-bmeta">'+meta.join(' · ')+'</div>'
      +'<div class="ob-bmeta sub">'+deliv+'</div>'
      +'<h2>Hva dere får</h2>'
      +'<p>En fast leverandør som er på stedet <b>hver uke</b> og kjenner bygget deres — ikke en plan laget på én årlig befaring. Tjenestene under leveres etter avtalt plan, dokumentert med bilde/bekreftelse for hver jobb.</p>'
      +'<h2>Tjenester og pris <span class="ob-bmva">(alt eks. mva)</span></h2>'
      + table + opt
      +'<p class="ob-bsever"><b>Hver modul er en egen avtale</b> — dere kan justere eller si opp én tjeneste uten å røre resten.</p>'
      + opSection
      +'<h2>Slik vet dere at jobben er gjort</h2>'
      +'<p>Hver oppgave logges med tidspunkt og bilde. Etter snøfall får dere en kort oppsummering av brøyteruta — før dere rekker å lure. Alt samlet ett sted, klart til årsmøtet.</p>'
      +'<h2>Hvorfor oss</h2>'
      +'<ul class="ob-bwhy">'
      +'<li><b>På stedet hver uke</b> — vi ser bygget, ikke et øyeblikksbilde.</li>'
      +'<li><b>Åpent og ærlig</b> — dere ser hver meter, hver pris, og at jobben ble gjort.</li>'
      +'<li><b>Lovpålagt internkontroll</b> følges opp (brann, el, heis, lekeplass m.m.).</li>'
      +'</ul></div>';
  }
  function showBoardDoc(c){
    if(!c.offer){ toast("Beregn tilbudet først"); return; }
    var host=document.getElementById("ob-board"); if(!host) return;
    host.innerHTML='<div class="ob-board-bar"><button class="ob-btn ghost" data-ob="closeBoard">✕ Lukk</button>'
      +'<div class="ob-board-title">Tilbud til styret</div>'
      +'<button class="ob-btn primary" data-ob="printBoard">🖨 Skriv ut / PDF</button></div>'
      +'<div class="ob-board-scroll">'+boardDocHTML(c)+'</div>';
    host.classList.add("on"); host.setAttribute("aria-hidden","false");
    buildOpMap(c,"snow","bs-opmap-snow"); buildOpMap(c,"grass","bs-opmap-grass");
  }
  function closeBoard(){
    var host=document.getElementById("ob-board"); if(!host) return;
    for(var k in opMaps){ if(k.indexOf("bs-")===0){ try{opMaps[k].remove();}catch(e){} delete opMaps[k]; } }
    host.classList.remove("on"); host.setAttribute("aria-hidden","true"); host.innerHTML="";
  }
  function printBoard(){
    for(var k in opMaps){ if(k.indexOf("bs-")===0){ try{opMaps[k].invalidateSize();}catch(e){} } }
    document.body.classList.add("ob-print-board");
    var cleanup=function(){ document.body.classList.remove("ob-print-board"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(function(){ window.print(); }, 200);
  }

  /* ---- post-snow Brøyterapport (doc 52/47, Phase 6b): compiled view over completionLog ---- */
  function repTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}); }
  function cap(s){ return s? s.charAt(0).toUpperCase()+s.slice(1) : s; }
  function dateLongNo(key){ var d=new Date(key+"T00:00:00"); return cap(WD_NO[d.getDay()])+" "+d.getDate()+". "+MON_NO[d.getMonth()]+" "+d.getFullYear(); }
  // service-parametrized compiler (snow shipped; a future Grønt-rapport reuses this)
  function compileServiceReports(service){
    var reports=[];
    customers().forEach(function(c){
      var es=(c.completionLog||[]).filter(function(e){return e.service===service;});
      if(!es.length) return;
      var byDate={};
      es.forEach(function(e){ var k=iso(new Date(e.ts)); (byDate[k]=byDate[k]||[]).push(e); }); // group by local calendar date
      Object.keys(byDate).forEach(function(k){
        var items=byDate[k].slice().sort(function(a,b){return a.ts<b.ts?-1:1;}); // chronological within the day
        reports.push({ id:c.id+"|"+service+"|"+k, customerId:c.id, service:service, date:k, entries:items });
      });
    });
    reports.sort(function(a,b){ return a.date<b.date?1:(a.date>b.date?-1:0); }); // newest day first
    return reports;
  }
  function snowReports(){ return compileServiceReports("snow"); } // TODO: weather-trigger (>5cm) — for now the day's logged snow activity defines the event
  function findReport(id){ return snowReports().filter(function(r){return r.id===id;})[0]; }
  function reportAck(id){ var st=S(); return (st.reportsSent||{})[id]||null; }
  function markReportSent(id){
    var st=S(); st.reportsSent=st.reportsSent||{}; st.reportsSent[id]=new Date().toISOString(); save(); render(); // PROD: email/push to board
    var host=document.getElementById("ob-snowrep"); if(host&&host.classList.contains("on")) showSnowReport(id); // refresh open panel bar + rebuild map (render() ran destroyOpMaps)
    toast("📤 Brøyterapport markert sendt til styret");
  }
  function snowSummaryLine(c, entries){
    var ms=entries.map(function(e){return new Date(e.ts).getTime();});
    var t0=repTime(Math.min.apply(null,ms)), t1=repTime(Math.max.apply(null,ms));
    var machine=false, hand=false, grit=false;
    entries.forEach(function(e){
      var z=e.zoneId?findZone(c,e.zoneId):null; var method=(z&&z.method)||"";
      var hay=((e.title||"")+" "+(e.note||"")+" "+method).toLowerCase();
      if(/maskin|brøyt|plog|machine|traktor/.test(hay)) machine=true;
      if(/hånd|hand|måk|manuell|skuff|inngang|trapp/.test(hay)) hand=true;
      if(/strø|grus|salt|sand|\bis\b|glatt|grit/.test(hay)) grit=true;
    });
    var verb=[];
    if(machine) verb.push("brøytet maskinelt");
    if(hand) verb.push("måkt for hånd ved innganger");
    if(!verb.length) verb.push("brøytet");
    var s=cap(verb.join(" og "))+(grit?", strødd":"")+". Utført "+t0+(t1!==t0?("–"+t1):"")+".";
    if((c.zones||[]).filter(function(z){return z.service==="snow";}).length) s+=" Se kart for soner.";
    return s;
  }
  function buildSnowReportMap(c, elId, coveredIds){
    if(!hasLeaflet||!c) return; var el=document.getElementById(elId); if(!el) return;
    if(opMaps[elId]){ try{opMaps[elId].remove();}catch(e){} delete opMaps[elId]; }
    var m=L.map(el,{zoomControl:true, attributionControl:true}); opMaps[elId]=m;
    L.tileLayer(KARTVERKET,{attribution:"© Kartverket", maxZoom:20}).addTo(m);
    if(c.center) L.marker([c.center.lat,c.center.lon],{interactive:false, keyboard:false, icon:bpinIcon()}).addTo(m);
    var anyAttr=coveredIds.length>0, grp=L.featureGroup().addTo(m);
    (c.zones||[]).filter(function(z){return z.service==="snow";}).forEach(function(z){
      var covered=coveredIds.indexOf(z.id)>=0;
      zoneToLayers(z,{permanentLabel:true}).forEach(function(l){
        if(anyAttr && l.setStyle){ l.setStyle(covered
          ? {color:"#15803d", fillColor:"#22c55e", fillOpacity:.40, weight:3}
          : {color:"#b91c1c", fillColor:"#ef4444", fillOpacity:.12, weight:2, dashArray:"5 4"}); }
        l.addTo(grp);
      });
    });
    try{ if(grp.getLayers().length) m.fitBounds(grp.getBounds().pad(0.35)); else if(c.center) m.setView([c.center.lat,c.center.lon], c.center.zoom||17); }
    catch(e){ if(c.center) m.setView([c.center.lat,c.center.lon], 17); }
    setTimeout(function(){ if(opMaps[elId]) opMaps[elId].invalidateSize(); }, 90);
  }
  function snowReportHTML(r){
    var c=cust(r.customerId); if(!c) return "";
    var covered=r.entries.map(function(e){return e.zoneId;}).filter(Boolean);
    var snowZones=(c.zones||[]).filter(function(z){return z.service==="snow";});
    var anyAttr=covered.length>0;
    var timeline=r.entries.map(function(e){
      var geo=e.geo?'<button class="ob-proofgeo" data-ob="proofGeoView" data-arg="'+e.geo.lat+','+e.geo.lon+','+(e.geo.acc||0)+'" title="vis posisjon">📍</button>':'';
      var z=e.zoneId?findZone(c,e.zoneId):null;
      return '<div class="ob-srtl"><div class="ob-srtime">'+repTime(e.ts)+'</div>'
        +'<div class="ob-srbody"><div class="ob-srwhat">'+esc(e.title||"Snørydding")+(z?' <span class="muted">· '+esc(z.label||z.service)+'</span>':'')+' '+geo+'</div>'
        +'<div class="ob-srwho">'+esc(e.by||"")+(e.note?' · '+esc(e.note):'')+'</div>'
        + proofThumbsHTML(e.photoIds) +'</div></div>';
    }).join("");
    var mapBlock = snowZones.length
      ? '<div class="ob-sropmap"><div class="ob-optitle">Operasjonskart – Vinter'
        +(anyAttr?' <span class="ob-srcovkey">· <span class="ob-sw" style="background:#22c55e"></span> dekket <span class="ob-sw" style="background:#ef4444"></span> ikke registrert</span>':'')+'</div>'
        +'<div class="ob-opmap" id="snowrep-map"></div>'
        +'<div class="ob-opcap">'+esc(snowCaption(c))+'</div>'+opLegend("snow")+'</div>'
      : '';
    var coverageNote = (snowZones.length && anyAttr) ? (function(){
        var miss=snowZones.filter(function(z){return z.priority!=null && covered.indexOf(z.id)<0;});
        return miss.length
          ? '<div class="ob-srmiss">⚠️ Ikke registrert utført: '+miss.map(function(z){return esc(z.label||z.service);}).join(", ")+'.</div>'
          : '<div class="ob-srok">✓ Alle prioriterte soner registrert utført.</div>';
      })() : '';
    return '<div class="ob-srdoc">'
      +'<div class="ob-srhead"><div><h1>Brøyterapport</h1><div class="ob-srsub">'+esc(c.name)+' · '+esc(c.addr||"")+'</div></div>'
      +'<div class="ob-srdate">'+dateLongNo(r.date)+'</div></div>'
      +'<p class="ob-srsummary">'+esc(snowSummaryLine(c, r.entries))+'</p>'
      +'<h2>Tidslinje</h2><div class="ob-srtimeline">'+timeline+'</div>'
      + mapBlock + coverageNote
      +'<p class="ob-srreassure">Brøyting utføres ved snøfall over 5 cm, i prioritert rekkefølge (lavest P-nummer først). Full dekning kan ta tid ved store snøfall.</p>'
      +'</div>';
  }
  function showSnowReport(id){
    var r=findReport(id); if(!r){ toast("Fant ikke rapporten"); return; }
    var host=document.getElementById("ob-snowrep"); if(!host) return;
    var ack=reportAck(r.id);
    host.innerHTML='<div class="ob-snowrep-bar"><button class="ob-btn ghost" data-ob="closeSnowReport">✕ Lukk</button>'
      +'<div class="ob-board-title">Brøyterapport · '+dateLongNo(r.date)+'</div>'
      +'<div class="ob-srbaracts">'
      +(ack?'<span class="chip green">Sendt '+repTime(ack)+'</span>':'<button class="ob-btn amber" data-ob="markReportSent" data-arg="'+r.id+'">📤 Marker sendt til styret</button>')
      +'<button class="ob-btn primary" data-ob="printSnowReport">🖨 Skriv ut / PDF</button></div></div>'
      +'<div class="ob-board-scroll">'+snowReportHTML(r)+'</div>';
    host.classList.add("on"); host.setAttribute("aria-hidden","false");
    buildSnowReportMap(cust(r.customerId), "snowrep-map", r.entries.map(function(e){return e.zoneId;}).filter(Boolean));
    hydratePhotos(host);
  }
  function closeSnowReport(){
    var host=document.getElementById("ob-snowrep"); if(!host) return;
    if(opMaps["snowrep-map"]){ try{opMaps["snowrep-map"].remove();}catch(e){} delete opMaps["snowrep-map"]; }
    host.classList.remove("on"); host.setAttribute("aria-hidden","true"); host.innerHTML="";
  }
  function printSnowReport(){
    if(opMaps["snowrep-map"]){ try{opMaps["snowrep-map"].invalidateSize();}catch(e){} }
    document.body.classList.add("ob-print-snowrep");
    var cleanup=function(){ document.body.classList.remove("ob-print-snowrep"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(function(){ window.print(); }, 200);
  }
  function snowReportsListHTML(){
    var reps=snowReports(); if(!reps.length) return "";
    var rows=reps.map(function(r){
      var c=cust(r.customerId), ack=reportAck(r.id);
      var badge= ack ? '<span class="chip green">Sendt</span>' : '<span class="chip amber ob-ny">● Ny</span>';
      var photos=r.entries.reduce(function(s,e){return s+((e.photoIds&&e.photoIds.length)||0);},0);
      return '<div class="ob-row" data-ob="openSnowReport" data-arg="'+r.id+'" style="cursor:pointer"><div class="ob-line-top">'
        +'<div class="rt">❄️ Brøyterapport · '+dateLongNo(r.date)+' '+badge+'</div><div class="rp">'+r.entries.length+' logg</div></div>'
        +'<div class="rd">'+esc(c?c.name:"")+' · '+r.entries.length+' oppgave'+(r.entries.length!==1?"r":"")+(photos?' · '+photos+' bilde'+(photos!==1?"r":""):"")+' · '+(ack?'sendt til styret':'klar – ikke sendt')+'</div></div>';
    }).join("");
    return '<div class="card ob-srcard"><div class="ct">❄️ Brøyterapporter <span class="chip grey">'+reps.length+'</span></div>'
      +'<p class="muted" style="font-size:12px;margin:-2px 0 10px">Sammenstilt automatisk fra loggen — sendes til styret <b>før klagen kommer</b>.</p>'
      + rows +'</div>';
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
    if(e.target && e.target.id==="ob-board"){ closeBoard(); return; } // backdrop click closes board doc
    if(e.target && e.target.id==="ob-snowrep"){ closeSnowReport(); return; } // backdrop closes Brøyterapport
    if(e.target && e.target.id==="ob-cockmap"){ closeCockMap(); return; } // backdrop closes in-cab map
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
      case "planDone": { var p=(arg||"").split("|"); openProofSheet({lineId:p[0], date:p[1], title:decodeURIComponent(p[2]||""), freq:decodeURIComponent(p[3]||""), building:decodeURIComponent(p[4]||"")}); break; }
      case "proofGeo": proofAddGeo(); break;
      case "proofGeoClear": proofClearGeo(); break;
      case "proofConfirm": proofConfirm(); break;
      case "proofCancel": proofCancel(); break;
      case "proofGeoView": proofGeoView(arg); break;
      case "eventDone": { var ep=(arg||"").split("|"); openProofSheet({lineId:ep[0], date:iso(refDate()), title:decodeURIComponent(ep[1]||""), freq:"beredskap", building:decodeURIComponent(ep[2]||"")}); break; }
      case "openSnowReport": showSnowReport(arg); break;
      case "closeSnowReport": closeSnowReport(); break;
      case "printSnowReport": printSnowReport(); break;
      case "markReportSent": markReportSent(arg); break;
      case "cockTeam": cockpitRosterSheet(arg); break;
      case "cockPick": { var cp=(arg||"").split("|"); setCockpit(cp[0], decodeURIComponent(cp[1]||"")); ui.cockMode="route"; obCloseSheet(); render(); var ctd=teamDef(cp[0]); toast("🚗 Cockpit: "+(ctd?ctd.label:cp[0])+" · "+decodeURIComponent(cp[1]||"")); break; }
      case "cockAddPerson": { var nm=val("cock_newname"); if(nm){ addToRoster(arg, nm); cockpitRosterSheet(arg); } break; }
      case "cockSwitch": cockpitSwitchSheet(); break;
      case "cockLogoff": clearCockpit(); ui.cockMode="route"; obCloseSheet(); render(); toast("Logget av cockpit"); break;
      case "cockMode": ui.cockMode=arg; render(); break;
      case "openCockMap": showCockMap(arg); break;
      case "closeCockMap": closeCockMap(); break;
      case "cockZoneDone": { var cz=(arg||"").split("|"); openZoneProof(cz[0], cz[1]); break; }
      case "equipLoad": { var veh=teamVehicle(cockpitTeam()); equipSetState(arg, "bil", veh?veh.id:null); render(); toast("📦 Lastet i bilen"); break; }
      case "equipDrop": { var ed=(arg||"").split("|"); equipSetState(ed[0], "lager", ed[1]); render(); var sN=storageById(ed[1]); toast("📦 Levert"+(sN?(" til "+sN.name):"")); break; }
      case "assetCard": { var ap=(arg||"").split("|"); assetCardSheet(ap[0], ap[1]); break; }
      case "assetAdd": { var ca=cust(arg); if(ca) openAssetSheet(ca, null); break; }
      case "assetEdit": { var ae=(arg||"").split("|"); var ce=cust(ae[0]); var aa=ce&&assetById(ce, ae[1]); if(ce&&aa) openAssetSheet(ce, aa); break; }
      case "assetSave": saveAssetFromSheet(); break;
      case "assetCancel": assetCancel(); break;
      case "assetDel": { var ad=(arg||"").split("|"); delAsset(ad[0], ad[1]); break; }
      case "assetPin": startAssetPin(); break;
      case "assetGeoView": assetGeoView(arg); break;
      case "assetFilter": { ui.assetFilter=arg; render(); break; }
      case "spawnEvt": spawnEvent(decodeURIComponent(arg||"")); break;
      case "back": ui.openId=null; ui.draftNew=false; repaintSales(); break;
      case "step": { var n=parseInt(id,10); if(c && n<=maxStep(c)){ ui.step=n; ui.activeLayer=null; repaintSales(); } break; }
      case "new": startNew(); break;
      case "newBuilding": startNewBuilding(); break;
      case "nbMode": { if(ui.newBuilding){ ui.newBuilding.mode=arg; ui.newBuilding.results=null; ui.newBuilding.error=null; nbRender(); } break; }
      case "nbSearch": nbSearch(); break;
      case "nbPick": nbPick(parseInt(arg,10)); break;
      case "nbGeocode": nbGeocode(); break;
      case "nbManual": nbManual(); break;
      case "nbCreate": nbCreate(); break;
      case "nbCancel": ui.newBuilding=null; repaintSales(); break;
      case "photoView": photoView(arg); break;
      case "photoDel": photoDelHandler(arg); break;
      case "photoCapSave": { photoSetCaption(arg, val("ph_cap")); obCloseSheet(); toast("Bildetekst lagret"); break; }
      case "lineGallery": galleryView(arg); break;
      case "mobilePane": { ui.mobilePane=arg; var g=document.getElementById("ob-walkgrid"); if(g){ g.classList.remove("pane-map","pane-list"); g.classList.add("pane-"+arg);
        [].forEach.call(document.querySelectorAll('[data-ob="mobilePane"]'),function(b){ b.classList.toggle("on", b.getAttribute("data-arg")===arg); });
        if(arg==="map"&&map){ setTimeout(function(){ try{map.invalidateSize();}catch(e){} },60); } } break; }
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
      case "closeObSheet": obCloseSheet(); pendingZone=null; if(pendingProof) proofCleanup(); if(pendingAsset) assetCleanup(); if(geoMini){ try{geoMini.remove();}catch(e){} geoMini=null; } break;
      case "printMap": printMapCard(arg); break;
      case "genOffer": if(c){ if(!c.offer) generateOffer(c); if(c.stage==="Prospect"||c.stage==="Surveyed") setStage(c,"Surveyed"); ui.step=2; repaintSales(); } break;
      case "sendOffer": if(c) sendOffer(c); break;
      case "openBoard": ui.boardOpen=(c?c.id:null); OnSite.go("board"); break;
      case "reviewNow": ui.boardOpen=(ui.boardOpen===id?null:id); OnSite.render(); break;
      case "printOffer": if(c) printOffer(c); break;
      case "boardDoc": if(c) showBoardDoc(c); break;
      case "printBoard": printBoard(); break;
      case "closeBoard": closeBoard(); break;
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
      case "clearCustomers": if(window.confirm("Clear all sales customers? (the day app is unaffected)")){ S().customers=[]; S().obSeeded=true; save(); photoGC(); ui.openId=null; repaintSales(); toast("Customers cleared — add a real one with ＋ New customer"); } break;
      case "reseed": { var rst=S(); rst.customers=(rst.customers||[]).filter(function(x){return x.id!=="holtet-cust"&&x.id!=="solbakken-cust";}); rst.customers.unshift(seedSolbakken()); rst.customers.unshift(seedHoltet()); rst.obSeeded=true; rst.storage=seedStorage(); rst.equipment=seedEquipment(); save(); photoGC(); ui.openId=null; repaintSales(); toast("Seed-klienter + utstyr tilbakestilt"); break; }
    }
  });

  // which customer is the board review acting on (board view uses ui.boardOpen; sales step3 uses ui.openId)
  function boardCustomer(){ return cur() || (ui.boardOpen?cust(ui.boardOpen):null) || customers().filter(function(c){return c.offer&&(c.stage==="Offer sent"||c.stage==="Changes requested");})[0] || null; }

  document.addEventListener("change", function(e){
    if(e.target && e.target.getAttribute && e.target.getAttribute("data-photocap")){ handlePhotoCapture(e.target); return; }
    handleField(e.target);
  });
  document.addEventListener("input", function(e){ var n=e.target.getAttribute && e.target.getAttribute("data-obf"); if(n==="bcomment"||n==="assetFind") handleField(e.target); });  // assetFind = live Bygg-info quick-find
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
    if(name==="proofBy"){ if(pendingProof){ pendingProof.by=val.trim()||currentUser(); setCurrentUser(pendingProof.by); } return; }
    if(name==="proofNote"){ if(pendingProof) pendingProof.note=val; return; }
    if(name==="proofZone"){ if(pendingProof) pendingProof.zoneId=val; return; }
    if(name==="assetFind"){ ui.assetQuery=ui.assetQuery||{}; ui.assetQuery[id]=val; var afc=cust(id); var ael=document.getElementById("ob-assetlist-"+id); if(afc&&ael) ael.innerHTML=assetListInnerHTML(afc); return; }
    if(name==="assetType"){ if(pendingAsset){ var prevType=pendingAsset.type; syncAssetFromDOM(); var d=assetTypeDef(pendingAsset.type);
        if(pendingAsset.area===assetTypeDef(prevType).area) pendingAsset.area=d.area;   // move area to new type's default only if untouched
        if(!pendingAsset.complianceLink && d.complianceHint){ var atc=assetCtx&&cust(assetCtx.custId); if(atc&&(atc.compliance||[]).some(function(r){return r.label===d.complianceHint;})) pendingAsset.complianceLink=d.complianceHint; }
        reopenAssetSheet(); hydratePhotos(document.getElementById("sheet")); } return; }
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
