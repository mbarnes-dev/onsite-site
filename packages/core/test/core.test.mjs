// @onsite/core — regression + future-LLM eval harness (Node's built-in test runner; zero install).
// Run: cd packages/core && node --test    (or: npm test)
// Fixtures are data files (test/fixtures/*) so they're reusable when an LLM replaces the
// rules behind parseContract/parseIntake. The anchors here are the same ones the live app proves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Core from "../src/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const holtet = JSON.parse(readFileSync(join(here, "fixtures", "holtet.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const FIXED_NOW = { nowStr: "21 Jun 2026" };

/* ---- ANCHOR 1: Holtet offer = kr 16 530/mnd (doc 37 signed price) ---- */
test("computeOffer → Holtet kr 16 530/mnd from its real drivers", () => {
  const c = clone(holtet);
  Core.computeOffer(c, FIXED_NOW);
  assert.equal(c.offer.totalMonthly, 16530, "Holtet anchor must hold");
  assert.equal(c.offer.totalYearly, 16530 * 12);
  // module breakdown the prototype shows
  const sub = {};
  c.offer.modules.forEach((m) => (sub[m.service] = m.subtotal));
  assert.equal(sub.base, 4200 + 491, "base = round + teknisk");
  assert.equal(sub.cleaning, 4160 + 607 + 1200, "cleaning = opp + heis + mats");
  assert.equal(sub.snow, 1193 + 602, "snow = machine + hand");
  assert.equal(sub.grass, 1410, "grass = mow");
  assert.equal(sub.greenery, 2667, "greenery = weeds");
  // hedge is an OPTION line (outside the recurring total), not a module
  assert.ok(c.offer.optionLines.some((l) => l.role === "hedge"), "hedge → optionLine");
});

test("computeOffer is deterministic + idempotent on re-run", () => {
  const a = clone(holtet); Core.computeOffer(a, FIXED_NOW);
  const b = clone(holtet); Core.computeOffer(b, FIXED_NOW);
  assert.equal(a.offer.totalMonthly, b.offer.totalMonthly);
  Core.computeOffer(a, FIXED_NOW); // recompute on an existing offer
  assert.equal(a.offer.totalMonthly, 16530);
});

/* ---- ANCHOR 2: scope classification on the real contract (docs 37–44) ----
   Scope = the PRICED offer lines + statutory compliance (the actual agreement). */
test("classifyAgainstScope → i-avtale / utenfor-avtale / borderline on real requests", () => {
  const c = clone(holtet);
  Core.computeOffer(c, FIXED_NOW); // scope auto-derives from the offer
  const cls = (title, desc = "") => Core.classifyAgainstScope(c, { title, desc }).cls;

  // in scope (priced domains present)
  assert.equal(cls("Trappevask oppgang B er skitten"), "i-avtale", "renhold is contracted");
  assert.equal(cls("Snøen må måkes ved inngangene"), "i-avtale", "vinter is contracted");
  // acute safety → in scope under the vaktmester agreement, flagged
  const lek = Core.classifyAgainstScope(c, { title: "Det lekker vann i garasjen", desc: "" });
  assert.equal(lek.cls, "i-avtale");
  assert.equal(lek.safety, true, "lekkasje is safety → gjør nå");
  // out of scope (not a priced line)
  assert.equal(cls("Skadedyr — mus i kjellerbod"), "utenfor-avtale", "skadedyr is an add-on");
  // borderline (conditional / covered-adjacent)
  assert.equal(cls("Ventilasjonen bråker i oppgang B"), "borderline", "ventilasjon depends on agreed scope");
});

test("scopeFromOffer + parseContract produce structured, explainable scope", () => {
  const c = clone(holtet); Core.computeOffer(c, FIXED_NOW);
  const auto = Core.deriveScope(c);
  const doms = auto.services.map((s) => s.serviceId);
  assert.ok(doms.includes("drift") && doms.includes("renhold") && doms.includes("snø"), "priced domains present");
  assert.ok(!doms.includes("hekk") && !doms.includes("vann"), "non-priced inspection items NOT in scope (radar-consistent)");
  // parseContract over pasted Norwegian contract text
  const parsed = Core.parseContract("Leverandør utfører ukentlig vaktmestertjeneste og tilsyn, trappevask, brøyting og strøing, brannvern årlig, heiskontroll hvert andre år. KPI-regulering etter SSB.");
  const pdoms = parsed.services.map((s) => s.serviceId);
  assert.deepEqual(pdoms, ["drift", "renhold", "snø", "brann", "heis"]);
  assert.ok(parsed.services.every((s) => s.trig), "every extracted line carries its trigger");
  assert.ok(parsed.standards.includes("KPI/SSB-regulering"));
});

/* ---- ANCHOR 3: radar → the repeated-ad-hoc hekklipp opportunity ---- */
test("recurringRadar → hekklipp repeated-ad-hoc headline (kr 9 000/år)", () => {
  const c = clone(holtet); Core.computeOffer(c, FIXED_NOW);
  const opps = Core.recurringRadar(c, { now: new Date("2026-06-21T12:00:00Z") });
  assert.ok(opps.length >= 1);
  const head = opps[0];
  assert.equal(head.key, "hekk");
  assert.equal(head.type, "repeat");
  assert.equal(head.estValueYr, 9000, "2 × kr 4 500");
  assert.equal(head.confidence, 2);
  // the declined fasade re-engagement is present but ranks below the recurring headline
  assert.ok(opps.some((o) => o.type === "winloss"), "declined → win/loss");
});

/* ---- ANCHOR 4: intake → garasje-lekkasje parse (rules) ---- */
test("parseIntake → garasje-lekkasje: service/garasje/høy, building unknown, photo prompt", () => {
  const r = Core.parseIntake("Det lekker vann i garasjen ved plass 14, har holdt på et par dager", { customers: [] });
  assert.equal(r.category, "service");
  assert.equal(r.area, "garasje");
  assert.equal(r.urgency, "høy");
  assert.equal(r.buildingId, null, "no building named → clarify");
  assert.equal(r.needsPhoto, true);
  assert.ok(r.categoryTrig && r.areaTrig && r.urgencyTrig, "explainable: every field carries its trigger");
  // a low-priority, building-known message
  const r2 = Core.parseIntake("Hekken mot veien er blitt veldig høy, kan dere ta den når det passer?", { buildingId: "holtet-cust" });
  assert.equal(r2.category, "hage");
  assert.equal(r2.urgency, "low");
  assert.equal(r2.buildingId, "holtet-cust");
});

/* ---- ANCHOR 5: schedule → correct instances for a known cadence + window ---- */
test("expandLine / generateInstances → dateAnchored 'autumn' fires once per year", () => {
  const line = { lineId: "x", building: "B", title: "Takrennerens", schedule: { type: "dateAnchored", anchor: "autumn" } };
  const inst = Core.expandLine(line, new Date(2026, 0, 1), new Date(2026, 11, 31));
  assert.equal(inst.length, 1);
  assert.equal(inst[0].date, "2026-10-10");
  // weekly over a 2-week window → 2 occurrences
  const wk = Core.expandLine({ lineId: "w", schedule: { type: "weekly" } }, new Date(2026, 5, 1), new Date(2026, 5, 14));
  assert.equal(wk.length, 2);
  // event-type lines are beredskap, not calendar — excluded by generateInstances
  const ev = Core.generateInstances([{ lineId: "e", schedule: { type: "event" } }], new Date(2026, 0, 1), new Date(2026, 11, 31));
  assert.equal(ev.length, 0);
});

/* ---- ANCHOR 6: geodesic within tolerance on a known polygon/line ---- */
test("geoArea / geoLength within tolerance", () => {
  // ~111 m per 0.001° latitude
  const seg = Core.geoLength([[59.0, 10.0], [59.001, 10.0]]);
  assert.ok(Math.abs(seg - 111.32) < 0.5, `segment ≈ 111.3 m, got ${seg.toFixed(2)}`);
  // a small square ~0.001° × 0.001° at lat 59 → width ≈ 57.3 m, height ≈ 111.3 m → ~6380 m²
  const sq = Core.geoArea([[59.0, 10.0], [59.0, 10.001], [59.001, 10.001], [59.001, 10.0]]);
  assert.ok(sq > 6000 && sq < 6700, `square ≈ 6.4k m², got ${sq.toFixed(0)}`);
  assert.equal(Core.geoArea([[59, 10], [59, 10]]), 0, "degenerate → 0");
});

/* ---- ANCHOR 7: while-here ranking — co-located + co-equipment + due-soon tops the list (📍⏰🔧) ---- */
test("rankWhileHere → co-located + co-equipment + due-soon ranks top with 📍⏰🔧", () => {
  const cand = [
    // Takrennerens: roof, needs stige, due in 9d — co-located + co-equipment on site today
    { key: "up:gutter", title: "Takrennerens (løv + nedløp)", area: "tak", equipment: ["stige"], statutory: false, daysUntil: 9 },
    // a far-area, no-equip-match, later task — should rank below
    { key: "up:hedge", title: "Beskjæring hekk", area: "ute", equipment: ["hekksaks"], statutory: false, daysUntil: 13 },
  ];
  const ranked = Core.rankWhileHere(cand, {
    hereAreas: { tak: 1 }, hereEquip: { stige: 1 }, WHILE_WINDOW: 21,
    areaLabel: (a) => ({ tak: "Tak", ute: "Uteareal" }[a] || a),
    equipTypeLabel: (t) => ({ stige: "Stige" }[t] || t),
  });
  const top = ranked[0];
  assert.equal(top.title, "Takrennerens (løv + nedløp)", "co-located + co-equip task tops the list");
  assert.deepEqual(top.reasons.map((r) => r.k), ["loc", "time", "equip"], "📍 loc + ⏰ time + 🔧 equip, in order");
  assert.equal(top.reasons[0].icon, "📍");
  assert.equal(top.reasons[2].icon, "🔧");
  assert.equal(top.score, 572, "score = 300 base + 200 coLoc + 60 coEq + (21−9) window");
  assert.ok(ranked[1].score < top.score, "the far/no-equip task ranks below");
  // dedupe by title+area, then optional team-scope filter on the app-annotated _svc
  const dup = Core.rankWhileHere(
    [{ title: "X", area: "tak", daysUntil: 2, _svc: "snow" }, { title: "X", area: "tak", daysUntil: 5, _svc: "snow" }],
    { teamServices: ["grass"] }
  );
  assert.equal(dup.length, 0, "dedupe → 1, then team-scope filters out the non-matching service bucket");
});

/* ---- ANCHOR 8 (doc 66 A2): bruksenhetsnummer → floors / stacking (real Kongsveien codes) ---- */
test("parseBruksenhet + aggregateBruksenheter → storeys/units/basement", () => {
  assert.deepEqual(Core.parseBruksenhet("H0301"), { plan: "H", floor: 3, unit: 1 });
  assert.equal(Core.parseBruksenhet("xx"), null, "garbage → null");
  assert.equal(Core.parseBruksenhet(""), null, "empty → null");
  // Kongsveien 86A (real geonorge payload): 11 dwellings across H01–H04, no basement → storeys 4
  const a86 = Core.aggregateBruksenheter(["H0101", "H0102", "H0103", "H0201", "H0202", "H0203", "H0301", "H0302", "H0303", "H0401", "H0402"]);
  assert.equal(a86.parsedUnits, 11);
  assert.equal(a86.floorsAbove, 4);
  assert.equal(a86.storeys, 4);
  assert.equal(a86.hasBasement, false);
  // Kongsveien 88B: 12 dwellings, 4 storeys
  const a88 = Core.aggregateBruksenheter(["H0101", "H0102", "H0201", "H0202", "H0203", "H0204", "H0301", "H0302", "H0303", "H0304", "H0401", "H0402"]);
  assert.equal(a88.parsedUnits, 12);
  assert.equal(a88.storeys, 4);
  // basement code → hasBasement true
  assert.equal(Core.aggregateBruksenheter(["K0101", "H0101"]).hasBasement, true);
  // empty payload (like 88A/88C) → zeros, not a crash
  assert.equal(Core.aggregateBruksenheter([]).parsedUnits, 0);
  assert.equal(Core.aggregateBruksenheter([]).storeys, 0);
});

test("app-path parity (review-3 F-M5): buildCustomerFromApp -> computeOffer holds the 16530 anchor", () => {
  const appFix = JSON.parse(readFileSync(join(here, "fixtures", "holtet-app.json"), "utf8"));
  const c = Core.buildCustomerFromApp(appFix);
  assert.equal(c.strictFloors, true, "app path is strict by default");
  assert.equal(c.floors, 4, "etasjer carries floors");
  assert.equal(c.markers.filter(m => m.layer === "entrance").length, 7, "innganger materialises entrance markers");
  Core.computeOffer(c, FIXED_NOW);
  assert.equal(c.offer.totalMonthly, 16530, "the anchor must hold through the APP builder");
});

test("strictFloors (review-3 F-M4): etasjer blank -> trappevask honestly unpriced, no fabricated kroner", () => {
  const appFix = JSON.parse(readFileSync(join(here, "fixtures", "holtet-app.json"), "utf8"));
  appFix.checklist = appFix.checklist.filter(i => i.id !== "etasjer");
  const c = Core.buildCustomerFromApp(appFix);
  assert.equal(c.floors, null);
  Core.computeOffer(c, FIXED_NOW);
  const opp = c.offer.modules.flatMap(m => m.lines).find(l => l.id.endsWith("cleaning:opp"));
  assert.ok(opp, "the line still exists");
  assert.equal(opp.computed, 0, "unpriced, never floors||4");
  assert.match(opp.label, /mangler etasjer/);
  assert.ok(c.offer.totalMonthly < 16530, "total excludes the unpriced line");
});
