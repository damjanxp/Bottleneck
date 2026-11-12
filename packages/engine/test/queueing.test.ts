/**
 * Validation tests for the lane queueing core against queueing theory (spec 7.2, Fixed).
 *
 * Statistical tests use the rule from review note B6: with 20 pinned seeds, the 95% confidence
 * interval of the measured mean must CONTAIN the theoretical value, and its half-width must be
 * under 3% of that value. The first part catches bias; the second stops a noisy result from
 * passing by accident.
 */

import { describe, expect, it } from "vitest";
import {
  EventKind,
  LaneBank,
  RandomStream,
  Simulation,
  distributionMoments,
  makeSampler,
  sampleExponential,
  shiftedLognormalFromMean,
  uniform,
  type EventHandler,
  type Sampler,
  type ServiceOutcome,
} from "../src/index.ts";

interface SingleLaneRun {
  sim: Simulation<number>;
  bank: LaneBank;
  /** Mean waiting time of services that started at or after `from`. */
  meanWaitFrom(from: number): number;
}

/** One lane with arrivals injected directly at it. `gap(i)` is the time between arrival i−1 and i. */
function singleLane(gap: (i: number) => number, service: Sampler, outcome?: (agent: number, attempt: number) => ServiceOutcome): SingleLaneRun {
  const starts: number[] = [];
  // eslint-disable-next-line prefer-const
  let bank: LaneBank;
  const onArrival: EventHandler<number> = (event, sim) => {
    const agent = event.payload;
    sim.schedule(sim.now + gap(agent + 1), EventKind.Arrival, 0, agent + 1);
    bank.commit(0, agent);
  };
  const sim = new Simulation<number>(
    new Map<number, EventHandler<number>>([
      [EventKind.Arrival, onArrival],
      [EventKind.ServiceComplete, (event) => bank.handleServiceComplete(event)],
    ]),
  );
  bank = new LaneBank(
    sim,
    {
      serviceTime: (agent) => service(agent, 0),
      outcome: outcome ? (agent, _lane, attempt) => outcome(agent, attempt) : undefined,
      onServiceStart: (_agent, _lane, time) => starts.push(time),
      onLeave: () => {},
    },
    1,
  );
  sim.schedule(gap(0), EventKind.Arrival, 0, 0);
  return {
    sim,
    bank,
    meanWaitFrom(from) {
      const waits = bank.waits(0);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < waits.length; i++) {
        if ((starts[i] as number) >= from) {
          sum += waits[i] as number;
          n++;
        }
      }
      return sum / n;
    },
  };
}

/** Mean and 95% confidence half-width (Student t, 19 degrees of freedom) of 20 values. */
function confidence(values: number[]): { mean: number; halfWidth: number } {
  expect(values.length).toBe(20);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return { mean, halfWidth: 2.093 * Math.sqrt(variance / values.length) };
}

function expectMatchesTheory(values: number[], theory: number, label: string): void {
  const { mean, halfWidth } = confidence(values);
  expect(Math.abs(mean - theory), `${label}: mean ${mean} vs theory ${theory} (CI ±${halfWidth})`).toBeLessThanOrEqual(halfWidth);
  expect(halfWidth / theory, `${label}: CI half-width ${halfWidth} too wide`).toBeLessThan(0.03);
}

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i);
const HOUR = 3600;

describe("D/D/1: deterministic arrivals and service", () => {
  it("at 80% utilisation the queue stays empty", () => {
    const run = singleLane(() => 1, () => 0.8);
    run.sim.runUntil(2 * HOUR);
    const m = run.bank.metrics(0);
    expect(m.maxQueue).toBeLessThanOrEqual(1); // an arrival is in the queue for an instant before service starts
    expect(m.meanQueue).toBe(0);
    expect(m.maxWait).toBe(0);
    expect(m.utilisation).toBeCloseTo(0.8, 3);
    expect(m.served).toBeGreaterThan(7190);
  });

  it("at 125% utilisation the queue at time t is (λ − μ)·t ± 1", () => {
    const lambda = 1.25;
    const mu = 1;
    const run = singleLane(() => 1 / lambda, () => 1 / mu);
    for (const t of [100, 400, 1000, 3600]) {
      run.sim.runUntil(t);
      expect(Math.abs(run.bank.queueLength(0) - (lambda - mu) * t), `queue at t=${t}`).toBeLessThanOrEqual(1);
    }
  });

  it("a 3.1 s service takes exactly 3.1 s, independent of the 0.25 s tick", () => {
    const run = singleLane(() => 3.1, () => 3.1);
    run.sim.runUntil(3100);
    // Back-to-back services with no idle gaps: utilisation is 1 and nobody waits.
    const m = run.bank.metrics(0);
    expect(m.utilisation).toBeCloseTo(1, 9);
    expect(m.maxWait).toBeLessThan(1e-9);
    expect(m.served).toBe(999);
  });
});

describe("M/D/1 at 70% utilisation", () => {
  it("mean queue length matches ρ²/(2(1−ρ)) = 0.817 over 20 seeds × 10 h after a 1 h warm-up", () => {
    const rho = 0.7;
    const theory = (rho * rho) / (2 * (1 - rho));
    const lq = SEEDS.map((seed) => {
      const run = singleLane((i) => sampleExponential(uniform(seed, RandomStream.ArrivalTime, i, 0), 1 / rho), () => 1);
      run.sim.runUntil(1 * HOUR);
      const atWarmUp = run.bank.queueIntegral(0);
      run.sim.runUntil(11 * HOUR);
      return (run.bank.queueIntegral(0) - atWarmUp) / (10 * HOUR);
    });
    expectMatchesTheory(lq, theory, "M/D/1 Lq");
  }, 60_000);
});

describe("M/G/1 at 80% utilisation with the default scan-time distribution", () => {
  // The turnstile default: never under 2.5 s, 4 s on average, lognormal tail (spec section 5).
  const scan = shiftedLognormalFromMean(2.5, 4, 0.6);
  const { mean: es, secondMoment: es2 } = distributionMoments(scan);
  const rho = 0.8;
  const lambda = rho / es;

  it("the sampler has the distribution's analytic mean", () => {
    const sample = makeSampler(scan, 7, RandomStream.ScanTime);
    let sum = 0;
    for (let i = 0; i < 200_000; i++) sum += sample(i, 0);
    expect(es).toBeCloseTo(4, 9);
    expect(Math.abs(sum / 200_000 - es) / es).toBeLessThan(0.005);
  });

  it("mean wait matches Pollaczek–Khinchine, Wq = λ·E[S²] / (2(1−ρ))", () => {
    const theory = (lambda * es2) / (2 * (1 - rho));
    const wq = SEEDS.map((seed) => {
      const run = singleLane((i) => sampleExponential(uniform(seed, RandomStream.ArrivalTime, i, 0), 1 / lambda), makeSampler(scan, seed, RandomStream.ScanTime));
      run.sim.runUntil(41 * HOUR);
      return run.meanWaitFrom(1 * HOUR);
    });
    expectMatchesTheory(wq, theory, "M/G/1 Wq");
  }, 60_000);
});

describe("Little's law, L = λ·W, within 3% on the lane's reporting window", () => {
  it("holds for M/D/1, M/G/1 and an overloaded lane", () => {
    const scan = shiftedLognormalFromMean(2.5, 4, 0.6);
    const cases: [string, SingleLaneRun][] = [
      ["M/D/1 ρ=0.7", singleLane((i) => sampleExponential(uniform(1, RandomStream.ArrivalTime, i, 0), 1 / 0.7), () => 1)],
      ["M/G/1 ρ=0.8", singleLane((i) => sampleExponential(uniform(2, RandomStream.ArrivalTime, i, 0), 5), makeSampler(scan, 2, RandomStream.ScanTime))],
      ["M/G/1 ρ=1.1 (overloaded)", singleLane((i) => sampleExponential(uniform(3, RandomStream.ArrivalTime, i, 0), 4 / 1.1), makeSampler(scan, 3, RandomStream.ScanTime))],
    ];
    for (const [name, run] of cases) {
      run.sim.runUntil(4 * HOUR);
      const m = run.bank.metrics(0);
      expect(m.started).toBeGreaterThan(1000);
      expect(m.littleLawError, name).toBeLessThan(1e-9);
      // When (almost) nobody is left queuing at the window end, this is the textbook L = λ·W.
      if (m.queuedAtWindowEnd <= 2) expect(Math.abs(m.meanQueue - m.arrivalRate * m.meanWait) / m.meanQueue, name).toBeLessThan(0.03);
      else expect(name).toContain("overloaded");
    }
  });
});

describe("scan failures and lane failure", () => {
  it("a retry keeps the lane busy for the extra time; a reject frees it without serving", () => {
    const left: [number, boolean, number][] = [];
    // eslint-disable-next-line prefer-const
    let bank: LaneBank;
    const sim = new Simulation<number>(new Map<number, EventHandler<number>>([[EventKind.ServiceComplete, (e) => bank.handleServiceComplete(e)]]));
    bank = new LaneBank(
      sim,
      {
        serviceTime: () => 4,
        // Agent 0 passes; agent 1 fails once then passes; agent 2 fails twice and is rejected.
        outcome: (agent, _lane, attempt) => (attempt < agent ? (attempt === 1 ? { kind: "reject" } : { kind: "retry", extra: 10 }) : { kind: "done" }),
        onLeave: (agent, _lane, time, served) => left.push([agent, served, time]),
      },
      1,
    );
    bank.commit(0, 0);
    bank.commit(0, 1);
    bank.commit(0, 2);
    sim.runUntil(100);
    expect(left).toEqual([
      [0, true, 4],
      [1, true, 18], // 4 + 4 + 10
      [2, false, 32], // 18 + 4 + 10, then rejected on the second failure
    ]);
    expect(bank.metrics(0).served).toBe(2);
  });

  it("a failed lane serves no one and hands back its queue in arrival order", () => {
    // eslint-disable-next-line prefer-const
    let bank: LaneBank;
    const served: number[] = [];
    const sim = new Simulation<number>(new Map<number, EventHandler<number>>([[EventKind.ServiceComplete, (e) => bank.handleServiceComplete(e)]]));
    bank = new LaneBank(sim, { serviceTime: () => 5, onLeave: (agent) => served.push(agent) }, 2);
    for (const agent of [10, 11, 12, 13]) bank.commit(0, agent);
    sim.runUntil(1);
    const displaced = bank.fail(0);
    expect(displaced).toEqual([11, 12, 13]); // agent 10 is mid-service and finishes
    for (const agent of displaced) bank.commit(1, agent);
    sim.runUntil(60);
    expect(served).toEqual([10, 11, 12, 13]);
    expect(bank.metrics(0).served).toBe(1);
    expect(bank.metrics(1).served).toBe(3);

    bank.commit(0, 14);
    sim.runUntil(120);
    expect(served).not.toContain(14); // failed lane serves none
    bank.reopen(0);
    sim.runUntil(130);
    expect(served).toContain(14);
    expect(bank.metrics(0).failedTime).toBeGreaterThan(0);
  });

  it("an agent that is not yet at the head of the line delays the service start", () => {
    // eslint-disable-next-line prefer-const
    let bank: LaneBank;
    const sim = new Simulation<number>(new Map<number, EventHandler<number>>([[EventKind.ServiceComplete, (e) => bank.handleServiceComplete(e)]]));
    bank = new LaneBank(sim, { serviceTime: () => 2, onLeave: () => {} }, 1);
    bank.commit(0, 1, false);
    sim.runUntil(3);
    expect(bank.inService(0)).toBe(-1);
    bank.markReady(0, 1);
    expect(bank.inService(0)).toBe(1);
    expect(bank.waits(0)).toEqual([3]); // the wait runs from commit, not from reaching the head
  });
});
