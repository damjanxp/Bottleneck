import { describe, expect, it } from "vitest";
import { TICK_SECONDS, createRun, restoreRun, type Run, type RunCheckpoint } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import { tinyScenario, tinyVenue } from "../determinism/tinyScenario.ts";
import { INSIDE_FADE_SECONDS, insideFade } from "../render/palette.ts";
import { summariseMetrics } from "../workerProtocol.ts";
import { clampLabel } from "./camera.ts";
import { CHECKPOINT_BUDGET_BYTES, CheckpointStore, FORWARD_RESTORE_GAIN, MIN_CHECKPOINT_INTERVAL, checkpointBytes, chooseInterval, planSeek } from "./checkpoints.ts";
import { headlines, withExtraLane } from "./headline.ts";
import { describeParameters, formatGroupSizes } from "./parameters.ts";

describe("checkpoint selection (review C1)", () => {
  const times = [600, 120, 360, 240, 480];

  it("restores the latest checkpoint at or before the target when seeking backwards", () => {
    expect(planSeek(1000, 500, times)).toEqual({ kind: "restore", time: 480 });
    expect(planSeek(1000, 480, times)).toEqual({ kind: "restore", time: 480 });
    expect(planSeek(1000, 479.75, times)).toEqual({ kind: "restore", time: 360 });
    expect(planSeek(400, 130, times)).toEqual({ kind: "restore", time: 120 });
  });

  it("starts a fresh run when no checkpoint lies at or before a backward target", () => {
    expect(planSeek(1000, 119.75, times)).toEqual({ kind: "fresh" });
    expect(planSeek(1000, 0, times)).toEqual({ kind: "fresh" });
    expect(planSeek(500, 100, [])).toEqual({ kind: "fresh" });
  });

  it("steps on from the current state when seeking forwards, unless a later checkpoint saves enough", () => {
    expect(planSeek(100, 200, times)).toEqual({ kind: "continue" }); // checkpoint 120 skips only 20 s
    expect(planSeek(100, 500, times)).toEqual({ kind: "restore", time: 480 });
    expect(planSeek(400, 500, times)).toEqual({ kind: "continue" }); // 480 is only 80 s ahead
    expect(planSeek(400, 900, times)).toEqual({ kind: "restore", time: 600 });
    expect(planSeek(250, 250, times)).toEqual({ kind: "continue" });
    expect(planSeek(0, 10_000, [])).toEqual({ kind: "continue" });
    expect(planSeek(0, 130, times, FORWARD_RESTORE_GAIN)).toEqual({ kind: "restore", time: 120 });
  });

  it("chooses the interval from the checkpoint size and the run length, in whole minutes", () => {
    expect(chooseInterval(9000, 1000)).toBe(MIN_CHECKPOINT_INTERVAL);
    // 10,000 people on the concert venue: about 1.64 MB at time 0 → every 5 minutes.
    expect(chooseInterval(9000, 1.64e6)).toBe(300);
    expect(chooseInterval(9000, 0.83e6)).toBe(180);
    const big = chooseInterval(9000, 20e6);
    expect(big % 60).toBe(0);
    // The planned checkpoints fit the budget even at 1.3× growth.
    expect((9000 / big) * 20e6 * 1.3).toBeLessThanOrEqual(CHECKPOINT_BUDGET_BYTES);
    expect(chooseInterval(0, 1e6)).toBe(MIN_CHECKPOINT_INTERVAL);
  });

  it("stores checkpoints on the interval grid and thins them out when over budget", () => {
    const store = new CheckpointStore<string>(60, 1000);
    expect(store.isDue(0)).toBe(false);
    expect(store.isDue(59.75)).toBe(false);
    expect(store.isDue(60)).toBe(true);
    for (let t = 60; t <= 300; t += 60) store.add(t, `cp${t}`, 150);
    expect(store.isDue(60)).toBe(false); // already saved
    expect(store.times()).toEqual([60, 120, 180, 240, 300]);
    expect(store.totalBytes).toBe(750);
    store.add(360, "cp360", 150);
    store.add(420, "cp420", 150); // 1,050 bytes > 1,000: keep every 120 s
    expect(store.interval).toBe(120);
    expect(store.times()).toEqual([120, 240, 360]);
    expect(store.totalBytes).toBe(450);
    expect(store.get(240)).toBe("cp240");
    expect(store.isDue(480)).toBe(true);
    expect(store.isDue(540)).toBe(false);
    store.clear(180);
    expect(store.size).toBe(0);
    expect(store.interval).toBe(180);
  });

  it("measures checkpoint bytes from the typed arrays", () => {
    expect(checkpointBytes({ a: new Float64Array(10), b: { c: new Int32Array(4), d: 3 } })).toBe(80 + 16 + 8);
  });

  /** What the worker does: step with checkpoints, seek by planSeek + restoreRun. */
  function seekTo(run: Run, target: number, store: CheckpointStore<RunCheckpoint>): Run {
    const plan = planSeek(run.time, target, store.times(), 0);
    let r = run;
    if (plan.kind === "fresh") r = createRun(tinyVenue, tinyScenario);
    else if (plan.kind === "restore") r = restoreRun(tinyVenue, tinyScenario, store.get(plan.time) as RunCheckpoint);
    while (r.time + TICK_SECONDS / 2 <= target && !r.done) {
      r.step();
      if (store.isDue(r.time)) {
        const cp = r.saveCheckpoint();
        store.add(r.time, cp, checkpointBytes(cp));
      }
    }
    return r;
  }

  it("a backward seek through a checkpoint ends in exactly the state of playing forward", () => {
    const store = new CheckpointStore<RunCheckpoint>(30);
    let run = createRun(tinyVenue, tinyScenario);
    run = seekTo(run, 200, store); // forward from 0, saving checkpoints at 30, 60, …
    expect(store.size).toBeGreaterThan(3);
    const target = 97.25;
    run = seekTo(run, target, store); // backwards: restores the checkpoint at 90
    expect(run.time).toBe(target);

    const straight = createRun(tinyVenue, tinyScenario);
    while (straight.time + TICK_SECONDS / 2 <= target) straight.step();
    expect(run.countsByState()).toEqual(straight.countsByState());
    expect(run.metricsHash()).toBe(straight.metricsHash());

    // And forwards again past a later checkpoint.
    run = seekTo(run, 180, store);
    while (straight.time + TICK_SECONDS / 2 <= 180) straight.step();
    expect(run.metricsHash()).toBe(straight.metricsHash());
  });
});

describe("headlines and the +1 lane fix", () => {
  const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
  if (!concert) throw new Error("concert example missing");
  const scenario = concert.scenarios[0] as Scenario;

  it("splits people still outside into already on site and not arrived", () => {
    const run = createRun(concert.venue, scenario);
    for (let k = 0; k < 4 * 60 * 5; k++) run.step();
    const m = summariseMetrics(run.metrics());
    const h = headlines(m, 0, run.toScenarioTime(run.time))[0];
    expect(h?.kind).toBe("stillOutside");
    expect(h?.split).toBeDefined();
    expect((h?.split?.onSite ?? 0) + (h?.split?.notArrived ?? 0)).toBe(h?.value);
  }, 60_000);

  it("adds one lane to an element without touching the others", () => {
    const next = withExtraLane(scenario, "gate-main", 3);
    expect(next.overrides?.["gate-main"]?.laneCount).toBe(4);
    expect(next.overrides?.["screening-main"]).toEqual(scenario.overrides?.["screening-main"]);
    expect(scenario.overrides?.["gate-main"]?.laneCount).toBe(3); // unchanged
    expect(withExtraLane({ ...scenario, overrides: undefined }, "gate-x", 64).overrides?.["gate-x"]?.laneCount).toBe(64);
  });
});

describe("parameter list", () => {
  const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
  if (!concert) throw new Error("concert example missing");
  const base = concert.scenarios[0] as Scenario;

  it("marks scenario-settable parameters as assumed only when the scenario leaves them out", () => {
    const keys = ["decisionDistance", "logitScale", "slotSpacing", "jockeyThreshold", "manualServiceTime", "watchdog", "shareInsideLead", "groupSizes", "bagPolicy"];
    const bare: Scenario = { ...base, parameters: {} };
    const runBare = createRun(concert.venue, bare);
    const rowsBare = describeParameters(runBare.parameters, concert.venue, bare);
    for (const k of keys) expect(rowsBare.find((r) => r.key === k)?.assumed, k).toBe(true);

    const set: Scenario = {
      ...base,
      parameters: { decisionDistance: 25, logitScale: 10, slotSpacing: 0.5, jockeyThreshold: 2, manualLaneServiceTime: { kind: "fixed", value: 30 }, watchdogMinutes: 15, shareInsideAt: -900, groupSizes: [1], bagPolicy: "clearBag" },
    };
    const runSet = createRun(concert.venue, set);
    const rowsSet = describeParameters(runSet.parameters, concert.venue, set);
    for (const k of keys) expect(rowsSet.find((r) => r.key === k)?.assumed, k).toBe(false);
    expect(rowsSet.find((r) => r.key === "shareInsideLead")?.value).toBe("15 min before the start");
    expect(rowsSet.find((r) => r.key === "groupSizes")?.value).toBe("everyone alone");
    expect(rowsSet.find((r) => r.key === "densitySigma")?.assumed).toBe(true); // engine setting
  });

  it("formats group sizes", () => {
    expect(formatGroupSizes([0.3, 0.4, 0.15, 0.1, 0.05])).toBe("30% alone, 40% in groups of 2, 15% in groups of 3, 10% in groups of 4, 5% in groups of 5");
  });
});

describe("renderer helpers", () => {
  it("keeps labels inside the view", () => {
    expect(clampLabel(5, 50, 40, 8, 800, 600, 6)).toEqual({ x: 46, y: 50 });
    expect(clampLabel(790, 2, 40, 8, 800, 600, 6)).toEqual({ x: 754, y: 14 });
    expect(clampLabel(400, 300, 40, 8, 800, 600, 6)).toEqual({ x: 400, y: 300 });
    expect(clampLabel(10, 10, 100, 8, 150, 600, 6).x).toBe(75); // too narrow: centred
  });

  it("fades people out after they arrive inside", () => {
    expect(insideFade(0)).toBe(1);
    expect(insideFade(INSIDE_FADE_SECONDS / 2)).toBeCloseTo(0.5);
    expect(insideFade(INSIDE_FADE_SECONDS)).toBe(0);
    expect(insideFade(Infinity)).toBe(0);
    expect(insideFade(Number.NaN)).toBe(0);
    expect(insideFade(-5)).toBe(1);
  });
});
