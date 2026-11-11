/** A fixed-size window of recent samples with nearest-rank percentiles (for the ?perf=1 overlay). */
export class RollingSamples {
  private readonly values: Float64Array;
  private count = 0;
  private next = 0;

  constructor(readonly capacity = 600) {
    this.values = new Float64Array(capacity);
  }

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }

  /** Nearest-rank percentile, q in (0, 1]; 0 when empty. */
  percentile(q: number): number {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.values.subarray(0, this.count)).sort((a, b) => a - b);
    const rank = Math.min(this.count, Math.max(1, Math.ceil(q * this.count)));
    return sorted[rank - 1] as number;
  }
}
