/**
 * Walking reachability of a venue, for the venue editor (Phase 5, D-065). It builds the same walk
 * grid and flow fields a run uses, so "reachable" here means exactly what it means in a run: a
 * person who appears at a source can walk to the entry lanes (or, without gates, to a destination),
 * and a person leaving a lane can walk on to the next stage or a destination. A run would turn
 * these people away as unreachable (D-022); the editor reports it before anyone simulates.
 *
 * Pure and deterministic: no randomness is drawn; elements are checked in venue order.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import { RUN_DEFAULTS } from "./run.ts";
import { buildVenueModel, type LaneGeometry } from "./venueModel.ts";
import { defaultPayStationServiceTime } from "./vehicles.ts";

export type ReachabilityIssue =
  /** People from this source cannot walk to any entry lane (or, without gates, to any destination). */
  | { kind: "sourceUnreachable"; sourceId: string }
  /** People leaving this screening stage or gate group cannot walk on (to the gates behind it, or to a destination). */
  | { kind: "exitUnreachable"; elementId: string }
  /** The venue has no walkable cell inside any destination area. */
  | { kind: "noDestination" };

/** An empty scenario: the check depends only on the venue's geometry (overrides do not move lines). */
const GEOMETRY_ONLY = { overrides: {} } as unknown as Scenario;

export function checkWalkingReachability(venue: Venue): ReachabilityIssue[] {
  const model = buildVenueModel(venue, GEOMETRY_ONLY, {
    slotSpacing: RUN_DEFAULTS.slotSpacing,
    manualServiceTime: RUN_DEFAULTS.manualLaneServiceTime,
    screeningServiceTime: null,
    payStationServiceTime: defaultPayStationServiceTime(0.5),
  });
  const { grid, destinationField } = model;
  const issues: ReachabilityIssue[] = [];

  let destinationCells = 0;
  for (let c = 0; c < grid.cellCount; c++) if (destinationField.dist[c] === 0) destinationCells++;
  if (venue.destinations.length > 0 && destinationCells === 0) issues.push({ kind: "noDestination" });

  const entry = model.hasEntryLanes ? model.stageSets[0]?.field : destinationField;
  venue.sources.forEach((s, i) => {
    const cell = grid.cellAt(model.sourceX[i] as number, model.sourceY[i] as number);
    if (entry === undefined || entry.distanceAt(cell) === Infinity) issues.push({ kind: "sourceUnreachable", sourceId: s.id });
  });

  for (const el of model.elements) {
    if (el.kind === "payStation") continue; // a pay station leads back to a car, not on foot
    const onward = el.kind === "screening" && el.nextStageSet >= 0 ? model.stageSets[el.nextStageSet]?.field : destinationField;
    // An element is fine if people can walk on from at least one of its lanes' exits.
    const ok = el.laneIds.some((id) => {
      const lane = model.lanes[id] as LaneGeometry;
      return onward !== undefined && onward.distanceAt(grid.cellAt(lane.exitX, lane.exitY)) !== Infinity;
    });
    if (!ok) issues.push({ kind: "exitUnreachable", elementId: el.id });
  }
  return issues;
}
