/**
 * Phase 1 additions to the run: metrics refinements (outside-at-start breakdown, lane periods
 * before/after the start, queue waits from joining the line, capacity against demand), groups,
 * bag policy, mixture distributions, scenario parameters and engine checkpoints.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import { describe, expect, it } from "vitest";
import {
  AgentState,
  BAG_POLICY_SERVICE_TIME,
  RUN_DEFAULTS,
  SERVICE_TIME_PRESETS,
  createRun,
  distributionMoments,
  makeSampler,
  restoreRun,
  type Run,
  type RunCheckpoint,
} from "../src/index.ts";
import { scenarioMinimal, venueMinimal } from "./runFixtures.ts";

declare const structuredClone: <T>(value: T) => T;

function runToEnd(run: Run): Run {
  while (!run.done) run.step();
  return run;
}

/** A smaller copy of the minimal fixture scenario (the same lane failure and bus burst). */
const scenario: Scenario = { ...scenarioMinimal, attendance: 1200 };

describe("metrics refinements", () => {
  const run = runToEnd(createRun(venueMinimal, scenario));
  const m = run.metrics();

  it("splits the people still outside at the start into arrived and not yet arrived", () => {
    expect(m.stillOutsideAtStart).toBeGreaterThan(0);
    expect((m.arrivedButOutsideAtStart ?? 0) + (m.notYetArrivedAtStart ?? 0)).toBe(m.stillOutsideAtStart);
    // The concert preset has about 11% of arrivals after the start.
    expect(m.notYetArrivedAtStart).toBeGreaterThan(0);
  });

  it("reports each lane's services before and after the event start", () => {
    for (const l of m.lanes) {
      const before = l.beforeStart!;
      const after = l.afterStart!;
      expect(before.started + after.started).toBe(l.metrics.started);
      expect(before.queueWait.count).toBe(before.started);
      if (l.metrics.started > 0) expect(Math.max(before.maxWait, after.maxWait)).toBe(l.metrics.maxWait);
      for (const u of [before.utilisation, after.utilisation]) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    const busiest = m.lanes.filter((l) => !l.manual).sort((a, b) => b.metrics.started - a.metrics.started)[0]!;
    expect(busiest.beforeStart!.utilisation).toBeGreaterThan(0);
  });

  it("measures queue waits from physically joining the line, never longer than Wq", () => {
    for (const l of m.lanes) {
      expect(l.queueWait.count).toBe(l.metrics.started);
      expect(l.queueWait.mean).toBeLessThanOrEqual(l.metrics.meanWait + 1e-9);
      expect(l.queueWait.max).toBeLessThanOrEqual(l.metrics.maxWait + 1e-9);
    }
    const regular = m.lanes.filter((l) => !l.manual && l.metrics.started > 0);
    // Walking to the line takes time, so the wait from joining it is clearly shorter on average.
    expect(regular.some((l) => l.queueWait.mean < l.metrics.meanWait - 1)).toBe(true);
  });

  it("marks the manual lane", () => {
    const manual = m.lanes.filter((l) => l.laneType === "manual");
    expect(manual.length).toBe(1);
    expect(manual[0]!.manual).toBe(true);
    expect(manual[0]!.laneIndex).toBe(5);
    expect(m.lanes.filter((l) => l.laneType === "regular").every((l) => !l.manual)).toBe(true);
  });

  it("reports capacity per hour against peak demand per hour", () => {
    expect(m.elements.length).toBe(1);
    const e = m.elements[0]!;
    const meanBusy = distributionMoments(venueMinimal.gateGroups[0]!.serviceTime).mean + 0.03 * 10;
    expect(e.meanBusyTime).toBeCloseTo(meanBusy, 12);
    expect(e.capacityPerHour).toBeCloseTo((5 * 3600) / meanBusy, 9);
    expect(e.peakDemandPerHour).toBeGreaterThan(0);
    expect(e.peakDemandPerHour).toBeLessThanOrEqual(m.agentCount);
    expect(e.utilisation.length).toBeGreaterThan(0);
    for (const u of e.utilisation) expect(u).toBeLessThanOrEqual(1 + 1e-9);
    if (e.below85At !== null) {
      expect(e.peakUtilisation).toBeGreaterThanOrEqual(RUN_DEFAULTS.reliefUtilisation);
      expect(e.below85At).toBeGreaterThan(e.peakUtilisationAt!);
    }
  });

  it("leaves the start-related metrics null for open-door events", () => {
    const fair: Scenario = {
      ...scenario,
      eventType: "fair",
      attendance: 200,
      timeline: { referenceClock: "10:00", gatesOpen: 0, eventStart: null, eventEnd: 7200, horizon: 9000 },
      arrivals: { preset: "fair" },
      timedEvents: [],
    };
    const mf = runToEnd(createRun(venueMinimal, fair)).metrics();
    expect(mf.arrivedButOutsideAtStart).toBeNull();
    expect(mf.notYetArrivedAtStart).toBeNull();
    for (const l of mf.lanes) {
      expect(l.beforeStart).toBeNull();
      expect(l.afterStart).toBeNull();
    }
  });
});

describe("groups", () => {
  it("arrive together at one source, walk at one pace, and mostly choose the same lane", () => {
    const run = createRun(venueMinimal, { ...scenario, timedEvents: [] });
    const a = run.debug.agents;
    const sizes = new Map<number, number>();
    for (let i = 0; i < run.agentCount; i++) {
      const leader = a.group[i]!;
      expect(leader).toBeLessThanOrEqual(i);
      expect(a.arrivalTime[i]).toBe(a.arrivalTime[leader]);
      expect(a.source[i]).toBe(a.source[leader]);
      expect(a.freeSpeed[i]).toBe(a.freeSpeed[leader]);
      sizes.set(leader, (sizes.get(leader) ?? 0) + 1);
    }
    const counts = [...sizes.values()];
    expect(Math.max(...counts)).toBeLessThanOrEqual(5);
    const mean = run.agentCount / counts.length;
    expect(mean).toBeGreaterThan(1.9); // 2.2 expected with the default sizes
    expect(mean).toBeLessThan(2.5);

    // First lane each agent commits to.
    const first = new Int32Array(run.agentCount).fill(-1);
    while (!run.done) {
      run.step();
      for (let i = 0; i < run.agentCount; i++) if (first[i] === -1 && a.state[i] === AgentState.Queuing && a.lane[i]! >= 0) first[i] = a.lane[i]!;
    }
    let members = 0;
    let same = 0;
    for (let i = 0; i < run.agentCount; i++) {
      const leader = a.group[i]!;
      if (leader === i) continue;
      members++;
      if (first[i] === first[leader]) same++;
    }
    expect(same / members).toBeGreaterThan(0.9);
  }, 30_000);

  it("groupSizes [1] makes everyone arrive alone", () => {
    const run = createRun(venueMinimal, { ...scenario, parameters: { ...scenario.parameters, groupSizes: [1] } });
    for (let i = 0; i < run.agentCount; i++) expect(run.debug.agents.group[i]).toBe(i);
    expect(run.parameters.groupSizes).toEqual([1]);
  });
});

describe("scenario parameters", () => {
  it("are read from the scenario and stored in the resolved parameters", () => {
    const run = createRun(venueMinimal, {
      ...scenario,
      parameters: {
        decisionDistance: 12,
        logitScale: 30,
        slotSpacing: 0.5,
        jockeyThreshold: 4,
        manualLaneServiceTime: { kind: "fixed", value: 25 },
        watchdogMinutes: 5,
        shareInsideAt: -1200,
        groupSizes: [1, 1],
      },
    });
    const p = run.parameters;
    expect([p.decisionDistance, p.logitScale, p.slotSpacing, p.jockeyThreshold, p.watchdogMinutes, p.shareInsideAt]).toEqual([12, 30, 0.5, 4, 5, -1200]);
    expect(p.manualLaneServiceTime).toEqual({ kind: "fixed", value: 25 });
    expect(p.groupSizes).toEqual([1, 1]);
    expect(p.bagPolicy).toBeNull();
    // Defaults where the scenario is silent.
    const d = createRun(venueMinimal, { ...scenario, parameters: {} }).parameters;
    expect(d.decisionDistance).toBe(RUN_DEFAULTS.decisionDistance);
    expect(d.groupSizes).toEqual(RUN_DEFAULTS.groupSizes);
    expect(d.shareInsideAt).toBe(-600);
  });

  it("bag policy sets the screening service time; an element override still wins", () => {
    const venue: Venue = {
      ...venueMinimal,
      screeningStages: [{ id: "security", name: "Security", line: { a: { x: 25, y: 35 }, b: { x: 25, y: 15 } }, laneCount: 2, queueLength: 8, serviceTime: { kind: "fixed", value: 3 } }],
      gateGroups: venueMinimal.gateGroups.map((g) => ({ ...g, screeningStageId: "security" })),
    };
    const base: Scenario = { ...scenario, attendance: 100, overrides: {}, timedEvents: [] };
    const full = createRun(venue, { ...base, parameters: { bagPolicy: "fullSearch" } }).parameters;
    expect(full.bagPolicy).toBe("fullSearch");
    expect(full.elements.find((e) => e.id === "security")!.serviceTime).toEqual(BAG_POLICY_SERVICE_TIME.fullSearch);
    expect(full.elements.find((e) => e.id === "gate-a")!.serviceTime).toEqual(venueMinimal.gateGroups[0]!.serviceTime);
    expect(distributionMoments(BAG_POLICY_SERVICE_TIME.none).mean).toBeCloseTo(2.5, 9);
    expect(distributionMoments(BAG_POLICY_SERVICE_TIME.clearBag).mean).toBeCloseTo(4, 9);
    expect(distributionMoments(BAG_POLICY_SERVICE_TIME.fullSearch).mean).toBeCloseTo(10, 9);
    const overridden = createRun(venue, { ...base, parameters: { bagPolicy: "fullSearch" }, overrides: { security: { serviceTime: { kind: "fixed", value: 5 } } } }).parameters;
    expect(overridden.elements.find((e) => e.id === "security")!.serviceTime).toEqual({ kind: "fixed", value: 5 });
    const none = createRun(venue, base).parameters;
    expect(none.elements.find((e) => e.id === "security")!.serviceTime).toEqual({ kind: "fixed", value: 3 });
  });
});

describe("mixture distributions", () => {
  it("the turnstile default is a 50/50 mix of card (mean 3 s) and QR (mean 4.5 s) with exact moments", () => {
    const t = SERVICE_TIME_PRESETS.turnstile;
    const card = distributionMoments(SERVICE_TIME_PRESETS.turnstileCard);
    const qr = distributionMoments(SERVICE_TIME_PRESETS.turnstileQr);
    const m = distributionMoments(t);
    expect(card.mean).toBeCloseTo(3, 9);
    expect(qr.mean).toBeCloseTo(4.5, 9);
    expect(m.mean).toBeCloseTo(3.75, 9);
    expect(m.secondMoment).toBeCloseTo((card.secondMoment + qr.secondMoment) / 2, 9);

    const sample = makeSampler(t, 7, 4);
    const n = 100_000;
    let sum = 0;
    let sum2 = 0;
    let below25 = 0;
    for (let i = 0; i < n; i++) {
      const x = sample(i, 0);
      sum += x;
      sum2 += x * x;
      if (x < 2.5) below25++;
    }
    expect(sum / n).toBeCloseTo(m.mean, 1);
    expect(Math.abs(sum2 / n - m.secondMoment) / m.secondMoment).toBeLessThan(0.02);
    // Only card scans (half the draws) can be under 2.5 s; about 13% of them are.
    expect(below25 / n).toBeGreaterThan(0.03);
    expect(below25 / n).toBeLessThan(0.15);
    expect(sample(3, 1)).toBe(sample(3, 1));
  });

  it("weights need not sum to 1", () => {
    const m = distributionMoments({
      kind: "mixture",
      components: [
        { weight: 3, distribution: { kind: "fixed", value: 2 } },
        { weight: 1, distribution: { kind: "fixed", value: 6 } },
      ],
    });
    expect(m.mean).toBe(3);
    expect(m.secondMoment).toBe(12);
  });
});

describe("checkpoints", () => {
  it("restoring a checkpoint and running on gives a bit-identical metrics hash", () => {
    const reference = createRun(venueMinimal, scenario);
    const checkpoints: { tick: number; cp: RunCheckpoint }[] = [];
    let tick = 0;
    while (!reference.done) {
      reference.step();
      tick++;
      // Every 10 simulated minutes, like a replay worker would.
      if (tick % 2400 === 0) checkpoints.push({ tick, cp: structuredClone(reference.saveCheckpoint()) });
    }
    const expected = reference.metricsHash();
    expect(checkpoints.length).toBeGreaterThanOrEqual(3);
    for (const { cp } of [checkpoints[0]!, checkpoints[Math.floor(checkpoints.length / 2)]!, checkpoints[checkpoints.length - 1]!]) {
      const resumed = restoreRun(venueMinimal, scenario, cp);
      expect(resumed.time).toBe(cp.time);
      runToEnd(resumed);
      expect(resumed.metricsHash()).toBe(expected);
    }
  }, 60_000);

  it("a restored run matches the original mid-run, and rejects a checkpoint of another scenario", () => {
    const a = createRun(venueMinimal, scenario);
    for (let k = 0; k < 6000; k++) a.step();
    const restored = restoreRun(venueMinimal, scenario, a.saveCheckpoint());
    expect(restored.metricsHash()).toBe(a.metricsHash());
    expect(restored.countsByState()).toEqual(a.countsByState());
    for (let k = 0; k < 400; k++) {
      a.step();
      restored.step();
    }
    const sa = new Float32Array(a.agentCount * 5);
    const sb = new Float32Array(a.agentCount * 5);
    a.writeSnapshot(sa);
    restored.writeSnapshot(sb);
    expect(sb).toEqual(sa);
    expect(Array.from(restored.density.data)).toEqual(Array.from(a.density.data));
    expect(() => restoreRun(venueMinimal, { ...scenario, seed: 1 }, a.saveCheckpoint())).toThrow(RangeError);
  }, 60_000);
});

describe("service log", () => {
  it("records every attempt in time order, is restored exactly, and does not change the metrics", () => {
    const a = createRun(venueMinimal, scenario);
    for (let k = 0; k < 6000; k++) a.step();
    const mid = a.serviceLog();
    expect(mid.length).toBeGreaterThan(20);
    const restored = restoreRun(venueMinimal, scenario, structuredClone(a.saveCheckpoint()));
    expect(restored.serviceLog()).toEqual(mid);
    runToEnd(a);
    runToEnd(restored);
    const log = a.serviceLog();
    expect(restored.serviceLog()).toEqual(log);
    expect(restored.metricsHash()).toBe(a.metricsHash());
    for (let i = 0; i < log.length; i++) {
      const r = log[i]!;
      expect(r.end).toBeGreaterThan(r.start);
      if (i > 0) expect(r.end).toBeGreaterThanOrEqual(log[i - 1]!.end);
    }
    // Passes equal the metrics' served counts; scan retries exist because scanFailure.rate > 0.
    const passes = log.filter((r) => r.outcome === "pass").length;
    const served = a.metrics().lanes.reduce((n, l) => n + l.metrics.served, 0);
    expect(passes).toBe(served);
    expect(log.some((r) => r.outcome === "retry")).toBe(true);
    // A lane serves one attempt at a time.
    const lastEnd = new Map<number, number>();
    for (const r of log) {
      expect(r.start).toBeGreaterThanOrEqual(lastEnd.get(r.laneId) ?? 0);
      lastEnd.set(r.laneId, r.end);
    }
  }, 60_000);
});
