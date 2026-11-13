/**
 * The scenario editor's form model: every field as the text the user typed, so half-typed or empty
 * inputs are representable. `scenarioToForm` fills a form from a scenario; `formToScenario` turns it
 * back into a scenario plus a list of problems in plain words. Fields the form does not show
 * (departures, custom arrival points, manual-lane service time, …) are carried over from the base
 * scenario unchanged. Pure; tested in library.test.ts, including "every editor output is valid
 * against the JSON Schema".
 */

import { RUN_DEFAULTS } from "@bottleneck/engine";
import type { BagPolicy, Distribution, ElementOverride, EventType, Scenario, ScenarioParameters, TimedEvent, Venue } from "@bottleneck/schema";
import { DEFAULT_SERVICE_SIGMA, cloneScenario, pruneOverrides, readSimpleServiceTime, simpleServiceTime, venueElements } from "./scenarios.ts";

export interface Problem {
  /** Which form field (for highlighting), or "" for the whole scenario. */
  field: string;
  message: string;
}

/** A time input in minutes relative to t = 0. Remembers the exact seconds it came from, so an untouched field round-trips bit for bit. */
export interface TimeField {
  text: string;
  seconds: number | null;
}

export type ServiceMode = "default" | "simple" | "json";

export interface ElementForm {
  id: string;
  kind: "gate" | "screening";
  name: string;
  laneCount: string;
  serviceMode: ServiceMode;
  serviceMin: string;
  serviceMean: string;
  serviceSigma: string;
  serviceJson: string;
  scanFailurePercent: string;
}

export interface EventForm {
  /** Stable key for React lists. */
  key: number;
  kind: TimedEvent["kind"];
  at: TimeField;
  groupId: string;
  /** 1-based lane number as shown to people. */
  laneNumber: string;
  sourceId: string;
  count: string;
}

export type ArrivalPreset = Scenario["arrivals"]["preset"];

export interface ScenarioForm {
  name: string;
  eventType: EventType;
  arrivalPreset: ArrivalPreset;
  /** Number of custom arrival points carried over from the base scenario (0 = none). */
  customPoints: number;
  /** False once the user removes the custom points. */
  keepCustomPoints: boolean;
  attendance: string;
  referenceClock: string;
  fixedStart: boolean;
  gatesOpen: TimeField;
  eventStart: TimeField;
  eventEnd: TimeField;
  horizon: TimeField;
  seed: string;
  carSharePercent: string;
  /** Free walking speed (truncated normal); null when the scenario uses another kind (kept as is). */
  walking: { mean: string; sd: string } | null;
  nearestLaneSharePercent: string;
  groupSizes: string;
  bagPolicy: "" | BagPolicy;
  decisionDistance: string;
  logitScale: string;
  jockeyThreshold: string;
  elements: ElementForm[];
  events: EventForm[];
}

export const EVENT_TYPES: readonly EventType[] = ["concert", "stadium", "fair", "conference"];
export const ARRIVAL_PRESETS: readonly ArrivalPreset[] = ["concert", "stadium", "fair", "conference", "custom"];
export const BAG_POLICIES: readonly BagPolicy[] = ["none", "clearBag", "fullSearch"];

// ---------------------------------------------------------------------------------------------
// Number formatting and parsing
// ---------------------------------------------------------------------------------------------

/** Shortest text for a number, at most `digits` decimals. */
export function numText(x: number | undefined | null, digits = 4): string {
  if (x === undefined || x === null || !Number.isFinite(x)) return "";
  return String(Number(x.toFixed(digits)));
}

export function timeField(seconds: number | null): TimeField {
  return { text: seconds === null ? "" : numText(seconds / 60, 4), seconds };
}

export function editTime(field: TimeField, text: string): TimeField {
  return { text, seconds: field.seconds !== null && text === timeField(field.seconds).text ? field.seconds : null };
}

/** Parses a number field; empty text gives `undefined`, garbage gives NaN. Accepts a decimal comma. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "") return undefined;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number.NaN;
  return Number(t);
}

/** Seconds of a time field: the remembered exact value if untouched, else minutes × 60 rounded to 1 ms. */
export function parseTime(field: TimeField): number | undefined {
  if (field.seconds !== null && field.text === timeField(field.seconds).text) return field.seconds;
  const m = parseNumber(field.text);
  if (m === undefined || Number.isNaN(m)) return m;
  return Math.round(m * 60 * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------
// Scenario → form
// ---------------------------------------------------------------------------------------------

let nextKey = 1;

export function eventToForm(e: TimedEvent): EventForm {
  const base = { key: nextKey++, at: timeField(e.at), groupId: "", laneNumber: "1", sourceId: "", count: "" };
  if (e.kind === "busBurst") return { ...base, kind: e.kind, sourceId: e.sourceId, count: String(e.count) };
  // A lot closing keeps its lot id in groupId (the editor has no lot picker yet).
  if (e.kind === "lotClose") return { ...base, kind: e.kind, groupId: e.lotId };
  return { ...base, kind: e.kind, groupId: e.groupId, laneNumber: String(e.laneIndex + 1) };
}

/** A new timed event row with sensible defaults for this venue. */
export function newEventForm(kind: TimedEvent["kind"], venue: Venue, atSeconds: number): EventForm {
  const firstElement = venueElements(venue).find((e) => e.kind === "gate") ?? venueElements(venue)[0];
  return { key: nextKey++, kind, at: timeField(atSeconds), groupId: firstElement?.id ?? "", laneNumber: "1", sourceId: venue.sources[0]?.id ?? "", count: kind === "busBurst" ? "500" : "" };
}

export function scenarioToForm(s: Scenario, venue: Venue): ScenarioForm {
  const p = s.parameters ?? {};
  const walk = p.freeWalkingSpeed;
  const elements: ElementForm[] = venueElements(venue).map((el) => {
    const o = s.overrides?.[el.id] ?? {};
    const simple = o.serviceTime ? readSimpleServiceTime(o.serviceTime) : null;
    const venueSimple = readSimpleServiceTime(el.serviceTime);
    return {
      id: el.id,
      kind: el.kind,
      name: el.name,
      laneCount: o.laneCount !== undefined ? String(o.laneCount) : "",
      serviceMode: o.serviceTime === undefined ? "default" : simple ? "simple" : "json",
      serviceMin: simple ? numText(simple.min, 3) : venueSimple ? numText(venueSimple.min, 3) : "",
      serviceMean: simple ? numText(simple.mean, 3) : venueSimple ? numText(venueSimple.mean, 3) : "",
      serviceSigma: numText(simple?.sigma ?? venueSimple?.sigma ?? DEFAULT_SERVICE_SIGMA, 3),
      serviceJson: JSON.stringify(o.serviceTime ?? el.serviceTime),
      scanFailurePercent: o.scanFailureRate !== undefined ? numText(o.scanFailureRate * 100, 3) : "",
    };
  });
  return {
    name: s.name,
    eventType: s.eventType,
    arrivalPreset: s.arrivals.preset,
    customPoints: s.arrivals.points?.length ?? 0,
    keepCustomPoints: true,
    attendance: String(s.attendance),
    referenceClock: s.timeline.referenceClock,
    fixedStart: s.timeline.eventStart !== null,
    gatesOpen: timeField(s.timeline.gatesOpen),
    eventStart: timeField(s.timeline.eventStart ?? 0),
    eventEnd: timeField(s.timeline.eventEnd),
    horizon: timeField(s.timeline.horizon),
    seed: String(s.seed),
    carSharePercent: numText(s.carShare * 100, 3),
    walking: walk === undefined ? { mean: "", sd: "" } : walk.kind === "truncatedNormal" ? { mean: numText(walk.mean, 3), sd: numText(walk.sd, 3) } : null,
    nearestLaneSharePercent: p.nearestLaneShare !== undefined ? numText(p.nearestLaneShare * 100, 3) : "",
    groupSizes: p.groupSizes ? p.groupSizes.map((w) => numText(w, 4)).join(", ") : "",
    bagPolicy: p.bagPolicy ?? "",
    decisionDistance: numText(p.decisionDistance, 3),
    logitScale: numText(p.logitScale, 3),
    jockeyThreshold: p.jockeyThreshold !== undefined ? String(p.jockeyThreshold) : "",
    elements,
    events: (s.timedEvents ?? []).map(eventToForm),
  };
}

// ---------------------------------------------------------------------------------------------
// Form → scenario
// ---------------------------------------------------------------------------------------------

class Collector {
  readonly problems: Problem[] = [];
  add(field: string, message: string): void {
    this.problems.push({ field, message });
  }
  /** A number within [min, max]; `undefined` if empty and optional. */
  number(field: string, label: string, text: string, opts: { min?: number; max?: number; integer?: boolean; required?: boolean; exclusiveMin?: boolean }): number | undefined {
    const v = parseNumber(text);
    if (v === undefined) {
      if (opts.required) this.add(field, `${label} is required.`);
      return undefined;
    }
    const range = rangeText(opts);
    if (Number.isNaN(v) || (opts.integer && !Number.isInteger(v)) || (opts.min !== undefined && (opts.exclusiveMin ? v <= opts.min : v < opts.min)) || (opts.max !== undefined && v > opts.max)) {
      this.add(field, `${label} must be ${opts.integer ? "a whole number" : "a number"}${range}.`);
      return undefined;
    }
    return v;
  }
  time(field: string, label: string, f: TimeField, required: boolean): number | undefined {
    const v = parseTime(f);
    if (v === undefined) {
      if (required) this.add(field, `${label} is required.`);
      return undefined;
    }
    if (Number.isNaN(v)) {
      this.add(field, `${label} must be a number of minutes (negative means before t = 0).`);
      return undefined;
    }
    return v;
  }
}

function rangeText(o: { min?: number; max?: number; exclusiveMin?: boolean }): string {
  const fmt = (x: number) => x.toLocaleString("en-GB");
  if (o.min !== undefined && o.max !== undefined) return o.exclusiveMin ? ` above ${fmt(o.min)} and at most ${fmt(o.max)}` : ` from ${fmt(o.min)} to ${fmt(o.max)}`;
  if (o.min !== undefined) return o.exclusiveMin ? ` above ${fmt(o.min)}` : ` of at least ${fmt(o.min)}`;
  if (o.max !== undefined) return ` of at most ${fmt(o.max)}`;
  return "";
}

/**
 * Builds a scenario from the form. `base` supplies everything the form does not show. The result
 * is null if a field could not be read; schema and cross-field checks run in validate.ts.
 */
export function formToScenario(form: ScenarioForm, base: Scenario, venue: Venue): { scenario: Scenario | null; problems: Problem[] } {
  const c = new Collector();
  const s = cloneScenario(base);
  s.venueId = venue.id ?? s.venueId;

  const name = form.name.trim();
  if (name.length === 0) c.add("name", "Give the scenario a name.");
  else if (name.length > 120) c.add("name", "The name can be at most 120 characters.");
  s.name = name;
  s.eventType = form.eventType;

  // Arrivals
  const points = form.keepCustomPoints ? base.arrivals.points : undefined;
  s.arrivals = { preset: form.arrivalPreset, ...(points && points.length >= 2 ? { points } : {}) };
  if (form.arrivalPreset === "custom" && !(points && points.length >= 2)) c.add("arrivalPreset", "The “custom” arrival curve needs points (for example from a fitted scan log). Pick a preset instead.");

  s.attendance = c.number("attendance", "Attendance", form.attendance, { min: 1, max: 200000, integer: true, required: true }) ?? s.attendance;

  // Timeline
  const clock = form.referenceClock.trim();
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(clock)) c.add("referenceClock", "The clock time of t = 0 must look like 20:00 (24-hour, two digits each).");
  const gatesOpen = c.time("gatesOpen", "Gate opening time", form.gatesOpen, true);
  const eventStart = form.fixedStart ? c.time("eventStart", "Event start", form.eventStart, true) : null;
  const eventEnd = c.time("eventEnd", "Event end", form.eventEnd, true);
  const horizon = c.time("horizon", "Simulation end", form.horizon, true);
  s.timeline = {
    referenceClock: clock,
    gatesOpen: gatesOpen ?? base.timeline.gatesOpen,
    eventStart: eventStart === undefined ? base.timeline.eventStart : eventStart,
    eventEnd: eventEnd ?? base.timeline.eventEnd,
    horizon: horizon ?? base.timeline.horizon,
  };

  s.seed = c.number("seed", "Seed", form.seed, { min: 0, max: 4294967295, integer: true, required: true }) ?? s.seed;
  const carShare = c.number("carSharePercent", "Car share", form.carSharePercent, { min: 0, max: 100, required: true });
  s.carShare = carShare !== undefined ? carShare / 100 : s.carShare;

  // Parameters: an empty field removes the value, so the built-in default (assumed) is used.
  const p: ScenarioParameters = { ...(base.parameters ?? {}) };
  const setParam = <K extends keyof ScenarioParameters>(key: K, value: ScenarioParameters[K] | undefined) => {
    if (value === undefined) delete p[key];
    else p[key] = value;
  };
  if (form.walking) {
    const mean = c.number("walking.mean", "Mean walking speed", form.walking.mean, { min: 0.2, max: 3 });
    const sd = c.number("walking.sd", "Walking speed spread", form.walking.sd, { min: 0, max: 2 });
    if (mean === undefined && sd === undefined) setParam("freeWalkingSpeed", undefined);
    else {
      const d = RUN_DEFAULTS.freeWalkingSpeed;
      const m = mean ?? d.mean;
      setParam("freeWalkingSpeed", { kind: "truncatedNormal", mean: m, sd: sd ?? d.sd, min: Math.min(d.min, m), max: Math.max(d.max, m) });
    }
  }
  const nearest = c.number("nearestLaneSharePercent", "Share taking the nearest lane", form.nearestLaneSharePercent, { min: 0, max: 100 });
  setParam("nearestLaneShare", nearest === undefined ? undefined : nearest / 100);
  setParam("groupSizes", parseGroupSizes(c, form.groupSizes));
  setParam("bagPolicy", form.bagPolicy === "" ? undefined : form.bagPolicy);
  setParam("decisionDistance", c.number("decisionDistance", "Lane decision distance", form.decisionDistance, { min: 0, max: 500, exclusiveMin: true }));
  setParam("logitScale", c.number("logitScale", "Lane choice sensitivity τ", form.logitScale, { min: 0, max: 3600, exclusiveMin: true }));
  setParam("jockeyThreshold", c.number("jockeyThreshold", "Lane switching threshold", form.jockeyThreshold, { min: 1, max: 1000, integer: true }));
  if (Object.keys(p).length > 0) s.parameters = p;
  else delete s.parameters;

  // Element overrides; overrides for elements the venue does not have are kept as they were.
  const overrides: Record<string, ElementOverride | undefined> = { ...(base.overrides ?? {}) };
  for (const el of form.elements) {
    const o: ElementOverride = {};
    const lanes = c.number(`elements.${el.id}.laneCount`, `${el.name}: lanes`, el.laneCount, { min: 1, max: 64, integer: true });
    if (lanes !== undefined) o.laneCount = lanes;
    const st = serviceFromForm(c, el);
    if (st !== undefined) o.serviceTime = st;
    if (el.kind === "gate") {
      const fail = c.number(`elements.${el.id}.scanFailurePercent`, `${el.name}: scan failure rate`, el.scanFailurePercent, { min: 0, max: 100 });
      if (fail !== undefined) o.scanFailureRate = fail / 100;
    }
    overrides[el.id] = o;
  }
  const pruned = pruneOverrides(overrides);
  if (pruned) s.overrides = pruned;
  else delete s.overrides;

  // Timed events, sorted by time (stable).
  const events: TimedEvent[] = [];
  form.events.forEach((e, k) => {
    const label = `Timed event ${k + 1}`;
    const at = c.time(`events.${e.key}.at`, `${label}: time`, e.at, true);
    if (at === undefined) return;
    if (e.kind === "busBurst") {
      const count = c.number(`events.${e.key}.count`, `${label}: number of people`, e.count, { min: 1, max: 5000, integer: true, required: true });
      if (!e.sourceId) c.add(`events.${e.key}.sourceId`, `${label}: choose where the people appear.`);
      if (count !== undefined && e.sourceId) events.push({ kind: "busBurst", at, sourceId: e.sourceId, count });
    } else if (e.kind === "lotClose") {
      if (!e.groupId) c.add(`events.${e.key}.groupId`, `${label}: choose the parking lot.`);
      else events.push({ kind: "lotClose", at, lotId: e.groupId });
    } else {
      const lane = c.number(`events.${e.key}.laneNumber`, `${label}: lane number`, e.laneNumber, { min: 1, max: 64, integer: true, required: true });
      if (!e.groupId) c.add(`events.${e.key}.groupId`, `${label}: choose the gate group or screening stage.`);
      const kind = e.kind;
      if (lane !== undefined && e.groupId) events.push({ kind, at, groupId: e.groupId, laneIndex: lane - 1 });
    }
  });
  const sorted = events.map((e, k) => ({ e, k })).sort((a, b) => a.e.at - b.e.at || a.k - b.k).map((x) => x.e);
  if (sorted.length > 0) s.timedEvents = sorted;
  else delete s.timedEvents;

  return { scenario: c.problems.length === 0 ? s : null, problems: c.problems };
}

function parseGroupSizes(c: Collector, text: string): number[] | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const parts = t.split(/[\s,;]+/).filter((x) => x !== "");
  const values = parts.map((x) => parseNumber(x));
  if (values.length < 1 || values.length > 8 || values.some((v) => v === undefined || Number.isNaN(v) || v < 0) || !values.some((v) => (v ?? 0) > 0)) {
    c.add("groupSizes", "Group sizes: 1 to 8 non-negative numbers separated by commas (shares of groups of 1, 2, 3, … people), not all zero.");
    return undefined;
  }
  return values as number[];
}

function serviceFromForm(c: Collector, el: ElementForm): Distribution | undefined {
  const field = `elements.${el.id}.service`;
  switch (el.serviceMode) {
    case "default":
      return undefined;
    case "simple": {
      const min = c.number(`${field}Min`, `${el.name}: minimum service time`, el.serviceMin, { min: 0, max: 3600, required: true });
      const mean = c.number(`${field}Mean`, `${el.name}: mean service time`, el.serviceMean, { min: 0, max: 3600, exclusiveMin: true, required: true });
      const sigma = c.number(`${field}Sigma`, `${el.name}: shape σ`, el.serviceSigma, { min: 0.05, max: 3 }) ?? DEFAULT_SERVICE_SIGMA;
      if (min === undefined || mean === undefined) return undefined;
      if (!(mean > min)) {
        c.add(`${field}Mean`, `${el.name}: the mean service time must be above the minimum.`);
        return undefined;
      }
      return simpleServiceTime(min, mean, sigma);
    }
    case "json": {
      try {
        const d = JSON.parse(el.serviceJson) as unknown;
        if (typeof d !== "object" || d === null || Array.isArray(d) || typeof (d as { kind?: unknown }).kind !== "string") throw new Error("not a distribution");
        return d as Distribution;
      } catch {
        c.add(`${field}Json`, `${el.name}: the service time is not valid JSON (expected something like {"kind": "uniform", "min": 2, "max": 6}).`);
        return undefined;
      }
    }
  }
}
