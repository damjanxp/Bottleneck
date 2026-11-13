/**
 * Runs every built-in example scenario headless to completion and checks the qualitative outcomes
 * the examples are meant to show (including the Belgrade Fair car parks of Phase 3). Margins are generous: the point is "jams" versus "copes", not exact numbers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { AgentState, ENGINE_VERSION, createRun, type RunMetrics } from "@bottleneck/engine";
import { SCHEMA_FILES, type RunRecord, type Scenario } from "@bottleneck/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { exampleVenues } from "../src/index.ts";

interface Result {
  m: RunMetrics;
  hash: string;
  scenario: Scenario;
  ms: number;
  /** Max queue of the busiest lane of an element. */
  maxQueue: (elementId: string) => number;
}

const results = new Map<string, Result>();

function simulate(venueIndex: number, scenarioId: string): Result {
  const ex = exampleVenues[venueIndex]!;
  const sc = ex.scenarios.find((s) => s.id === scenarioId)!;
  const t0 = Date.now();
  const run = createRun(ex.venue, sc);
  while (!run.done) run.step();
  const ms = Date.now() - t0;
  const m = run.metrics();
  expect(run.countsByState().reduce((a, b) => a + b, 0)).toBe(run.agentCount);
  return {
    m,
    hash: run.metricsHash(),
    scenario: sc,
    ms,
    maxQueue: (id) => Math.max(0, ...m.lanes.filter((l) => l.elementId === id).map((l) => l.metrics.maxQueue)),
  };
}

const only = process.env.EXAMPLE_RUNS_ONLY?.split(",");
const ids = exampleVenues
  .flatMap((e, vi) => e.scenarios.map((s) => ({ vi, id: s.id as string })))
  .filter((x) => only === undefined || only.some((o) => x.id.includes(o)));

describe("example scenarios, simulated", () => {
  beforeAll(() => {
    for (const { vi, id } of ids) results.set(id, simulate(vi, id));
    if (process.env.EXAMPLE_RUNS_VERBOSE !== undefined) {
      for (const [id, { m, ms, maxQueue }] of results) {
        const lanes = m.lanes.map((l) => `${l.elementId}#${l.laneIndex}:q${l.metrics.maxQueue}/u${l.metrics.utilisation.toFixed(2)}`).join(" ");
        console.log(
          `${id}: agents=${m.agentCount} unreach=${m.unreachable} deadlock=${m.deadlock} drained=${m.drained} ms=${ms} peakP95=${m.peakHour.p95Wait.toFixed(0)} meanWait=${m.meanWait.toFixed(0)} p95=${m.p95Wait.toFixed(0)} outside=${m.stillOutsideAtStart} maxQ(gate-a)=${maxQueue("gate-a")}\n   ${lanes}`,
        );
      }
    }
  }, 300_000);

  const r = (id: string): Result => results.get(id)!;

  it("every scenario drains with nobody unreachable and no deadlock, and conserves agents", () => {
    for (const { id } of ids) {
      const { m } = r(id);
      expect(m.unreachable, id).toBe(0);
      expect(m.deadlock, id).toBe(false);
      expect(m.drained, id).toBe(true);
      expect(m.countsByState.reduce((a, b) => a + b, 0), id).toBe(m.agentCount);
    }
  });

  it("every run's record is valid against run.schema.json", () => {
    const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schema");
    const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
    addFormats.default(ajv);
    for (const file of SCHEMA_FILES) ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, file), "utf8")) as object, file);
    const validate = ajv.getSchema("run.schema.json")!;
    for (const { id } of ids) {
      const { m, hash, scenario } = r(id);
      const { parameters, ...metrics } = m;
      const record: RunRecord = { schemaVersion: 1, engineVersion: ENGINE_VERSION, createdAt: "2026-11-12T00:00:00Z", origin: "job", scenario, venueHash: "0000000000000000", parameters, metrics, metricsHash: hash };
      expect(validate(record), `${id}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
  });

  it("reports capacity against demand and the outside-at-start breakdown", () => {
    const m3 = r("concert-3-lanes").m;
    const gate = m3.elements.find((e) => e.elementId === "gate-main")!;
    // 3 lanes cannot serve the peak hour: demand above capacity, utilisation pinned near 100%.
    expect(gate.peakDemandPerHour).toBeGreaterThan(gate.capacityPerHour);
    expect(gate.peakUtilisation).toBeGreaterThan(0.95);
    expect((m3.arrivedButOutsideAtStart ?? 0) + (m3.notYetArrivedAtStart ?? 0)).toBe(m3.stillOutsideAtStart);
    expect(m3.arrivedButOutsideAtStart).toBeGreaterThan(m3.notYetArrivedAtStart ?? 0);
  });

  it("concert with 3 lanes jams badly", () => {
    const m = r("concert-3-lanes").m;
    expect(m.stillOutsideAtStart ?? 0).toBeGreaterThan(300);
    expect(m.peakHour.p95Wait).toBeGreaterThan(600);
  });

  it("concert with 5 lanes mostly copes", () => {
    const m3 = r("concert-3-lanes").m;
    const m5 = r("concert-5-lanes").m;
    expect((m3.stillOutsideAtStart ?? 0)).toBeGreaterThan(5 * (m5.stillOutsideAtStart ?? 0));
    expect(m5.stillOutsideAtStart ?? 0).toBeLessThan(300);
    expect(m5.peakHour.p95Wait).toBeLessThan(600);
  });

  it("a failed lane makes the 5-lane concert visibly worse", () => {
    const m5 = r("concert-5-lanes").m;
    const mf = r("concert-lane-fails").m;
    expect(mf.stillOutsideAtStart ?? 0).toBeGreaterThan((m5.stillOutsideAtStart ?? 0) * 1.1);
    expect(mf.peakHour.p95Wait).toBeGreaterThan(m5.peakHour.p95Wait * 1.5);
    expect(mf.stillOutsideAtStart ?? 0).toBeLessThan(r("concert-3-lanes").m.stillOutsideAtStart ?? 0);
  });

  it("fair-day baseline flows with short waits", () => {
    const m = r("fair-day-baseline").m;
    expect(m.peakHour.p95Wait).toBeLessThan(150);
    expect(m.meanWait).toBeLessThan(90);
  });

  it("the bus burst produces a clear temporary queue", () => {
    const base = r("fair-day-baseline");
    const burst = r("fair-day-bus-burst");
    expect(burst.maxQueue("gate-a")).toBeGreaterThan(base.maxQueue("gate-a") * 1.5);
    expect(burst.m.p95Wait).toBeGreaterThan(base.m.p95Wait * 1.15);
    expect(burst.m.meanWait).toBeGreaterThan(base.m.meanWait);
  });

  it("reducing gate A creates a queue at gate A", () => {
    const base = r("fair-day-baseline");
    const red = r("fair-day-gate-a-reduced");
    expect(red.maxQueue("gate-a")).toBeGreaterThan(base.maxQueue("gate-a") + 4);
    expect(red.m.p95Wait).toBeGreaterThan(base.m.p95Wait * 1.1);
  });
  describe("Belgrade Fair with car parks (Phase 3)", () => {
    const carIds = ["fair-day-with-cars", "fair-day-north-car-park-closes", "concert-cars-pay-station", "concert-cars-pay-at-barrier"];
    const have = (id: string) => results.has(id);
    const parking = (id: string) => r(id).m.parking!;
    const lotOf = (id: string, lotId: string) => parking(id).lots.find((l) => l.lotId === lotId)!;
    const exitBarrier = (id: string, barrierId: string) => parking(id).barriers.find((b) => b.barrierId === barrierId)!;
    const payServed = (id: string) => r(id).m.lanes.filter((l) => l.elementKind === "payStation").reduce((s, l) => s + l.metrics.served, 0);

    it("conserves people and cars: everyone departs or was turned away, nobody is unreachable, the run drains without deadlock", () => {
      for (const id of carIds.filter(have)) {
        const { m } = r(id);
        const p = m.parking!;
        expect(p.carCount, id).toBeGreaterThan(500);
        expect(m.unreachable, id).toBe(0);
        expect(m.deadlock, id).toBe(false);
        expect(m.drained, id).toBe(true);
        expect(m.countsByState.reduce((a, b) => a + b, 0), id).toBe(m.agentCount);
        expect(p.carCountsByState.reduce((a, b) => a + b, 0), id).toBe(p.carCount);
        expect(m.countsByState[AgentState.Departed]! + m.countsByState[AgentState.TurnedAway]!, id).toBe(m.agentCount);
        expect(p.carCountsByState[AgentState.Departed]! + p.carCountsByState[AgentState.TurnedAway]!, id).toBe(p.carCount);
        // Cars turned away at lots add up to the turned-away cars, and every car that parked drove off again.
        expect(p.lots.reduce((s, l) => s + l.turnedAway, 0), id).toBe(p.carCountsByState[AgentState.TurnedAway]);
        expect(p.lots.reduce((s, l) => s + l.parked, 0), id).toBeGreaterThan(300);
        expect(m.departures!.departedCars, id).toBe(p.carCountsByState[AgentState.Departed]);
        for (const l of p.lots) {
          expect(l.maxOccupancy, id).toBeLessThanOrEqual(l.stalls);
          expect(l.timeToEmpty, `${id} ${l.lotId}`).not.toBeNull();
          expect(l.timeToEmpty!, `${id} ${l.lotId}`).toBeGreaterThan(0);
        }
        for (const l of [...m.lanes, ...p.barrierLanes]) expect(l.metrics.littleLawError, `${id} lane ${l.laneId}`).toBeLessThan(1e-9);
      }
    });

    it("fair day with cars: both car parks cope with the cars, and paying at the north exit barrier builds a long exit queue", () => {
      const id = "fair-day-with-cars";
      if (!have(id)) return;
      const p = parking(id);
      expect(p.carCount).toBeGreaterThan(900);
      expect(p.carCount).toBeLessThan(1200);
      expect(p.carCountsByState[AgentState.TurnedAway]!).toBeLessThan(0.1 * p.carCount);
      expect(lotOf(id, "n-car-park").parked).toBeGreaterThan(300);
      expect(lotOf(id, "s-car-park").parked).toBeGreaterThan(300);
      // North pays at the barrier (slow exit), south at machines on foot.
      expect(exitBarrier(id, "n-exit-barrier").maxQueueMetres).toBeGreaterThan(100);
      expect(exitBarrier(id, "n-exit-barrier").meanQueueMetres).toBeGreaterThan(5 * exitBarrier(id, "s-exit-barrier").meanQueueMetres);
      expect(payServed(id)).toBe(lotOf(id, "s-car-park").parked);
      expect(lotOf(id, "n-car-park").timeToEmpty!).toBeLessThan(2 * 3600);
      // Pedestrian waits at the gates stay in the normal range of the fair day.
      expect(r(id).m.peakHour.p95Wait).toBeLessThan(200);
    });

    it("closing the north car park diverts its cars to the south one and turns the rest away", () => {
      const id = "fair-day-north-car-park-closes";
      if (!have(id)) return;
      const north = lotOf(id, "n-car-park");
      const south = lotOf(id, "s-car-park");
      expect(north.closedAt).toBe(1800);
      expect(north.divertedAway).toBeGreaterThan(100);
      expect(south.divertedIn).toBeGreaterThan(100);
      expect(south.maxOccupancy).toBe(south.stalls);
      expect(north.maxOccupancy).toBeLessThan(0.7 * north.stalls);
      expect(parking(id).carCountsByState[AgentState.TurnedAway]!).toBeGreaterThan(100);
      expect(r(id).m.countsByState[AgentState.TurnedAway]!).toBeGreaterThan(100);
      // The base day turns nobody away.
      if (have("fair-day-with-cars")) expect(parking("fair-day-with-cars").carCountsByState[AgentState.TurnedAway]!).toBeLessThan(parking(id).carCountsByState[AgentState.TurnedAway]! / 5);
    });

    it("concert with cars: the exit rush after the show builds a visible exit queue and the car park empties well after the end", () => {
      const id = "concert-cars-pay-station";
      if (!have(id)) return;
      const lot = lotOf(id, "car-park");
      const exit = exitBarrier(id, "exit-barrier");
      expect(lot.parked).toBeGreaterThan(500);
      expect(lot.maxOccupancy).toBeGreaterThan(500);
      expect(exit.maxQueueMetres).toBeGreaterThan(100);
      expect(exit.maxQueueCars).toBeGreaterThan(50);
      expect(exit.meanQueueMetres).toBeGreaterThan(30);
      expect(lot.timeToEmpty!).toBeGreaterThan(1800);
      expect(lot.timeToEmpty!).toBeLessThan(3 * 3600);
      expect(payServed(id)).toBe(lot.parked);
      // The pedestrian side still works: 5 gate lanes cope with the walk-ins from the car park too.
      expect(r(id).m.stillOutsideAtStart ?? 0).toBeLessThan(900);
    });

    it("concert car park: paying at the exit barrier instead of at the machines lengthens the exit queue and empties the lot at least 15 minutes later", () => {
      const a = "concert-cars-pay-station";
      const b = "concert-cars-pay-at-barrier";
      if (!have(a) || !have(b)) return;
      expect(payServed(b)).toBe(0);
      expect(lotOf(b, "car-park").timeToEmpty!).toBeGreaterThan(lotOf(a, "car-park").timeToEmpty! + 900);
      expect(exitBarrier(b, "exit-barrier").meanQueueMetres).toBeGreaterThan(1.2 * exitBarrier(a, "exit-barrier").meanQueueMetres);
    });
  });
});
