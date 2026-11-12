/**
 * Engine Web Worker: runs the self-check and the simulation off the main thread, so the UI never
 * freezes (spec 6.2). The engine itself never touches the network or the clock; this driver
 * owns the timer and turns wall-clock time into ticks with PlaybackPacer.
 */

import { ENGINE_VERSION, EXPECTED_SELF_CHECK_HASH, PlaybackPacer, TICK_SECONDS, createRun, restoreRun, runSelfCheck, snapshotLength, type Run, type RunCheckpoint } from "@bottleneck/engine";
import { scanLogFromRun, toScanLogCsv } from "@bottleneck/analysis";
import type { Scenario, Venue } from "@bottleneck/schema";
import { tinyScenario, tinyVenue } from "./determinism/tinyScenario.ts";
import { CheckpointStore, checkpointBytes, chooseInterval, planSeek } from "./sim/checkpoints.ts";
import { peakWindowStart } from "./sim/peak.ts";
import { RollingSamples } from "./sim/rolling.ts";
import { seekFraction, summariseMetrics, type StatsMessage, type WorkerRequest, type WorkerResponse } from "./workerProtocol.ts";

// The web app compiles with the DOM library, which types `self` as a Window. Inside a worker it is
// a DedicatedWorkerGlobalScope; only the members used here are declared.
const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

/** The loop runs this often while playing (wall-clock ms): one snapshot per loop, ~20 Hz. */
const LOOP_MS = 50;
/** Work budget per loop; ticks beyond it are dropped (the run slows down, results are unchanged). */
const LOOP_BUDGET_MS = 40;
/** Seek work per chunk before yielding to the message queue (so Cancel gets through). */
const SEEK_CHUNK_MS = 30;
const STATS_EVERY_LOOPS = 4;
const METRICS_EVERY_LOOPS = 20;

let venue: Venue | null = null;
let scenario: Scenario | null = null;
let run: Run | null = null;
let generation = 0;
const pacer = new PlaybackPacer(1, 600);
let playing = false;
let densityOn = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastLoop = 0;
let loopCount = 0;
let lastSnapshotTime = Number.NaN;
let freeBuffers: Float32Array[] = [];
const tickTimes = new RollingSamples(600);
let seek: { id: number; target: number; from: number; resumePlaying: boolean; cancelled: boolean; startedAt: number } | null = null;
/** Engine checkpoints of the loaded scenario (review C1); kept across restarts, cleared on load. */
const checkpoints = new CheckpointStore<RunCheckpoint>();

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function postError(error: unknown): void {
  post({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

function newRun(): Run {
  if (!venue || !scenario) throw new Error("No scenario loaded");
  return createRun(venue, scenario);
}

function stepTimed(r: Run): void {
  const t0 = performance.now();
  r.step();
  tickTimes.add(performance.now() - t0);
  // Checkpoints are saved wherever the run passes the interval grid: playing, stepping or seeking.
  if (checkpoints.isDue(r.time)) {
    const cp = r.saveCheckpoint();
    checkpoints.add(r.time, cp, checkpointBytes(cp));
  }
}

function postSnapshot(force = false): void {
  if (!run) return;
  const time = run.toScenarioTime(run.time);
  if (!force && time === lastSnapshotTime) return;
  const buffer = freeBuffers.pop();
  if (!buffer) return; // both buffers are with the main thread: drop, never queue
  run.writeSnapshot(buffer);
  lastSnapshotTime = time;
  post({ type: "snapshot", generation, buffer, time, agentCount: run.agentCount }, [buffer.buffer]);
}

function postStats(): void {
  if (!run) return;
  const msg: StatsMessage = {
    type: "stats",
    generation,
    time: run.toScenarioTime(run.time),
    playing,
    done: run.done,
    drained: run.drained,
    deadlock: run.deadlock,
    speed: pacer.speed,
    countsByState: run.countsByState(),
    lanes: run.laneStates(),
    tick: { p50: tickTimes.percentile(0.5), p95: tickTimes.percentile(0.95), samples: tickTimes.size },
    checkpoints: { count: checkpoints.size, bytes: checkpoints.totalBytes, interval: checkpoints.interval },
  };
  if (densityOn) {
    const copy = run.density.data.slice();
    msg.density = copy;
    post(msg, [copy.buffer]);
  } else post(msg);
}

function postMetrics(): void {
  if (!run) return;
  post({ type: "metrics", generation, metrics: summariseMetrics(run.metrics()) });
}

function postAll(): void {
  postSnapshot(true);
  postStats();
  postMetrics();
}

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(): void {
  stopTimer();
  timer = setTimeout(loop, LOOP_MS);
}

function loop(): void {
  timer = null;
  if (!run || !playing || seek) return;
  const now = performance.now();
  const elapsed = (now - lastLoop) / 1000;
  lastLoop = now;
  const ticks = pacer.ticksFor(elapsed);
  for (let k = 0; k < ticks && !run.done; k++) {
    stepTimed(run);
    if (performance.now() - now > LOOP_BUDGET_MS) {
      pacer.reset();
      break;
    }
  }
  loopCount++;
  postSnapshot();
  if (run.done) {
    playing = false;
    postAll();
    return;
  }
  if (loopCount % STATS_EVERY_LOOPS === 0) postStats();
  if (loopCount % METRICS_EVERY_LOOPS === 0) postMetrics();
  schedule();
}

function play(): void {
  if (!run || run.done || seek) {
    if (seek) seek.resumePlaying = true;
    return;
  }
  playing = true;
  pacer.reset();
  lastLoop = performance.now();
  schedule();
  postStats();
}

function pause(): void {
  if (seek) seek.resumePlaying = false;
  playing = false;
  stopTimer();
  pacer.reset();
  postAll();
}

function load(v: Venue, s: Scenario, speed: number): void {
  stopTimer();
  seek = null;
  venue = v;
  scenario = s;
  playing = false;
  generation++;
  tickTimes.clear();
  pacer.speed = speed;
  pacer.reset();
  run = newRun();
  // Size the checkpoint interval from a checkpoint of the fresh run (review C1, see checkpoints.ts).
  checkpoints.clear(chooseInterval(run.toEngineTime(run.parameters.horizon), checkpointBytes(run.saveCheckpoint())));
  const len = snapshotLength(run.agentCount);
  freeBuffers = [new Float32Array(len), new Float32Array(len)];
  lastSnapshotTime = Number.NaN;
  const p = run.parameters;
  const d = run.density;
  post({
    type: "loaded",
    generation,
    agentCount: run.agentCount,
    startTime: run.toScenarioTime(0),
    endTime: p.horizon,
    lanes: [...run.lanes],
    parameters: p,
    peakStart: Math.max(run.toScenarioTime(0), peakWindowStart(p.arrivalCurve)),
    density: { cols: d.cols, rows: d.rows, cellSize: d.cellSize, originX: d.originX, originY: d.originY },
  });
  postAll();
}

function restart(): void {
  if (!venue || !scenario) return;
  stopTimer();
  seek = null;
  playing = false;
  pacer.reset();
  run = newRun();
  lastSnapshotTime = Number.NaN;
  postAll();
}

/** Interactive lane events (review B8): swap in the working copy and replay exactly up to `target`. */
function replaceScenario(s: Scenario, target: number, id: number): void {
  if (!venue || !run) return;
  const wasPlaying = seek ? seek.resumePlaying : playing;
  stopTimer();
  seek = null;
  playing = false;
  pacer.reset();
  const before = run.agentCount;
  scenario = s;
  run = newRun();
  if (run.agentCount !== before) {
    // Only bus bursts change the head count; lane events never do. Reload properly to resize buffers.
    load(venue, s, pacer.speed);
    return;
  }
  // Checkpoints of the old scenario do not hold the new timed event: start over from 0.
  checkpoints.clear(chooseInterval(run.toEngineTime(run.parameters.horizon), checkpointBytes(run.saveCheckpoint())));
  playing = wasPlaying; // startSeek resumes playing afterwards if it was playing
  startSeek(target, id);
}

function startSeek(target: number, id: number): void {
  if (!run || !venue || !scenario) return;
  const startedAt = performance.now();
  const resumePlaying = seek ? seek.resumePlaying : playing;
  stopTimer();
  playing = false;
  pacer.reset();
  const engineTarget = run.toEngineTime(Math.min(Math.max(target, run.toScenarioTime(0)), run.parameters.horizon));
  // Start from the best checkpoint: backwards always (or from 0 if there is none before the
  // target), forwards only if a checkpoint skips enough stepping. Exact either way (determinism).
  const plan = planSeek(run.time, engineTarget, checkpoints.times());
  if (plan.kind === "fresh") run = newRun();
  else if (plan.kind === "restore") {
    const cp = checkpoints.get(plan.time);
    run = cp ? restoreRun(venue, scenario, cp) : newRun();
  }
  const s = { id, target: engineTarget, from: run.time, resumePlaying, cancelled: false, startedAt };
  seek = s;
  seekChunk(s);
}

function seekChunk(s: NonNullable<typeof seek>): void {
  // A newer seek, a restart or a load replaced this one: its chain ends here.
  if (seek !== s || !run) return;
  if (!s.cancelled) {
    const t0 = performance.now();
    while (run.time + TICK_SECONDS / 2 <= s.target && !run.done && performance.now() - t0 < SEEK_CHUNK_MS) stepTimed(run);
  }
  const finished = s.cancelled || run.time + TICK_SECONDS / 2 > s.target || run.done;
  if (!finished) {
    post({ type: "seekProgress", generation, seekId: s.id, fraction: seekFraction(s.from, s.target, run.time) });
    postSnapshot();
    setTimeout(() => seekChunk(s), 0);
    return;
  }
  seek = null;
  post({ type: "seekDone", generation, seekId: s.id, cancelled: s.cancelled, time: run.toScenarioTime(run.time), durationMs: performance.now() - s.startedAt });
  postAll();
  if (s.resumePlaying && !run.done) play();
}

scope.onmessage = (event) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "selfCheck": {
        const started = performance.now();
        const result = runSelfCheck();
        post({
          type: "selfCheckResult",
          hash: result.hash,
          expected: EXPECTED_SELF_CHECK_HASH,
          matches: result.matches,
          numbers: result.numbers,
          durationMs: performance.now() - started,
          engineVersion: ENGINE_VERSION,
        });
        break;
      }
      case "determinismCheck": {
        const r = createRun(tinyVenue, tinyScenario);
        while (!r.done) r.step();
        post({ type: "determinismResult", hash: r.metricsHash() });
        break;
      }
      case "load":
        load(msg.venue, msg.scenario, msg.speed);
        break;
      case "play":
        play();
        break;
      case "pause":
        pause();
        break;
      case "step":
        if (run && !playing && !seek) {
          for (let k = 0; k < Math.max(1, Math.floor(msg.ticks)) && !run.done; k++) stepTimed(run);
          postAll();
        }
        break;
      case "restart":
        restart();
        break;
      case "setSpeed":
        pacer.speed = msg.speed;
        pacer.reset();
        postStats();
        break;
      case "seek":
        startSeek(msg.time, msg.seekId);
        break;
      case "cancelSeek":
        if (seek) seek.cancelled = true;
        break;
      case "returnBuffer":
        if (msg.generation === generation && run && msg.buffer.length === snapshotLength(run.agentCount) && freeBuffers.length < 2) freeBuffers.push(msg.buffer);
        break;
      case "setDensity":
        densityOn = msg.enabled;
        postStats();
        break;
      case "replaceScenario":
        replaceScenario(msg.scenario, msg.time, msg.seekId);
        break;
      case "scanLog": {
        if (!run || !scenario) break;
        const rows = scanLogFromRun(run.serviceLog(), run.lanes, run.timeOffset, scenario.timeline.referenceClock);
        post({ type: "scanLog", requestId: msg.requestId, csv: toScanLogCsv(rows), rows: rows.length });
        break;
      }
    }
  } catch (error) {
    playing = false;
    stopTimer();
    postError(error);
  }
};
