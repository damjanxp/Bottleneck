/**
 * Runs every built-in example scenario headless to completion and checks the qualitative outcomes
 * the examples are meant to show. Margins are generous: the point is "jams" versus "copes", not exact numbers.
 */
import { createRun, type RunMetrics } from "@bottleneck/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { exampleVenues } from "../src/index.ts";

interface Result {
  m: RunMetrics;
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
});
