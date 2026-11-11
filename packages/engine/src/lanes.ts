/**
 * Lane queueing core (spec 4.1 "queue core", decision D-004 and review note B3).
 *
 * A lane serves one agent at a time. Each lane has a *logical* FIFO: an agent joins it the moment
 * it commits to the lane (wherever it is standing, even spilled back outside the queue area), and
 * that is when its waiting time starts. An agent can only be served once it is also *ready*,
 * meaning it has physically reached the head of the line. So a service starts at
 *
 *     max(previous completion, moment the head agent is ready)
 *
 * and never waits for a tick boundary. All times are exact event times.
 *
 * Per lane-visit the core measures: waiting time Wq (commit to service start), time-weighted queue
 * length (excluding the agent in service), busy time and failed time. That is everything needed
 * for the metrics in spec 4.5 and for Little's law (L = λ·W).
 */

import type { Simulation } from "./simulation.ts";

/** Event kinds, in tie-break order at equal times: a lane frees up before the next arrival. */
export const EventKind = {
  ServiceComplete: 0,
  Timed: 1,
  Arrival: 2,
} as const;

/** What happens when a service attempt ends. */
export type ServiceOutcome =
  | { kind: "done" }
  /** The attempt failed (a bad scan): the agent stays in service for `extra` more seconds. */
  | { kind: "retry"; extra: number }
  /** The agent leaves this lane unserved (for example, sent to the manual lane). */
  | { kind: "reject" };

export interface LaneCallbacks {
  /** Service time in seconds for this agent's visit to this lane. */
  serviceTime(agent: number, lane: number): number;
  /** Called when a service attempt ends; `attempt` starts at 0. Defaults to always "done". */
  outcome?(agent: number, lane: number, attempt: number): ServiceOutcome;
  /** The agent's service on this lane began (it leaves the queue). */
  onServiceStart?(agent: number, lane: number, time: number): void;
  /** The agent left the lane: served (passed) or rejected. */
  onLeave(agent: number, lane: number, time: number, served: boolean): void;
}

export interface LaneMetrics {
  /** Agents that committed to the lane (and were not moved away by a lane failure). */
  arrivals: number;
  /** Agents whose service started. */
  started: number;
  /** Agents that passed. */
  served: number;
  /** Reporting window: first arrival to last service start. */
  windowStart: number;
  windowEnd: number;
  meanWait: number;
  /** 95th percentile wait, nearest-rank definition. */
  p95Wait: number;
  maxWait: number;
  /** Time-averaged queue length over the window, excluding the agent in service. */
  meanQueue: number;
  maxQueue: number;
  /** Agents entering service per second over the window. */
  arrivalRate: number;
  /** Busy time / open time over the window. */
  utilisation: number;
  /** Seconds the lane was failed inside the window. */
  failedTime: number;
  /** Agents still waiting when the window ended (non-zero only if the run ended with a queue). */
  queuedAtWindowEnd: number;
  /**
   * Little's law check, as a relative error: the time-integral of the queue length against the sum
   * of all waiting times in the window (including the wait-so-far of agents still queuing at its end).
   * These are two independent ways of counting the same person-seconds, so this must be ~0.
   */
  littleLawError: number;
}

class Lane {
  open = true;
  // FIFO stored as parallel arrays with a moving head, so dequeuing is O(1).
  readonly agents: number[] = [];
  readonly commitTimes: number[] = [];
  readonly ready: boolean[] = [];
  head = 0;

  busyAgent = -1;
  attempt = 0;

  // Statistics. Integrals are accumulated up to `lastChange`.
  lastChange = 0;
  queueIntegral = 0;
  busyIntegral = 0;
  failedIntegral = 0;
  arrivals = 0;
  started = 0;
  served = 0;
  maxQueue = 0;
  firstArrival = -1;
  lastServiceStart = -1;
  // Integrals frozen at the last service start, which is the end of the reporting window.
  queueIntegralAtWindowEnd = 0;
  busyIntegralAtWindowEnd = 0;
  failedIntegralAtWindowEnd = 0;
  // Integrals at the first arrival, which is the start of the reporting window.
  busyIntegralAtWindowStart = 0;
  failedIntegralAtWindowStart = 0;
  readonly waits: number[] = [];
  /** Sum of the commit times of the agents now in the queue, so their total wait-so-far is O(1). */
  queuedCommitSum = 0;
  waitSum = 0;
  queuedAtWindowEnd = 0;
  residualWaitAtWindowEnd = 0;

  get queueLength(): number {
    return this.agents.length - this.head;
  }

  accumulate(now: number): void {
    const dt = now - this.lastChange;
    if (dt > 0) {
      this.queueIntegral += this.queueLength * dt;
      if (this.busyAgent >= 0) this.busyIntegral += dt;
      if (!this.open) this.failedIntegral += dt;
      this.lastChange = now;
    }
  }

  clearQueue(): void {
    this.agents.length = 0;
    this.commitTimes.length = 0;
    this.ready.length = 0;
    this.head = 0;
  }
}

/** Nearest-rank percentile of an unsorted list (p in (0, 1]). Returns 0 for an empty list. */
export function percentileNearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

/**
 * All lanes of a run. Lanes are addressed by a dense numeric id (0, 1, 2, ...), which is also the
 * `id` of their events, so equal-time events on different lanes are ordered by lane id.
 * The event payload is the agent id.
 */
export class LaneBank {
  private readonly lanes: Lane[] = [];

  constructor(
    private readonly sim: Simulation<number>,
    private readonly callbacks: LaneCallbacks,
    laneCount: number,
  ) {
    for (let i = 0; i < laneCount; i++) this.lanes.push(new Lane());
  }

  /** Handler to register for EventKind.ServiceComplete. */
  readonly handleServiceComplete = (event: { id: number; payload: number }): void => {
    const laneId = event.id;
    const lane = this.lane(laneId);
    const agent = event.payload;
    const now = this.sim.now;
    const outcome = this.callbacks.outcome?.(agent, laneId, lane.attempt) ?? { kind: "done" };
    if (outcome.kind === "retry") {
      lane.attempt++;
      this.sim.schedule(now + outcome.extra, EventKind.ServiceComplete, laneId, agent);
      return;
    }
    lane.accumulate(now);
    lane.busyAgent = -1;
    const served = outcome.kind === "done";
    if (served) lane.served++;
    this.callbacks.onLeave(agent, laneId, now, served);
    this.tryStart(laneId);
  };

  get laneCount(): number {
    return this.lanes.length;
  }

  /**
   * The agent joins the lane's logical FIFO now; its wait starts here. Pass `ready = false` if it
   * still has to walk to the head of the line, and call markReady() when it gets there.
   */
  commit(laneId: number, agent: number, ready = true): void {
    const lane = this.lane(laneId);
    const now = this.sim.now;
    lane.accumulate(now);
    lane.agents.push(agent);
    lane.commitTimes.push(now);
    lane.queuedCommitSum += now;
    lane.ready.push(ready);
    lane.arrivals++;
    if (lane.firstArrival < 0) {
      lane.firstArrival = now;
      lane.busyIntegralAtWindowStart = lane.busyIntegral;
      lane.failedIntegralAtWindowStart = lane.failedIntegral;
    }
    if (lane.queueLength > lane.maxQueue) lane.maxQueue = lane.queueLength;
    this.tryStart(laneId);
  }

  /** The agent has physically reached the service position (it matters once it heads the FIFO). */
  markReady(laneId: number, agent: number): void {
    const lane = this.lane(laneId);
    for (let i = lane.head; i < lane.agents.length; i++) {
      if (lane.agents[i] === agent) {
        lane.ready[i] = true;
        break;
      }
    }
    this.tryStart(laneId);
  }

  /**
   * The lane fails: it finishes the agent in service, then serves no one. Returns the queued agents
   * in arrival order, removed from this lane, for the caller to reassign.
   */
  fail(laneId: number): number[] {
    const lane = this.lane(laneId);
    lane.accumulate(this.sim.now);
    lane.open = false;
    const displaced = lane.agents.slice(lane.head);
    // Their wait so far on this lane is dropped from both sides of Little's law.
    lane.queueIntegral -= lane.queueLength * this.sim.now - lane.queuedCommitSum;
    lane.queuedCommitSum = 0;
    lane.clearQueue();
    lane.arrivals -= displaced.length; // their visit here is void; they start a new visit elsewhere
    return displaced;
  }

  /**
   * A queued agent leaves this lane's FIFO without being served (it jockeys to another lane).
   * Like a lane failure, its visit here is void: its wait so far is dropped from both sides of
   * Little's law and it no longer counts as an arrival. Returns false if the agent is not queued
   * here (for example, already in service).
   */
  withdraw(laneId: number, agent: number): boolean {
    const lane = this.lane(laneId);
    let i = lane.head;
    while (i < lane.agents.length && lane.agents[i] !== agent) i++;
    if (i === lane.agents.length) return false;
    const now = this.sim.now;
    lane.accumulate(now);
    const commitTime = lane.commitTimes[i] as number;
    lane.queueIntegral -= now - commitTime;
    lane.queuedCommitSum -= commitTime;
    lane.agents.splice(i, 1);
    lane.commitTimes.splice(i, 1);
    lane.ready.splice(i, 1);
    lane.arrivals--;
    if (lane.head === lane.agents.length) {
      lane.clearQueue();
      lane.queuedCommitSum = 0;
    }
    this.tryStart(laneId);
    return true;
  }

  /** Calls fn(agent, position, ready) for every queued agent, head (position 0) first. */
  forEachQueued(laneId: number, fn: (agent: number, position: number, ready: boolean) => void): void {
    const lane = this.lane(laneId);
    for (let i = lane.head; i < lane.agents.length; i++) fn(lane.agents[i] as number, i - lane.head, lane.ready[i] as boolean);
  }

  reopen(laneId: number): void {
    const lane = this.lane(laneId);
    lane.accumulate(this.sim.now);
    lane.open = true;
    this.tryStart(laneId);
  }

  isOpen(laneId: number): boolean {
    return this.lane(laneId).open;
  }

  /** Agents waiting, excluding the one in service. */
  queueLength(laneId: number): number {
    return this.lane(laneId).queueLength;
  }

  /** Agents waiting plus the one in service: what a newcomer sees ahead of them. */
  committed(laneId: number): number {
    const lane = this.lane(laneId);
    return lane.queueLength + (lane.busyAgent >= 0 ? 1 : 0);
  }

  /** Agent in service, or −1. */
  inService(laneId: number): number {
    return this.lane(laneId).busyAgent;
  }

  /** Position of an agent in the waiting line (0 = next to be served), or −1 if not queued. */
  positionOf(laneId: number, agent: number): number {
    const lane = this.lane(laneId);
    for (let i = lane.head; i < lane.agents.length; i++) if (lane.agents[i] === agent) return i - lane.head;
    return -1;
  }

  /** ∫ queue length dt from 0 to now, for time-averaged queue lengths over any window. */
  queueIntegral(laneId: number): number {
    const lane = this.lane(laneId);
    lane.accumulate(this.sim.now);
    return lane.queueIntegral;
  }

  /** Raw waiting times (seconds) of every service that started, in start order. */
  waits(laneId: number): readonly number[] {
    return this.lane(laneId).waits;
  }

  metrics(laneId: number): LaneMetrics {
    const lane = this.lane(laneId);
    const windowStart = Math.max(0, lane.firstArrival);
    const windowEnd = Math.max(windowStart, lane.lastServiceStart);
    const duration = windowEnd - windowStart;
    let sum = 0;
    let max = 0;
    for (const w of lane.waits) {
      sum += w;
      if (w > max) max = w;
    }
    const failedTime = lane.failedIntegralAtWindowEnd - lane.failedIntegralAtWindowStart;
    const openTime = duration - failedTime;
    const personSeconds = lane.waitSum + lane.residualWaitAtWindowEnd;
    return {
      arrivals: lane.arrivals,
      started: lane.started,
      served: lane.served,
      windowStart,
      windowEnd,
      meanWait: lane.waits.length > 0 ? sum / lane.waits.length : 0,
      p95Wait: percentileNearestRank(lane.waits, 0.95),
      maxWait: max,
      // The queue is empty before the first arrival, so the integral needs no start offset.
      meanQueue: duration > 0 ? lane.queueIntegralAtWindowEnd / duration : 0,
      maxQueue: lane.maxQueue,
      arrivalRate: duration > 0 ? lane.started / duration : 0,
      utilisation: openTime > 0 ? (lane.busyIntegralAtWindowEnd - lane.busyIntegralAtWindowStart) / openTime : 0,
      failedTime,
      queuedAtWindowEnd: lane.queuedAtWindowEnd,
      littleLawError: personSeconds > 0 ? Math.abs(lane.queueIntegralAtWindowEnd - personSeconds) / personSeconds : 0,
    };
  }

  private lane(laneId: number): Lane {
    const lane = this.lanes[laneId];
    if (lane === undefined) throw new RangeError(`Unknown lane ${laneId}`);
    return lane;
  }

  private tryStart(laneId: number): void {
    const lane = this.lane(laneId);
    if (!lane.open || lane.busyAgent >= 0 || lane.queueLength === 0 || !lane.ready[lane.head]) return;
    const now = this.sim.now;
    lane.accumulate(now);
    const agent = lane.agents[lane.head] as number;
    const commitTime = lane.commitTimes[lane.head] as number;
    const wait = now - commitTime;
    lane.queuedCommitSum -= commitTime;
    lane.waitSum += wait;
    lane.head++;
    if (lane.head === lane.agents.length) {
      lane.clearQueue();
      lane.queuedCommitSum = 0; // exact reset, so rounding cannot build up
    }
    lane.busyAgent = agent;
    lane.attempt = 0;
    lane.started++;
    lane.waits.push(wait);
    lane.lastServiceStart = now;
    lane.queueIntegralAtWindowEnd = lane.queueIntegral;
    lane.busyIntegralAtWindowEnd = lane.busyIntegral;
    lane.failedIntegralAtWindowEnd = lane.failedIntegral;
    lane.queuedAtWindowEnd = lane.queueLength;
    lane.residualWaitAtWindowEnd = lane.queueLength * now - lane.queuedCommitSum;
    this.callbacks.onServiceStart?.(agent, laneId, now);
    this.sim.schedule(now + this.callbacks.serviceTime(agent, laneId), EventKind.ServiceComplete, laneId, agent);
  }
}
