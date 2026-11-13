/**
 * Phase 3 acceptance tests (docs/PROJECT.md section 4): cars, barriers, parking lots, departures.
 *
 * - a parked car produces exactly its occupant count as pedestrians (review A4);
 * - plate recognition beats ticket entry over 10 paired seeds (95% CI of the paired difference);
 * - departure with N cars and one exit lane: time to empty ≈ N·s plus walking and driving;
 * - overflow rules (leave, divert once, queue), lot closing; conservation for people and cars;
 * - an entry queue reaching the public road is recorded with its time;
 * - Little's law on barrier and pay-station lanes; one car per barrier lane; cars stay on the roads;
 * - determinism, translation, checkpoints; a performance smoke test at 10,000 pedestrians + 2,000 cars.
 */

import type { Venue } from "@bottleneck/schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_STATE_COUNT,
  AgentState,
  CarPhase,
  VEHICLE_DEFAULTS,
  VEHICLE_SNAPSHOT_FIELDS,
  VehicleSnapshotField,
  createRun,
  restoreRun,
  vehicleSnapshotLength,
  type Run,
  type RunMetrics,
} from "../src/index.ts";
import { crossingVenue, parkingScenario, parkingVenue, referenceVenueWithCars, translateVenue } from "./parkingFixtures.ts";
import { largeScenario, scenarioMinimal, venueMinimal } from "./runFixtures.ts";

declare const performance: { now(): number };
declare const console: { log(...values: unknown[]): void };

function runToEnd(run: Run): Run {
  while (!run.done) run.step();
  return run;
}

/** Conservation of people and cars after every tick; returns the run. */
function runConserving(run: Run, each?: (run: Run) => void): Run {
  while (!run.done) {
    run.step();
    const people = run.countsByState();
    const cars = run.carCountsByState();
    expect(people.reduce((s, c) => s + c, 0)).toBe(run.agentCount);
    expect(cars.reduce((s, c) => s + c, 0)).toBe(run.vehicleCount);
    each?.(run);
  }
  return run;
}

const lot = (m: RunMetrics, id = "lot-a") => m.parking!.lots.find((l) => l.lotId === id)!;
const barrier = (m: RunMetrics, id: string) => m.parking!.barriers.find((b) => b.barrierId === id)!;

describe("cars become people (A4)", () => {
  it("a parked car produces exactly its occupant count as pedestrians", () => {
    const venue = parkingVenue({ perRow: 30 });
    const scenario = parkingScenario({ cars: 0, attendance: 100, singleOccupant: false });
    const run = createRun(venue, scenario);
    const world = run.debug.vehicles!;
    const agents = run.debug.agents;
    const size = world.spec.size;
    // While a car is not yet parked (or parked less than the exit delay), its occupants are Pending.
    runConserving(run, () => {
      for (let c = 0; c < world.carCount; c++) {
        if (world.cars.phase[c] === CarPhase.Parked) continue;
        for (let i = 0; i < run.agentCount; i++) if (agents.car[i] === c) expect(agents.state[i]).toBe(AgentState.Pending);
      }
    });
    const m = run.metrics();
    expect(m.drained).toBe(true);
    expect(world.carCount).toBeGreaterThan(30);
    let people = 0;
    for (let c = 0; c < world.carCount; c++) {
      expect(world.cars.state[c]).toBe(AgentState.Parked);
      let out = 0;
      for (let i = 0; i < run.agentCount; i++) if (agents.car[i] === c && agents.state[i] !== AgentState.Pending) out++;
      expect(out).toBe(size[c]);
      people += size[c] as number;
    }
    expect(people).toBe(run.agentCount);
    expect(m.countsByState[AgentState.Inside]).toBe(run.agentCount);
    expect(m.parking!.carPeople).toBe(run.agentCount);
    // Occupancy 1-4 with the default distribution: about 2.1 people per car.
    expect(run.agentCount / world.carCount).toBeGreaterThan(1.7);
    expect(run.agentCount / world.carCount).toBeLessThan(2.6);
  }, 60_000);
});

/**
 * With the spec's defaults a plate barrier has the lower mean service time (4-8 s plus 5% misreads
 * that add 15-30 s: 7.1 s) but the larger second moment than a ticket barrier (5-10 s: 7.5 s), so
 * by Pollaczek-Khinchine plate only wins clearly when the entry barrier is the bottleneck and runs
 * close to (or over) capacity. Each car also needs about 1.25 s to move up to the stop line, so the
 * effective capacity is about 1 / 8.75 s for ticket and 1 / 8.35 s for plate. The test uses
 * 0.125 cars/s for 20 minutes, and a 1 s parking manoeuvre so that the single aisle behind the
 * barrier is not the bottleneck (with the default 6 s, cars parking one after another block the
 * aisle, the barrier waits for the aisle, and the faster entry no longer helps).
 */
describe("plate recognition versus ticket entry", () => {
  it("over 10 paired seeds plate recognition gives a lower mean entry queue, with the 95% CI of the paired difference above 0", () => {
    const diffs: number[] = [];
    let sumTicket = 0;
    let sumPlate = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const scenario = parkingScenario({ cars: 150, window: 1200, seed, parkManoeuvre: 1 });
      const q = (type: "ticket" | "plate") => barrier(runToEnd(createRun(parkingVenue({ perRow: 80, entryType: type }), scenario)).metrics(), "lot-a-entry").meanQueueMetres;
      const ticket = q("ticket");
      const plate = q("plate");
      sumTicket += ticket;
      sumPlate += plate;
      diffs.push(ticket - plate);
    }
    const n = diffs.length;
    const mean = diffs.reduce((s, d) => s + d, 0) / n;
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - mean) * (d - mean), 0) / (n - 1));
    const half = (2.262 * sd) / Math.sqrt(n); // Student t, 9 degrees of freedom
    console.log(`entry queue (time-mean, m): ticket ${(sumTicket / n).toFixed(2)}, plate ${(sumPlate / n).toFixed(2)}; paired difference ${mean.toFixed(2)} ± ${half.toFixed(2)}`);
    expect(sumPlate).toBeLessThan(sumTicket);
    expect(mean - half).toBeGreaterThan(0);
  }, 120_000);
});

describe("departures", () => {
  it("with N cars and one exit lane as the bottleneck (service s), time to empty ≥ N·s and within 10% of N·s plus walking and driving", () => {
    const N = 60;
    const s = 12;
    const scenario = parkingScenario({ cars: N, departAll: true, overrides: { "lot-a-exit": { serviceTime: { kind: "fixed", value: s } } } });
    const run = runConserving(createRun(parkingVenue({ perRow: 30 }), scenario));
    const m = run.metrics();
    expect(m.drained).toBe(true);
    const T = lot(m).timeToEmpty!;
    // Walking and driving before the first car reaches the barrier (assumed speeds, fixture geometry):
    // hall → walking exit (≈ 37 m) and on to a stall (≈ 12 m) at 1.3 m/s, boarding delay, pulling out,
    // ≈ 18 m of aisle at 8 km/h and 20 m of exit road at 25 km/h. Driving also includes each next car
    // moving up to the stop line once the previous one has gone: one car spacing (carLength + carGap)
    // at 25 km/h, noticed at the end of a 0.25 s tick.
    const lag = (37 + 12) / 1.3 + VEHICLE_DEFAULTS.carBoardDelay + VEHICLE_DEFAULTS.parkManoeuvre + 18 / (8 / 3.6) + 20 / (25 / 3.6);
    const moveUp = (VEHICLE_DEFAULTS.carLength + VEHICLE_DEFAULTS.carGap) / (25 / 3.6) + 0.25;
    const expected = N * s + (N - 1) * moveUp + lag;
    console.log(`time to empty: ${T.toFixed(1)} s; N·s = ${N * s} s; N·s + walking and driving ≈ ${expected.toFixed(1)} s`);
    expect(T).toBeGreaterThanOrEqual(N * s);
    expect(Math.abs(T - expected)).toBeLessThanOrEqual(0.1 * expected);
    expect(m.departures!.departedCars).toBe(N);
    expect(m.departures!.departedPeople).toBe(N);
    expect(m.countsByState[AgentState.Departed]).toBe(N);
    expect(m.parking!.carCountsByState[AgentState.Departed]).toBe(N);
  }, 60_000);

  it("people on foot walk back out and depart; the run drains", () => {
    const scenario = {
      ...scenarioMinimal,
      attendance: 400,
      timedEvents: [],
      overrides: {},
      departures: { preset: "concert" as const },
      timeline: { ...scenarioMinimal.timeline, horizon: 9000 + 7200 },
    };
    const run = runConserving(createRun(venueMinimal, scenario));
    const m = run.metrics();
    expect(m.drained).toBe(true);
    expect(m.departures!.departedPeople).toBe(400);
    expect(m.parking).toBeNull();
    expect(m.departures!.lastDepartureAt).toBeGreaterThan(9000);
  }, 60_000);
});

describe("overflow rules", () => {
  it("leave: a full lot turns cars away, counted for cars and their occupants", () => {
    const run = runConserving(createRun(parkingVenue({ perRow: 10 }), parkingScenario({ cars: 35 })));
    const m = run.metrics();
    expect(m.drained).toBe(true);
    expect(lot(m).parked).toBe(20);
    expect(lot(m).turnedAway).toBe(15);
    expect(m.parking!.turnedAwayCars).toBe(15);
    expect(m.parking!.carCountsByState[AgentState.TurnedAway]).toBe(15);
    expect(m.parking!.turnedAwayPeople).toBe(15);
    expect(m.countsByState[AgentState.TurnedAway]).toBe(15);
    expect(m.unreachable).toBe(0);
  }, 60_000);

  it("divert: a car is redirected at most once; a second full lot turns it away (A3)", () => {
    const venue = parkingVenue({ perRow: 10, lotBPerRow: 3, overflow: { rule: "divert", divertTo: "lot-b" } });
    let sawDiverted = 0;
    const run = createRun(venue, parkingScenario({ cars: 35 }));
    runConserving(run, (r) => (sawDiverted = Math.max(sawDiverted, r.carCountsByState()[AgentState.Diverted]!)));
    const m = run.metrics();
    const world = run.debug.vehicles!;
    expect(m.drained).toBe(true);
    expect(sawDiverted).toBeGreaterThan(0);
    expect(lot(m, "lot-a").parked).toBe(20);
    expect(lot(m, "lot-a").divertedAway).toBe(15);
    expect(lot(m, "lot-b").divertedIn).toBe(15);
    expect(lot(m, "lot-b").parked).toBe(6);
    expect(lot(m, "lot-b").turnedAway).toBe(9);
    expect(m.parking!.divertedCars).toBe(15);
    expect(m.parking!.turnedAwayCars).toBe(9);
    let divertedFlags = 0;
    for (let c = 0; c < world.carCount; c++) {
      expect(world.cars.diverted[c]).toBeLessThanOrEqual(1);
      divertedFlags += world.cars.diverted[c] as number;
      if (world.cars.state[c] === AgentState.TurnedAway) expect(world.cars.diverted[c]).toBe(1);
    }
    expect(divertedFlags).toBe(15);
  }, 60_000);

  it("queue: cars wait at the entry until stalls free up during departures; nobody is turned away", () => {
    const run = runConserving(createRun(parkingVenue({ perRow: 10, overflow: { rule: "queue" } }), parkingScenario({ cars: 30, departAll: true, horizon: 3600 * 6 })));
    const m = run.metrics();
    expect(m.drained).toBe(true);
    expect(m.deadlock).toBe(false);
    expect(m.parking!.turnedAwayCars).toBe(0);
    expect(lot(m).parked).toBe(30);
    expect(m.parking!.carCountsByState[AgentState.Departed]).toBe(30);
  }, 60_000);

  it("queue without departures: the cars that can never park stop the run through the deadlock watchdog", () => {
    const run = runToEnd(createRun(parkingVenue({ perRow: 10, overflow: { rule: "queue" } }), parkingScenario({ cars: 30 })));
    const m = run.metrics();
    expect(m.deadlock).toBe(true);
    expect(m.drained).toBe(false);
    expect(lot(m).parked).toBe(20);
  }, 60_000);

  it("lotClose: from the closing time on the lot takes no more cars", () => {
    const run = runConserving(createRun(parkingVenue({ perRow: 30 }), parkingScenario({ cars: 40, timedEvents: [{ kind: "lotClose", at: -2700, lotId: "lot-a" }] })));
    const m = run.metrics();
    expect(lot(m).closedAt).toBe(-2700);
    expect(lot(m).turnedAway).toBeGreaterThan(10);
    expect(lot(m).parked + lot(m).turnedAway).toBe(40);
    expect(m.drained).toBe(true);
  }, 60_000);
});

describe("entry queues and the public road", () => {
  it("an entry queue reaching the public-road boundary is recorded with its time", () => {
    const slow = { "lot-a-entry": { serviceTime: { kind: "fixed" as const, value: 30 } } };
    const m = runToEnd(createRun(parkingVenue({ perRow: 30 }), parkingScenario({ cars: 40, window: 300, overrides: slow }))).metrics();
    const b = barrier(m, "lot-a-entry");
    expect(b.reachedPublicRoadAt).not.toBeNull();
    expect(b.reachedPublicRoadAt!).toBeGreaterThan(-3600);
    expect(b.reachedPublicRoadAt!).toBeLessThan(-3600 + 300 + 600);
    // The entry road is 30 m long: a queue on the public road is longer than that.
    expect(b.maxQueueMetres).toBeGreaterThan(30);
    expect(b.maxQueueAt).not.toBeNull();

    const fast = { "lot-a-entry": { serviceTime: { kind: "fixed" as const, value: 2 } } };
    const light = runToEnd(createRun(parkingVenue({ perRow: 30 }), parkingScenario({ cars: 20, window: 3000, overrides: fast }))).metrics();
    expect(barrier(light, "lot-a-entry").reachedPublicRoadAt).toBeNull();
  }, 60_000);
});

describe("a car park with a pay station, two exit lanes and departures", () => {
  const venue = parkingVenue({ perRow: 25, paymentMode: "payStation", exitLanes: 2 });
  const scenario = parkingScenario({ cars: 0, attendance: 90, singleOccupant: false, departAll: true });
  const run = createRun(venue, scenario);
  const layout = run.vehicleLayout!;
  const world = run.debug.vehicles!;
  const polylines = [...layout.roads.map((r) => r.points), ...layout.aisles.map((a) => a.points)];
  let offRoad = 0;
  let checked = 0;
  let m: RunMetrics;
  beforeAll(() => {
    runConserving(run, () => {
      const c = world.cars;
      for (let k = 0; k < world.carCount; k++) {
        const st = c.state[k];
        if (st !== AgentState.Driving && st !== AgentState.Diverted) continue;
        if (c.phase[k] === CarPhase.ParkingIn || c.phase[k] === CarPhase.PullOut) continue;
        const x = (c.x[k] as number) + run.debug.model.frame.originX;
        const y = (c.y[k] as number) + run.debug.model.frame.originY;
        checked++;
        if (Math.min(...polylines.map((p) => distanceToPolyline(p, x, y))) > 1.5 + 1e-6) offRoad++;
      }
    });
    m = run.metrics();
  }, 60_000);

  it("drains, with every car and person departed", () => {
    expect(m.drained).toBe(true);
    expect(m.countsByState[AgentState.Departed]).toBe(run.agentCount);
    expect(m.parking!.carCountsByState[AgentState.Departed]).toBe(run.vehicleCount);
  });

  it("keeps driving cars on roads and aisles", () => {
    expect(checked).toBeGreaterThan(1000);
    expect(offRoad).toBe(0);
  });

  it("serves at most one car at a time on every barrier lane", () => {
    const barrierLanes = new Set(m.parking!.barrierLanes.map((l) => l.laneId));
    const byLane = new Map<number, { start: number; end: number }[]>();
    for (const r of run.serviceLog()) {
      if (!barrierLanes.has(r.laneId)) continue;
      const list = byLane.get(r.laneId) ?? [];
      list.push({ start: r.start, end: r.end });
      byLane.set(r.laneId, list);
    }
    expect(byLane.size).toBe(3);
    for (const list of byLane.values()) {
      list.sort((a, b) => a.start - b.start);
      for (let k = 1; k < list.length; k++) expect(list[k]!.start).toBeGreaterThanOrEqual(list[k - 1]!.end);
    }
  });

  it("satisfies Little's law on barrier and pay-station lanes", () => {
    const pay = m.lanes.filter((l) => l.elementKind === "payStation");
    expect(pay.length).toBe(2);
    expect(pay.reduce((s, l) => s + l.metrics.served, 0)).toBeGreaterThan(20);
    for (const l of [...pay, ...m.parking!.barrierLanes]) {
      expect(l.metrics.littleLawError).toBeLessThan(1e-9);
      expect(l.metrics.served).toBeLessThanOrEqual(l.metrics.arrivals);
    }
    // Every car passed one entry and one exit service.
    const served = (kind: "entry" | "exit") => m.parking!.barrierLanes.filter((l) => l.kind === kind).reduce((s, l) => s + l.metrics.served, 0);
    expect(served("entry")).toBe(run.vehicleCount);
    expect(served("exit")).toBe(run.vehicleCount);
    // Only drivers pay: one payer per car.
    expect(pay.reduce((s, l) => s + l.metrics.served, 0)).toBe(run.vehicleCount);
  });

  it("reports occupancy, search time and time to empty", () => {
    const l = lot(m);
    expect(l.maxOccupancy).toBe(run.vehicleCount);
    expect(l.occupancy.length).toBeGreaterThan(60);
    expect(Math.max(...l.occupancy)).toBe(run.vehicleCount);
    expect(l.meanSearchTime).toBeGreaterThan(VEHICLE_DEFAULTS.parkManoeuvre);
    expect(l.meanSearchTime).toBeLessThan(120);
    expect(l.timeToEmpty).toBeGreaterThan(0);
    expect(l.emptyAt).toBe(3600 + l.timeToEmpty!);
  });

  it("writes vehicle snapshots and layout", () => {
    const out = new Float32Array(vehicleSnapshotLength(run.vehicleCount));
    expect(out.length).toBe(VEHICLE_SNAPSHOT_FIELDS * run.vehicleCount);
    run.writeVehicleSnapshot(out);
    const n = run.vehicleCount;
    for (let c = 0; c < n; c++) {
      expect(out[VehicleSnapshotField.State * n + c]).toBe(AgentState.Departed);
      const hx = out[VehicleSnapshotField.HX * n + c]!;
      const hy = out[VehicleSnapshotField.HY * n + c]!;
      expect(Math.abs(Math.sqrt(hx * hx + hy * hy) - 1)).toBeLessThan(1e-5);
    }
    expect(layout.lots[0]!.stalls.length).toBe(50);
    expect(layout.barriers.map((b) => b.laneCount)).toEqual([1, 2]);
    expect(layout.barriers[1]!.laneIds).toEqual(m.parking!.barrierLanes.filter((l) => l.barrierId === "lot-a-exit").map((l) => l.laneId));
    expect(run.barrierStates().length).toBe(3);
    expect(run.lotStates()[0]).toMatchObject({ lotId: "lot-a", stalls: 50, occupied: 0, free: 50, closed: false });
    expect(run.carCountsByState().length).toBe(AGENT_STATE_COUNT);
  });
});

describe("crossings", () => {
  it("cars stop for pedestrians on a crossing; pedestrians wait while a stopped car stands across it", () => {
    // 60 cars and 60 people on foot, leaving over 20 minutes after the event end; a slow exit barrier
    // (20 s per car) makes the exit queue stand across the crossing the people on foot must use.
    const base = parkingScenario({ cars: 60, attendance: 120, overrides: { "lot-a-exit": { serviceTime: { kind: "fixed" as const, value: 20 } } } });
    const departures = {
      preset: "custom" as const,
      points: [
        { t: 3600, weight: 1 },
        { t: 4800, weight: 1 },
      ],
    };
    const scenario = { ...base, carShare: 0.5, departures };
    const run = createRun(crossingVenue(), scenario);
    const w = run.debug.vehicles!;
    const a = run.debug.agents;
    const cr = w.crossings[0]!;
    const reach = cr.half + w.settings.carLength / 2;
    const dist = (x: number, y: number) => {
      const dx = cr.bx - cr.ax;
      const dy = cr.by - cr.ay;
      const t = Math.min(1, Math.max(0, ((x - cr.ax) * dx + (y - cr.ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(cr.ax + dx * t - x, cr.ay + dy * t - y);
    };
    const px = new Float64Array(run.agentCount);
    const py = new Float64Array(run.agentCount);
    const cx = new Float64Array(w.carCount);
    const cy = new Float64Array(w.carCount);
    let pedOnTicks = 0;
    let blockedTicks = 0;
    let carsIntoBusyCrossing = 0;
    let peopleOntoBlockedCrossing = 0;
    let peopleWaiting = 0;
    runConserving(run, () => undefined);
    // Second run, checked tick by tick (runConserving above proved the counts).
    const r = createRun(crossingVenue(), scenario);
    const rw = r.debug.vehicles!;
    const ra = r.debug.agents;
    while (!r.done) {
      px.set(ra.x);
      py.set(ra.y);
      cx.set(rw.cars.x);
      cy.set(rw.cars.y);
      const blocked = rw.crossingBlocked[0] === 1;
      r.step();
      const pedOn = rw.pedOnCrossing[0] === 1;
      if (pedOn) pedOnTicks++;
      if (blocked) blockedTicks++;
      for (let c = 0; c < rw.carCount; c++) {
        if (rw.cars.state[c] !== AgentState.Driving) continue;
        if (pedOn && dist(cx[c]!, cy[c]!) > reach + 1e-6 && dist(rw.cars.x[c]!, rw.cars.y[c]!) <= reach + 1e-6) carsIntoBusyCrossing++;
      }
      if (!blocked) continue;
      for (let i = 0; i < r.agentCount; i++) {
        if (ra.state[i] !== AgentState.Walking) continue;
        const before = dist(px[i]!, py[i]!);
        const after = dist(ra.x[i]!, ra.y[i]!);
        if (before > cr.half && after <= cr.half) peopleOntoBlockedCrossing++;
        if (before > cr.half && before < cr.half + 1 && ra.x[i] === px[i] && ra.y[i] === py[i]) peopleWaiting++;
      }
    }
    const m = r.metrics();
    console.log(`crossing: ${JSON.stringify({ pedOnTicks, blockedTicks, peopleWaiting, carsIntoBusyCrossing, peopleOntoBlockedCrossing, counts: m.countsByState, cars: m.parking!.carCountsByState, unreachable: m.unreachable })}`);
    expect(r.metricsHash()).toBe(run.metricsHash());
    expect(m.drained).toBe(true);
    expect(m.deadlock).toBe(false);
    expect(a.count).toBe(120);
    expect(pedOnTicks).toBeGreaterThan(20);
    expect(blockedTicks).toBeGreaterThan(20);
    expect(peopleWaiting).toBeGreaterThan(0);
    expect(carsIntoBusyCrossing).toBe(0);
    expect(peopleOntoBlockedCrossing).toBe(0);
  }, 60_000);
});

describe("determinism with cars", () => {
  const venue = parkingVenue({ perRow: 25, paymentMode: "payStation", exitLanes: 2 });
  const scenario = parkingScenario({ cars: 0, attendance: 90, singleOccupant: false, departAll: true });

  it("the same seed gives the same hash; translating the venue gives a bit-identical one", () => {
    const a = runToEnd(createRun(venue, scenario)).metricsHash();
    const b = runToEnd(createRun(venue, scenario)).metricsHash();
    const moved = runToEnd(createRun(translateVenue(venue, 1234.5, -987.25), scenario)).metricsHash();
    const other = runToEnd(createRun(venue, { ...scenario, seed: 2 })).metricsHash();
    expect(b).toBe(a);
    expect(moved).toBe(a);
    expect(other).not.toBe(a);
  }, 60_000);

  it("checkpoints restore bit-identically during arrivals, the show and departures", () => {
    const straight = runToEnd(createRun(venue, scenario));
    const expected = straight.metricsHash();
    const run = createRun(venue, scenario);
    const at = [run.toEngineTime(-3000), run.toEngineTime(0), run.toEngineTime(3700), run.toEngineTime(4100)];
    for (const t of at) {
      while (run.time < t) run.step();
      const restored = runToEnd(restoreRun(venue, scenario, run.saveCheckpoint()));
      expect(restored.metricsHash()).toBe(expected);
      expect(restored.serviceLog()).toEqual(straight.serviceLog());
    }
  }, 60_000);
});

describe("performance smoke test with cars", () => {
  it("steps 10,000 pedestrians and 2,000 cars and reports the tick time", () => {
    const { venue, scenario } = largeScenario();
    const withCars: Venue = referenceVenueWithCars(venue);
    const sc = {
      ...scenario,
      attendance: 12000,
      carShare: 2000 / 12000,
      parameters: { occupancy: [1] },
      arrivals: {
        preset: "custom" as const,
        points: [
          { t: -3600, weight: 1 },
          { t: -2400, weight: 1 },
        ],
      },
      timeline: { ...scenario.timeline, horizon: 1800 },
    };
    const t0 = performance.now();
    const run = createRun(withCars, sc);
    const build = performance.now() - t0;
    const times: number[] = [];
    let maxCars = 0;
    let maxPeople = 0;
    const snap = new Float32Array(vehicleSnapshotLength(run.vehicleCount));
    // As in the pedestrian-only smoke test: everyone arrives in the 20 minutes before the gates open
    // (6,000 ticks), so the plaza holds 10,000 people while 2,000 cars queue at the entries and park.
    while (!run.done && times.length < 6000) {
      const t = performance.now();
      run.step();
      times.push(performance.now() - t);
      const c = run.carCountsByState();
      const p = run.countsByState();
      maxCars = Math.max(maxCars, run.debug.vehicles!.activeCount() + c[AgentState.Parked]!);
      maxPeople = Math.max(maxPeople, p[AgentState.Walking]! + p[AgentState.Queuing]! + p[AgentState.InService]!);
      if (times.length % 12 === 0) run.writeVehicleSnapshot(snap);
    }
    const sorted = Float64Array.from(times).sort();
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    console.log(
      `10k pedestrians + 2k cars: build ${build.toFixed(0)} ms, ${times.length} ticks, mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max people on site ${maxPeople}, max cars arrived (queuing, driving or parked) ${maxCars}`,
    );
    expect(run.vehicleCount).toBe(2000);
    expect(maxCars).toBe(2000);
    expect(maxPeople).toBeGreaterThan(9000);
    expect(p95).toBeLessThan(150);
  }, 300_000);
});

function distanceToPolyline(points: readonly { x: number; y: number }[], x: number, y: number): number {
  let best = Infinity;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * t - x;
    const py = a.y + dy * t - y;
    best = Math.min(best, Math.sqrt(px * px + py * py));
  }
  return best;
}
