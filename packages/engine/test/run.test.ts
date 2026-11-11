/**
 * Phase 1 acceptance tests for the pedestrian run (docs/PROJECT.md section 4):
 * determinism, conservation, physical rules, Little's law, lane failure, translation/rescale,
 * and a performance smoke test at the 10,000-pedestrian reference load.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_STATE_COUNT, AgentState, SNAPSHOT_FIELDS, SnapshotField, createRun, snapshotLength, type Run, type RunMetrics } from "../src/index.ts";
import { laneFailureScenario, largeScenario, mapVenue, scenarioMinimal, venueMinimal } from "./runFixtures.ts";

declare const performance: { now(): number };
declare const console: { log(...values: unknown[]): void };

function runToEnd(run: Run): Run {
  while (!run.done) run.step();
  return run;
}

/** Calls fn(run) after every tick. */
function runChecked(run: Run, fn: (run: Run) => void): Run {
  while (!run.done) {
    run.step();
    fn(run);
  }
  return run;
}

describe("determinism", () => {
  it("the same seed gives the same metrics hash; a different seed a different one", () => {
    const a = runToEnd(createRun(venueMinimal, scenarioMinimal)).metricsHash();
    const b = runToEnd(createRun(venueMinimal, scenarioMinimal)).metricsHash();
    const c = runToEnd(createRun(venueMinimal, { ...scenarioMinimal, seed: 43 })).metricsHash();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  }, 60_000);
});

describe("the minimal fixture run", () => {
  // One run, checked after every tick.
  const run = createRun(venueMinimal, scenarioMinimal);
  const { agents, bank, laneFailed, model } = run.debug;
  const serviceStartsOnFailedLane: number[] = [];
  const serviceStartsBeforeOpening: number[] = [];
  // Observe every service start (the lane bank calls this method by name).
  const internal = run as unknown as { onServiceStart(agent: number, lane: number, time: number): void };
  const original = internal.onServiceStart.bind(run);
  internal.onServiceStart = (agent, lane, time) => {
    if (laneFailed[lane] === 1) serviceStartsOnFailedLane.push(lane);
    if (run.toScenarioTime(time) < scenarioMinimal.timeline.gatesOpen) serviceStartsBeforeOpening.push(lane);
    original(agent, lane, time);
  };
  let conservationViolations = 0;
  let offWalkable = 0;
  let doubleService = 0;
  let ticks = 0;
  const perLane = new Int32Array(model.lanes.length);
  let metrics: RunMetrics;
  beforeAll(() => {
    runChecked(run, (r) => {
      ticks++;
      const counts = r.countsByState();
      let sum = 0;
      for (const c of counts) sum += c;
      const recount = new Array<number>(AGENT_STATE_COUNT).fill(0);
      perLane.fill(0);
      for (let i = 0; i < r.agentCount; i++) {
        const s = agents.state[i] as number;
        recount[s] = (recount[s] as number) + 1;
        if (s === AgentState.Walking || s === AgentState.Queuing || s === AgentState.InService) {
          if (!model.grid.isWalkableAt(agents.x[i] as number, agents.y[i] as number)) offWalkable++;
        }
        if (s === AgentState.InService) perLane[agents.lane[i] as number]! += 1;
      }
      if (sum !== r.agentCount || recount.some((c, s) => c !== counts[s])) conservationViolations++;
      for (let l = 0; l < perLane.length; l++) if ((perLane[l] as number) > 1 || (perLane[l] === 1) !== bank.inService(l) >= 0) doubleService++;
    });
    metrics = run.metrics();
  }, 60_000);

  it("drains, without a deadlock", () => {
    expect(ticks).toBeGreaterThan(1000);
    expect(run.drained).toBe(true);
    expect(run.deadlock).toBe(false);
    expect(metrics.countsByState[AgentState.Inside]).toBe(scenarioMinimal.attendance + 120);
  });

  it("conserves agents at every tick", () => {
    expect(conservationViolations).toBe(0);
  });

  it("keeps every agent on walkable cells", () => {
    expect(offWalkable).toBe(0);
  });

  it("serves at most one agent per lane, none on a failed lane, none before the gates open", () => {
    expect(doubleService).toBe(0);
    expect(serviceStartsOnFailedLane).toEqual([]);
    expect(serviceStartsBeforeOpening).toEqual([]);
    // Lane 1 failed 30 min before the start and never reopened: it served nobody after that.
    const lane1 = metrics.lanes[1]!;
    expect(run.toScenarioTime(lane1.metrics.windowEnd)).toBeLessThanOrEqual(-1800);
  });

  it("satisfies Little's law on every lane", () => {
    for (const lane of metrics.lanes) {
      const m = lane.metrics;
      expect(m.littleLawError).toBeLessThan(1e-9);
      if (m.started === 0) continue;
      if (m.queuedAtWindowEnd > 0) {
        // Only possible on a lane that failed with people queued (they were moved to other lanes).
        expect(run.laneStates()[lane.laneId]!.failed).toBe(true);
        continue;
      }
      const L = m.meanQueue;
      const lambdaW = m.arrivalRate * m.meanWait;
      expect(Math.abs(L - lambdaW)).toBeLessThanOrEqual(0.03 * lambdaW);
    }
  });

  it("reports the venue-wide metrics", () => {
    expect(metrics.peakHour.arrivals).toBeGreaterThan(0);
    expect(metrics.peakHour.p95Wait).toBeGreaterThan(0);
    expect(metrics.shareInside.time).toBe(-600);
    expect(metrics.shareInside.share).toBeGreaterThan(0.3);
    expect(metrics.shareInside.share).toBeLessThan(1);
    expect(metrics.stillOutsideAtStart).toBeGreaterThan(0);
    expect(metrics.density.mean.length).toBe(metrics.density.cols * metrics.density.rows);
    expect(metrics.parameters.elements[0]!.laneCount).toBe(5); // scenario override applied
    for (const lane of metrics.lanes) expect(lane.queueLength.length).toBe(Math.floor(run.time / 10));
  });

  it("writes structure-of-arrays snapshots", () => {
    const buf = new Float32Array(snapshotLength(run.agentCount));
    run.writeSnapshot(buf);
    expect(buf.length).toBe(SNAPSHOT_FIELDS * run.agentCount);
    const n = run.agentCount;
    expect(buf[SnapshotField.State * n]).toBe(AgentState.Inside);
    const x = buf[SnapshotField.X * n + 0]!;
    expect(x).toBeGreaterThanOrEqual(50); // inside the hall
    expect(run.density.data.length).toBe(run.density.cols * run.density.rows);
    expect(run.lanes.length).toBe(6); // 5 lanes + the manual lane
    expect(run.laneStates()[1]!.failed).toBe(true);
  });
});

describe("lane failure", () => {
  it("failing 2 of 4 lanes 30 min before the start raises the remaining lanes' maximum queue by at least 30%", () => {
    const base = runToEnd(createRun(laneFailureScenario(false).venue, laneFailureScenario(false).scenario)).metrics();
    const failed = runToEnd(createRun(laneFailureScenario(true).venue, laneFailureScenario(true).scenario)).metrics();
    // About 85% utilisation before the failure.
    const pre = base.lanes.filter((l) => !l.manual).map((l) => l.metrics.utilisation);
    for (const u of pre) expect(u).toBeGreaterThan(0.75);
    for (const lane of [0, 3]) {
      const before = base.lanes[lane]!.metrics.maxQueue;
      const after = failed.lanes[lane]!.metrics.maxQueue;
      expect(after).toBeGreaterThanOrEqual(1.3 * before);
    }
  }, 60_000);
});

describe("geometry invariance", () => {
  it("translating the venue gives a bit-identical metrics hash", () => {
    const moved = mapVenue(venueMinimal, (p) => ({ x: p.x + 1234.5, y: p.y - 987.25 }));
    const odd = mapVenue(venueMinimal, (p) => ({ x: p.x + 0.1, y: p.y + 0.7 }));
    const a = runToEnd(createRun(venueMinimal, scenarioMinimal)).metricsHash();
    expect(runToEnd(createRun(moved, scenarioMinimal)).metricsHash()).toBe(a);
    expect(runToEnd(createRun(odd, scenarioMinimal)).metricsHash()).toBe(a);
  }, 60_000);

  it("rescaling the venue by 1.01 changes the mean p95 wait over 20 paired seeds by less than 2%", () => {
    const { venue, scenario } = laneFailureScenario(false);
    const small = {
      ...scenario,
      attendance: 1530,
      arrivals: {
        preset: "custom" as const,
        points: [
          { t: -1800, weight: 1 },
          { t: 0, weight: 1 },
        ],
      },
    };
    const scaled = mapVenue(venue, (p) => ({ x: p.x * 1.01, y: p.y * 1.01 }), 1.01);
    let sumA = 0;
    let sumB = 0;
    for (let seed = 1; seed <= 20; seed++) {
      sumA += runToEnd(createRun(venue, { ...small, seed })).metrics().peakHour.p95Wait;
      sumB += runToEnd(createRun(scaled, { ...small, seed })).metrics().peakHour.p95Wait;
    }
    const change = Math.abs(sumB - sumA) / sumA;
    console.log(`rescale 1.01: mean p95 wait ${(sumA / 20).toFixed(2)} s -> ${(sumB / 20).toFixed(2)} s (${(change * 100).toFixed(2)}%)`);
    expect(change).toBeLessThan(0.02);
  }, 180_000);
});

describe("performance smoke test", () => {
  it("steps 10,000 pedestrians and reports the tick time", () => {
    const { venue, scenario } = largeScenario();
    const t0 = performance.now();
    const run = createRun(venue, scenario);
    const build = performance.now() - t0;
    const times: number[] = [];
    let maxActive = 0;
    const snapshot = new Float32Array(snapshotLength(run.agentCount));
    for (let tick = 0; tick < 6000 && !run.done; tick++) {
      const t = performance.now();
      run.step();
      times.push(performance.now() - t);
      const c = run.countsByState();
      const active = c[AgentState.Walking]! + c[AgentState.Queuing]! + c[AgentState.InService]!;
      if (active > maxActive) maxActive = active;
      if (tick % 12 === 0) run.writeSnapshot(snapshot);
    }
    const sorted = Float64Array.from(times).sort();
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    console.log(`10k pedestrians: build ${build.toFixed(0)} ms, ${times.length} ticks, mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max on site ${maxActive}`);
    expect(run.agentCount).toBe(10000);
    expect(maxActive).toBeGreaterThan(9000);
    // A smoke test, not the [human] performance check: only catch gross regressions.
    expect(p95).toBeLessThan(100);
  }, 300_000);
});
