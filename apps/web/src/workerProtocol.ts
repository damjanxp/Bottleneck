/**
 * Messages between the main thread and the engine worker (spec 6.2, review notes C2/C3).
 *
 * Snapshots travel as Transferable Float32Arrays (no SharedArrayBuffer). The worker owns two
 * buffers; the main thread hands each one back with `returnBuffer` once a newer snapshot has
 * arrived. If no buffer is free when a snapshot is due, the worker drops it (never queues it).
 */

import type { LaneLayout, LaneLive, ResolvedParameters, RunMetrics } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";

export type WorkerRequest =
  | { type: "selfCheck" }
  /** Test hook: runs the tiny pinned scenario to completion and answers with its metrics hash. */
  | { type: "determinismCheck" }
  | { type: "load"; venue: Venue; scenario: Scenario; speed: number }
  | { type: "play" }
  | { type: "pause" }
  /** Advances `ticks` ticks while paused. */
  | { type: "step"; ticks: number }
  | { type: "restart" }
  | { type: "setSpeed"; speed: number }
  /**
   * Seek to a scenario time: restore the nearest engine checkpoint at or before it (or start from
   * 0) and re-run the seeded simulation from there (exact, thanks to determinism; review C1).
   */
  | { type: "seek"; time: number; seekId: number }
  | { type: "cancelSeek" }
  | { type: "returnBuffer"; buffer: Float32Array; generation: number }
  | { type: "setDensity"; enabled: boolean };

/** Lane metrics for the side panel: everything in RunMetrics except the big density arrays. */
export type MetricsSummary = Omit<RunMetrics, "density" | "parameters">;

export interface TickTiming {
  p50: number;
  p95: number;
  samples: number;
}

export interface LoadedInfo {
  type: "loaded";
  generation: number;
  agentCount: number;
  /** Scenario time of engine time 0. */
  startTime: number;
  /** Scenario time at which the run stops at the latest (the horizon). */
  endTime: number;
  lanes: LaneLayout[];
  parameters: ResolvedParameters;
  /** Scenario time at which the busiest 60-minute arrival window starts. */
  peakStart: number;
  density: { cols: number; rows: number; cellSize: number; originX: number; originY: number };
}

export interface StatsMessage {
  type: "stats";
  generation: number;
  /** Scenario time, seconds. */
  time: number;
  playing: boolean;
  done: boolean;
  drained: boolean;
  deadlock: boolean;
  speed: number;
  countsByState: number[];
  lanes: LaneLive[];
  tick: TickTiming;
  /** Engine checkpoints held for seeking: how many, their total size, the interval (simulated s). */
  checkpoints: { count: number; bytes: number; interval: number };
  /** People per m², present only while the heatmap is on. */
  density?: Float32Array;
}

export type WorkerResponse =
  | {
      type: "selfCheckResult";
      hash: string;
      expected: string;
      matches: boolean;
      numbers: number;
      durationMs: number;
      engineVersion: string;
    }
  | { type: "determinismResult"; hash: string }
  | { type: "error"; message: string }
  | LoadedInfo
  | { type: "snapshot"; generation: number; buffer: Float32Array; time: number; agentCount: number }
  | StatsMessage
  | { type: "metrics"; generation: number; metrics: MetricsSummary }
  | { type: "seekProgress"; generation: number; seekId: number; fraction: number }
  | { type: "seekDone"; generation: number; seekId: number; cancelled: boolean; time: number; durationMs: number };

/** Strips the parts of RunMetrics that the UI does not need every second. */
export function summariseMetrics(m: RunMetrics): MetricsSummary {
  const { density: _density, parameters: _parameters, ...rest } = m;
  return rest;
}

/** Seek progress in [0, 1]: how far from `from` towards `to` the run has got. */
export function seekFraction(from: number, to: number, now: number): number {
  if (!(to > from)) return 1;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}
