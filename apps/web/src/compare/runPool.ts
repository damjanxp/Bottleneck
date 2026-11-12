/**
 * Runs comparison jobs on a small pool of batch workers (one job per worker at a time), with
 * progress and cancel. Results are independent of the pool size and of the order jobs finish in:
 * each run is deterministic.
 */

import type { Venue } from "@bottleneck/schema";
import type { BatchRequest, BatchResponse, RunResult } from "../batchProtocol.ts";
import type { Job } from "./plan.ts";

export interface PoolCallbacks {
  onProgress(jobId: number, fraction: number): void;
  onResult(result: RunResult): void;
  onError(jobId: number, message: string): void;
  /** Every job has finished, failed or been cancelled. */
  onDone(cancelled: boolean): void;
}

/** Workers to use: leave one core for the page and the playback worker; at most 4. */
export function poolSize(jobs: number, cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2): number {
  return Math.max(1, Math.min(4, jobs, cores - 1));
}

export class RunPool {
  private readonly workers: Worker[] = [];
  private readonly queue: Job[];
  private readonly running = new Map<Worker, number>();
  private remaining: number;
  private cancelled = false;
  private finished = false;

  constructor(
    jobs: readonly Job[],
    private readonly venueFor: (job: Job) => Venue,
    private readonly cb: PoolCallbacks,
  ) {
    this.queue = [...jobs];
    this.remaining = jobs.length;
    const n = poolSize(jobs.length);
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL("../batch.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<BatchResponse>) => this.handle(w, e.data);
      w.onerror = (e) => {
        const jobId = this.running.get(w);
        if (jobId !== undefined) this.fail(w, jobId, e.message || "Worker error");
      };
      this.workers.push(w);
    }
    if (jobs.length === 0) this.finish();
    for (const w of this.workers) this.next(w);
  }

  private next(w: Worker): void {
    const job = this.cancelled ? undefined : this.queue.shift();
    if (!job) return;
    this.running.set(w, job.jobId);
    const msg: BatchRequest = { type: "run", jobId: job.jobId, venue: this.venueFor(job), scenario: job.scenario };
    w.postMessage(msg);
  }

  private settle(w: Worker): void {
    this.running.delete(w);
    this.remaining--;
    if (this.cancelled) {
      // Skipped jobs never ran.
      this.remaining -= this.queue.length;
      this.queue.length = 0;
    }
    if (this.remaining <= 0) this.finish();
    else this.next(w);
  }

  private fail(w: Worker, jobId: number, message: string): void {
    this.cb.onError(jobId, message);
    this.settle(w);
  }

  private handle(w: Worker, msg: BatchResponse): void {
    if (this.finished) return;
    switch (msg.type) {
      case "progress":
        this.cb.onProgress(msg.jobId, msg.fraction);
        break;
      case "result": {
        const { type: _type, ...result } = msg;
        this.cb.onResult(result);
        this.settle(w);
        break;
      }
      case "cancelled":
        this.settle(w);
        break;
      case "error":
        this.fail(w, msg.jobId, msg.message);
        break;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const w of this.workers) w.terminate();
    this.cb.onDone(this.cancelled);
  }

  /** Stops queued jobs and asks running ones to stop at their next chunk. */
  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.remaining -= this.queue.length;
    this.queue.length = 0;
    for (const [w, jobId] of this.running) {
      const msg: BatchRequest = { type: "cancel", jobId };
      w.postMessage(msg);
    }
    if (this.running.size === 0) this.finish();
  }

  /** Immediate stop (component unmount). */
  dispose(): void {
    this.finished = true;
    for (const w of this.workers) w.terminate();
  }
}
