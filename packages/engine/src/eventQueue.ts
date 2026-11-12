/**
 * Priority queue of scheduled events, ordered by (time, kind, id, seq).
 *
 * - time: exact simulated time in seconds (never rounded to the tick).
 * - kind: tie-break between different kinds of event at the same instant (lower first).
 * - id:   tie-break between events of the same kind, usually the lane or agent id.
 * - seq:  insertion counter, so the order is total and never depends on heap internals.
 *
 * A total order is what makes the engine deterministic: two events can never be processed in a
 * different order on another machine.
 */

export interface SimEvent<P = unknown> {
  readonly time: number;
  readonly kind: number;
  readonly id: number;
  readonly seq: number;
  readonly payload: P;
}

function before(a: SimEvent, b: SimEvent): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.kind !== b.kind) return a.kind < b.kind;
  if (a.id !== b.id) return a.id < b.id;
  return a.seq < b.seq;
}

export class EventQueue<P = unknown> {
  private readonly heap: SimEvent<P>[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  /** Schedules an event and returns it. */
  push(time: number, kind: number, id: number, payload: P): SimEvent<P> {
    if (!Number.isFinite(time)) throw new RangeError(`Event time must be finite, got ${time}`);
    const event: SimEvent<P> = { time, kind, id, seq: this.nextSeq++, payload };
    const heap = this.heap;
    heap.push(event);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent] as SimEvent<P>;
      if (!before(event, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = event;
    return event;
  }

  /**
   * Copies of the queued events in internal (heap) order, plus the next insertion number: enough
   * to rebuild an identical queue with restore() (used by run checkpoints).
   */
  save(): { events: SimEvent<P>[]; nextSeq: number } {
    return { events: this.heap.map((e) => ({ ...e })), nextSeq: this.nextSeq };
  }

  /** Replaces the queue's contents with a save()d state (events must be in the saved heap order). */
  restore(events: readonly SimEvent<P>[], nextSeq: number): void {
    this.heap.length = 0;
    for (const e of events) this.heap.push({ ...e });
    this.nextSeq = nextSeq;
  }

  /** The earliest event without removing it. */
  peek(): SimEvent<P> | undefined {
    return this.heap[0];
  }

  /** Removes and returns the earliest event. */
  pop(): SimEvent<P> | undefined {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop();
    if (top === undefined || last === undefined || heap.length === 0) return top;

    let i = 0;
    const n = heap.length;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (right < n && before(heap[right] as SimEvent<P>, heap[left] as SimEvent<P>)) child = right;
      const c = heap[child] as SimEvent<P>;
      if (!before(c, last)) break;
      heap[i] = c;
      i = child;
    }
    heap[i] = last;
    return top;
  }
}
