/**
 * Polling a server job until it finishes (spec 6.4: no websockets). The delay starts short and grows
 * by a factor up to a cap, and starts short again whenever the job moves (status or progress
 * changed), so a running job updates often and a long queue wait costs few requests. A 429 waits
 * what the server asked for (Retry-After); a network error backs off like an unchanged poll.
 * Pure: `sleep` and `get` are injected.
 */

import { ApiError, type JobResponse, type JobStatus } from "./client.ts";

export interface Backoff {
  /** First delay, ms. */
  initialMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1000, factor: 1.5, maxMs: 15_000 };

/** Delay before poll number `attempt` (0-based) since the job last moved. */
export function backoffDelay(attempt: number, b: Backoff = DEFAULT_BACKOFF): number {
  let d = b.initialMs;
  for (let k = 0; k < attempt && d < b.maxMs; k++) d *= b.factor;
  return Math.min(b.maxMs, Math.round(d));
}

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/** A cheap fingerprint of what the user sees changing. */
function movement(j: JobResponse): string {
  return `${j.status}|${j.progress.completedRuns}|${j.cancelRequested}`;
}

export interface PollOptions {
  get(): Promise<JobResponse>;
  onUpdate(job: JobResponse): void;
  /** A poll failed (shown, then polling continues). */
  onError?(error: ApiError): void;
  sleep(ms: number): Promise<void>;
  /** Polling stops when this returns true (component unmounted, job deleted). */
  stopped(): boolean;
  backoff?: Backoff;
  /** Give up after this many consecutive failures (default 20). */
  maxFailures?: number;
}

/** Polls until the job is finished, stopped or keeps failing; resolves with the last job seen (or null). */
export async function pollJob(o: PollOptions): Promise<JobResponse | null> {
  const b = o.backoff ?? DEFAULT_BACKOFF;
  let attempt = 0;
  let failures = 0;
  let last: JobResponse | null = null;
  let lastMove = "";
  for (;;) {
    if (o.stopped()) return last;
    let wait: number;
    try {
      const job = await o.get();
      failures = 0;
      if (o.stopped()) return last;
      last = job;
      o.onUpdate(job);
      if (isTerminal(job.status)) return job;
      const m = movement(job);
      attempt = m === lastMove ? attempt + 1 : 0;
      lastMove = m;
      wait = backoffDelay(attempt, b);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("network", 0, e instanceof Error ? e.message : String(e));
      if (err.kind === "not-found" || err.kind === "unauthorized") {
        o.onError?.(err);
        return last;
      }
      failures++;
      o.onError?.(err);
      if (failures >= (o.maxFailures ?? 20)) return last;
      attempt++;
      wait = err.kind === "rate-limited" && err.retryAfterSeconds !== null ? Math.max(backoffDelay(attempt, b), err.retryAfterSeconds * 1000) : backoffDelay(attempt, b);
    }
    await o.sleep(wait);
  }
}
