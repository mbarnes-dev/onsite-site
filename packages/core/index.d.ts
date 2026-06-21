// @onsite/core — public type surface (signatures + core data shapes).
// Lifted from the Phase-8 backbone shapes. Internal typing is intentionally loose;
// these cover the public boundary an LLM/back-end consumer needs. // PROD: author the
// implementation in TS so these are generated, not hand-maintained.

/* ---- core data shapes ---- */
export type LngLat = [number, number]; // note: geo* take [lat, lng] pairs
export type ServiceKey = "base" | "cleaning" | "snow" | "grass" | "greenery" | "other";
export type ScopeClass = "i-avtale" | "utenfor-avtale" | "borderline";
export type Urgency = "low" | "med" | "høy";

export interface Zone {
  id: string; service: string; method?: string;
  area_m2?: number; length_m?: number;
  geometry: { type: "Polygon" | "LineString" | "Point"; coordinates?: unknown };
  label?: string; priceLineId?: string;
}
export interface OfferLine {
  id: string; service: ServiceKey; role: string; label: string; subtype: string;
  category: string; emoji: string; qty: number | null; unit: string; rate: number | null;
  cadence: string; computed: number; final: number; price: number; overridden: boolean;
  inScope: boolean; deliveredBy: string; partnerName: string | null;
  compliance: boolean; oneOff: boolean; measure: string;
  review: { decision: string | null; comment: string };
  zoneId?: string | null;
}
export interface OfferModule {
  service: ServiceKey; title: string; lines: OfferLine[]; included: boolean;
  startDate: string; indexationPct: number; cap: number; subtotal: number;
}
export interface Offer {
  version: number; createdAt: string; period: "mnd" | "år";
  modules: OfferModule[]; optionLines: OfferLine[]; lines: OfferLine[]; upsells: OfferLine[];
  totalMonthly: number; totalYearly: number; travel: number; terms: unknown; coverNote: string;
}
export interface ChecklistItem { id: string; scope: "in" | "upsell" | "out" | "unknown"; price?: number; value?: unknown; subtype?: string; label?: string; oneOff?: boolean; emoji?: string; category?: string; compliance?: boolean; }
export interface Request { id: string; title: string; desc?: string; category?: string; area?: string; urgency?: Urgency; status: string; done?: boolean; ts: string; estCost?: number | null; source?: string; channel?: string | null; }
export interface ContractScope { services: { serviceId: string; label: string; cadence: string; source: string; keywords: string[]; compliance?: boolean; trig?: string }[]; standards: string[]; parsedFrom: string; ts: string | null; }
export interface Customer {
  id: string; name: string; period?: "mnd" | "år"; floors?: number | null;
  checklist?: ChecklistItem[]; zones?: Zone[]; markers?: any[]; compliance?: { label: string }[];
  requests?: Request[]; offer?: Offer | null; addedLines?: any[]; radarActioned?: string[];
  contractScope?: ContractScope | null; terms?: unknown;
}
export interface ScheduleLine { lineId: string; building?: string; title: string; category?: string; zone?: number; partner?: string | null; statutory?: boolean; schedule: { type: string; [k: string]: unknown }; }
export interface ScheduleInstance { lineId: string; building?: string; title: string; date: string; freq: string; }
export interface RadarOpportunity { id: string; type: "repeat" | "seasonal" | "upsell" | "winloss"; key: string; label: string; evidence: string; estValueYr: number | null; suggestedCadence: string; service: string; sourceIds: string[]; confidence: number; }
export interface IntakeParse { category: string | null; categoryTrig: string; area: string | null; areaTrig: string; urgency: Urgency; urgencyTrig: string; buildingId: string | null; buildingTrig: string | null; needsPhoto: boolean; needsPhotoTrig: string | null; }
export interface Classification { cls: ScopeClass; reason: string; safety: boolean; }

/* ---- engines ---- */
export function computeOffer(c: Customer, opts?: { nowStr?: string; LAYERS?: Record<string, any>; catLabel?: (k: string) => string }): Offer;
export function syncOfferTotals(c: Customer): void;
export function rebuildOfferFlat(c: Customer): void;
export function oLine(o: Partial<OfferLine> & { id: string; service: ServiceKey; label: string }): OfferLine;
export function lineRemoved(l: OfferLine): boolean;

export function expandLine(line: ScheduleLine, from: Date, to: Date): ScheduleInstance[];
export function generateInstances(lines: ScheduleLine[], from: Date, to: Date): ScheduleInstance[];
export function freqText(s: { type: string; [k: string]: unknown }): string;

// while-here ranking (Phase 7): the pure scoring/dedupe half of suggestWhileHere. The app gathers candidates
// (catalogue- + completedInstances/instKey-coupled); core ranks them. Mutates+returns survivors, sorted by score.
export interface WhileHereCandidate { title: string; area: string; equipment?: string[]; statutory?: boolean; daysUntil: number; _svc?: string; [k: string]: unknown; }
export interface WhileHereReason { k: "loc" | "time" | "equip" | "comp"; icon: string; text: string; }
export function rankWhileHere(cand: WhileHereCandidate[], opts?: { hereAreas?: Record<string, unknown>; hereEquip?: Record<string, unknown>; WHILE_WINDOW?: number; teamServices?: string[] | null; areaLabel?: (a: string) => string; equipTypeLabel?: (t: string) => string }): (WhileHereCandidate & { reasons: WhileHereReason[]; score: number; coLoc: boolean })[];

export function recurringRadar(c: Customer, opts?: { now?: Date }): RadarOpportunity[];
export function radarKeyword(s: string): string;
export function radarSeasonOf(isoStr: string): string;

export function parseIntake(text: string, ctx?: { buildingId?: string | null; photoIds?: string[]; customers?: Customer[] }): IntakeParse;
export function intakeTitle(text: string): string;
export function channelLabel(ch: string): string;

export function parseContract(text: string): ContractScope;
export function classifyAgainstScope(c: Customer, request: { title?: string; desc?: string }): Classification;
export function scopeFromOffer(c: Customer): ContractScope;
export function deriveScope(c: Customer): ContractScope | null;
export function scopeMismatch(c: Customer): { label: string; why: string }[];
export function scopeKeyword(text: string): string;
export function scopeDomLabel(k: string): string;

export function geoArea(pts: LngLat[]): number;   // pts = [[lat,lng],…]; returns m²
export function geoLength(pts: LngLat[]): number;  // returns metres

// NB: migration is NOT exported — it stays in the app (index.html `migrate`, parse-time + demo()-coupled).
// See CORE-EXTRACTION.md.

/* ---- data + formatters ---- */
export const RATES: Record<string, Record<string, number>>;
export const MOD_TITLES: Record<ServiceKey, string>;
export const MOD_ORDER: ServiceKey[];
export const INTAKE_CHANNELS: [string, string][];
export const VERSION: string;
export function kr(n: number): string;
export function cap(s: string): string;
export function iso(d: Date): string;
export function dateLabel(d: Date): string;
export function tsLabel(ts: string | number | Date): string;
