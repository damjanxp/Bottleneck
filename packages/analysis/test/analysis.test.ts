import { createRun, type LaneLayout, type ServiceRecord } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import { describe, expect, it } from "vitest";
import { fitScanLog, groupOf, parseScanLogCsv, scanLogFromRun, summarise, toScanLogCsv, type ScanLogRow } from "../src/index.ts";

describe("summarise", () => {
  it("matches known values", () => {
    const s = summarise([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.n).toBe(8);
    expect(s.mean).toBe(5);
    expect(s.sd).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(s.ci95HalfWidth).toBeCloseTo((2.3646 * Math.sqrt(32 / 7)) / Math.sqrt(8), 10);
  });
  it("uses t for n = 2, t(30) for n = 31 and the normal value beyond", () => {
    expect(summarise([1, 3]).ci95HalfWidth).toBeCloseTo((12.7062 * Math.SQRT2) / Math.SQRT2, 9);
    const thirtyOne = summarise(Array.from({ length: 31 }, (_, i) => i));
    expect(thirtyOne.ci95HalfWidth).toBeCloseTo((2.0423 * thirtyOne.sd) / Math.sqrt(31), 12);
    const s = summarise(Array.from({ length: 40 }, (_, i) => i));
    expect(s.ci95HalfWidth).toBeCloseTo((1.96 * s.sd) / Math.sqrt(40), 12);
  });
  it("handles n < 2", () => {
    const one = summarise([3]);
    expect(one).toMatchObject({ n: 1, mean: 3, sd: 0 });
    expect(one.ci95HalfWidth).toBeNaN();
    expect(summarise([]).ci95HalfWidth).toBeNaN();
  });
});

describe("scan log CSV", () => {
  const rows: ScanLogRow[] = [
    { time: "19:59:58.500", seconds: -1.5, lane: "gate-main#1", event: "scan_fail" },
    { time: "20:00:01.250", seconds: 1.25, lane: "gate-main#1", event: "scan_ok" },
    { time: "20:00:02.000", seconds: 2, lane: "gate-main#manual", event: "manual_ok" },
    { time: "20:00:03.000", seconds: 3, lane: "gate-main#2", event: "rejected" },
  ];
  it("round-trips", () => {
    const csv = toScanLogCsv(rows);
    expect(csv.split("\n")[0]).toBe("time,seconds,lane,event");
    const parsed = parseScanLogCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(rows);
  });
  it("is tolerant: column order, blanks, whitespace, CRLF, BOM", () => {
    const text = "﻿event , lane,seconds,time\r\n\r\n scan_ok , a#1 , 4.5 , 20:00:04.500\r\n\r\nSCAN_FAIL,a#1,5,\r\n";
    const parsed = parseScanLogCsv(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { time: "20:00:04.500", seconds: 4.5, lane: "a#1", event: "scan_ok" },
      { time: "", seconds: 5, lane: "a#1", event: "scan_fail" },
    ]);
  });
  it("reports bad lines with line numbers and keeps the good ones", () => {
    const text = "time,seconds,lane,event\n20:00:01.000,1,a#1,scan_ok\n20:00:02.000,abc,a#1,scan_ok\n20:00:03.000,3,,scan_ok\n20:00:04.000,4,a#1,exploded\nnot-a-time,5,a#1,scan_ok\n";
    const parsed = parseScanLogCsv(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.errors[0]).toMatch(/^Line 3:/);
    expect(parsed.errors[1]).toMatch(/^Line 4:/);
    expect(parsed.errors[2]).toMatch(/^Line 5:.*exploded/);
    expect(parsed.errors[3]).toMatch(/^Line 6:/);
  });
  it("rejects a file without a usable header", () => {
    const parsed = parseScanLogCsv("a,b,c\n1,2,3\n");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]).toMatch(/^Line 1:/);
  });
});

describe("scanLogFromRun", () => {
  const base = { service: { x: 0, y: 0 }, exit: { x: 0, y: 0 }, queueHead: { x: 0, y: 0 }, queueTail: { x: 0, y: 0 }, capacity: 1 };
  const lanes: LaneLayout[] = [
    { ...base, laneId: 0, elementId: "screen", elementKind: "screening", laneIndex: 0, manual: false },
    { ...base, laneId: 1, elementId: "gate", elementKind: "gate", laneIndex: 1, manual: false },
    { ...base, laneId: 2, elementId: "gate", elementKind: "gate", laneIndex: 2, manual: true },
  ];
  const records: ServiceRecord[] = [
    { laneId: 0, agent: 0, start: 0, end: 2, outcome: "pass" },
    { laneId: 1, agent: 0, start: 3, end: 5, outcome: "retry" },
    { laneId: 1, agent: 0, start: 5, end: 9, outcome: "reject" },
    { laneId: 2, agent: 0, start: 10, end: 20.5, outcome: "pass" },
  ];
  it("names lanes, maps events, offsets time and formats the clock (wrapping midnight)", () => {
    const rows = scanLogFromRun(records, lanes, -100, "00:01");
    expect(rows.map((r) => [r.lane, r.event, r.seconds])).toEqual([
      ["gate#2", "scan_fail", -95],
      ["gate#2", "rejected", -91],
      ["gate#manual", "manual_ok", -79.5],
    ]);
    expect(rows[0]!.time).toBe("23:59:25.000");
    expect(rows[2]!.time).toBe("23:59:40.500");
    const withScreening = scanLogFromRun(records, lanes, 0, "20:00", { includeScreening: true });
    expect(withScreening[0]).toMatchObject({ lane: "screen#1", event: "scan_ok", time: "20:00:02.000" });
  });
});

/** Mean duration of a visit (all attempts of one agent on one lane) over the given lanes. */
function trueMeanVisit(records: readonly ServiceRecord[], laneIds: ReadonlySet<number>): number {
  const visits = new Map<string, number>();
  for (const r of records) {
    if (!laneIds.has(r.laneId)) continue;
    const key = `${r.laneId}:${r.agent}`;
    visits.set(key, (visits.get(key) ?? 0) + (r.end - r.start));
  }
  const all = [...visits.values()];
  return all.reduce((a, b) => a + b, 0) / all.length;
}

describe("fitScanLog", () => {
  it("recovers an exactly known mean on a busy lane (idle gaps excluded)", () => {
    // One lane: services of exactly 4 s back to back, with a 100 s idle gap in the middle.
    const rows: ScanLogRow[] = [];
    let t = 0;
    for (let k = 0; k < 50; k++) {
      t += 4;
      rows.push({ time: "", seconds: t, lane: "g#1", event: "scan_ok" });
    }
    t += 100;
    for (let k = 0; k < 50; k++) {
      t += 4;
      rows.push({ time: "", seconds: t, lane: "g#1", event: "scan_ok" });
    }
    const fit = fitScanLog(rows);
    expect(fit.groups).toEqual([{ group: "g", meanServiceTime: 4, busyIntervals: 98 }]);
    expect(fit.lanes[0]).toMatchObject({ lane: "g#1", group: "g", passes: 100, busyIntervals: 98, meanServiceTime: 4 });
    expect(fitScanLog(rows, { idleGapSeconds: 1000 }).groups[0]!.meanServiceTime).toBeGreaterThan(4.9);
  });

  it("counts a failed scan and its retry as one visit, and keeps manual lanes separate", () => {
    const rows: ScanLogRow[] = [];
    // Visits of 10 s (4 s failed attempt + 6 s retry), back to back.
    for (let k = 0; k < 20; k++) {
      rows.push({ time: "", seconds: k * 10 + 4, lane: "g#1", event: "scan_fail" });
      rows.push({ time: "", seconds: k * 10 + 10, lane: "g#1", event: "scan_ok" });
    }
    for (let k = 0; k < 5; k++) rows.push({ time: "", seconds: k * 30, lane: "g#manual", event: "manual_ok" });
    const fit = fitScanLog(rows);
    expect(groupOf("g#manual")).toBe("g#manual");
    expect(fit.groups.find((g) => g.group === "g")!.meanServiceTime).toBeCloseTo(10, 12);
    expect(fit.groups.find((g) => g.group === "g#manual")!.meanServiceTime).toBeCloseTo(30, 12);
  });

  it("builds a demand curve from first attempts", () => {
    const rows: ScanLogRow[] = [];
    for (let k = 0; k < 100; k++) rows.push({ time: "", seconds: k * 3, lane: "g#1", event: "scan_ok" }); // dense, 0..297
    for (let k = 0; k < 10; k++) rows.push({ time: "", seconds: 300 + k * 30, lane: "g#1", event: "scan_ok" }); // sparse
    const fit = fitScanLog(rows, { binSeconds: 300 });
    expect(fit.arrivals.length).toBeGreaterThanOrEqual(4);
    expect(fit.arrivals[0]!.weight).toBe(0);
    expect(fit.arrivals.at(-1)!.weight).toBe(0);
    expect(Math.max(...fit.arrivals.map((p) => p.weight))).toBe(1);
    expect(fit.arrivals[1]!.weight).toBe(1);
    expect(fit.arrivals[2]!.weight).toBeCloseTo(0.1, 6);
    expect(fit.firstTime).toBe(0);
    expect(fit.lastTime).toBe(570);
  });

  it("handles an empty log", () => {
    expect(fitScanLog([])).toEqual({ lanes: [], groups: [], arrivals: [], firstTime: 0, lastTime: 0 });
  });

  // Acceptance: "A generated scan log, re-imported, recovers the mean scan time within 10%".
  it("recovers the engine's mean busy time per visit from a generated, re-imported log (concert-5-lanes)", () => {
    const ex = exampleVenues.find((e) => e.id === "belgrade-fair-concert")!;
    const scenario = ex.scenarios.find((s) => s.id === "concert-5-lanes")!;
    const run = createRun(ex.venue, scenario);
    while (!run.done) run.step();
        const records = run.serviceLog();
    const rows = scanLogFromRun(records, run.lanes, run.timeOffset, scenario.timeline.referenceClock);
    const parsed = parseScanLogCsv(toScanLogCsv(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.length).toBe(rows.length);
    const fit = fitScanLog(parsed.rows);

    const gateLanes = new Set(run.lanes.filter((l) => l.elementKind === "gate" && !l.manual).map((l) => l.laneId));
    const truth = trueMeanVisit(records, gateLanes);
    const gate = fit.groups.find((g) => g.group === "gate-main")!;
    expect(gate.busyIntervals).toBeGreaterThan(1000);
    expect(Math.abs((gate.meanServiceTime as number) - truth) / truth).toBeLessThan(0.1);
    // The fitted demand curve spans the arrival window and peaks at 1.
    expect(fit.arrivals.length).toBeGreaterThan(5);
    expect(Math.max(...fit.arrivals.map((p) => p.weight))).toBe(1);
  }, 120_000);
});
