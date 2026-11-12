import { describe, expect, it } from "vitest";
import { AgentState, RUN_DEFAULTS, createRun, resolveArrivalPoints, type LaneLive, type RunMetrics } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import { heatColor, styleIndex, STATE_STYLES } from "../render/palette.ts";
import { seekFraction, summariseMetrics } from "../workerProtocol.ts";
import { distanceToSegment, fitCamera, pan, screenToWorld, worldToScreen, zoomAt } from "./camera.ts";
import { agentPosition, extrapolationSeconds } from "./extrapolate.ts";
import { formatDistribution, formatDuration, formatHms, formatPercent, formatRelativeClock, formatWallClock } from "./format.ts";
import { headlines, worstLane } from "./headline.ts";
import { describeParameters } from "./parameters.ts";
import { peakWindowStart } from "./peak.ts";
import { RollingSamples } from "./rolling.ts";
import { laneSeries } from "./series.ts";

describe("format", () => {
  it("formats relative clocks around the event start and since opening", () => {
    expect(formatRelativeClock(-2700, 0, true)).toBe("T−45:00");
    expect(formatRelativeClock(-5400, 0, true)).toBe("T−1:30:00");
    expect(formatRelativeClock(305, 0, true)).toBe("T+5:05");
    expect(formatRelativeClock(5400, 0, false)).toBe("+1:30:00");
    expect(formatHms(0)).toBe("0:00");
  });

  it("formats wall clocks with wrap-around", () => {
    expect(formatWallClock("20:00", -5400)).toBe("18:30");
    expect(formatWallClock("23:30", 3600)).toBe("00:30");
    expect(formatWallClock("00:15", -1800)).toBe("23:45");
    expect(formatWallClock("10:00", 61, true)).toBe("10:01:01");
  });

  it("formats durations, percentages and distributions", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(200)).toBe("3 min 20 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatPercent(0.873)).toBe("87%");
    expect(formatDistribution({ kind: "uniform", min: 20, max: 40 }, "s")).toBe("uniform 20–40 s");
    expect(formatDistribution({ kind: "fixed", value: 3 })).toBe("3");
  });
});

describe("extrapolation", () => {
  it("extrapolates below 10x only while playing, capped", () => {
    expect(extrapolationSeconds(0.02, 1, true)).toBeCloseTo(0.02);
    expect(extrapolationSeconds(0.02, 1, false)).toBe(0);
    expect(extrapolationSeconds(0.02, 10, true)).toBe(0);
    expect(extrapolationSeconds(0.02, 30, true)).toBe(0);
    // A stalled worker: 2 s since the last snapshot at 8x is capped at 0.6 s simulated.
    expect(extrapolationSeconds(2, 8, true)).toBeCloseTo(0.6);
    // At 1x the cap is at least one tick.
    expect(extrapolationSeconds(5, 1, true)).toBe(0.25);
  });

  it("moves agents along their velocity", () => {
    // Two agents: x, y, vx, vy, state blocks.
    const snap = Float32Array.from([1, 2, 10, 20, 0.5, -1, 0, 0, 1, 2]);
    const out: [number, number] = [0, 0];
    agentPosition(snap, 2, 0, 0.5, out);
    expect(out).toEqual([1.25, 10]);
    agentPosition(snap, 2, 1, 0.5, out);
    expect(out).toEqual([1.5, 20]);
  });
});

describe("camera", () => {
  it("fits bounds centred and zooms around a fixed point", () => {
    const cam = fitCamera({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 1000, 1000, 0);
    expect(cam.scale).toBe(10);
    expect(worldToScreen(cam, 50, 25)).toEqual({ x: 500, y: 500 });
    const z = zoomAt(cam, 300, 400, 2);
    const before = screenToWorld(cam, 300, 400);
    const after = screenToWorld(z, 300, 400);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(pan(cam, 5, -5)).toEqual({ scale: 10, x: cam.x + 5, y: cam.y - 5 });
    expect(distanceToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distanceToSegment(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
});

describe("protocol helpers", () => {
  it("computes seek progress", () => {
    expect(seekFraction(0, 100, 25)).toBe(0.25);
    expect(seekFraction(0, 100, 200)).toBe(1);
    expect(seekFraction(50, 50, 50)).toBe(1);
  });

  it("rolling percentiles", () => {
    const r = new RollingSamples(4);
    for (const v of [5, 1, 3, 2, 4]) r.add(v);
    expect(r.size).toBe(4);
    expect(r.percentile(0.5)).toBe(2);
    expect(r.percentile(0.95)).toBe(4);
  });
});

describe("palette", () => {
  it("draws every visible state with its own shape", () => {
    const shapes = new Set(STATE_STYLES.map((s) => s.shape));
    expect(shapes.size).toBe(STATE_STYLES.length);
    expect(styleIndex(AgentState.Pending)).toBe(-1);
    expect(STATE_STYLES[styleIndex(AgentState.Queuing)]?.shape).toBe("square");
    const px = new Uint8ClampedArray(4);
    heatColor(0, px, 0);
    expect(px[3]).toBe(0);
    heatColor(10, px, 0);
    expect(px[3]).toBeGreaterThan(200);
  });
});

describe("with the concert example", () => {
  const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
  if (!concert) throw new Error("concert example missing");
  const scenario = concert.scenarios[0];
  if (!scenario) throw new Error("concert scenario missing");

  it("finds the peak arrival hour from the curve", () => {
    const start = peakWindowStart(resolveArrivalPoints(scenario.arrivals, scenario.timeline));
    // The concert preset peaks 45-60 min before the start; the busiest hour starts about 70-55 min before.
    expect(start).toBeGreaterThanOrEqual(-4500);
    expect(start).toBeLessThanOrEqual(-3000);
    expect(Math.abs(start % 60)).toBe(0);
  });

  it("strips density from metrics, picks headlines and the worst lane, lists parameters", () => {
    const run = createRun(concert.venue, scenario);
    for (let k = 0; k < 4 * 60 * 10; k++) run.step();
    const m: RunMetrics = run.metrics();
    const summary = summariseMetrics(m);
    expect("density" in summary).toBe(false);
    expect("parameters" in summary).toBe(false);
    expect(summary.lanes.length).toBe(run.lanes.length);

    const hs = headlines(summary, 0, run.toScenarioTime(run.time));
    expect(hs.map((h) => h.kind)).toEqual(["stillOutside", "p95PeakWait"]);
    expect(hs[0]?.final).toBe(false);

    const states: LaneLive[] = [
      { laneId: 0, queueLength: 3, inService: true, open: true, failed: false },
      { laneId: 1, queueLength: 7, inService: true, open: true, failed: false },
      { laneId: 2, queueLength: 7, inService: true, open: true, failed: false },
    ];
    expect(worstLane(states)?.laneId).toBe(1);
    expect(worstLane([{ laneId: 0, queueLength: 0, inService: false, open: true, failed: false }])).toBeNull();

    const rows = describeParameters(run.parameters, concert.venue, scenario);
    expect(rows.find((r) => r.key === "decisionDistance")?.assumed).toBe(true);
    expect(rows.find((r) => r.key === "freeWalkingSpeed")?.assumed).toBe(true);
    expect(rows.find((r) => r.key === "gate-main.lanes")?.value).toBe("3");

    const lane = summary.lanes[0];
    if (!lane) throw new Error("no lanes");
    const series = laneSeries(lane, run.timeOffset, RUN_DEFAULTS.queueSampleInterval, RUN_DEFAULTS.throughputBin);
    expect(series.queue.x.length).toBe(lane.queueLength.length);
    expect(series.queue.x[0]).toBe(run.timeOffset + RUN_DEFAULTS.queueSampleInterval);
    expect(series.throughput.x[1]).toBe(run.timeOffset + 60);
  }, 60_000);
});
