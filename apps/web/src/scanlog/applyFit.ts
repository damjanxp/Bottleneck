/**
 * Turns a fitted scan log into a new scenario: custom arrival points, attendance from the log,
 * and each matching gate group's (or screening stage's) service time set to the fitted mean with
 * the venue's distribution shape (serviceTimeWithMean). Pure; tested in scanlog.test.ts.
 */

import type { ScanLogFit } from "@bottleneck/analysis";
import type { Scenario, Venue } from "@bottleneck/schema";
import { cloneScenario, serviceTimeWithMean, venueElements } from "../library/scenarios.ts";

export interface AppliedFit {
  scenario: Scenario;
  /** Fitted groups with no gate group or screening stage of that id in the venue. */
  unmatched: string[];
}

/** People in the log: passes on regular (non-manual) lanes. */
export function peopleInLog(fit: ScanLogFit): number {
  return fit.lanes.filter((l) => !l.group.endsWith("#manual")).reduce((s, l) => s + l.passes, 0);
}

/** At most 200 points (schema limit), at least 2, weights ≥ 0. */
export function arrivalPoints(fit: ScanLogFit): { t: number; weight: number }[] {
  let pts = fit.arrivals.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.weight)).map((p) => ({ t: p.t, weight: Math.max(0, p.weight) }));
  if (pts.length > 200) {
    const step = Math.ceil(pts.length / 200);
    pts = pts.filter((_, k) => k % step === 0);
  }
  return pts;
}

export function applyFit(fit: ScanLogFit, base: Scenario, venue: Venue, id: string, name: string): AppliedFit {
  const s = cloneScenario(base);
  s.id = id;
  s.name = name.slice(0, 120);
  s.venueId = venue.id ?? s.venueId;
  const points = arrivalPoints(fit);
  if (points.length >= 2 && points.some((p) => p.weight > 0)) s.arrivals = { preset: "custom", points };
  const people = peopleInLog(fit);
  if (people >= 1) s.attendance = Math.min(200000, people);
  const elements = venueElements(venue);
  const overrides = { ...(s.overrides ?? {}) };
  const unmatched: string[] = [];
  for (const g of fit.groups) {
    if (g.group.endsWith("#manual")) continue;
    const el = elements.find((e) => e.id === g.group);
    if (!el) {
      unmatched.push(g.group);
      continue;
    }
    if (g.meanServiceTime === null || !(g.meanServiceTime > 0)) continue;
    const current = overrides[el.id]?.serviceTime ?? el.serviceTime;
    overrides[el.id] = { ...(overrides[el.id] ?? {}), serviceTime: serviceTimeWithMean(current, g.meanServiceTime) };
  }
  // An element override beats the bag policy, so a fitted screening time is used as fitted.
  if (Object.keys(overrides).length > 0) s.overrides = overrides;
  return { scenario: s, unmatched };
}
