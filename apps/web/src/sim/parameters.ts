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
    { key: "decisionDistance", label: L.decisionDistance, value: `${p.decisionDistance} m`, assumed: true },
    { key: "logitScale", label: L.logitScale, value: `${p.logitScale} s`, assumed: true },
    { key: "slotSpacing", label: L.slotSpacing, value: `${p.slotSpacing} m`, assumed: true },
    { key: "jockeyThreshold", label: L.jockeyThreshold, value: String(p.jockeyThreshold), assumed: true },
    { key: "manualServiceTime", label: L.manualServiceTime, value: formatDistribution(p.manualLaneServiceTime, "s"), assumed: true },
    { key: "densitySigma", label: L.densitySigma, value: `${p.densitySigma} m`, assumed: true },
    { key: "watchdog", label: L.watchdog, value: `${p.watchdogMinutes} min`, assumed: true },
    { key: "shareInsideLead", label: L.shareInsideAt, value: scenario.timeline.eventStart === null ? strings.parameters.oneHourAfterOpening : formatDuration(scenario.timeline.eventStart - p.shareInsideAt) + strings.parameters.beforeStart, assumed: true },
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

/** Display name of a gate group or screening stage. */
export function elementName(venue: Venue, id: string): string {
  return venue.gateGroups.find((g) => g.id === id)?.name ?? venue.screeningStages.find((s) => s.id === id)?.name ?? id;
}
