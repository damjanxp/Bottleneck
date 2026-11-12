/**
 * Pure helpers for working with scenario documents: ids, blank defaults, duplicates, timed events
 * and service-time presets. No React, no storage; tested in library.test.ts.
 */

import { distributionMoments, shiftedLognormalFromMean } from "@bottleneck/engine";
import type { Distribution, ElementOverride, Scenario, TimedEvent, Venue } from "@bottleneck/schema";

/** A gate group or screening stage as the editor shows it, with the venue's own (default) values. */
export interface VenueElement {
  id: string;
  kind: "gate" | "screening";
  name: string;
  laneCount: number;
  serviceTime: Distribution;
  /** Gate groups only. */
  scanFailureRate: number | null;
}

export function venueElements(venue: Venue): VenueElement[] {
  return [
    ...venue.screeningStages.map((s) => ({ id: s.id, kind: "screening" as const, name: s.name, laneCount: s.laneCount, serviceTime: s.serviceTime, scanFailureRate: null })),
    ...venue.gateGroups.map((g) => ({ id: g.id, kind: "gate" as const, name: g.name, laneCount: g.laneCount, serviceTime: g.serviceTime, scanFailureRate: g.scanFailure.rate })),
  ];
}

/** The lane count an element runs with in this scenario (override, else the venue's). */
export function effectiveLaneCount(scenario: Scenario, venue: Venue, elementId: string): number | null {
  const el = venueElements(venue).find((e) => e.id === elementId);
  if (!el) return null;
  return scenario.overrides?.[elementId]?.laneCount ?? el.laneCount;
}

/** Id pattern of /schema common.schema.json#/definitions/Id. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A new id for a user scenario, e.g. "user-mhx3k2a1-4f9q". `now` and `random` are injectable for tests. */
export function newScenarioId(now: number = Date.now(), random: () => number = Math.random): string {
  const r = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `user-${Math.max(0, Math.floor(now)).toString(36)}-${r}`;
}

/** Default scenario for a venue: a fixed-start concert-style evening, or an open-door day for fair venues. */
export function blankScenario(venue: Venue, id: string, openDoor = false): Scenario {
  return {
    schemaVersion: 1,
    id,
    venueId: venue.id ?? "venue",
    name: "New scenario",
    eventType: openDoor ? "fair" : "concert",
    timeline: openDoor ? { referenceClock: "10:00", gatesOpen: 0, eventStart: null, eventEnd: 7200, horizon: 9000 } : { referenceClock: "20:00", gatesOpen: -5400, eventStart: 0, eventEnd: 9000, horizon: 3600 },
    attendance: 3000,
    carShare: 0,
    arrivals: { preset: openDoor ? "fair" : "concert" },
    seed: 1,
  };
}

/** Deep copy of a JSON document (scenarios are plain JSON). */
export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s)) as Scenario;
}

export function duplicateScenario(s: Scenario, id: string, name: string): Scenario {
  return { ...cloneScenario(s), id, name };
}

/** "Concert, 3 lanes (copy)", trimmed to the schema's 120 characters. */
export function copyName(name: string, suffix = " (copy)"): string {
  return (name.slice(0, 120 - suffix.length) + suffix).trim();
}

/** Inserts a timed event, keeping the list sorted by time (stable: equal times keep their order). */
export function withTimedEvent(s: Scenario, event: TimedEvent): Scenario {
  const events = [...(s.timedEvents ?? [])];
  let k = events.length;
  while (k > 0 && (events[k - 1] as TimedEvent).at > event.at) k--;
  events.splice(k, 0, event);
  return { ...s, timedEvents: events };
}

/** One more regular lane at element `elementId` (which has `laneCount` lanes now), capped at 64. */
export function withLaneCount(s: Scenario, elementId: string, laneCount: number): Scenario {
  const overrides = { ...(s.overrides ?? {}) };
  overrides[elementId] = { ...(overrides[elementId] ?? {}), laneCount: Math.min(64, Math.max(1, Math.round(laneCount))) };
  return { ...s, overrides };
}

/** Removes empty override objects (the schema needs at least one property per override). */
export function pruneOverrides(overrides: Record<string, ElementOverride | undefined>): Record<string, ElementOverride> | undefined {
  const out: Record<string, ElementOverride> = {};
  for (const id of Object.keys(overrides).sort()) {
    const o = overrides[id];
    if (o && Object.keys(o).length > 0) out[id] = o;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Default shape (σ of the lognormal part) when an element's own distribution gives none. */
export const DEFAULT_SERVICE_SIGMA = 0.5;

/** "Minimum + mean" helper: a shifted lognormal with exactly that minimum and mean. */
export function simpleServiceTime(min: number, mean: number, sigma = DEFAULT_SERVICE_SIGMA): Distribution {
  return shiftedLognormalFromMean(min, mean, sigma);
}

/** The minimum, mean and σ of a shifted lognormal; null for other kinds. */
export function readSimpleServiceTime(d: Distribution): { min: number; mean: number; sigma: number } | null {
  if (d.kind !== "shiftedLognormal") return null;
  return { min: d.shift, mean: distributionMoments(d).mean, sigma: d.sigma };
}

/**
 * A service time with a new mean but the "shape" of an existing one: a shifted lognormal keeps its
 * σ and its minimum (scaled down if the mean falls below it); anything else becomes a shifted
 * lognormal with the default σ and a minimum of 60% of the mean.
 */
export function serviceTimeWithMean(shape: Distribution, mean: number): Distribution {
  const s = readSimpleServiceTime(shape);
  if (s && s.min < mean * 0.95) return simpleServiceTime(s.min, mean, s.sigma);
  return simpleServiceTime(round3(mean * 0.6), mean, s?.sigma ?? DEFAULT_SERVICE_SIGMA);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
