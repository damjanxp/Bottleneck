/**
 * The tick loop (spec section 4.1, as amended by decision D-004 in docs/PROJECT.md).
 *
 * Two layers share one clock:
 *
 * 1. Event core. Service starts, completions, arrivals and timed scenario events are scheduled at
 *    exact times. Inside each tick, every event due by the end of the tick is processed in
 *    (time, kind, id) order, including events scheduled by other events in the same tick.
 *    So a 3.1 s service takes exactly 3.1 s and a lane is never idle waiting for the next tick.
 *
 * 2. Tick systems. After the events, systems that work per tick run in a fixed order:
 *    lane assignment, movement, density, metric sampling (added in Phase 1).
 *
 * The tick length is fixed. Playback speed only changes how many ticks run per real second
 * (see playback.ts), never the tick length, so the result never depends on playback speed.
 */

import { EventQueue, type SimEvent } from "./eventQueue.ts";

/** Fixed simulated length of one movement tick, in seconds. Exactly representable in binary. */
export const TICK_SECONDS = 0.25;

export type EventHandler<P> = (event: SimEvent<P>, sim: Simulation<P>) => void;

export interface TickSystem<P> {
  readonly name: string;
  /** Called once per tick after all due events, with sim.now equal to the end of the tick. */
  update(sim: Simulation<P>): void;
}

export class Simulation<P = unknown> {
  private readonly queue = new EventQueue<P>();
  private ticksDone = 0;
  private current = 0;

  constructor(
    private readonly handlers: ReadonlyMap<number, EventHandler<P>>,
    private readonly systems: readonly TickSystem<P>[] = [],
  ) {}

  /** Number of completed ticks. */
  get tick(): number {
    return this.ticksDone;
  }

  /**
   * Current simulated time in seconds: the event's own time while an event is being handled,
   * otherwise the end of the last completed tick.
   */
  get now(): number {
    return this.current;
  }

  /** Number of events still scheduled. */
  get pendingEvents(): number {
    return this.queue.size;
  }

  /** Schedules an event. Scheduling into the past is a bug, so it throws. */
  schedule(time: number, kind: number, id: number, payload: P): SimEvent<P> {
    if (time < this.current) {
      throw new RangeError(`Cannot schedule an event at ${time} s, before the current time ${this.current} s`);
    }
    if (!this.handlers.has(kind)) throw new RangeError(`No handler registered for event kind ${kind}`);
    return this.queue.push(time, kind, id, payload);
  }

  /** The clock and the event queue, for run checkpoints (see restoreState). */
  saveState(): { ticks: number; now: number; events: SimEvent<P>[]; nextSeq: number } {
    return { ticks: this.ticksDone, now: this.current, ...this.queue.save() };
  }

  /** Restores a saveState() result: the next step() continues exactly where that state was taken. */
  restoreState(state: { ticks: number; now: number; events: readonly SimEvent<P>[]; nextSeq: number }): void {
    this.ticksDone = state.ticks;
    this.current = state.now;
    this.queue.restore(state.events, state.nextSeq);
  }

  /** Advances the simulation by exactly one tick. */
  step(): void {
    // Computed from the tick count, not by repeated addition, so the clock cannot drift.
    const tickEnd = (this.ticksDone + 1) * TICK_SECONDS;

    for (let next = this.queue.peek(); next !== undefined && next.time <= tickEnd; next = this.queue.peek()) {
      this.queue.pop();
      this.current = next.time;
      (this.handlers.get(next.kind) as EventHandler<P>)(next, this);
    }

    this.current = tickEnd;
    for (const system of this.systems) system.update(this);
    this.ticksDone += 1;
  }

  /** Runs ticks until simulated time reaches at least `time` seconds. */
  runUntil(time: number): void {
    while (this.current < time) this.step();
  }
}
