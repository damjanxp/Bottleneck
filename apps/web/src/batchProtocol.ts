/**
 * Messages between the page and a batch worker (batch.worker.ts), which runs one scenario to the
 * end as fast as it can, for comparisons and multi-seed batches. Separate from the playback worker,
 * so a comparison never disturbs the simulation that is on screen.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import type { MetricsSummary } from "./workerProtocol.ts";

export type BatchRequest = { type: "run"; jobId: number; venue: Venue; scenario: Scenario } | { type: "cancel"; jobId: number };

/** Everything the comparison view needs from one finished run. */
export interface RunResult {
  jobId: number;
  seed: number;
  metrics: MetricsSummary;
  /** Scenario time of engine time 0 (x of the first queue sample is startTime + queueSampleInterval). */
  startTime: number;
  queueSampleInterval: number;
  throughputBin: number;
  /** Metrics hash (D-006): equal hashes mean bit-identical results. */
  hash: string;
  /** Wall time of the run in the worker, ms. */
  durationMs: number;
}

export type BatchResponse =
  | { type: "progress"; jobId: number; fraction: number }
  | ({ type: "result" } & RunResult)
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };
