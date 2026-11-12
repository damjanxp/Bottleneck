import { describe, expect, it } from "vitest";
import { createRun } from "@bottleneck/engine";
import type { Scenario } from "@bottleneck/schema";
import type { RunResult } from "../batchProtocol.ts";
import { tinyScenario, tinyVenue } from "../determinism/tinyScenario.ts";
import { summariseMetrics, type MetricsSummary } from "../workerProtocol.ts";
import { alignSeries, chartElements, peakOf, queueSamples } from "./chartData.ts";
import { compareBatches, compareValues, formatSummary, measuresFor, type Measure } from "./measures.ts";
import { deriveSeeds, planJobs, seedsFor, venueIds, type CompareEntry } from "./plan.ts";
import { capacityRows, endNotes, measureRows } from "./table.ts";

const measure = (key: string): Measure => measuresFor(true).find((m) => m.key === key) as Measure;

function entry(key: string, seed: number, venueId = "v"): CompareEntry {
  return { key, label: key, scenario: { ...tinyScenario, venueId, seed } as Scenario };
}

/** A RunResult with only the fields the comparison reads. */
function fakeResult(over: Partial<MetricsSummary>, jobId = 0): RunResult {
  const metrics = {
    drained: true,
    deadlock: false,
    stillOutsideAtStart: 100,
    arrivedButOutsideAtStart: 60,
    notYetArrivedAtStart: 40,
    peakHour: { start: 0, end: 3600, arrivals: 10, p95Wait: 600 },
    meanWait: 120,
    p95Wait: 500,
    shareInside: { time: 0, share: 0.9 },
    elements: [],
    lanes: [],
    ...over,
  } as unknown as MetricsSummary;
  return { jobId, seed: 1, metrics, startTime: -100, queueSampleInterval: 10, throughputBin: 60, hash: "x", durationMs: 1 };
}

describe("seeds and jobs", () => {
  it("derives a reproducible, distinct set of 32-bit seeds that starts with the base seed", () => {
    const s = deriveSeeds(1, 5);
    expect(s[0]).toBe(1);
    expect(s).toEqual(deriveSeeds(1, 5));
    expect(new Set(s).size).toBe(5);
    expect(s.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)).toBe(true);
    expect(deriveSeeds(1, 3)).toEqual(s.slice(0, 3));
    expect(deriveSeeds(2, 5)).not.toEqual(s);
  });

  it("gives every scenario the same seeds when comparing with common random numbers", () => {
    const entries = [entry("a", 7), entry("b", 99)];
    expect(seedsFor(entries, 3, true)).toEqual([deriveSeeds(7, 3), deriveSeeds(7, 3)]);
    expect(seedsFor(entries, 3, false)).toEqual([deriveSeeds(7, 3), deriveSeeds(99, 3)]);
    expect(seedsFor(entries, 99, true)[0]).toHaveLength(5); // capped at 5 seeds in the browser
    const jobs = planJobs(entries, 2, true);
    expect(jobs.map((j) => `${j.entryIndex}/${j.seedIndex}`)).toEqual(["0/0", "1/0", "0/1", "1/1"]);
    expect(jobs.map((j) => j.scenario.seed)).toEqual([7, 7, deriveSeeds(7, 2)[1], deriveSeeds(7, 2)[1]]);
    expect(jobs.map((j) => j.jobId)).toEqual([0, 1, 2, 3]);
  });

  it("notices scenarios of different venues", () => {
    expect(venueIds([entry("a", 1, "x"), entry("b", 1, "x")])).toEqual(["x"]);
    expect(venueIds([entry("a", 1, "x"), entry("b", 1, "y")])).toEqual(["x", "y"]);
  });
});

describe("differences in words", () => {
  it("says what changed, by how much, and whether it is better", () => {
    expect(compareValues(measure("p95PeakWait"), 1630, 121)?.sentence).toBe("p95 wait, peak arrival hour: 27 min 10 s → 2 min 1 s (−25 min 09 s, better)".replace("25 min 09 s", "25 min 9 s"));
    expect(compareValues(measure("stillOutside"), 1312, 177)?.sentence).toBe("Still outside at the start: 1,312 people → 177 people (−1,135 people, better)");
    expect(compareValues(measure("stillOutside"), 177, 1312)?.verdict).toBe("worse");
    // Higher is better for the share inside.
    expect(compareValues(measure("shareInside"), 0.8, 0.9)?.verdict).toBe("better");
    expect(compareValues(measure("shareInside"), 0.8, 0.9)?.delta).toBe("+10.0 points");
    expect(compareValues(measure("meanWait"), 60, 60.2)?.sentence).toBe("Mean wait, everyone: 1 min → 1 min (no change)");
    expect(compareValues(measure("stillOutside"), null, 3)).toBeNull();
  });

  it("uses the paired differences of a batch, and says so when the change is within the noise", () => {
    const m = measure("p95PeakWait");
    // Clearly better in every seed.
    const clear = compareBatches(m, [1600, 1650, 1580, 1700, 1620], [120, 125, 118, 130, 121], true);
    expect(clear?.verdict).toBe("better");
    expect(clear?.from).toBe("27 min 10 s ± 58 s");
    // Seed-to-seed noise much larger than the change: no verdict.
    const noisy = compareBatches(m, [100, 300, 200, 400, 150], [110, 280, 230, 390, 160], true);
    expect(noisy?.verdict).toBe("unclear");
    expect(noisy?.sentence).toContain("no clear difference");
    // Pairing removes shared noise: the same numbers unpaired would not be clear.
    const pairedOnly = compareBatches(m, [100, 300, 200, 400, 150], [90, 290, 190, 390, 140], true);
    expect(pairedOnly?.verdict).toBe("better");
    expect(compareBatches(m, [100, 300, 200, 400, 150], [90, 290, 190, 390, 140], false)?.verdict).toBe("unclear");
    expect(compareBatches(m, [5, 5], [5, 5], true)?.verdict).toBe("same");
  });

  it("formats mean ± 95% CI", () => {
    expect(formatSummary("people", { n: 5, mean: 1312.4, sd: 20, ci95HalfWidth: 24.8 })).toBe("1,312 people ± 25");
    expect(formatSummary("duration", { n: 1, mean: 90, sd: 0, ci95HalfWidth: Number.NaN })).toBe("1 min 30 s");
    expect(formatSummary("share", { n: 3, mean: 0.5, sd: 0.01, ci95HalfWidth: 0.012 })).toBe("50.0% ± 1.2 points");
  });
});

describe("comparison table", () => {
  it("has one row per measure with a difference against the first scenario", () => {
    const rows = measureRows([[fakeResult({})], [fakeResult({ stillOutsideAtStart: 20, arrivedButOutsideAtStart: 5, notYetArrivedAtStart: 15 } as Partial<MetricsSummary>)]], true, true);
    expect(rows.map((r) => r.measure.key)).toEqual(["stillOutside", "onSite", "notArrived", "p95PeakWait", "meanWait", "p95Wait", "shareInside"]);
    const outside = rows[0]!;
    expect(outside.cells).toEqual(["100 people", "20 people"]);
    expect(outside.differences[0]).toBeNull();
    expect(outside.differences[1]?.verdict).toBe("better");
    expect(rows.find((r) => r.measure.key === "p95PeakWait")?.differences[1]?.verdict).toBe("same");
  });

  it("drops measures that do not apply (open-door events have no 'outside at the start')", () => {
    const open = fakeResult({ stillOutsideAtStart: null, arrivedButOutsideAtStart: null, notYetArrivedAtStart: null } as Partial<MetricsSummary>);
    expect(measureRows([[open], [open]], false, true).map((r) => r.measure.key)).toEqual(["shareInside", "p95PeakWait", "meanWait", "p95Wait"]);
  });

  it("shows capacity against demand per element and flags overload", () => {
    const el = (laneCount: number) => ({ elementId: "gate", kind: "gate", laneCount, meanBusyTime: 4, capacityPerHour: laneCount * 900, peakDemandPerHour: 3000, peakDemandStart: 0, utilisation: [], peakUtilisation: 1, peakUtilisationAt: 0, below85At: null });
    const rows = capacityRows([fakeResult({ elements: [el(3)] } as Partial<MetricsSummary>), fakeResult({ elements: [el(5)] } as Partial<MetricsSummary>)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cells.map((c) => c?.overloaded)).toEqual([true, false]);
  });

  it("notes runs that did not finish", () => {
    expect(endNotes([[fakeResult({ drained: false } as Partial<MetricsSummary>)], [fakeResult({})]], ["A", "B"])).toEqual(["A: 1 of 1 run reached the end of the simulated period with people still outside; their waits are a lower bound."]);
  });
});

describe("comparison charts", () => {
  it("sums the regular lanes of an element and aligns runs on one time axis", () => {
    const run = createRun(tinyVenue, tinyScenario);
    while (!run.done) run.step();
    const r: RunResult = { ...fakeResult({}), metrics: summariseMetrics(run.metrics()), startTime: run.toScenarioTime(0), queueSampleInterval: run.parameters.queueSampleInterval };
    const all = queueSamples(r, "gate-a", null);
    const l0 = queueSamples(r, "gate-a", 0);
    const l1 = queueSamples(r, "gate-a", 1);
    expect(all.y.length).toBeGreaterThan(10);
    expect(all.y).toEqual(l0.y.map((v, k) => v + (l1.y[k] as number)));
    expect(all.x[0]).toBe(r.startTime + r.queueSampleInterval);
    expect(chartElements([r])).toEqual([{ elementId: "gate-a", kind: "gate", maxLanes: 2 }]);

    const a = alignSeries([
      { x: [10, 20, 30], y: [1, 2, 3] },
      { x: [20, 30, 40], y: [5, 6, 7] },
    ]);
    expect(a.x).toEqual([10, 20, 30, 40]);
    expect(a.ys).toEqual([
      [1, 2, 3, null],
      [null, 5, 6, 7],
    ]);
    expect(peakOf(a.x, a.ys[1]!)).toEqual({ t: 40, value: 7 });
  });
});
