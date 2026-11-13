/**
 * Scenario validation before saving or importing: (1) the JSON Schema (the same /schema files the
 * backend will use), through a validator compiled at build time (see validation/buildValidator.ts),
 * and (2) checks the schema cannot express, against the venue: element ids, lane numbers, sources,
 * and the order of the timeline. Messages are plain sentences. Pure; the schema validator is passed in.
 */

import { SCHEMA_VERSION, type Scenario, type Venue } from "@bottleneck/schema";
import type { Problem } from "./form.ts";
import { venueElements } from "./scenarios.ts";

/** The parts of an Ajv error object used here. */
export interface SchemaError {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
}

export type SchemaValidator = (data: unknown) => { ok: boolean; errors: SchemaError[] };

const MAX_SCHEMA_MESSAGES = 8;

/** "/timeline/horizon" → "timeline › horizon"; "/timedEvents/2/at" → "timed event 3 › at". */
export function pathLabel(instancePath: string): string {
  if (instancePath === "") return "scenario";
  const parts = instancePath.split("/").slice(1);
  const out: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k] as string;
    const next = parts[k + 1];
    if (p === "timedEvents" && next !== undefined && /^\d+$/.test(next)) {
      out.push(`timed event ${Number(next) + 1}`);
      k++;
    } else if (p === "overrides" && next !== undefined) {
      out.push(`override for “${next}”`);
      k++;
    } else if (/^\d+$/.test(p)) out.push(`item ${Number(p) + 1}`);
    else out.push(p);
  }
  return out.join(" › ");
}

/** Schema errors as short sentences, without the noise of every failed `oneOf` branch. */
export function schemaMessages(errors: readonly SchemaError[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // oneOf/anyOf summaries say nothing useful when the branch errors are shown too.
  const specific = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf");
  for (const e of specific.length > 0 ? specific : errors) {
    let msg = e.message ?? "is not valid";
    if (e.keyword === "additionalProperties" && typeof e.params?.additionalProperty === "string") msg = `has an unknown field “${e.params.additionalProperty}”`;
    if (e.keyword === "const" && e.params?.allowedValue !== undefined) msg = `must be ${JSON.stringify(e.params.allowedValue)}`;
    if (e.keyword === "enum" && Array.isArray(e.params?.allowedValues)) msg = `must be one of ${(e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    const text = `${pathLabel(e.instancePath)} ${msg}.`;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text.charAt(0).toUpperCase() + text.slice(1));
  }
  if (out.length > MAX_SCHEMA_MESSAGES) return [...out.slice(0, MAX_SCHEMA_MESSAGES), `…and ${out.length - MAX_SCHEMA_MESSAGES} more.`];
  return out;
}

/** Checks against the venue that the JSON Schema cannot express. */
export function venueProblems(s: Scenario, venue: Venue): Problem[] {
  const out: Problem[] = [];
  if (venue.id !== undefined && s.venueId !== venue.id) out.push({ field: "", message: `This scenario belongs to venue “${s.venueId}”, not to “${venue.name}”.` });
  const elements = venueElements(venue);
  const byId = new Map(elements.map((e) => [e.id, e]));
  // Vehicle barriers, parking lots and pay stations (Phase 3) can be overridden too; the editor does not show them yet.
  const vehicleIds = new Set([...(venue.vehicleBarriers ?? []).map((b) => b.id), ...(venue.parkingLots ?? []).flatMap((l) => [l.id, ...(l.payStation ? [l.payStation.id] : [])])]);
  for (const id of Object.keys(s.overrides ?? {}).sort()) {
    const el = byId.get(id);
    if (!el && vehicleIds.has(id)) continue;
    if (!el) out.push({ field: "", message: `There is a change for “${id}”, but the venue has no gate group or screening stage with that id.` });
    else if (el.kind === "screening" && s.overrides?.[id]?.scanFailureRate !== undefined) out.push({ field: `elements.${id}.scanFailurePercent`, message: `${el.name} is a screening stage; only gate groups have a scan failure rate.` });
  }
  (s.timedEvents ?? []).forEach((e, k) => {
    const label = `Timed event ${k + 1}`;
    if (e.kind === "busBurst") {
      if (!venue.sources.some((src) => src.id === e.sourceId)) out.push({ field: "", message: `${label}: the venue has no source “${e.sourceId}”.` });
      return;
    }
    if (e.kind === "lotClose") {
      if (!(venue.parkingLots ?? []).some((l) => l.id === e.lotId)) out.push({ field: "", message: `${label}: the venue has no parking lot “${e.lotId}”.` });
      return;
    }
    const el = byId.get(e.groupId);
    if (!el) {
      out.push({ field: "", message: `${label}: the venue has no gate group or screening stage “${e.groupId}”.` });
      return;
    }
    const lanes = s.overrides?.[e.groupId]?.laneCount ?? el.laneCount;
    if (e.laneIndex >= lanes) out.push({ field: "", message: `${label}: ${el.name} has ${lanes} lane${lanes === 1 ? "" : "s"} in this scenario, so there is no lane ${e.laneIndex + 1}.` });
  });
  const tl = s.timeline;
  if (tl.eventStart !== null && tl.gatesOpen > tl.eventStart) out.push({ field: "gatesOpen", message: "The gates open after the event starts." });
  if (tl.eventStart !== null && tl.eventEnd < tl.eventStart) out.push({ field: "eventEnd", message: "The event ends before it starts." });
  if (tl.horizon <= tl.gatesOpen) out.push({ field: "horizon", message: "The simulation must end after the gates open." });
  if (s.arrivals.preset === "custom" && !(s.arrivals.points && s.arrivals.points.length >= 2)) out.push({ field: "arrivalPreset", message: "The custom arrival curve has no points." });
  if (s.arrivals.points && !s.arrivals.points.some((p) => p.weight > 0)) out.push({ field: "arrivalPreset", message: "Every point of the custom arrival curve has weight 0, so nobody would arrive." });
  if (s.eventType === "fair" && tl.eventStart !== null) out.push({ field: "fixedStart", message: "A fair is an open-door event: untick “fixed start” or choose another event type." });
  return out;
}

/** All problems of a scenario document: schema first (if it fails, the venue checks may not apply). */
export function checkScenario(data: unknown, venue: Venue | null, validate: SchemaValidator): Problem[] {
  if (typeof data === "object" && data !== null && (data as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
    return [{ field: "", message: `This file has schemaVersion ${JSON.stringify((data as { schemaVersion?: unknown }).schemaVersion)}; this version of Bottleneck reads version ${SCHEMA_VERSION}.` }];
  }
  const result = validate(data);
  if (!result.ok) return schemaMessages(result.errors).map((message) => ({ field: "", message }));
  return venue ? venueProblems(data as Scenario, venue) : [];
}
