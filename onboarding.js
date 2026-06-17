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

  /* ---------- the layer catalog (doc 33 table) ---------- */
  var LAYERS = {
    snow:      {emoji:"❄️", label:"Snow shoveling",      measure:"area",  unit:"m²",   rate:30,    service:"Winter clearing",                  freq:"Per event / seasonal",          feeds:"plan + winter tasks"},
    grass:     {emoji:"🌿", label:"Grass cutting",        measure:"area",  unit:"m²",   rate:12,    service:"Mowing (tractor / manual / edge)", freq:"Weekly in season",              feeds:"plan + equipment", method:"Tractor"},
    greenery:  {emoji:"🌳", label:"Greenery / beds",      measure:"count", unit:"bed",  rate:2500,  service:"Trimming & weeding",               freq:"Seasonal",                      feeds:"plan"},
    laundry:   {emoji:"🧺", label:"Laundry rooms",        measure:"count", unit:"room", rate:6000,  service:"Cleaning + machine checks",        freq:"Weekly",                        feeds:"tasks", upsellService:"machine service contract"},
    tech:      {emoji:"🔧", label:"Tech rooms",           measure:"count", unit:"room", rate:4000,  service:"Inspection rounds",                freq:"Monthly",                       feeds:"tasks + compliance", compliance:true},
    playground:{emoji:"🛝", label:"Playground",           measure:"count", unit:"unit", rate:9000,  service:"Annual inspection (NS-EN 1176)",   freq:"Annual",                        feeds:"compliance", compliance:true, statutory:true},
    fire:      {emoji:"🔥", label:"Fire / safety points", measure:"count", unit:"point",rate:3500,  service:"HMS round, extinguishers, detectors",freq:"Quarterly",                   feeds:"compliance pack", compliance:true, statutory:true},
    lift:      {emoji:"🛗", label:"Lift",                 measure:"count", unit:"lift", rate:12000, service:"2-yearly safety control",          freq:"Biennial (certified partner)",  feeds:"compliance", compliance:true, statutory:true},
    garage:    {emoji:"🅿️", label:"Garage / parking",     measure:"area",  unit:"m²",   rate:8,     service:"Sweeping, door checks",            freq:"Monthly",                       feeds:"tasks"},
    entrance:  {emoji:"🚪", label:"Entrances / access",   measure:"count", unit:"door", rate:0,     service:"Access notes, keys / codes",       freq:"—",                             feeds:"building record", recordOnly:true},
    /* interior layers unlocked in enrichment (Step 5) */
    panel:     {emoji:"🔌", label:"Electric panel",       measure:"count", unit:"panel",rate:0,     service:"Location + inspection note",        freq:"—",                            feeds:"building record", recordOnly:true, enrich:true},
    valve:     {emoji:"🚰", label:"Valve / shut-off",     measure:"count", unit:"valve",rate:0,     service:"Location note",                     freq:"—",                            feeds:"building record", recordOnly:true, enrich:true}
  };
  var SALES_LAYERS = ["snow","grass","greenery","laundry","tech","playground","fire","lift","garage","entrance"];
  var ENRICH_LAYERS = SALES_LAYERS.concat(["panel","valve"]);

  var PROFILES = ["Residential — association","Residential — rental","Commercial — office","Commercial — retail","Commercial — warehouse/logistics","Mixed-use"];
  var SCOPE_OPTS = [
    {key:"grass",    label:"🌿 Grass cutting"},
    {key:"snow",     label:"❄️ Winter clearing"},
    {key:"laundry",  label:"🧺 Common-area cleaning"},
    {key:"greenery", label:"🌳 Greenery & beds"},
    {key:"garage",   label:"🅿️ Garage / parking"}
  ];
  var STAGES = ["Prospect","Surveyed","Offer sent","Changes requested","Agreed","Live"];
  var STEP_NAMES = ["Office prep","Walkaround","Offer","Board review","Updated offer","Go-live"];

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
  var ui = { openId:null, step:0, activeLayer:null, draftNew:false };

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
        mk("sm1","grass",     0.00045,-0.00060, 1800, "Main lawn — tractor cut"),
        mk("sm2","snow",     -0.00030, 0.00075,  650, "Front path + parking apron"),
        mk("sm3","laundry",   0.00012, 0.00022,    1, "Block A basement"),
        mk("sm4","laundry",  -0.00022,-0.00030,    1, "Block B basement"),
        mk("sm5","playground",0.00052, 0.00040,    1, "Behind block B — present, not quoted"),
        mk("sm6","lift",     -0.00040, 0.00020,    1, "Block A — 1998, due 2-yearly control"),
        mk("sm7","fire",      0.00020,-0.00042,    1, "Main entrance: extinguisher + detectors")
      ],
      offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
      log:[{ts:"14 Jun 2026", text:"Surveyed on site — 7 zones marked, 3 upsell flags"},
           {ts:"12 Jun 2026", text:"Prospect created from board enquiry (grass + winter + cleaning)"}]
    };
  }
  function seedIfNeeded(){
    var st=S(); if(!st) return;
    if(!st.customers) st.customers=[];
    if(!st.obSeeded){
      if(!cust("solbakken-cust")) st.customers.push(seedSolbakken());
      st.obSeeded=true; save();
    }
  }

  /* ===========================================================================
     MAP (Leaflet)
     =========================================================================== */
  var map=null, markerLayer=null, buildingMarker=null, leafMarkers={};

  function destroyMap(){
    if(map){ try{ map.remove(); }catch(e){} map=null; markerLayer=null; buildingMarker=null; leafMarkers={}; }
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
    map.on("click", onMapClick);
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
      +(d.recordOnly?'':'<div style="margin-top:8px;font-weight:750">'+kr(m.price)+' /yr</div>')
      +'<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">'
        +'<button class="ob-mini'+(m.photo?' on':'')+'" data-ob="photo" data-id="'+m.id+'">📷 '+(m.photo?'photo ✓':'add photo')+'</button>'
        +'<button class="ob-mini no on" data-ob="delMarker" data-id="'+m.id+'">🗑 delete</button>'
      +'</div></div>';
  }
  function onMapClick(e){
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
  function generateOffer(c){
    var lines=(c.markers||[]).filter(function(m){ return !LAYERS[m.layer].recordOnly; }).map(function(m){
      var d=LAYERS[m.layer];
      return { id:"L"+uid(), markerId:m.id, layer:m.layer,
        scope:m.service||d.service, frequency:m.frequency||d.freq,
        qty:m.qty, unit:m.unit||d.unit, price:m.price, recurring:true, inScope:m.inScope,
        review:{decision:null, comment:""} };
    });
    c.offer={ version:1, createdAt:nowStr(), coverNote:"Annual service plan for "+c.name+", priced per zone from our on-site survey. Statutory inspections included where present.", travel:0, lines:lines };
    if(!c.offerHistory) c.offerHistory=[];
    logEvent(c,"Offer v1 generated from "+lines.length+" zones ("+kr(offerTotal(c.offer))+"/yr)");
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
      snow:["snow","brøyt","snø","winter","vinter"], grass:["grass","lawn","gress","plen","mow","mowing"],
      laundry:["laundry","vaskeri","cleaning","renhold","clean"], fire:["fire","brann","extinguisher","slukker","detector"],
      tech:["tech","teknisk"], garage:["garage","garasje","parking"], greenery:["hedge","hekk","bed","greenery","planting","shrub"] };
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
      var o=oldById[l.id];
      if(!o){ out.push({type:"add", text:"Added — "+LAYERS[l.layer].emoji+" "+l.scope+" ("+kr(l.price)+"/yr)"}); return; }
      var ch=[];
      if((o.price||0)!==(l.price||0)) ch.push("price "+kr(o.price)+" → "+kr(l.price));
      if((o.qty||0)!==(l.qty||0)) ch.push("qty "+o.qty+" → "+l.qty);
      if((o.scope||"")!==(l.scope||"")) ch.push("scope “"+o.scope+"” → “"+l.scope+"”");
      if((o.frequency||"")!==(l.frequency||"")) ch.push("freq “"+o.frequency+"” → “"+l.frequency+"”");
      if(ch.length) out.push({type:"ch", text:LAYERS[l.layer].emoji+" "+l.scope+": "+ch.join(", ")});
    });
    oldLines.forEach(function(o){ if(!newById[o.id]) out.push({type:"rm", text:"Removed — "+LAYERS[o.layer].emoji+" "+o.scope+" ("+kr(o.price)+"/yr)"}); });
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
    logEvent(c,"Offer v"+c.offer.version+" issued + re-sent ("+diff.length+" change(s), now "+kr(offerTotal(c.offer))+"/yr)");
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
    active.forEach(function(l){
      var d=LAYERS[l.layer];
      st.items.push({ id:uid(), kind:"plan", bld:b.id,
        title:d.emoji+" "+l.scope, detail:l.frequency+" · "+kr(l.price)+"/yr"+(l.inScope?"":" · added as upsell")+" — from agreed offer",
        status:"approved", billable:true, cost:l.price, hours:0, time:"—", who:"System", proof:null });
      nPlan++;
      if(d.compliance){
        st.items.push({ id:uid(), kind:"task", bld:b.id,
          title:"📋 "+l.scope, detail:"Statutory routine"+(d.statutory?" (NS / certified partner)":"")+" — schedule first inspection.",
          status:"todo", billable:true, hours:0.5, time:"—", who:"System", proof:null });
        nComp++;
      } else if(opCount<2){
        st.items.push({ id:uid(), kind:"task", bld:b.id,
          title:"▶ First "+l.scope.toLowerCase(), detail:"Day-1 occurrence from the service plan ("+l.frequency+").",
          status:"todo", billable:true, hours:1, time:"09:00", who:"Martin", proof:null });
        nTask++; opCount++;
      }
    });
    // 4. handover pack
    c.handover={ createdAt:nowStr(), building:b.name, addr:c.addr, access:c.accessNote||"",
      contacts:c.contacts.slice(), planValue:offerTotal(c.offer),
      zones:active.length, systems:active.filter(function(l){return LAYERS[l.layer].compliance;}).length,
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
  function renderExtras(view, cols){
    seedIfNeeded();
    destroyMap();
    if(view==="sales"){ renderSales(cols); }
    else if(view==="board"){ renderBoardExtras(cols); }
    else if(view==="office"){ renderOfficeExtras(cols); }
  }

  function renderSales(cols){
    cols.className="cols";
    var c=cur();
    if(!c){ cols.innerHTML=pipelineHTML(); return; }
    cols.innerHTML=wizardHTML(c);
    if(ui.step===1 || (ui.step===5 && c.stage==="Live")) buildMap(c);
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
          +(c.offer?'<span class="chip blue">'+kr(offerTotal(c.offer))+'/yr</span>':'')
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
    return '<button class="ob-layer'+(on?" on":"")+(active?" active":"")+'" '+(selectable?'data-ob="pick" data-id="'+key+'"':'')+'>'
      +d.emoji+' '+d.label+' <span class="c">'+n+'</span></button>';
  }
  function stepWalk(c){
    var hasZones=(c.markers||[]).some(function(m){return !LAYERS[m.layer].recordOnly;});
    return '<div class="ob-grid split">'
      +'<div>'
        +'<div class="ob-hint">Pick a layer, then <b>tap the map</b> to drop a marker. Counts tally per layer. Anything outside the requested scope auto-flags as an <b>upsell</b>.</div>'
        +'<div class="ob-layers" id="ob-layers">'+SALES_LAYERS.map(function(k){return layerChip(c,k,true);}).join("")+'</div>'
        +'<div class="ob-maptools"><span class="ob-active-note" id="ob-active">'+activeNote()+'</span><span class="spacer" style="flex:1"></span>'
          +'<button class="ob-btn ghost" data-ob="locateWalk">📍 Locate address</button>'
          +'<button class="ob-btn ghost" data-ob="geotag">📍 Use my location</button></div>'
        +'<div id="ob-map"></div>'
      +'</div>'
      +'<div>'
        +'<div class="card"><div class="ct">Zones captured</div><div id="ob-zones">'+zonesHTML(c)+'</div></div>'
        +'<div id="ob-upsell">'+upsellHTML(c)+'</div>'
        +'<div class="card"><div class="ct">Recurring value so far</div><div class="ob-tot grand"><span>Per year</span><span class="v" id="ob-walktotal">'+kr(walkTotal(c))+'</span></div></div>'
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="genOffer" '+(hasZones?'':'disabled')+'>Generate offer →</button></div>'
      +'</div></div>';
  }
  function activeNote(){ return ui.activeLayer ? ('Active layer: '+LAYERS[ui.activeLayer].emoji+' '+LAYERS[ui.activeLayer].label+' — tap the map') : 'No layer selected — pick one above'; }
  function walkTotal(c){ return (c.markers||[]).reduce(function(s,m){return s+(m.price||0);},0); }
  function zonesHTML(c){
    var groups=SALES_LAYERS.concat(["panel","valve"]).filter(function(k){return (c.markers||[]).some(function(m){return m.layer===k;});});
    if(!groups.length) return '<div class="empty">No zones yet — tap the map to mark what you see.</div>';
    return groups.map(function(k){
      var d=LAYERS[k];
      var ms=(c.markers||[]).filter(function(m){return m.layer===k;});
      var rows=ms.map(function(m){
        return '<div class="ob-row'+(isUpsell(c,m)?' up':'')+'"><div class="ob-line-top"><div class="rt">'+d.emoji+' '+esc(m.service)
          +(isUpsell(c,m)?' <span class="chip amber">upsell</span>':'')+(m.source==="caretaker"?' <span class="chip blue">interior</span>':'')
          +(m.photo?' <span class="chip grey">📷</span>':'')+'</div>'
          +(d.recordOnly?'':'<div class="rp">'+kr(m.price)+'</div>')+'</div>'
          +'<div class="rd">'+esc(m.frequency)+' · '+(d.measure==="area"?(m.qty+" m²"):(m.qty+" "+d.unit))+(m.note?' · '+esc(m.note):'')+(m.accuracy?' · 📍±'+m.accuracy+'m':'')+'</div></div>';
      }).join("");
      return '<div style="margin-bottom:10px"><div style="font-weight:700;font-size:12.5px;color:var(--muted);margin-bottom:5px">'+d.emoji+' '+d.label+' · '+tallyStr(c,k)+'</div>'+rows+'</div>';
    }).join("");
  }
  function upsellHTML(c){
    var ups=(c.markers||[]).filter(function(m){return isUpsell(c,m);});
    if(!ups.length) return "";
    return '<div class="ob-callout"><b>⚠️ '+ups.length+' upsell opportunit'+(ups.length>1?'ies':'y')+'</b> — present but outside requested scope: '
      +ups.map(function(m){return LAYERS[m.layer].emoji+" "+LAYERS[m.layer].label;}).join(", ")+'. Nothing seen is lost.</div>';
  }
  function refreshWalk(c){
    setHTML("ob-layers", SALES_LAYERS.map(function(k){return layerChip(c,k,true);}).join(""));
    setHTML("ob-zones", zonesHTML(c));
    setHTML("ob-upsell", upsellHTML(c));
    setText("ob-walktotal", kr(walkTotal(c)));
    setText("ob-active", activeNote());
    var gen=document.querySelector('[data-ob="genOffer"]'); if(gen){ if((c.markers||[]).some(function(m){return !LAYERS[m.layer].recordOnly;})) gen.removeAttribute("disabled"); }
  }

  /* ---- Step 2: offer ---- */
  function stepOffer(c){
    if(!c.offer){
      return '<div class="card"><div class="ct">Step 2 — offer</div>'
        +'<p class="muted" style="font-size:13.5px">The offer is derived 1:1 from the zones you marked. Generate it to review the line items.</p>'
        +'<div class="ob-bar"><button class="ob-btn primary" data-ob="genOffer">Generate offer from walkaround →</button></div></div>';
    }
    var sent = STAGES.indexOf(c.stage) >= STAGES.indexOf("Offer sent");
    return '<div class="ob-grid split">'
      +'<div class="card"><div class="ct">Live offer — '+esc(c.name)+' <span class="ob-ver">v'+c.offer.version+'</span></div>'
        +offerLinesHTML(c,false)
        +'<div class="ob-tot"><span>Travel / callout</span><span class="v">'+kr(c.offer.travel||0)+'</span></div>'
        +'<div class="ob-tot grand"><span>Total recurring / year</span><span class="v">'+kr(offerTotal(c.offer))+'</span></div>'
        +(upsellTotal(c.offer)?'<div class="ob-tot"><span class="muted">…of which upsell (newly surfaced)</span><span class="v" style="color:var(--amber)">'+kr(upsellTotal(c.offer))+'</span></div>':'')
      +'</div>'
      +'<div>'
        +'<div class="card"><div class="ct">Cover note</div><textarea data-obf="cover" rows="4">'+esc(c.offer.coverNote||"")+'</textarea></div>'
        +'<div class="card"><div class="ct">Two surfaces, one offer</div>'
          +'<p class="muted" style="font-size:12.5px;margin:0 0 10px">The board gets a formal PDF <i>and</i> the live in-app offer they act on.</p>'
          +'<div class="ob-bar"><button class="ob-btn ghost" data-ob="printOffer">🖨 Print / Save as PDF</button></div></div>'
        +(sent
          ? '<div class="ob-ok">✅ Offer sent — board access granted. They review it in the <b>Board</b> view.</div>'
            +boardEmailCard(c)
            +'<div class="ob-bar"><button class="ob-btn amber" data-ob="openBoard">Open the board\'s view →</button></div>'
          : '<div class="ob-bar"><button class="ob-btn primary" data-ob="sendOffer">Send offer &amp; grant board access →</button></div>')
      +'</div></div>';
  }
  function offerLinesHTML(c, editable){
    return c.offer.lines.map(function(l){
      var d=LAYERS[l.layer];
      var removed=l.review.decision==="remove";
      return '<div class="ob-row'+(!l.inScope?' up':'')+'" style="'+(removed?'opacity:.5':'')+'"><div class="ob-line-top">'
        +'<div class="rt">'+d.emoji+' '+esc(l.scope)+(!l.inScope?' <span class="chip amber">upsell</span>':'')+'</div>'
        +'<div class="rp">'+kr(l.price)+'/yr</div></div>'
        +'<div class="rd">'+esc(l.frequency)+' · '+(d.measure==="area"?(l.qty+" m²"):(l.qty+" "+d.unit))+'</div></div>';
    }).join("");
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
      var d=LAYERS[l.layer]; var dec=l.review.decision;
      function b(act,label,cls){ return '<button class="ob-mini '+cls+(dec===act?' on':'')+'" data-ob="dec" data-id="'+l.id+'" data-arg="'+act+'">'+label+'</button>'; }
      return '<div class="ob-row'+(!l.inScope?' up':'')+'">'
        +'<div class="ob-line-top"><div class="rt">'+d.emoji+' '+esc(l.scope)+(!l.inScope?' <span class="chip amber">new / upsell</span>':'')+'</div><div class="rp">'+kr(l.price)+'/yr</div></div>'
        +'<div class="rd">'+esc(l.frequency)+'</div>'
        +'<div class="ob-acts">'+b("approve","✓ Approve","ok")+b("question","? Question","")+b("change","✎ Change","warn")+b("remove","✕ Remove","no")+'</div>'
        +'<textarea class="ob-cmt'+(dec&&dec!=="approve"?' show':'')+'" data-obf="bcomment" data-id="'+l.id+'" placeholder="Add a comment for the office…">'+esc(l.review.comment||"")+'</textarea>'
      +'</div>';
    }).join("");
    return '<div class="ob-grid split"><div class="card"><div class="ct">Your offer — line by line <span class="ob-ver">v'+c.offer.version+'</span></div>'
      +lines
      +'<div class="ob-tot grand"><span>Total / year</span><span class="v">'+kr(offerTotal(c.offer))+'</span></div>'
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
      var d=l?LAYERS[l.layer]:null;
      var head=(d?d.emoji+" "+esc(l.scope):"General")+' <span class="chip '+(r.type==="remove"?"red":r.type==="question"?"blue":"amber")+'">'+r.type+'</span>'
        +' <span class="chip grey">'+r.source+'</span>'+(r.status!=="open"?' <span class="chip '+(r.status==="declined"?"red":"green")+'">'+r.status+'</span>':'');
      var edit = (l && r.status==="open") ? '<div class="row2" style="display:flex;gap:8px;margin-top:8px">'
          +'<div style="flex:2"><label>Scope</label><input data-obf="linescope" data-id="'+l.id+'" value="'+esc(l.scope)+'"></div>'
          +'<div style="flex:1"><label>Price/yr</label><input type="number" data-obf="lineprice" data-id="'+l.id+'" value="'+l.price+'"></div></div>'
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
      return '<div class="ob-row"><div class="ob-line-top"><div class="rt"><span class="ob-ver">v'+h.version+'</span> '+h.at+'</div><div class="rp">'+kr(h.total)+'/yr</div></div>'+diff+'</div>';
    }).join("")+'</div>';
  }

  /* ---- Step 5: go-live + enrichment ---- */
  function stepGoLive(c){
    if(c.stage==="Agreed"){
      var active=c.offer.lines.filter(function(l){return l.review.decision!=="remove";});
      var comp=active.filter(function(l){return LAYERS[l.layer].compliance;}).length;
      return '<div class="ob-grid split">'
        +'<div class="card"><div class="ct">Ready to go live</div>'
          +'<p class="muted" style="font-size:13.5px">On go-live, everything derives from the agreed offer — zero re-entry:</p>'
          +'<div class="ob-row"><div class="rt">🔁 '+active.length+' recurring zones → service plans + tasks</div></div>'
          +'<div class="ob-row"><div class="rt">📋 '+comp+' systems → statutory compliance routines</div></div>'
          +'<div class="ob-row"><div class="rt">🏢 Building record created · 🔑 day-1 tasks scheduled · 📦 handover pack</div></div>'
          +'<div class="ob-tot grand"><span>Plan value locked</span><span class="v">'+kr(offerTotal(c.offer))+'/yr</span></div>'
          +'<div class="ob-bar"><button class="ob-btn green" data-ob="goLive">🚀 Go live — convert &amp; populate the day app</button></div></div>'
        +'<div>'+historyHTML(c)+logCard(c)+'</div></div>';
    }
    // Live → enrichment mode
    var h=c.handover||{};
    return '<div class="ob-ok">🚀 <b>'+esc(c.name)+' is live.</b> '+ (h.plans||0) +' service plans and day-1 tasks are now in the Field &amp; Office day app — switch the view above to see them.</div>'
      +'<div class="ob-grid split">'
      +'<div>'
        +'<div class="ob-callout" style="border-color:var(--blue);background:var(--blue-l);color:var(--blue)"><b>🧭 Learn the building (enrichment).</b> The sales walk caught the outside &amp; obvious. Now add interior items room by room — tech/laundry rooms, 🔌 panels, 🚰 valves/shut-offs — and correct counts. The record keeps thickening.</div>'
        +'<div class="ob-layers" id="ob-layers">'+ENRICH_LAYERS.map(function(k){return layerChip(c,k,true);}).join("")+'</div>'
        +'<div class="ob-maptools"><span class="ob-active-note" id="ob-active">'+activeNote()+'</span><span style="flex:1"></span>'
          +'<button class="ob-btn ghost" data-ob="geotag">📍 Use my location</button></div>'
        +'<div id="ob-map"></div>'
      +'</div>'
      +'<div>'
        +'<div class="card"><div class="ct">Handover pack</div>'
          +'<div class="ob-tot"><span>Building</span><span class="v" style="font-size:14px">'+esc(h.building||c.name)+'</span></div>'
          +'<div class="ob-tot"><span>Access</span><span class="v" style="font-size:13px">'+esc(h.access||"—")+'</span></div>'
          +'<div class="ob-tot"><span>Service plans</span><span class="v">'+(h.plans||0)+'</span></div>'
          +'<div class="ob-tot"><span>Day-1 tasks</span><span class="v">'+((h.tasks||0)+(h.compliance||0))+'</span></div>'
          +'<div class="ob-tot grand"><span>Plan value</span><span class="v">'+kr(h.planValue||offerTotal(c.offer))+'/yr</span></div>'
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
        +'<div class="rp">'+(c.offer?kr(offerTotal(c.offer))+'/yr':'—')+'</div></div>'
        +'<div class="rd">'+(c.markers?c.markers.length:0)+' zones'+(up?' · '+up+' upsell':'')+(c.buildingId?' · live building':'')+'</div></div>';
    }).join(""):'<div class="empty">No customers in the pipeline yet.</div>';
    host.innerHTML='<div class="card"><div class="ct">Sales pipeline — new customers</div>'+rows
      +'<button class="ob-newbtn" data-ob="new">＋ Set up a new client (sales → onboarding)</button></div>';
    cols.insertBefore(host, cols.firstChild);
  }

  /* ===========================================================================
     PRINT (formal offer / handover — browser Save-as-PDF)
     =========================================================================== */
  function printOffer(c){
    if(!c.offer){ toast("Generate the offer first"); return; }
    var lines=c.offer.lines.filter(function(l){return l.review.decision!=="remove";}).map(function(l){
      var d=LAYERS[l.layer];
      return '<div class="docrow"><div><div class="sc">'+d.emoji+' '+esc(l.scope)+(!l.inScope?' <span class="upsell-tag">NEW</span>':'')+'</div>'
        +'<div class="fr">'+esc(l.frequency)+' · '+(d.measure==="area"?(l.qty+" m²"):(l.qty+" "+d.unit))+'</div></div>'
        +'<div class="pr">'+kr(l.price)+'/yr</div></div>';
    }).join("");
    var ct=c.contacts[0]||{};
    var html='<div class="ob-doc">'
      +'<h1>Service offer — '+esc(c.name)+'</h1>'
      +'<div class="docsub">'+esc(c.addr||"")+' · Offer v'+c.offer.version+' · '+c.offer.createdAt+' · OnSite</div>'
      +'<div class="docsub">To: '+esc(ct.name||"The board")+(ct.email?' &lt;'+esc(ct.email)+'&gt;':'')+'</div>'
      +lines
      +'<div class="docrow"><div class="sc">Travel / callout</div><div class="pr">'+kr(c.offer.travel||0)+'</div></div>'
      +'<div class="doctot"><span>Total recurring / year</span><span>'+kr(offerTotal(c.offer))+'</span></div>'
      +'<div class="note">'+esc(c.offer.coverNote||"")+'</div>'
      +'<div class="sig"><div>_______________________<br>For '+esc(c.name)+'</div><div>_______________________<br>OnSite</div></div>'
      +'</div>';
    var pa=document.getElementById("ob-print"); if(!pa) return;
    pa.innerHTML=html;
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
      case "open": ui.openId=id; var co=cust(id); ui.step=co?defaultStep(co):0; ui.draftNew=false; ui.activeLayer=null; OnSite.go("sales"); break;
      case "back": ui.openId=null; ui.draftNew=false; repaintSales(); break;
      case "step": { var n=parseInt(id,10); if(c && n<=maxStep(c)){ ui.step=n; ui.activeLayer=null; repaintSales(); } break; }
      case "new": startNew(); break;
      case "prefill": prefillForm(); break;
      case "savePrep": savePrep(); break;
      case "locatePrep": { var a=val("p_addr"); var cc=cur(); if(cc){ cc.addr=a; locate(cc,a);} break; }
      case "locateWalk": if(c) locate(c, c.addr); break;
      case "geotag": if(c) geotag(c); break;
      case "pick": if(c){ pickLayer(c,id); } break;
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
      case "reseed": { if(!cust("solbakken-cust")) S().customers.push(seedSolbakken()); else { S().customers=S().customers.filter(function(x){return x.id!=="solbakken-cust";}); S().customers.push(seedSolbakken()); } S().obSeeded=true; save(); ui.openId=null; repaintSales(); toast("Demo client reset"); break; }
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
    if(!c) return;
    if(name==="cover"){ if(c.offer){ c.offer.coverNote=val; save(); } return; }
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
    if(box){ [].forEach.call(box.querySelectorAll(".ob-layer"), function(b){ b.classList.remove("active"); });
      // re-render chips to reflect "on" set + active
      var layers = (c.stage==="Live") ? ENRICH_LAYERS : SALES_LAYERS;
      box.innerHTML = layers.map(function(k){return layerChip(c,k,true);}).join("");
    }
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
      accessNote:"", markers:[], offer:null, offerHistory:[], changeRequests:[], buildingId:null, handover:null, enrichment:false,
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
