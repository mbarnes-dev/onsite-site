/* @onsite/core — portable domain engines, extracted from the validated prototype (doc-55 step 1).
 *
 * PURITY CONTRACT: every export is a pure function of its inputs — NO DOM, NO localStorage/
 * IndexedDB, NO global reads. Where the prototype reached for a global (refDate/ui.refMs,
 * customers(), nowStr(), save()), the boundary is lifted here into an explicit parameter so
 * the APP passes data in and renders the result out. Same logic, relocated — the anchors
 * (Holtet kr 16 530, scope classification on docs 37–44, radar, intake) prove no drift.
 *
 * This single ESM file IS the browser bundle (no bundler needed): the build copies it to
 * repo-root core.bundle.js, loaded via <script type="module"> which assigns window.OnSiteCore.
 * Node tests import it directly. // PROD: author in TS + tsup/vitest once a build step is OK.
 */

/* ============================================================ shared formatters (pure) */
export function kr(n) { return "kr " + (Math.round(n) || 0).toLocaleString("no"); }
export function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
export function iso(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
export function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
export function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
export function ymd(y, m, day) { return new Date(y, m - 1, day); }
function inRange(d, from, to) { return d.getTime() >= from.getTime() && d.getTime() <= to.getTime(); }
var MON_NO = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];
export function dateLabel(d) { return d.getDate() + ". " + MON_NO[d.getMonth()]; }
export function tsLabel(ts) { try { return dateLabel(new Date(ts)); } catch (e) { return ""; } }
function findZone(c, id) { return (c.zones || []).filter(function (z) { return z.id === id; })[0]; }

/* ============================================================ geodesic (no deps) */
export function geoArea(pts) {
  if (pts.length < 3) return 0;
  var R = 6378137, lat0 = 0; pts.forEach(function (p) { lat0 += p[0]; }); lat0 = (lat0 / pts.length) * Math.PI / 180;
  var xy = pts.map(function (p) { return [R * (p[1] * Math.PI / 180) * Math.cos(lat0), R * (p[0] * Math.PI / 180)]; });
  var a = 0; for (var i = 0; i < xy.length; i++) { var j = (i + 1) % xy.length; a += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; } return Math.abs(a) / 2;
}
function hav(a, b) {
  var R = 6378137, dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180, la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2); return 2 * R * Math.asin(Math.sqrt(h));
}
export function geoLength(pts) { var d = 0; for (var i = 1; i < pts.length; i++) d += hav(pts[i - 1], pts[i]); return d; }

/* ============================================================ pricing engine (RATES + computeOffer)
 * RATES = the editable "blue cells"; reverse-engineered so Holtet's drivers ≈ kr 16 530/mnd (doc 37 anchor). */
export var RATES = {
  snow: { machine_m2_mnd: 0.48, hand_per_entry_mnd: 86 },
  grass: { mow_m2_mnd: 0.42, edge_m_mnd: 6 },
  greenery: { hedge_m_year: 200, gartner_bed_m2_year: 90 },
  cleaning: { per_oppgang_floor_week: 60, per_heis_week: 35 },
  base: { vaktmester_round_mnd: 4200 }
};
var WPM = 52 / 12;
export var MOD_TITLES = { base: "Drift / vaktmester", cleaning: "Renhold", snow: "Vintertjeneste", grass: "Grønt – klipp", greenery: "Grønt – skjøtsel", other: "Annet" };
export var MOD_ORDER = ["base", "cleaning", "snow", "grass", "greenery", "other"];
export function layerToService(layer) {
  return ({ grass: "grass", snow: "snow", gritting: "snow", laundry: "cleaning", stairwell: "cleaning", facade: "cleaning",
    greenery: "greenery", beds: "greenery", tech: "base", fire: "base", lift: "base", entrance: "base", playground: "base", panel: "base", valve: "base" })[layer] || "other";
}
function ckVal(c, id) { var it = (c.checklist || []).filter(function (x) { return x.id === id; })[0]; return it ? it.value : null; }
function keptVal(c, id, fb) { var it = (c.checklist || []).filter(function (x) { return x.id === id; })[0]; return (it && it.price) ? it.price : fb; }
function driverCounts(c) {
  var entry = (c.markers || []).filter(function (m) { return m.layer === "entrance"; }).length;
  return { oppganger: parseInt(ckVal(c, "oppganger"), 10) || entry || 4, heiser: parseInt(ckVal(c, "heiser"), 10) || 0,
    entryways: entry || parseInt(ckVal(c, "oppganger"), 10) || 4, floors: c.floors || 4 };
}
function zoneAgg(c) {
  var z = c.zones || [];
  function sa(f) { return z.filter(f).reduce(function (s, x) { return s + (x.area_m2 || 0); }, 0); }
  function sl(f) { return z.filter(f).reduce(function (s, x) { return s + (x.length_m || 0); }, 0); }
  return { snowMachine: sa(function (x) { return x.service === "snow" && x.method === "machine"; }),
    mow: sa(function (x) { return x.service === "grass" && (x.method === "mow" || !x.method); }),
    edge: sl(function (x) { return x.service === "grass" && x.method === "edge"; }),
    hedgeZones: z.filter(function (x) { return x.service === "greenery" && x.geometry.type === "LineString"; }),
    bedZones: z.filter(function (x) { return x.service === "greenery" && x.geometry.type === "Polygon"; }),
    firstId: function (svc, meth) { var m = z.filter(function (x) { return x.service === svc && (!meth || x.method === meth); })[0]; return m ? m.id : null; } };
}
export function oLine(o) {
  return { id: o.id, src: o.src || "computed", service: o.service, role: o.role || "", label: o.label, subtype: o.label,
    category: o.category || MOD_TITLES[o.service] || "", emoji: o.emoji || "•", layer: o.layer || null, zoneId: o.zoneId || null,
    qty: (o.qty == null ? null : o.qty), unit: o.unit || "", rate: (o.rate == null ? null : o.rate), cadence: o.cadence || "",
    computed: Math.round(o.computed || 0), final: Math.round((o.final != null ? o.final : o.computed) || 0), overridden: !!o.overridden,
    price: Math.round((o.final != null ? o.final : o.computed) || 0),
    frequency: o.frequency || o.cadence || "", inScope: (o.inScope !== false), deliveredBy: o.deliveredBy || "in-house", partnerName: o.partnerName || null,
    compliance: !!o.compliance, oneOff: !!o.oneOff, measure: o.measure || "count", review: { decision: null, comment: "" } };
}
export function lineRemoved(l) { return !!(l && l.review && l.review.decision === "remove"); }
/** Build + assign c.offer from measured zones + counts. opts.nowStr/LAYERS/catLabel lift the
 *  prototype's global reads (nowStr() for createdAt; LAYERS/catLabel for the marker-model path). */
export function computeOffer(c, opts) {
  opts = opts || {};
  // nowStr may be a value OR a function (called fresh per compute) — the app passes the function so
  // each offer's createdAt reflects its compute moment, not a frozen first-render timestamp.
  var nowStr = (typeof opts.nowStr === "function" ? opts.nowStr() : opts.nowStr) || (function () { try { return new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); } catch (e) { return "today"; } })();
  var LAYERS = opts.LAYERS || {}, catLabel = opts.catLabel || function (k) { return k; };
  var prev = c.offer, per = c.period || "år";
  var prevLine = {}, prevMod = {};
  if (prev && prev.modules) { prev.modules.forEach(function (m) { prevMod[m.service] = { included: m.included, startDate: m.startDate, indexationPct: m.indexationPct, cap: m.cap };
    m.lines.forEach(function (l) { prevLine[l.id] = { final: l.final, overridden: l.overridden }; }); }); }
  function withPrev(l) { var p = prevLine[l.id]; if (p && p.overridden) { l.final = p.final; l.price = p.final; l.overridden = true; } return l; }
  var lines = [], optionLines = [];

  if (c.checklist && c.checklist.length) {
    var n = driverCounts(c), z = zoneAgg(c), id = c.id + ":";
    lines.push(withPrev(oLine({ id: id + "base:round", service: "base", role: "round", label: "Ukentlig vaktmesterrunde + tilsyn", emoji: "🧰", qty: 1, unit: "runde", rate: RATES.base.vaktmester_round_mnd, cadence: "Ukentlig", computed: RATES.base.vaktmester_round_mnd })));
    var tek = keptVal(c, "water", 0); if (tek > 0) lines.push(withPrev(oLine({ id: id + "base:teknisk", service: "base", role: "teknisk", label: "Teknisk rom – tilsyn", emoji: "🔧", cadence: "Månedlig", computed: tek })));
    var oppCaptured = ckVal(c, "oppganger") != null && ckVal(c, "oppganger") !== "";
    var entryCaptured = (c.markers || []).some(function (m) { return m.layer === "entrance"; }) || oppCaptured;
    if (oppCaptured) {
      var cl = Math.round(n.oppganger * n.floors * RATES.cleaning.per_oppgang_floor_week * WPM);
      lines.push(withPrev(oLine({ id: id + "cleaning:opp", service: "cleaning", role: "opp", label: "Trappevask " + n.oppganger + " oppg × " + n.floors + " etg", emoji: "🧹", qty: n.oppganger * n.floors, unit: "etg/uke", rate: RATES.cleaning.per_oppgang_floor_week, cadence: "Ukentlig", computed: cl })));
      if (n.heiser > 0) { var he = Math.round(n.heiser * RATES.cleaning.per_heis_week * WPM);
        lines.push(withPrev(oLine({ id: id + "cleaning:heis", service: "cleaning", role: "heis", label: "Heisrenhold " + n.heiser + " heis", emoji: "🛗", qty: n.heiser, unit: "heis/uke", rate: RATES.cleaning.per_heis_week, cadence: "Ukentlig", computed: he }))); }
    }
    var mats = keptVal(c, "mats", 0); if (mats > 0) lines.push(withPrev(oLine({ id: id + "cleaning:mats", service: "cleaning", role: "mats", label: "Inngangsmatter (8 stk)", emoji: "🧺", cadence: "Månedlig", computed: mats, deliveredBy: "partner", partnerName: "Dørmatte Gutta AS" })));
    if (z.snowMachine > 0) { lines.push(withPrev(oLine({ id: id + "snow:machine", service: "snow", role: "machine", label: "Maskinell brøyting", emoji: "❄️", qty: z.snowMachine, unit: "m²", rate: RATES.snow.machine_m2_mnd, cadence: "Per snøfall >5 cm", computed: z.snowMachine * RATES.snow.machine_m2_mnd, zoneId: z.firstId("snow", "machine") }))); }
    if (entryCaptured) lines.push(withPrev(oLine({ id: id + "snow:hand", service: "snow", role: "hand", label: "Manuell rydding + strøing (" + n.entryways + " innganger)", emoji: "🧂", qty: n.entryways, unit: "inngang", rate: RATES.snow.hand_per_entry_mnd, cadence: "Per snøfall / is", computed: n.entryways * RATES.snow.hand_per_entry_mnd, zoneId: z.firstId("snow", "hand") })));
    if (z.mow > 0) { lines.push(withPrev(oLine({ id: id + "grass:mow", service: "grass", role: "mow", label: "Gressklipping", emoji: "🌿", qty: z.mow, unit: "m²", rate: RATES.grass.mow_m2_mnd, cadence: "Ukentlig i vekstsesong", computed: z.mow * RATES.grass.mow_m2_mnd, zoneId: z.firstId("grass", "mow") }))); }
    if (z.edge > 0) { lines.push(withPrev(oLine({ id: id + "grass:edge", service: "grass", role: "edge", label: "Kantklipp", emoji: "✂️", qty: z.edge, unit: "m", rate: RATES.grass.edge_m_mnd, cadence: "Sesong", computed: z.edge * RATES.grass.edge_m_mnd, zoneId: z.firstId("grass", "edge") }))); }
    var grnt = keptVal(c, "weeds", 0); if (grnt > 0) lines.push(withPrev(oLine({ id: id + "greenery:ovrig", service: "greenery", role: "ovrig", label: "Grøntområde – sprøyting, bed, trær", emoji: "🌳", cadence: "Sesong", computed: grnt })));
    z.hedgeZones.forEach(function (zz, i) { var yr = Math.round((zz.length_m || 0) * RATES.greenery.hedge_m_year);
      optionLines.push(oLine({ id: id + "opt:hedge" + i, service: "greenery", role: "hedge", label: "Beskjæring hekk (" + zz.label + ")", emoji: "🌳", qty: zz.length_m, unit: "m", rate: RATES.greenery.hedge_m_year, cadence: "2×/år", computed: yr, oneOff: false, zoneId: zz.id })); zz.priceLineId = id + "opt:hedge" + i; });
    z.bedZones.forEach(function (zz, i) { var yr = Math.round((zz.area_m2 || 0) * RATES.greenery.gartner_bed_m2_year);
      optionLines.push(oLine({ id: id + "opt:bed" + i, service: "greenery", role: "bed", label: "Gartner bed (" + zz.label + ")", emoji: "🌷", qty: zz.area_m2, unit: "m²", rate: RATES.greenery.gartner_bed_m2_year, cadence: "Sesong", computed: yr, zoneId: zz.id })); zz.priceLineId = id + "opt:bed" + i; });
    (c.checklist || []).filter(function (it) { return it.scope === "upsell" && (it.price || 0) > 0; }).forEach(function (it, i) {
      optionLines.push(oLine({ id: id + "opt:up" + i, service: layerToService(it.id) || "other", role: "upsell", label: it.subtype || it.label, emoji: it.emoji || "⬆", qty: null, computed: it.price, oneOff: !!it.oneOff, cadence: it.oneOff ? "engangs" : "løpende" })); });
    lines.forEach(function (l) { if (l.zoneId) { var zz = findZone(c, l.zoneId); if (zz) zz.priceLineId = l.id; } });
  } else {
    (c.markers || []).filter(function (m) { return LAYERS[m.layer] && !LAYERS[m.layer].recordOnly; }).forEach(function (m) {
      var d = LAYERS[m.layer];
      lines.push(withPrev(oLine({ id: c.id + ":mk:" + m.id, service: layerToService(m.layer), role: "marker", label: d.label, category: catLabel(m.layer), emoji: d.emoji,
        qty: m.qty, unit: (m.unit || d.unit), rate: d.rate, cadence: m.frequency || d.freq, computed: m.price, frequency: m.frequency || d.freq, inScope: m.inScope, measure: d.measure, compliance: d.compliance })));
    });
  }
  (c.addedLines || []).forEach(function (a) { lines.push(withPrev(oLine(a))); });
  var modules = MOD_ORDER.map(function (svc) {
    var ml = lines.filter(function (l) { return l.service === svc; }); if (!ml.length) return null;
    var pm = prevMod[svc] || {};
    return { service: svc, title: MOD_TITLES[svc], lines: ml, included: (pm.included != null ? pm.included : true),
      startDate: pm.startDate || (svc === "snow" ? "15.11.2026" : "01.01.2026"),
      indexationPct: (pm.indexationPct != null ? pm.indexationPct : 2.5), cap: (pm.cap != null ? pm.cap : 3), subtotal: 0 };
  }).filter(Boolean);
  c.offer = { version: (prev ? prev.version : 1), createdAt: nowStr, period: per, modules: modules, optionLines: optionLines,
    lines: [], upsells: optionLines, totalMonthly: 0, totalYearly: 0, travel: 0, terms: c.terms || null,
    coverNote: (prev && prev.coverNote) ? prev.coverNote : (per === "mnd"
      ? "Månedlig serviceavtale for " + c.name + " — priset fra bygningens målte arealer og talte enheter (ikke rundsum). Hver tjeneste er en egen modul som kan velges bort separat. Opsjoner holdes utenfor grunnbeløpet."
      : "Service plan for " + c.name + " — computed from measured zones + counts; each service is a severable module.") };
  if (!c.offerHistory) c.offerHistory = [];
  rebuildOfferFlat(c);
  return c.offer;
}
export function syncOfferTotals(c) {
  var o = c.offer; if (!o || !o.modules) return;
  o.modules.forEach(function (m) { m.lines.forEach(function (l) { l.price = l.final; }); m.subtotal = m.lines.reduce(function (s, l) { return s + (lineRemoved(l) ? 0 : (l.final || 0)); }, 0); });
  var sum = o.modules.filter(function (m) { return m.included; }).reduce(function (s, m) { return s + m.subtotal; }, 0) + (o.travel || 0);
  if (o.period === "mnd") { o.totalMonthly = Math.round(sum); o.totalYearly = Math.round(sum * 12); }
  else { o.totalYearly = Math.round(sum); o.totalMonthly = Math.round(sum / 12); }
}
export function rebuildOfferFlat(c) {
  var o = c.offer; if (!o || !o.modules) return;
  syncOfferTotals(c);
  var incl = o.modules.filter(function (m) { return m.included; });
  o.lines = []; incl.forEach(function (m) { m.lines.forEach(function (l) { if (!lineRemoved(l)) o.lines.push(l); }); });
}

/* ============================================================ recurring-revenue radar (Phase 12) */
export function radarSeasonOf(isoStr) { var m = parseInt((isoStr || "").split("-")[1], 10) || 0; return (m <= 2 || m === 12) ? "vinter" : (m <= 5) ? "vår" : (m <= 8) ? "sommer" : "høst"; }
function monthsBetween(d1, d2) { return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / (30.4 * 86400000))); }
export function radarKeyword(s) {
  s = (s || "").toLowerCase();
  if (/hekk|beskjær/.test(s)) return "hekk";
  if (/gress|plen|klipp/.test(s)) return "gressklipp";
  if (/takrenn|nedløp/.test(s)) return "takrenner";
  if (/fasade|svertesopp|spotvask/.test(s)) return "fasade";
  if (/vindu|glass/.test(s)) return "vindu";
  if (/garasje|spyl/.test(s)) return "garasje";
  if (/skadedyr|mus|insekt/.test(s)) return "skadedyr";
  if (/ventilasjon|filter|aggregat/.test(s)) return "ventilasjon";
  if (/lekeplass/.test(s)) return "lekeplass";
  if (/mal|råte|puss/.test(s)) return "maling";
  return (s.split(/[ (–-]/)[0] || "annet");
}
function radarServiceFromCategory(cat) { return ({ hage: "greenery", renhold: "cleaning", vinter: "snow", drift: "base", service: "other", anlegg: "other" })[cat] || "other"; }
function standingLineLabels(c) { var out = []; if (c.offer && c.offer.modules) c.offer.modules.forEach(function (m) { if (m.included) m.lines.forEach(function (l) { out.push((l.label || "").toLowerCase()); }); }); return out; }
var RADAR_TYPEW = { repeat: 3, seasonal: 3, upsell: 2, winloss: 1 };
/** Ranked, explainable opportunities from history, deduped vs the standing plan. opts.now lifts refDate(). */
export function recurringRadar(c, opts) {
  if (!c) return [];
  var now = (opts && opts.now) || new Date();
  var actioned = c.radarActioned || [], standing = standingLineLabels(c), opps = [];
  function covered(kw) { return standing.some(function (l) { return l.indexOf(kw) >= 0; }); }
  var hist = (c.requests || []).filter(function (r) { return r.status !== "avslått" && (r.done || r.status === "godkjent"); });
  var groups = {}; hist.forEach(function (r) { var k = radarKeyword(r.title); (groups[k] = groups[k] || []).push(r); });
  Object.keys(groups).forEach(function (k) {
    var g = groups[k]; if (g.length < 2 || covered(k)) return;
    var total = g.reduce(function (s, r) { return s + (r.estCost || 0); }, 0);
    var seasons = {}; g.forEach(function (r) { seasons[radarSeasonOf(r.ts)] = 1; });
    var sk = Object.keys(seasons), sameSeason = sk.length === 1;
    var type = sameSeason ? "seasonal" : "repeat";
    var cadence = sameSeason ? ("fast hver " + sk[0]) : (g.length + "×/år");
    var evid = "Kjøpt " + g.length + "× " + (sameSeason ? ("hver " + sk[0]) : (sk.join(" + "))) + " utenom avtalen: " + g.map(function (r) { return tsLabel(r.ts) + (r.estCost ? (" " + kr(r.estCost)) : ""); }).join(" + ");
    opps.push({ id: "rad:" + type + ":" + k, type: type, key: k, label: cap(g[0].title), evidence: evid,
      estValueYr: total || null, suggestedCadence: cadence, service: radarServiceFromCategory(g[0].category),
      sourceIds: g.map(function (r) { return r.id; }), confidence: g.length });
  });
  (c.checklist || []).filter(function (it) { return it.scope === "upsell" && (it.price || 0) > 0 && !it.oneOff; }).forEach(function (it) {
    var kw = radarKeyword(it.subtype || it.label); if (covered(kw)) return;
    opps.push({ id: "rad:upsell:" + it.id, type: "upsell", key: it.id, label: cap(it.subtype || it.label),
      evidence: "Registrert på befaring, men ikke på fast plan" + (it.compliance ? " — lovpålagt kontroll" : ""),
      estValueYr: it.price || null, suggestedCadence: "løpende", service: radarServiceFromCategory(it.category), sourceIds: [it.id], confidence: 1 });
  });
  (c.requests || []).filter(function (r) { return r.status === "avslått"; }).forEach(function (r) {
    var mo = monthsBetween(new Date(r.ts), now); if (mo < 3) return;
    opps.push({ id: "rad:winloss:" + r.id, type: "winloss", key: r.id, label: cap(r.title),
      evidence: "Avslått for " + mo + " mnd siden — verdt å ta opp igjen?",
      estValueYr: r.estCost || null, suggestedCadence: "ny vurdering", service: radarServiceFromCategory(r.category), sourceIds: [r.id], confidence: 1 });
  });
  return opps.filter(function (o) { return actioned.indexOf(o.id) < 0; })
    .sort(function (a, b) { return ((b.estValueYr || 0) * b.confidence * RADAR_TYPEW[b.type]) - ((a.estValueYr || 0) * a.confidence * RADAR_TYPEW[a.type]); });
}

/* ============================================================ AI intake — parseIntake (Phase 13, rules) */
export var INTAKE_CHANNELS = [["sms", "✉️ SMS"], ["epost", "📧 E-post"], ["whatsapp", "💬 WhatsApp"], ["qr", "🔳 Beboer-QR"], ["tale", "🎙️ Tale→tekst"]];
export function channelLabel(ch) { var m = INTAKE_CHANNELS.filter(function (x) { return x[0] === ch; })[0]; return m ? m[1] : ch; }
export function intakeTitle(text) { var t = (text || "").trim().replace(/\s+/g, " "); if (t.length > 56) t = t.slice(0, 54).replace(/\s\S*$/, "") + "…"; return cap(t) || "Innmelding"; }
/** Rules/keyword parse → structured draft, each field with its trigger. ctx.customers lifts customers(). */
export function parseIntake(text, ctx) {
  ctx = ctx || {}; text = text || ""; var low = text.toLowerCase();
  function first(rules) { for (var i = 0; i < rules.length; i++) { if (rules[i][0].test(low)) return { val: rules[i][1], trig: rules[i][2] }; } return null; }
  var cat = first([
    [/lekkasje|lekker|\bvann\b|rør|ror|sluk|avløp|kran|sanitær|tett|kloakk/, "service", "«vann/rør»"],
    [/lys|lampe|strøm|stikk|sikring|elektr|kabel/, "drift", "«elektrisk»"],
    [/brann|røyk|slukker|alarm/, "drift", "«brann/HMS»"],
    [/snø|brøyt|\bis\b|glatt|strø/, "vinter", "«vinter»"],
    [/hekk|gress|plen|\btre\b|busk|beskjær|grønt|ugras/, "hage", "«grønt»"],
    [/søppel|avfall|dunk|container/, "service", "«avfall»"],
    [/heis/, "drift", "«heis»"],
    [/vindu|glass/, "renhold", "«vindu/glass»"],
    [/\bmal|råte|puss|\bmur|sprekk|asfalt/, "anlegg", "«bygg/anlegg»"],
    [/skadedyr|\bmus\b|rotte|veps|insekt|maur/, "service", "«skadedyr»"]
  ]);
  var area = first([
    [/garasje|p-?plass|parkering|plass \d/, "garasje", "«garasje»"],
    [/\btak\b|renne|nedløp|pipe|loft/, "tak", "«tak»"],
    [/kjeller|\bbod\b|fellesvask/, "kjeller", "«kjeller»"],
    [/heis/, "heis", "«heis»"],
    [/oppgang|trapp|inngang|\bgang\b|korridor/, "oppgang", "«oppgang»"],
    [/fasade|yttervegg|kledning/, "fasade", "«fasade»"],
    [/hage|plen|hekk|\bute\b|\bvei\b|gård|uteareal|busk/, "ute", "«uteareal»"]
  ]);
  var urg, urgTrig;
  if (/lekkasje|lekker|brann|røyk|innbrudd|\bgass\b|strømbrudd|heis står|heisen står|akutt|farlig|\bfare\b|sperret|nødutgang|kloakk/.test(low)) { urg = "høy"; urgTrig = "akutt-ord i meldingen"; }
  else if (/når det passer|ikke hast|ikke akutt|kosmetisk|etter hvert|på sikt/.test(low)) { urg = "low"; urgTrig = "«når det passer» o.l."; }
  else { urg = "med"; urgTrig = "ingen hast-/lav-ord → standard"; }
  var buildingId = ctx.buildingId || null, bTrig = buildingId ? "oppgitt kanal-/QR-kontekst" : null;
  if (!buildingId) {
    (ctx.customers || []).forEach(function (c) {
      if (buildingId) return;
      var toks = (c.name + " " + (c.addr || "")).toLowerCase().split(/[ ,]+/).filter(function (w) { return w.length >= 4 && !/borettslag|sameiet|horisont/.test(w); });
      for (var i = 0; i < toks.length; i++) { if (low.indexOf(toks[i]) >= 0) { buildingId = c.id; bTrig = "navn nevnt: «" + toks[i] + "»"; break; } }
    });
  }
  var visual = /lekkasje|lekker|skade|sprekk|råte|svertesopp|knust|ødelagt|\bhull\b|rust|brann|søl/.test(low);
  var needsPhoto = visual && !(ctx.photoIds && ctx.photoIds.length);
  return {
    category: cat ? cat.val : null, categoryTrig: cat ? cat.trig : "fant ikke kategori-ord",
    area: area ? area.val : (cat ? "teknisk" : null), areaTrig: area ? area.trig : (cat ? "ingen stedord → teknisk" : "fant ikke stedord"),
    urgency: urg, urgencyTrig: urgTrig, buildingId: buildingId, buildingTrig: bTrig,
    needsPhoto: needsPhoto, needsPhotoTrig: visual ? "visuelt problem, ingen bilde" : null
  };
}

/* ============================================================ contract → scope + classify (Phase 14, rules) */
export function scopeKeyword(text) {
  text = (text || "").toLowerCase();
  if (/lekkasje|lekker|\bvann\b|rør|sluk|avløp|sanitær|kloakk/.test(text)) return "vann";
  if (/sprinkler/.test(text)) return "sprinkler";
  if (/brann|røyk|slukke|røykvarsler|\bhms\b/.test(text)) return "brann";
  if (/lys|lampe|strøm|sikring|elektr|kabel|stikk/.test(text)) return "el";
  if (/snø|brøyt|\bis\b|strø|glatt|vinter/.test(text)) return "snø";
  if (/hekk|beskjær|busk/.test(text)) return "hekk";
  if (/gress|plen|gressklipp/.test(text)) return "gress";
  if (/grønt|\bbed\b|ugras|sprøyt|plant/.test(text)) return "grønt";
  if (/trappe?vask|renhold|fellesareal/.test(text)) return "renhold";
  if (/matter|matte/.test(text)) return "matter";
  if (/takrenn|nedløp|løv/.test(text)) return "takrenner";
  if (/\btak\b|takstein|taksten|beslag|vannbord/.test(text)) return "tak";
  if (/fasade|svertesopp|kledning/.test(text)) return "fasade";
  if (/vindu|glass/.test(text)) return "vindu";
  if (/garasje|\bport\b/.test(text)) return "garasje";
  if (/skadedyr|\bmus\b|rotte|veps|insekt|maur/.test(text)) return "skadedyr";
  if (/ventilasjon|filter|aggregat|vifte/.test(text)) return "ventilasjon";
  if (/heis/.test(text)) return "heis";
  if (/søppel|avfall|dunk|container/.test(text)) return "avfall";
  if (/lekeplass/.test(text)) return "lekeplass";
  if (/vaktmester|tilsyn|\bdrift\b|runde|rundering/.test(text)) return "drift";
  return "annet";
}
var SCOPE_DOM_LABEL = { vann: "Vann/rør", el: "Elektrisk", brann: "Brannvern", sprinkler: "Sprinkler", snø: "Vinter", hekk: "Hekk/beskjæring", gress: "Gressklipp", grønt: "Grøntskjøtsel", renhold: "Renhold", matter: "Matter", takrenner: "Takrenner", tak: "Tak", fasade: "Fasade", vindu: "Vindu", garasje: "Garasje", skadedyr: "Skadedyr", ventilasjon: "Ventilasjon", heis: "Heis", avfall: "Avfall", lekeplass: "Lekeplass", drift: "Drift/vaktmester", annet: "Annet" };
export function scopeDomLabel(k) { return SCOPE_DOM_LABEL[k] || cap(k); }
export function scopeFromOffer(c) {
  var services = [], seen = {};
  function add(label, cadence, source, compliance, trig) { var k = scopeKeyword(label); if (seen[k]) return; seen[k] = 1;
    services.push({ serviceId: k, label: label, cadence: cadence || "", source: source, keywords: [k], compliance: !!compliance, trig: trig }); }
  if (c.offer && c.offer.modules) c.offer.modules.filter(function (m) { return m.included; }).forEach(function (m) { m.lines.forEach(function (l) { if (!lineRemoved(l)) add(l.label, l.cadence || l.frequency, "tilbud", l.compliance, "tilbudslinje"); }); });
  (c.compliance || []).forEach(function (r) { add(r.label, "lovpålagt", "tilbud", true, "compliance-pakke"); });
  return { services: services, standards: (c.terms ? ["KPI/SSB-regulering", "3 mnd oppsigelse"] : []), parsedFrom: "gjeldende tilbud (auto)", ts: null };
}
export function deriveScope(c) { return (c && c.contractScope && c.contractScope.services && c.contractScope.services.length) ? c.contractScope : (c ? scopeFromOffer(c) : null); }
function scopeDomains(scope) { var d = {}; (scope && scope.services || []).forEach(function (s) { (s.keywords || []).forEach(function (k) { if (!d[k]) d[k] = s; }); }); return d; }
export function parseContract(text) {
  text = text || ""; var low = text.toLowerCase(), services = [], seen = {};
  var rules = [
    [/vaktmester|tilsyn|ukentlig runde|rundering|driftsavtale/, "drift", "Vaktmester / drift", "Ukentlig", "«vaktmester/tilsyn»"],
    [/trappe?vask|renhold|fellesareal/, "renhold", "Trappevask / renhold", "Ukentlig", "«renhold»"],
    [/brøyt|snørydding|strø|vintervedlikehold|måking/, "snø", "Brøyting + strøing", "Beredskap", "«brøyting/strø»"],
    [/gress|plen|gressklipp/, "gress", "Gressklipping", "Vekstsesong", "«gress»"],
    [/hekk|beskjær|grøntanlegg|busk/, "grønt", "Grøntskjøtsel", "Sesong", "«grønt»"],
    [/matter|inngangsmatte/, "matter", "Inngangsmatter", "Månedlig", "«matter»"],
    [/brann|\bhms\b|slukke|røykvarsler/, "brann", "Brannvern / HMS", "Årlig", "«brann/HMS»"],
    [/sprinkler/, "sprinkler", "Sprinklerkontroll", "Årlig", "«sprinkler»"],
    [/heis/, "heis", "Heiskontroll", "2-årlig", "«heis»"]
  ];
  rules.forEach(function (r) { if (r[0].test(low) && !seen[r[1]]) { seen[r[1]] = 1; services.push({ serviceId: r[1], label: r[2], cadence: r[3], source: "kontrakt", keywords: [r[1]], compliance: (r[1] === "brann" || r[1] === "sprinkler" || r[1] === "heis"), trig: r[4] }); } });
  var standards = []; if (/kpi|indeks|ssb/.test(low)) standards.push("KPI/SSB-regulering"); if (/oppsigelse|måneders/.test(low)) standards.push("Oppsigelsestid");
  return { services: services, standards: standards, parsedFrom: "kontrakt (limt inn)", ts: null };
}
var SCOPE_SAFETY = /vann|lekkasje|lekker|brann|røyk|strøm|\bel\b|gass|innbrudd|kloakk|sprinkler|\bfare\b|farlig/;
var SCOPE_BORDERLINE = { ventilasjon: 1, heis: 1, fasade: 1, tak: 1, vindu: 1 };
/** Classify a request against the scope → {cls, reason, safety}. cls ∈ i-avtale|utenfor-avtale|borderline. */
export function classifyAgainstScope(c, request) {
  var scope = deriveScope(c);
  if (!scope || !scope.services.length) return { cls: "borderline", reason: "Ingen avtale-scope definert ennå", safety: false };
  var doms = scopeDomains(scope), hay = ((request.title || "") + " " + (request.desc || "")).toLowerCase();
  var kw = scopeKeyword(hay), safety = SCOPE_SAFETY.test(hay), baseCovered = !!doms["drift"];
  if (doms[kw]) return { cls: "i-avtale", reason: "Dekket av avtalen: " + doms[kw].label, safety: safety };
  if (safety && baseCovered) return { cls: "i-avtale", reason: "Akutt sikkerhet — strakstiltak under vaktmesteravtalen", safety: true };
  if (SCOPE_BORDERLINE[kw]) return { cls: "borderline", reason: scopeDomLabel(kw) + ": avhenger av avtalt omfang — sjekk avtalen", safety: safety };
  return { cls: "utenfor-avtale", reason: scopeDomLabel(kw) + " er ikke i avtalen → tillegg/godkjenning", safety: safety };
}
export function scopeMismatch(c) {
  var doms = scopeDomains(deriveScope(c) || { services: [] }), out = [];
  (c.checklist || []).filter(function (it) { return it.scope === "upsell" && (it.price || 0) > 0; }).forEach(function (it) {
    var k = scopeKeyword(it.subtype || it.label); if (!doms[k]) out.push({ label: it.subtype || it.label, why: it.compliance ? "lovpålagt kontroll" : "registrert, ikke i avtalen" });
  });
  return out;
}

/* ============================================================ schedule cadence helpers (subset, Phase-8 catalogue feeds these in the app) */
export function freqText(s) {
  switch (s.type) {
    case "weekly": return "ukentlig"; case "monthly": return "månedlig"; case "nPerYear": return s.count + "×/år";
    case "seasonal": return "sesong (" + s.windows.length + " vindu)"; case "growingSeason": return "ukentlig i vekstsesong";
    case "dateAnchored": return { before17mai: "før 17. mai", beforeSthans: "før st.hans", autumn: "høst", spring: "vår" }[s.anchor] || "årlig";
    case "intervalYears": return s.years + "-årlig"; case "annual": return "årlig"; case "event": return "beredskap";
  }
  return "";
}
var VEKST_START = [4, 20], VEKST_END = [10, 15];
function inGrowing(d) { var m = d.getMonth() + 1, day = d.getDate(); return ((m > VEKST_START[0]) || (m === VEKST_START[0] && day >= VEKST_START[1])) && ((m < VEKST_END[0]) || (m === VEKST_END[0] && day <= VEKST_END[1])); }
/** Expand one schedule line into dated instances within [from,to]. Pure (line carries its own schedule). */
export function expandLine(line, from, to) {
  var s = line.schedule, out = [], y0 = from.getFullYear(), y1 = to.getFullYear();
  function push(d) { if (inRange(d, from, to)) out.push({ lineId: line.lineId, building: line.building, title: line.title, category: line.category, zone: line.zone, partner: line.partner, statutory: line.statutory, date: iso(d), freq: freqText(s) }); }
  if (s.type === "weekly") { for (var d = mondayOf(from); d.getTime() <= to.getTime(); d = addDays(d, 7)) push(addDays(d, 2)); }
  else if (s.type === "growingSeason") { for (var d2 = mondayOf(from); d2.getTime() <= to.getTime(); d2 = addDays(d2, 7)) { var w = addDays(d2, 2); if (inGrowing(w)) push(w); } }
  else if (s.type === "monthly") { for (var y = y0; y <= y1; y++) for (var m = 1; m <= 12; m++) push(ymd(y, m, 1)); }
  else if (s.type === "nPerYear") { for (var y3 = y0; y3 <= y1; y3++) { var st0 = s.season ? ymd(y3, VEKST_START[0], VEKST_START[1]) : ymd(y3, 1, 1), en = s.season ? ymd(y3, VEKST_END[0], VEKST_END[1]) : ymd(y3, 12, 31); for (var i = 0; i < s.count; i++) push(new Date(st0.getTime() + ((i + 0.5) / s.count) * (en.getTime() - st0.getTime()))); } }
  else if (s.type === "seasonal") { for (var y4 = y0; y4 <= y1; y4++) s.windows.forEach(function (wd) { push(ymd(y4, wd[0][0], wd[0][1])); }); }
  else if (s.type === "dateAnchored") { var a = { before17mai: [5, 10], beforeSthans: [6, 20], autumn: [10, 10], spring: [4, 15] }[s.anchor] || [6, 1]; for (var y5 = y0; y5 <= y1; y5++) push(ymd(y5, a[0], a[1])); }
  else if (s.type === "annual" || s.type === "intervalYears") { for (var y6 = y0; y6 <= y1; y6++) push(ymd(y6, s.dueMonth || 6, s.dueDay || 1)); }
  return out;
}
/** Expand many lines (skips event-type, which are beredskap not calendar). */
export function generateInstances(lines, from, to) { var out = []; lines.filter(function (l) { return l.schedule.type !== "event"; }).forEach(function (l) { out = out.concat(expandLine(l, from, to)); }); return out; }

/* ============================================================ while-here ranking (Phase 7 "Mens du er her") */
/** Rank "while you're here" candidates — the pure scoring/ranking/dedupe half of suggestWhileHere.
 *  The app gathers the candidates (catalogue- + completedInstances/instKey-coupled — that part stays in
 *  the app, by design); core owns the SCORING domain logic: co-location +200, co-equipment +60, statutory
 *  +40, base 300, and (window − daysUntil) so nearer-due wins ties. Pure over its args (no globals).
 *  @param cand  candidate objects: {title, area, equipment[], statutory, daysUntil, _svc, …passthrough}
 *  @param opts  {hereAreas{}, hereEquip{}, WHILE_WINDOW=21, teamServices?[], areaLabel(fn), equipTypeLabel(fn)}
 *  Mutates+returns the surviving candidates with .reasons[], .score, .coLoc — sorted desc by score. */
export function rankWhileHere(cand, opts) {
  opts = opts || {};
  var W = opts.WHILE_WINDOW || 21, hereAreas = opts.hereAreas || {}, hereEquip = opts.hereEquip || {};
  var areaLabel = opts.areaLabel || function (a) { return a; };
  var equipTypeLabel = opts.equipTypeLabel || function (t) { return t; };
  // dedupe by title+area
  var seen = {}, uniq = [];
  (cand || []).forEach(function (s) { var k = s.title + "|" + s.area; if (!seen[k]) { seen[k] = 1; uniq.push(s); } });
  // optional team scope (cockpit) — filters on the app-annotated service bucket
  if (opts.teamServices) uniq = uniq.filter(function (s) { return opts.teamServices.indexOf(s._svc) >= 0; });
  uniq.forEach(function (s) {
    var coLoc = !!hereAreas[s.area], matchedEq = null;
    (s.equipment || []).some(function (t) { if (hereEquip[t]) { matchedEq = t; return true; } return false; });
    var coEq = !!matchedEq;
    s.reasons = [];
    if (coLoc) s.reasons.push({ k: "loc", icon: "📍", text: "Samme område — " + areaLabel(s.area) });
    s.reasons.push({ k: "time", icon: "⏰", text: "Forfaller om " + s.daysUntil + " dag" + (s.daysUntil === 1 ? "" : "er") });
    if (coEq) s.reasons.push({ k: "equip", icon: "🔧", text: equipTypeLabel(matchedEq) + " er på stedet i dag" });
    if (s.statutory) s.reasons.push({ k: "comp", icon: "✅", text: "Lovpålagt — forfaller nå" });
    var score = 300; if (coLoc) score += 200; if (coEq) score += 60; if (s.statutory) score += 40; score += Math.max(0, (W - s.daysUntil));
    s.score = score; s.coLoc = coLoc;
  });
  uniq.sort(function (a, b) { return b.score - a.score; });
  return uniq;
}

/* ============================================================ migration — INTENTIONALLY NOT EXTRACTED.
 * Migration is the one engine that stays app-side (index.html `migrate`): it runs at parse-time, BEFORE
 * this deferred module loads, and depends on the app's `demo()` seed + `SCHEMA_VERSION`. A core copy would
 * be a duplicate the app never calls — an untested-against-live drift surface — so it lives only in the app.
 * See CORE-EXTRACTION.md ("What stays in the app"). */

export var VERSION = "0.1.0";
