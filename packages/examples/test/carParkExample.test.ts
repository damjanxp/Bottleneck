/**
 * The stand-alone car park example (Phase 3), simulated: the exit-rush comparisons it is meant to
 * show, and the crossing rules checked tick by tick: cars stop for pedestrians on the zebra crossing,
 * and nobody steps onto it while a stopped car stands across it (that case is exercised in
 * packages/engine/test/vehicles.test.ts; here the crossing is behind the exit barrier, where cars
 * rarely stop). EXAMPLE_RUNS_VERBOSE=1 prints the numbers.
 */
import { AgentState, createRun, type Run, type RunMetrics, type VehicleWorld } from "@bottleneck/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { exampleVenues } from "../src/index.ts";

const ex = exampleVenues.find((e) => e.id === "standalone-car-park")!;
const scenario = (id: string) => ex.scenarios.find((s) => s.id === id)!;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

const results = new Map<string, RunMetrics>();
const crossing = { pedOnTicks: 0, blockedTicks: 0, carsIntoBusyCrossing: 0, peopleOntoBlockedCrossing: 0, carHeldTicks: 0 };

describe("stand-alone car park example", () => {
  beforeAll(() => {
    for (const s of ex.scenarios) {
      if (s.id === "car-park-pay-station") continue;
      const run = createRun(ex.venue, s);
      while (!run.done) run.step();
      results.set(s.id as string, run.metrics());
    }
    // The baseline, tick by tick.
    const run: Run = createRun(ex.venue, scenario("car-park-pay-station"));
    const w = run.debug.vehicles as VehicleWorld;
    const a = run.debug.agents;
    const cr = w.crossings[0]!;
    const carReach = cr.half + w.settings.carLength / 2;
    const px = new Float64Array(run.agentCount);
    const py = new Float64Array(run.agentCount);
    const cx = new Float64Array(w.carCount);
    const cy = new Float64Array(w.carCount);
    while (!run.done) {
      px.set(a.x);
      py.set(a.y);
      cx.set(w.cars.x);
      cy.set(w.cars.y);
      const blockedBefore = w.crossingBlocked[0] === 1;
      run.step();
      expect(run.countsByState().reduce((s, c) => s + c, 0)).toBe(run.agentCount);
      expect(run.carCountsByState().reduce((s, c) => s + c, 0)).toBe(run.vehicleCount);
      const pedOn = w.pedOnCrossing[0] === 1;
      if (pedOn) crossing.pedOnTicks++;
      if (blockedBefore) crossing.blockedTicks++;
      let held = false;
      for (let c = 0; c < w.carCount; c++) {
        if (w.cars.state[c] !== AgentState.Driving) continue;
        const before = distanceToSegment(cx[c]!, cy[c]!, cr.ax, cr.ay, cr.bx, cr.by);
        const after = distanceToSegment(w.cars.x[c]!, w.cars.y[c]!, cr.ax, cr.ay, cr.bx, cr.by);
        // A car may not drive onto the crossing while a pedestrian is on it.
        if (pedOn && before > carReach + 1e-6 && after <= carReach + 1e-6) crossing.carsIntoBusyCrossing++;
        if (pedOn && after > carReach && after < carReach + 2 && Math.hypot(w.cars.vx[c]!, w.cars.vy[c]!) < 0.01) held = true;
      }
      if (held) crossing.carHeldTicks++;
      if (blockedBefore) {
        for (let i = 0; i < run.agentCount; i++) {
          if (a.state[i] !== AgentState.Walking) continue;
          if (distanceToSegment(px[i]!, py[i]!, cr.ax, cr.ay, cr.bx, cr.by) > cr.half && distanceToSegment(a.x[i]!, a.y[i]!, cr.ax, cr.ay, cr.bx, cr.by) <= cr.half) crossing.peopleOntoBlockedCrossing++;
        }
      }
    }
    results.set("car-park-pay-station", run.metrics());
    if (process.env.EXAMPLE_RUNS_VERBOSE !== undefined) {
      for (const [id, m] of results) {
        const p = m.parking!;
        const lot = p.lots[0]!;
        const pay = m.lanes.filter((l) => l.elementKind === "payStation");
        const payWait = pay.reduce((s, l) => s + l.metrics.meanWait * l.metrics.served, 0) / Math.max(1, pay.reduce((s, l) => s + l.metrics.served, 0));
        const b = (k: string) => p.barriers.find((x) => x.barrierId === k)!;
        console.log(
          `${id}: cars=${p.carCount} people=${m.agentCount} parked=${lot.parked} turnedAway=${p.turnedAwayCars} maxOcc=${lot.maxOccupancy} search=${lot.meanSearchTime.toFixed(1)}s timeToEmpty=${lot.timeToEmpty?.toFixed(0)}s payWait=${payWait.toFixed(0)}s exitQueue max ${b("exit-barrier").maxQueueMetres.toFixed(0)} m / ${b("exit-barrier").maxQueueCars} cars, mean ${b("exit-barrier").meanQueueMetres.toFixed(1)} m; entry N max ${b("entry-north-barrier").maxQueueMetres.toFixed(0)} m, public road at ${b("entry-north-barrier").reachedPublicRoadAt}; entry S max ${b("entry-south-barrier").maxQueueMetres.toFixed(0)} m, public road at ${b("entry-south-barrier").reachedPublicRoadAt}`,
        );
      }
      console.log(`crossing: ${JSON.stringify(crossing)}`);
    }
  }, 300_000);

  const m = (id: string) => results.get(id)!;
  const lot = (id: string) => m(id).parking!.lots[0]!;

  it("fills the car park before the start and turns away the cars that do not fit", () => {
    const p = m("car-park-pay-station").parking!;
    const l = p.lots[0]!;
    expect(l.stalls).toBe(320);
    expect(p.carCount).toBeGreaterThan(300);
    expect(l.parked).toBe(Math.min(p.carCount, 320));
    expect(p.turnedAwayCars).toBe(p.carCount - l.parked);
    expect(l.maxOccupancy).toBe(l.parked);
    expect(l.meanSearchTime).toBeGreaterThan(10);
    expect(l.meanSearchTime).toBeLessThan(180);
  });

  it("everyone gets home: every run drains and every person and car departs or was turned away", () => {
    for (const s of ex.scenarios) {
      const r = m(s.id as string);
      expect(r.drained, s.id).toBe(true);
      expect(r.countsByState[AgentState.Departed]! + r.countsByState[AgentState.TurnedAway]!, s.id).toBe(r.agentCount);
      expect(r.parking!.carCountsByState[AgentState.Departed]! + r.parking!.carCountsByState[AgentState.TurnedAway]!, s.id).toBe(r.parking!.carCount);
    }
  });

  it("the entry queues reach the main road during the arrival peak, and it is recorded", () => {
    const p = m("car-park-pay-station").parking!;
    const reached = p.barriers.filter((b) => b.kind === "entry" && b.reachedPublicRoadAt !== null);
    expect(reached.length).toBeGreaterThan(0);
    for (const b of reached) expect(b.reachedPublicRoadAt!).toBeLessThan(0);
    expect(p.barriers.find((b) => b.kind === "exit")!.reachedPublicRoadAt).toBeNull();
  });

  it("drivers queue at the pay machines; paying at the exit barrier instead empties the car park at least 10 minutes later", () => {
    const pay = (id: string) => m(id).lanes.filter((l) => l.elementKind === "payStation");
    const base = pay("car-park-pay-station");
    const meanWait = base.reduce((s, l) => s + l.metrics.meanWait * l.metrics.served, 0) / base.reduce((s, l) => s + l.metrics.served, 0);
    expect(meanWait).toBeGreaterThan(120);
    expect(pay("car-park-pay-at-barrier").reduce((s, l) => s + l.metrics.served, 0)).toBe(0);
    expect(lot("car-park-pay-at-barrier").timeToEmpty!).toBeGreaterThan(lot("car-park-pay-station").timeToEmpty! + 600);
    const exitMean = (id: string) => m(id).parking!.barriers.find((b) => b.kind === "exit")!.meanQueueMetres;
    expect(exitMean("car-park-pay-at-barrier")).toBeGreaterThan(1.5 * exitMean("car-park-pay-station"));
  });

  it("a third exit lane wins back at least 5 minutes of what paying at the barrier costs", () => {
    expect(lot("car-park-pay-at-barrier-3-lanes").timeToEmpty!).toBeLessThan(lot("car-park-pay-at-barrier").timeToEmpty! - 300);
  });

  it("Little's law holds on every barrier and pay-machine lane", () => {
    for (const s of ex.scenarios) {
      const r = m(s.id as string);
      for (const l of [...r.lanes, ...r.parking!.barrierLanes]) expect(l.metrics.littleLawError, `${s.id} lane ${l.laneId}`).toBeLessThan(1e-9);
    }
  });

  it("cars stop for pedestrians on the zebra crossing, and nobody steps onto it while a stopped car stands across it", () => {
    expect(crossing.pedOnTicks).toBeGreaterThan(100);
    expect(crossing.carHeldTicks).toBeGreaterThan(0);
    expect(crossing.carsIntoBusyCrossing).toBe(0);
    expect(crossing.peopleOntoBlockedCrossing).toBe(0);
  });
});
