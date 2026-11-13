/**
 * Cars and parking for the simulation view: the parking headline numbers, live rows per lot and
 * per barrier, chart series, the event phase shown next to the clock, and the "close lot now"
 * timed event. Pure; tested in parking.test.ts.
 */

import { AgentState, type BarrierLaneLive, type CurvePoint, type LotLive, type VehicleLayout } from "@bottleneck/engine";
import type { BarrierLaneReport, BarrierReport, DepartureMetrics, LotReport, ParkingMetrics, Scenario, Timeline } from "@bottleneck/schema";
import { withTimedEvent } from "../library/scenarios.ts";
import type { ChartSeries } from "./series.ts";

// ---------------------------------------------------------------------------------------------
// Headline numbers (spec 4.4 and 4.5, Parking)
// ---------------------------------------------------------------------------------------------

export interface TimeToEmpty {
  /** Seconds from the event end until the last lot was empty; null if not (yet) empty. */
  seconds: number | null;
  /** The lot that emptied last (or is still not empty). */
  lotId: string | null;
  /** "empty": every lot that had cars emptied; "notYet": still emptying; "notEmpty": the run ended first; "noDepartures": nobody leaves. */
  status: "empty" | "notYet" | "notEmpty" | "noDepartures";
}

export interface QueueHeadline {
  barrierId: string;
  metres: number;
  cars: number;
  /** Scenario time of the longest queue. */
  at: number | null;
}

export interface ParkingHeadlines {
  timeToEmpty: TimeToEmpty;
  /** Longest queue at any exit barrier; null if the venue has no exit barrier. */
  longestExitQueue: QueueHeadline | null;
  /** Longest queue at any entry barrier; null if there is none. */
  longestEntryQueue: QueueHeadline | null;
  /** Earliest time an entry queue reached the public road, and at which barrier; null if never. */
  entryReachedPublicRoad: { barrierId: string; at: number } | null;
  turnedAwayCars: number;
  divertedCars: number;
}

/** Time until the car parks are empty: the slowest lot that had cars. `done`: the run has ended. */
export function timeToEmpty(parking: ParkingMetrics, departures: DepartureMetrics | null, done: boolean): TimeToEmpty {
  if (departures === null) return { seconds: null, lotId: null, status: "noDepartures" };
  const used = parking.lots.filter((l) => l.parked > 0);
  const notEmpty = used.find((l) => l.timeToEmpty === null);
  if (notEmpty) return { seconds: null, lotId: notEmpty.lotId, status: done ? "notEmpty" : "notYet" };
  let worst: LotReport | null = null;
  for (const l of used) if (worst === null || (l.timeToEmpty as number) > (worst.timeToEmpty as number)) worst = l;
  if (worst === null) return { seconds: null, lotId: null, status: done ? "notEmpty" : "notYet" };
  return { seconds: worst.timeToEmpty, lotId: worst.lotId, status: "empty" };
}

function longestQueue(barriers: readonly BarrierReport[], kind: "entry" | "exit"): QueueHeadline | null {
  let best: BarrierReport | null = null;
  for (const b of barriers) if (b.kind === kind && (best === null || b.maxQueueMetres > best.maxQueueMetres)) best = b;
  return best === null ? null : { barrierId: best.barrierId, metres: best.maxQueueMetres, cars: best.maxQueueCars, at: best.maxQueueAt };
}

export function parkingHeadlines(parking: ParkingMetrics, departures: DepartureMetrics | null, done: boolean): ParkingHeadlines {
  let reached: { barrierId: string; at: number } | null = null;
  for (const b of parking.barriers) {
    if (b.kind !== "entry" || b.reachedPublicRoadAt === null) continue;
    if (reached === null || b.reachedPublicRoadAt < reached.at) reached = { barrierId: b.barrierId, at: b.reachedPublicRoadAt };
  }
  return {
    timeToEmpty: timeToEmpty(parking, departures, done),
    longestExitQueue: longestQueue(parking.barriers, "exit"),
    longestEntryQueue: longestQueue(parking.barriers, "entry"),
    entryReachedPublicRoad: reached,
    turnedAwayCars: parking.turnedAwayCars,
    divertedCars: parking.divertedCars,
  };
}

// ---------------------------------------------------------------------------------------------
// Live rows
// ---------------------------------------------------------------------------------------------

/** Car states the counts panel lists, in this order. */
export const CAR_STATES = [AgentState.Pending, AgentState.Driving, AgentState.Diverted, AgentState.Parked, AgentState.Departed, AgentState.TurnedAway] as const;

/** Cars on the map right now (driving, diverted or parked). */
export function carsOnSite(counts: readonly number[]): number {
  return (counts[AgentState.Driving] ?? 0) + (counts[AgentState.Diverted] ?? 0) + (counts[AgentState.Parked] ?? 0);
}

export interface LotRow {
  lotId: string;
  name: string;
  stalls: number;
  occupied: number;
  free: number;
  /** Occupied / stalls. */
  share: number;
  closed: boolean;
  /** From the metrics, if there are any yet. */
  maxOccupancy: number | null;
  turnedAway: number | null;
  timeToEmpty: number | null;
}

export function lotRows(layout: VehicleLayout, live: readonly LotLive[], reports: readonly LotReport[] | undefined): LotRow[] {
  return layout.lots.map((l) => {
    const s = live.find((x) => x.lotId === l.id);
    const r = reports?.find((x) => x.lotId === l.id);
    const stalls = s?.stalls ?? l.stalls.length;
    const occupied = s?.occupied ?? 0;
    return {
      lotId: l.id,
      name: l.name,
      stalls,
      occupied,
      free: s?.free ?? stalls,
      share: stalls > 0 ? occupied / stalls : 0,
      closed: s?.closed ?? false,
      maxOccupancy: r?.maxOccupancy ?? null,
      turnedAway: r?.turnedAway ?? null,
      timeToEmpty: r?.timeToEmpty ?? null,
    };
  });
}

export interface BarrierRow {
  barrierId: string;
  name: string;
  kind: "entry" | "exit";
  laneCount: number;
  /** Cars waiting right now, excluding the ones being served. */
  waiting: number;
  /** Lanes serving a car right now. */
  busyLanes: number;
  maxQueueCars: number | null;
  maxQueueMetres: number | null;
  meanQueueMetres: number | null;
  reachedPublicRoadAt: number | null;
}

export function barrierRows(layout: VehicleLayout, live: readonly BarrierLaneLive[], reports: readonly BarrierReport[] | undefined): BarrierRow[] {
  return layout.barriers.map((b) => {
    let waiting = 0;
    let busy = 0;
    for (const l of live) {
      if (l.barrierId !== b.id) continue;
      waiting += l.queueLength;
      if (l.inService) busy++;
    }
    const r = reports?.find((x) => x.barrierId === b.id);
    return {
      barrierId: b.id,
      name: b.name,
      kind: b.kind,
      laneCount: b.laneCount,
      waiting,
      busyLanes: busy,
      maxQueueCars: r?.maxQueueCars ?? null,
      maxQueueMetres: r?.maxQueueMetres ?? null,
      meanQueueMetres: r?.meanQueueMetres ?? null,
      reachedPublicRoadAt: r?.reachedPublicRoadAt ?? null,
    };
  });
}

/** Live barrier lane state by lane id (for the renderer). */
export function barrierLaneBusy(live: readonly BarrierLaneLive[]): Map<number, BarrierLaneLive> {
  return new Map(live.map((l) => [l.laneId, l]));
}

// ---------------------------------------------------------------------------------------------
// Chart series
// ---------------------------------------------------------------------------------------------

/** Cars in stalls at the end of each throughput bin, in scenario time. */
export function lotOccupancySeries(report: LotReport, startTime: number, binSeconds: number): ChartSeries {
  return { x: report.occupancy.map((_, k) => startTime + (k + 1) * binSeconds), y: [...report.occupancy] };
}

/** Cars waiting at one barrier (all its lanes summed) every queue sample interval, in scenario time. */
export function barrierQueueSeries(lanes: readonly BarrierLaneReport[], barrierId: string, startTime: number, queueInterval: number): ChartSeries {
  const own = lanes.filter((l) => l.barrierId === barrierId);
  const n = Math.max(0, ...own.map((l) => l.queueLength.length));
  const x: number[] = [];
  const y: number[] = [];
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (const l of own) sum += l.queueLength[k] ?? 0;
    x.push(startTime + (k + 1) * queueInterval);
    y.push(sum);
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// Event phase next to the clock
// ---------------------------------------------------------------------------------------------

export type EventPhase = "beforeOpening" | "arrivals" | "event" | "open" | "departures";

/**
 * Which part of the event scenario time `t` is in: before the gates open, arrivals (until the
 * start of a fixed-start event), the event itself (or "open" for open-door events), and departures
 * from the first point of the departure curve on (for a fair they overlap the opening hours).
 */
export function eventPhase(t: number, timeline: Timeline, departureCurve: readonly CurvePoint[] | null): EventPhase {
  const depStart = departureCurve && departureCurve.length > 0 ? firstRising(departureCurve) : null;
  if (depStart !== null && t >= depStart) return "departures";
  if (t < timeline.gatesOpen) return "beforeOpening";
  if (timeline.eventStart === null) return "open";
  return t < timeline.eventStart ? "arrivals" : "event";
}

/** Earliest time at which the curve has weight (the start of its first non-zero segment). */
function firstRising(points: readonly CurvePoint[]): number {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  for (let k = 0; k < sorted.length; k++) {
    const p = sorted[k] as CurvePoint;
    if (p.weight > 0) return k > 0 ? (sorted[k - 1] as CurvePoint).t : p.t;
  }
  return (sorted[0] as CurvePoint).t;
}

// ---------------------------------------------------------------------------------------------
// Interactive lot closing
// ---------------------------------------------------------------------------------------------

/** The scenario with a lotClose timed event at scenario time `at` (review B8, like a lane failure). */
export function withLotClosed(s: Scenario, lotId: string, at: number): Scenario {
  return withTimedEvent(s, { kind: "lotClose", at, lotId });
}
