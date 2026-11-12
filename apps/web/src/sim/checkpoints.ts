/**
 * Engine checkpoints for replay (review C1).
 *
 * The worker saves a checkpoint (run.saveCheckpoint()) every `interval` simulated seconds while it
 * steps the run, whether playing or seeking. A seek then starts from the best checkpoint instead
 * of from time 0, and steps forward from there. Every checkpoint is the exact state of the seeded
 * run at that tick, so a seek ends in exactly the state that playing to the same time would give.
 *
 * Memory budget. A checkpoint is about 165 bytes per agent plus the lane histories and the density
 * grid; measured on the concert venue: 0.83–1.10 MB at 4,500 people and 1.64–2.10 MB at 10,000
 * (the performance reference load), growing slowly as histories fill. The interval is chosen when a
 * run is loaded so that a checkpoint every `interval` over the whole run, at 1.3× the size of a
 * checkpoint taken at time 0, fits CHECKPOINT_BUDGET_BYTES (64 MB), with a 1-minute minimum, in
 * whole minutes. Should the checkpoints still outgrow the budget, every other one is dropped and the
 * interval doubles. With the run itself (about one checkpoint plus the flow fields) the worker stays
 * well under 200 MB. Examples (concert venue, 150 simulated minutes): 4,500 people, every 3 min,
 * 50 checkpoints, about 50 MB; 10,000 people, every 5 min, 30 checkpoints, about 57 MB. A backward
 * seek then costs one restoreRun() (about 0.3 s, mostly rebuilding the flow fields) plus at most
 * one interval of stepping.
 */

export const CHECKPOINT_BUDGET_BYTES = 64 * 1024 * 1024;
export const MIN_CHECKPOINT_INTERVAL = 60;
/** Headroom for histories that grow during the run (measured: +33% over a 2.5-hour concert run). */
export const CHECKPOINT_GROWTH = 1.3;
/** A forward seek restores a later checkpoint only if that skips at least this much simulated time (restoring costs about as much as 2 minutes of stepping). */
export const FORWARD_RESTORE_GAIN = 120;

const TICK = 0.25;

/** Bytes held by a checkpoint: the sum of its typed arrays (plus 8 per plain number). */
export function checkpointBytes(value: unknown): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "number") return 8;
  if (value !== null && typeof value === "object") {
    let sum = 0;
    for (const v of Object.values(value)) sum += checkpointBytes(v);
    return sum;
  }
  return 0;
}

/** Checkpoint interval (s, whole minutes, at least MIN_CHECKPOINT_INTERVAL) for a run of `duration` simulated seconds whose checkpoints are about `bytesEach`. */
export function chooseInterval(duration: number, bytesEach: number, budget = CHECKPOINT_BUDGET_BYTES): number {
  if (!(duration > 0) || !(bytesEach > 0)) return MIN_CHECKPOINT_INTERVAL;
  const count = Math.max(1, Math.floor(budget / (bytesEach * CHECKPOINT_GROWTH)));
  const raw = duration / count;
  return Math.max(MIN_CHECKPOINT_INTERVAL, Math.ceil(raw / 60) * 60);
}

export type SeekPlan =
  /** Step on from where the run is now. */
  | { kind: "continue" }
  /** Restore the checkpoint taken at `time`, then step. */
  | { kind: "restore"; time: number }
  /** Start a fresh run from time 0, then step. */
  | { kind: "fresh" };

/**
 * Where a seek from engine time `current` to `target` should start. `times` are the checkpoint
 * times (any order). Backwards: the latest checkpoint at or before the target, else a fresh run.
 * Forwards: the latest checkpoint at or before the target if it skips at least `minGain` seconds
 * past the current time, else continue from the current state.
 */
export function planSeek(current: number, target: number, times: readonly number[], minGain = FORWARD_RESTORE_GAIN): SeekPlan {
  let best = -Infinity;
  for (const t of times) if (t <= target && t > best) best = t;
  if (target < current) return best > -Infinity ? { kind: "restore", time: best } : { kind: "fresh" };
  if (best > -Infinity && best - current >= minGain) return { kind: "restore", time: best };
  return { kind: "continue" };
}

/** Checkpoints of one run, keyed by engine time (a multiple of the interval). */
export class CheckpointStore<T> {
  private readonly entries = new Map<number, { value: T; bytes: number }>();
  private total = 0;
  interval: number;
  readonly budget: number;

  constructor(interval = MIN_CHECKPOINT_INTERVAL, budget = CHECKPOINT_BUDGET_BYTES) {
    this.interval = interval;
    this.budget = budget;
  }

  get size(): number {
    return this.entries.size;
  }
  get totalBytes(): number {
    return this.total;
  }
  /** Checkpoint times in ascending order. */
  times(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b);
  }
  get(time: number): T | undefined {
    return this.entries.get(time)?.value;
  }

  /** True when a checkpoint should be saved at engine time `time` (on the interval grid, not time 0, not saved yet). */
  isDue(time: number): boolean {
    if (!(time > 0)) return false;
    const ticks = Math.round(time / TICK);
    const every = Math.round(this.interval / TICK);
    return ticks % every === 0 && !this.entries.has(time);
  }

  add(time: number, value: T, bytes: number): void {
    if (this.entries.has(time)) return;
    this.entries.set(time, { value, bytes });
    this.total += bytes;
    // Over budget: double the interval and keep only the checkpoints on the coarser grid.
    while (this.total > this.budget && this.entries.size > 1) {
      this.interval *= 2;
      const every = Math.round(this.interval / TICK);
      for (const [t, e] of [...this.entries]) {
        if (Math.round(t / TICK) % every !== 0) {
          this.entries.delete(t);
          this.total -= e.bytes;
        }
      }
    }
  }

  clear(interval = this.interval): void {
    this.entries.clear();
    this.total = 0;
    this.interval = interval;
  }
}
