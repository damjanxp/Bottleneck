/**
 * Batch Web Worker: runs one scenario to the end, in chunks so that a "cancel" message gets through,
 * and posts progress and the final metrics. Used by the comparison view (several of these run in
 * parallel, one job each at a time). Determinism makes every run here bit-identical to the same
 * scenario and seed played on screen or run in Node.
 */

import { createRun, type Run } from "@bottleneck/engine";
import type { BatchRequest, BatchResponse } from "./batchProtocol.ts";
import { summariseMetrics } from "./workerProtocol.ts";

const scope = self as unknown as {
  postMessage(message: BatchResponse): void;
  onmessage: ((event: MessageEvent<BatchRequest>) => void) | null;
};

/** Work per chunk before yielding to the message queue (ms). */
const CHUNK_MS = 100;

let current: { jobId: number; run: Run; startedAt: number; cancelled: boolean; end: number; begin: number } | null = null;

function post(message: BatchResponse): void {
  scope.postMessage(message);
}

function chunk(job: NonNullable<typeof current>): void {
  if (current !== job) return;
  if (job.cancelled) {
    current = null;
    post({ type: "cancelled", jobId: job.jobId });
    return;
  }
  try {
    const t0 = performance.now();
    const r = job.run;
    while (!r.done && performance.now() - t0 < CHUNK_MS) r.step();
    if (!r.done) {
      post({ type: "progress", jobId: job.jobId, fraction: Math.min(1, Math.max(0, (r.time - job.begin) / Math.max(1, job.end - job.begin))) });
      setTimeout(() => chunk(job), 0);
      return;
    }
    const m = r.metrics();
    current = null;
    post({
      type: "result",
      jobId: job.jobId,
      seed: r.parameters.seed,
      metrics: summariseMetrics(m),
      startTime: r.toScenarioTime(0),
      queueSampleInterval: r.parameters.queueSampleInterval,
      throughputBin: r.parameters.throughputBin,
      hash: r.metricsHash(),
      durationMs: performance.now() - job.startedAt,
    });
  } catch (error) {
    current = null;
    post({ type: "error", jobId: job.jobId, message: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    if (current && current.jobId === msg.jobId) current.cancelled = true;
    return;
  }
  try {
    const startedAt = performance.now();
    const run = createRun(msg.venue, msg.scenario);
    const job = { jobId: msg.jobId, run, startedAt, cancelled: false, begin: 0, end: run.toEngineTime(run.parameters.horizon) };
    current = job;
    post({ type: "progress", jobId: msg.jobId, fraction: 0 });
    setTimeout(() => chunk(job), 0);
  } catch (error) {
    post({ type: "error", jobId: msg.jobId, message: error instanceof Error ? error.message : String(error) });
  }
};
