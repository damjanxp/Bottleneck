/**
 * Unit tests for the building blocks of a run: arrival curves, the walkable grid, flow fields,
 * Weidmann speeds, LaneBank.withdraw, and run features not covered by run.test.ts
 * (screening before the gates, lane reopening, the deadlock watchdog, open-door events).
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import { describe, expect, it } from "vitest";
import { buildFlowField } from "../src/flowField.ts";
import { buildWalkGrid, localFrame } from "../src/geometry.ts";
import { AgentState, EventKind, LaneBank, PiecewiseLinearCurve, Simulation, createRun, resolveArrivalPoints, weidmannFactor, type EventHandler, type Run } from "../src/index.ts";
import { mapVenue, scenarioMinimal, venueMinimal } from "./runFixtures.ts";

function runToEnd(run: Run): Run {
  while (!run.done) run.step();
  return run;
}

describe("arrival curves", () => {
  const timeline = scenarioMinimal.timeline;

  it("concert preset: about 20% in the last 15 min, peak 45-60 min before, about 10% after the start", () => {
    const c = new PiecewiseLinearCurve(resolveArrivalPoints({ preset: "concert" }, timeline));
    expect(c.share(-900, 0)).toBeGreaterThan(0.18);
    expect(c.share(-900, 0)).toBeLessThan(0.22);
    expect(c.share(0, 1e9)).toBeGreaterThan(0.08);
    expect(c.share(0, 1e9)).toBeLessThan(0.13);
    expect(c.start).toBe(-5400);
  });

  it("stadium preset: about 5% after kick-off", () => {
    const c = new PiecewiseLinearCurve(resolveArrivalPoints({ preset: "stadium" }, timeline));
    expect(c.share(0, 1e9)).toBeGreaterThan(0.03);
    expect(c.share(0, 1e9)).toBeLessThan(0.07);
  });

  it("the inverse-CDF sampler reproduces the curve's shares", () => {
    const c = new PiecewiseLinearCurve([
      { t: 0, weight: 0 },
      { t: 100, weight: 2 },
      { t: 300, weight: 2 },
      { t: 400, weight: 0 },
    ]);
    const n = 20000;
    let firstSegment = 0;
    let previous = -Infinity;
    for (let k = 0; k < n; k++) {
      const t = c.sample((k + 0.5) / n);
      expect(t).toBeGreaterThanOrEqual(previous); // monotone in u
      previous = t;
      if (t < 100) firstSegment++;
    }
    expect(firstSegment / n).toBeCloseTo(c.share(0, 100), 3);
    expect(c.share(0, 100)).toBeCloseTo(100 / 600, 12);
  });
});

describe("walkable grid and flow fields", () => {
  it("rasterises walkable areas minus holes and obstacles", () => {
    const venue: Venue = {
      ...venueMinimal,
      walkableAreas: [{ id: "a", polygon: { outer: square(0, 0, 10), holes: [square(2, 2, 2)] } }],
      obstacles: [{ id: "o", polygon: { outer: square(6, 6, 2) } }],
    };
    const grid = buildWalkGrid(venue, localFrame(venue));
    expect(grid.cols).toBe(20);
    expect(grid.rows).toBe(20);
    expect(grid.isWalkableAt(1, 1)).toBe(true);
    expect(grid.isWalkableAt(3, 3)).toBe(false); // hole
    expect(grid.isWalkableAt(7, 7)).toBe(false); // obstacle
    expect(grid.isWalkableAt(10.2, 5)).toBe(false); // outside
    let walkable = 0;
    for (const w of grid.walkable) walkable += w;
    expect(walkable).toBe(400 - 16 - 16);
  });

  it("gives the same grid for a translated venue", () => {
    const moved = mapVenue(venueMinimal, (p) => ({ x: p.x - 333.3, y: p.y + 0.1 }));
    const a = buildWalkGrid(venueMinimal, localFrame(venueMinimal));
    const b = buildWalkGrid(moved, localFrame(moved));
    expect(Array.from(b.walkable)).toEqual(Array.from(a.walkable));
  });

  it("measures 8-neighbour walking distance around an obstacle", () => {
    const venue: Venue = {
      ...venueMinimal,
      walkableAreas: [{ id: "a", polygon: { outer: square(0, 0, 10) } }],
      obstacles: [{ id: "wall", polygon: { outer: rect(4, 0, 5, 8) } }],
    };
    const grid = buildWalkGrid(venue, localFrame(venue));
    const target = grid.cellAt(9.25, 0.25);
    const field = buildFlowField(grid, [target]);
    const start = grid.cellAt(0.25, 0.25);
    // Straight-line distance is 9 m, but the path has to go round the wall's end at y = 8:
    // about 3.5·√2 + 4.5 + 1.5 + 4·√2 + 4 ≈ 20.6 m on the 8-neighbour grid.
    expect(field.distanceAt(start)).toBeCloseTo(20.6066, 3);
    expect(field.distanceAt(target)).toBe(0);
    // Following `next` reaches the target over walkable cells.
    let cell = start;
    for (let k = 0; k < 200 && cell !== target; k++) {
      cell = field.next[cell] as number;
      expect(grid.walkable[cell]).toBe(1);
    }
    expect(cell).toBe(target);
  });
});

describe("Weidmann speed-density relation", () => {
  it("is free-flow below 0.1 /m², decreasing above, floored at 0.1 at and beyond rhoMax", () => {
    expect(weidmannFactor(0, 1.913, 5.4)).toBe(1);
    expect(weidmannFactor(0.09, 1.913, 5.4)).toBe(1);
    const f1 = weidmannFactor(1, 1.913, 5.4);
    const f3 = weidmannFactor(3, 1.913, 5.4);
    expect(f1).toBeCloseTo(1 - Math.exp(-1.913 * (1 - 1 / 5.4)), 12);
    expect(f3).toBeLessThan(f1);
    expect(weidmannFactor(5.4, 1.913, 5.4)).toBe(0.1);
    expect(weidmannFactor(9, 1.913, 5.4)).toBe(0.1);
  });
});

describe("LaneBank.withdraw", () => {
  it("removes a queued agent and keeps Little's law exact", () => {
    // eslint-disable-next-line prefer-const
    let bank: LaneBank;
    const sim = new Simulation<number>(new Map<number, EventHandler<number>>([[EventKind.ServiceComplete, (e) => bank.handleServiceComplete(e)]]));
    bank = new LaneBank(sim, { serviceTime: () => 10, onLeave: () => {} }, 2);
    bank.commit(0, 1);
    bank.commit(0, 2);
    bank.commit(0, 3);
    sim.runUntil(3);
    expect(bank.withdraw(0, 2)).toBe(true);
    expect(bank.withdraw(0, 1)).toBe(false); // in service
    bank.commit(1, 2);
    expect(bank.positionOf(0, 3)).toBe(0);
    sim.runUntil(60);
    const m = bank.metrics(0);
    expect(m.arrivals).toBe(2);
    expect(m.started).toBe(2);
    expect(m.littleLawError).toBeLessThan(1e-12);
    expect(bank.metrics(1).started).toBe(1);
  });
});

describe("run features", () => {
  it("passes screening before the gates", () => {
    const venue: Venue = {
      ...venueMinimal,
      screeningStages: [
        {
          id: "security",
          name: "Security",
          line: { a: { x: 25, y: 35 }, b: { x: 25, y: 15 } },
          laneCount: 2,
          queueLength: 8,
          serviceTime: { kind: "uniform", min: 8, max: 16 },
        },
      ],
      gateGroups: venueMinimal.gateGroups.map((g) => ({ ...g, screeningStageId: "security" })),
    };
    const scenario: Scenario = { ...scenarioMinimal, attendance: 400, overrides: {}, timedEvents: [] };
    const run = runToEnd(createRun(venue, scenario));
    const m = run.metrics();
    expect(run.drained).toBe(true);
    const screened = m.lanes.filter((l) => l.elementKind === "screening").reduce((s, l) => s + l.metrics.served, 0);
    const gated = m.lanes.filter((l) => l.elementKind === "gate").reduce((s, l) => s + l.metrics.served, 0);
    expect(screened).toBe(400);
    expect(gated).toBe(400);
    for (const l of m.lanes) expect(l.metrics.littleLawError).toBeLessThan(1e-9);
  }, 30_000);

  it("reopens a failed lane, and the watchdog stops a run whose lanes have all failed", () => {
    const base: Scenario = { ...scenarioMinimal, attendance: 200, overrides: { "gate-a": { laneCount: 2 } }, timedEvents: [] };
    const reopened = runToEnd(
      createRun(venueMinimal, {
        ...base,
        timedEvents: [
          { kind: "laneFail", at: -5000, groupId: "gate-a", laneIndex: 0 },
          { kind: "laneFail", at: -5000, groupId: "gate-a", laneIndex: 1 },
          { kind: "laneReopen", at: -3000, groupId: "gate-a", laneIndex: 1 },
        ],
      }),
    );
    expect(reopened.drained).toBe(true);
    expect(reopened.metrics().lanes[0]!.metrics.started).toBe(0);

    const stuck = runToEnd(
      createRun(venueMinimal, {
        ...base,
        timedEvents: [
          { kind: "laneFail", at: -5400, groupId: "gate-a", laneIndex: 0 },
          { kind: "laneFail", at: -5400, groupId: "gate-a", laneIndex: 1 },
        ],
      }),
    );
    expect(stuck.deadlock).toBe(true);
    expect(stuck.drained).toBe(false);
    const m = stuck.metrics();
    expect(m.countsByState[AgentState.Inside]).toBe(0);
    expect(m.stillOutsideAtStart).toBe(m.agentCount);
  }, 30_000);

  it("handles an open-door event (no fixed start) and arrivals before the gates open", () => {
    const scenario: Scenario = {
      ...scenarioMinimal,
      eventType: "fair",
      attendance: 300,
      timeline: { referenceClock: "10:00", gatesOpen: 600, eventStart: null, eventEnd: 7200, horizon: 9000 },
      arrivals: { preset: "fair" },
      overrides: {},
      timedEvents: [],
    };
    const run = createRun(venueMinimal, scenario);
    // People arrive from t = 0, before the gates open at 600: the run starts a whole minute earlier.
    expect(run.timeOffset).toBeLessThan(600);
    expect(run.timeOffset % 60).toBe(0);
    runToEnd(run);
    const m = run.metrics();
    expect(run.drained).toBe(true);
    expect(m.stillOutsideAtStart).toBeNull();
    expect(m.shareInside.time).toBe(600 + 3600);
    for (const l of m.lanes) expect(run.toScenarioTime(l.metrics.windowEnd) >= 600 || l.metrics.started === 0).toBe(true);
  }, 30_000);
});

function square(x: number, y: number, size: number) {
  return rect(x, y, x + size, y + size);
}

function rect(x0: number, y0: number, x1: number, y1: number) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}
