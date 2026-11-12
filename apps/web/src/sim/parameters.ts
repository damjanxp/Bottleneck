/**
 * The run's resolved parameters as labelled rows for the "Assumptions" list. A row is `assumed`
 * when the value is a built-in default rather than something the venue or scenario set.
 */

import type { ResolvedParameters } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";
import { strings } from "../strings.ts";
import { formatDistribution, formatDuration, formatPercent } from "./format.ts";

export interface ParameterRow {
  key: string;
  label: string;
  value: string;
  assumed: boolean;
}

export function describeParameters(p: ResolvedParameters, venue: Venue, scenario: Scenario): ParameterRow[] {
  const L = strings.parameters.labels;
  const sp = scenario.parameters ?? {};
  const rows: ParameterRow[] = [
    { key: "freeWalkingSpeed", label: L.freeWalkingSpeed, value: formatDistribution(p.freeWalkingSpeed, "m/s"), assumed: sp.freeWalkingSpeed === undefined },
    { key: "nearestLaneShare", label: L.nearestLaneShare, value: formatPercent(p.nearestLaneShare), assumed: sp.nearestLaneShare === undefined },
    {
      key: "speedDensity",
      label: L.speedDensity,
      value: `γ ${p.speedDensity.gamma}, ρmax ${p.speedDensity.rhoMax} /m²`,
      assumed: venue.parameters?.speedDensity === undefined,
    },
    { key: "arrivalCurve", label: L.arrivalCurve, value: scenario.arrivals.points && scenario.arrivals.points.length >= 2 ? strings.parameters.customCurve : `${scenario.arrivals.preset} ${strings.parameters.preset}`, assumed: !(scenario.arrivals.points && scenario.arrivals.points.length >= 2) },
    // Scenario-settable assumptions: "assumed" only when the scenario leaves them at the default.
    { key: "decisionDistance", label: L.decisionDistance, value: `${p.decisionDistance} m`, assumed: sp.decisionDistance === undefined },
    { key: "logitScale", label: L.logitScale, value: `${p.logitScale} s`, assumed: sp.logitScale === undefined },
    { key: "slotSpacing", label: L.slotSpacing, value: `${p.slotSpacing} m`, assumed: sp.slotSpacing === undefined },
    { key: "jockeyThreshold", label: L.jockeyThreshold, value: String(p.jockeyThreshold), assumed: sp.jockeyThreshold === undefined },
    { key: "manualServiceTime", label: L.manualServiceTime, value: formatDistribution(p.manualLaneServiceTime, "s"), assumed: sp.manualLaneServiceTime === undefined },
    { key: "groupSizes", label: L.groupSizes, value: formatGroupSizes(p.groupSizes), assumed: sp.groupSizes === undefined },
    { key: "bagPolicy", label: L.bagPolicy, value: p.bagPolicy === null ? strings.parameters.bagPolicyNone : strings.parameters.bagPolicies[p.bagPolicy], assumed: sp.bagPolicy === undefined },
    { key: "densitySigma", label: L.densitySigma, value: `${p.densitySigma} m`, assumed: true },
    { key: "watchdog", label: L.watchdog, value: `${p.watchdogMinutes} min`, assumed: sp.watchdogMinutes === undefined },
    { key: "shareInsideLead", label: L.shareInsideAt, value: shareInsideText(p, scenario), assumed: sp.shareInsideAt === undefined },
  ];
  for (const el of p.elements) {
    const name = elementName(venue, el.id);
    rows.push({ key: `${el.id}.lanes`, label: `${name}: ${L.laneCount}`, value: String(el.laneCount), assumed: false });
    rows.push({ key: `${el.id}.service`, label: `${name}: ${L.serviceTime}`, value: formatDistribution(el.serviceTime, "s"), assumed: false });
    if (el.kind === "gate") {
      rows.push({ key: `${el.id}.scanFailure`, label: `${name}: ${L.scanFailure}`, value: formatPercent(el.scanFailureRate, 1), assumed: false });
    }
  }
  return rows;
}

/** "30% alone, 40% in 2s, …": relative frequencies of group sizes 1, 2, 3, … */
export function formatGroupSizes(sizes: readonly number[]): string {
  const total = sizes.reduce((s, w) => s + w, 0);
  if (!(total > 0) || sizes.length <= 1) return strings.parameters.everyoneAlone;
  return sizes.map((w, k) => `${Math.round((100 * w) / total)}% ${k === 0 ? strings.parameters.alone : `${strings.parameters.groupOf} ${k + 1}`}`).join(", ");
}

function shareInsideText(p: ResolvedParameters, scenario: Scenario): string {
  const start = scenario.timeline.eventStart;
  if (scenario.parameters?.shareInsideAt === undefined && start === null) return strings.parameters.oneHourAfterOpening;
  if (start !== null && p.shareInsideAt <= start) return formatDuration(start - p.shareInsideAt) + strings.parameters.beforeStart;
  const ref = start ?? scenario.timeline.gatesOpen;
  return formatDuration(p.shareInsideAt - ref) + (start !== null ? strings.parameters.afterStart : strings.parameters.afterOpening);
}

/** Display name of a gate group or screening stage. */
export function elementName(venue: Venue, id: string): string {
  return venue.gateGroups.find((g) => g.id === id)?.name ?? venue.screeningStages.find((s) => s.id === id)?.name ?? id;
}
