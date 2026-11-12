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

import type { LaneMetrics } from "@bottleneck/schema";
import type { Simulation } from "./simulation.ts";

export type { LaneMetrics };

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

/**
 * LaneMetrics (generated from /schema/run.schema.json) holds, per lane, over the reporting window
 * from the first commitment to the last service start: arrivals (commitments not moved away by a
 * lane failure or jockeying), started and served services, mean/p95 (nearest rank)/max wait, the
 * time-averaged queue length excluding the person in service, the service-start rate, busy time /
 * open time, failed time, people still queuing at the window end, and the Little's law check: the
 * time-integral of the queue length against the sum of all waits (including the wait-so-far of
 * people still queuing at the window end), as a relative error that must be ~0.
 */

/** Optional per-lane bookkeeping a run asks for (all off by default, so the core tests stay minimal). */
export interface LaneBankOptions {
  /** Busy and open time are also collected per bin of this many seconds (from time 0). */
  binSeconds?: number;
  /** Busy and failed time are also recorded at this instant (e.g. the event start). */
  splitAt?: number;
}

/** One completed service attempt (a retry is one record per attempt), in engine seconds. */
export interface ServiceRecord {
  readonly laneId: number;
  readonly agent: number;
  readonly start: number;
  readonly end: number;
  readonly outcome: "pass" | "retry" | "reject";
}

const OUTCOME_CODES = ["pass", "retry", "reject"] as const;

class Lane {
  open = true;
  /** Start of the attempt in progress (service start, or the end of the previous failed attempt). */
  attemptStart = 0;
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
  /** Service start time of each entry in `waits`. */
  readonly starts: number[] = [];
  // Optional bins and split (LaneBankOptions).
  readonly busyBins: number[] = [];
  readonly openBins: number[] = [];
  splitDone = false;
  busyAtSplit = 0;
  failedAtSplit = 0;

  get queueLength(): number {
    return this.agents.length - this.head;
  }

  accumulate(now: number, binSeconds: number, splitAt: number): void {
    const dt = now - this.lastChange;
    if (!this.splitDone && now >= splitAt) {
      // Recorded on the side; the main integrals are added up exactly as without a split.
      const before = Math.max(0, splitAt - this.lastChange);
      this.busyAtSplit = this.busyIntegral + (this.busyAgent >= 0 ? before : 0);
      this.failedAtSplit = this.failedIntegral + (!this.open ? before : 0);
      this.splitDone = true;
    }
    if (dt > 0) {
      this.queueIntegral += this.queueLength * dt;
      if (this.busyAgent >= 0) this.busyIntegral += dt;
      if (!this.open) this.failedIntegral += dt;
      if (binSeconds > 0) addToBins(this.lastChange, now, binSeconds, this.busyAgent >= 0 ? this.busyBins : null, this.open ? this.openBins : null);
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

/** Scalar fields of a lane, in checkpoint order. */
const LANE_SCALARS = [
  "busyAgent",
  "attempt",
  "attemptStart",
  "lastChange",
  "queueIntegral",
  "busyIntegral",
  "failedIntegral",
  "arrivals",
  "started",
  "served",
  "maxQueue",
  "firstArrival",
  "lastServiceStart",
  "queueIntegralAtWindowEnd",
  "busyIntegralAtWindowEnd",
  "failedIntegralAtWindowEnd",
  "busyIntegralAtWindowStart",
  "failedIntegralAtWindowStart",
  "queuedCommitSum",
  "waitSum",
  "queuedAtWindowEnd",
  "residualWaitAtWindowEnd",
  "busyAtSplit",
  "failedAtSplit",
] as const;

/** A LaneBank's complete state as typed arrays (structured-clone friendly), for run checkpoints. */
export interface LaneBankState {
  /** LANE_SCALARS per lane, then open and splitDone as 0/1. */
  readonly scalars: Float64Array;
  /** Queued agents of all lanes, head first, with their commit times and readiness. */
  readonly queueAgents: Int32Array;
  readonly queueCommitTimes: Float64Array;
  readonly queueReady: Uint8Array;
  readonly queueOffsets: Int32Array;
  readonly waits: Float64Array;
  readonly starts: Float64Array;
  readonly waitOffsets: Int32Array;
  readonly busyBins: Float64Array;
  readonly busyBinOffsets: Int32Array;
  readonly openBins: Float64Array;
  readonly openBinOffsets: Int32Array;
  /** The service log (see LaneBank.serviceLog), one entry per completed attempt, in time order. */
  readonly logLane: Int32Array;
  readonly logAgent: Int32Array;
  readonly logStart: Float64Array;
  readonly logEnd: Float64Array;
  /** Index into OUTCOME_CODES. */
  readonly logOutcome: Uint8Array;
}

/** Concatenates lists into one typed array plus offsets (list k is data[offsets[k] .. offsets[k + 1])). */
function pack<T extends Float64Array | Int32Array | Uint8Array>(lists: readonly (readonly number[])[], make: (n: number) => T): { data: T; offsets: Int32Array } {
  const offsets = new Int32Array(lists.length + 1);
  for (let k = 0; k < lists.length; k++) offsets[k + 1] = (offsets[k] as number) + (lists[k] as readonly number[]).length;
  const data = make(offsets[lists.length] as number);
  for (let k = 0; k < lists.length; k++) data.set(lists[k] as readonly number[], offsets[k] as number);
  return { data, offsets };
}

function unpack(data: ArrayLike<number>, offsets: Int32Array, k: number): number[] {
  const out: number[] = [];
  for (let i = offsets[k] as number; i < (offsets[k + 1] as number); i++) out.push(data[i] as number);
  return out;
}

/** Adds the overlap of [t0, t1) with each bin to the given series (null: skip). */
export function addToBins(t0: number, t1: number, binSeconds: number, a: number[] | null, b: number[] | null): void {
  if (a === null && b === null) return;
  let t = t0;
  while (t < t1) {
    const bin = Math.floor(t / binSeconds);
    const end = Math.min(t1, (bin + 1) * binSeconds);
    if (a !== null) {
      while (a.length <= bin) a.push(0);
      a[bin] = (a[bin] as number) + (end - t);
    }
    if (b !== null) {
      while (b.length <= bin) b.push(0);
      b[bin] = (b[bin] as number) + (end - t);
    }
    t = end;
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
  private readonly binSeconds: number;
  private readonly splitAt: number;
  private readonly log: ServiceRecord[] = [];

  constructor(
    private readonly sim: Simulation<number>,
    private readonly callbacks: LaneCallbacks,
    laneCount: number,
    options: LaneBankOptions = {},
  ) {
    for (let i = 0; i < laneCount; i++) this.lanes.push(new Lane());
    this.binSeconds = options.binSeconds ?? 0;
    this.splitAt = options.splitAt ?? Infinity;
  }

  private touch(lane: Lane, now: number): void {
    lane.accumulate(now, this.binSeconds, this.splitAt);
  }

  /** Handler to register for EventKind.ServiceComplete. */
  readonly handleServiceComplete = (event: { id: number; payload: number }): void => {
    const laneId = event.id;
    const lane = this.lane(laneId);
    const agent = event.payload;
    const now = this.sim.now;
    const outcome = this.callbacks.outcome?.(agent, laneId, lane.attempt) ?? { kind: "done" };
    this.log.push({ laneId, agent, start: lane.attemptStart, end: now, outcome: outcome.kind === "done" ? "pass" : outcome.kind });
    if (outcome.kind === "retry") {
      lane.attempt++;
      lane.attemptStart = now;
      this.sim.schedule(now + outcome.extra, EventKind.ServiceComplete, laneId, agent);
      return;
    }
    this.touch(lane, now);
    lane.busyAgent = -1;
    const served = outcome.kind === "done";
    if (served) lane.served++;
    this.callbacks.onLeave(agent, laneId, now, served);
    this.tryStart(laneId);
  };

  /** Every completed service attempt so far, in time order (a copy). Not part of any hash. */
  serviceLog(): ServiceRecord[] {
    return this.log.slice();
  }

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
    this.touch(lane, now);
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
    this.touch(lane, this.sim.now);
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
    this.touch(lane, now);
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
    this.touch(lane, this.sim.now);
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
    this.touch(lane, this.sim.now);
    return lane.queueIntegral;
  }

  /** Raw waiting times (seconds) of every service that started, in start order. */
  waits(laneId: number): readonly number[] {
    return this.lane(laneId).waits;
  }

  /** Service start time of every entry of waits(), in start order. */
  starts(laneId: number): readonly number[] {
    return this.lane(laneId).starts;
  }

  /**
   * Busy and open seconds per bin (LaneBankOptions.binSeconds), up to now. Copies; the time since
   * the lane's last change is included without touching the lane's own sums.
   */
  bins(laneId: number): { busy: number[]; open: number[] } {
    const lane = this.lane(laneId);
    const busy = [...lane.busyBins];
    const open = [...lane.openBins];
    if (this.binSeconds > 0) addToBins(lane.lastChange, this.sim.now, this.binSeconds, lane.busyAgent >= 0 ? busy : null, lane.open ? open : null);
    return { busy, open };
  }

  /**
   * Utilisation (busy time / open time) within the reporting window on one side of the split time
   * (LaneBankOptions.splitAt): "before" is [window start, split), "after" is [split, window end].
   * 0 if that part of the window is empty.
   */
  periodUtilisation(laneId: number, side: "before" | "after"): number {
    const lane = this.lane(laneId);
    const ws = Math.max(0, lane.firstArrival);
    const we = Math.max(ws, lane.lastServiceStart);
    const startBusy = lane.busyIntegralAtWindowStart;
    const startFailed = lane.failedIntegralAtWindowStart;
    const endBusy = lane.busyIntegralAtWindowEnd;
    const endFailed = lane.failedIntegralAtWindowEnd;
    let from: number, to: number, busy: number, failed: number;
    if (this.splitAt <= ws || this.splitAt >= we) {
      // The split is outside the window: one side is all of it, the other empty.
      const whole = side === "before" ? this.splitAt >= we : this.splitAt <= ws;
      if (!whole) return 0;
      from = ws;
      to = we;
      busy = endBusy - startBusy;
      failed = endFailed - startFailed;
    } else if (side === "before") {
      from = ws;
      to = this.splitAt;
      busy = lane.busyAtSplit - startBusy;
      failed = lane.failedAtSplit - startFailed;
    } else {
      from = this.splitAt;
      to = we;
      busy = endBusy - lane.busyAtSplit;
      failed = endFailed - lane.failedAtSplit;
    }
    const open = to - from - failed;
    return open > 0 ? busy / open : 0;
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

  /** Complete state for a checkpoint; restore() on a bank with the same lane count continues identically. */
  save(): LaneBankState {
    const n = this.lanes.length;
    const per = LANE_SCALARS.length + 2;
    const scalars = new Float64Array(n * per);
    this.lanes.forEach((lane, k) => {
      LANE_SCALARS.forEach((key, j) => (scalars[k * per + j] = lane[key]));
      scalars[k * per + LANE_SCALARS.length] = lane.open ? 1 : 0;
      scalars[k * per + LANE_SCALARS.length + 1] = lane.splitDone ? 1 : 0;
    });
    const queued = this.lanes.map((l) => l.agents.slice(l.head));
    const commits = this.lanes.map((l) => l.commitTimes.slice(l.head));
    const ready = this.lanes.map((l) => l.ready.slice(l.head).map((r) => (r ? 1 : 0)));
    const q = pack(queued, (m) => new Int32Array(m));
    const waits = pack(this.lanes.map((l) => l.waits), (m) => new Float64Array(m));
    const busy = pack(this.lanes.map((l) => l.busyBins), (m) => new Float64Array(m));
    const open = pack(this.lanes.map((l) => l.openBins), (m) => new Float64Array(m));
    return {
      scalars,
      queueAgents: q.data,
      queueCommitTimes: pack(commits, (m) => new Float64Array(m)).data,
      queueReady: pack(ready, (m) => new Uint8Array(m)).data,
      queueOffsets: q.offsets,
      waits: waits.data,
      starts: pack(this.lanes.map((l) => l.starts), (m) => new Float64Array(m)).data,
      waitOffsets: waits.offsets,
      busyBins: busy.data,
      busyBinOffsets: busy.offsets,
      openBins: open.data,
      openBinOffsets: open.offsets,
      logLane: Int32Array.from(this.log, (r) => r.laneId),
      logAgent: Int32Array.from(this.log, (r) => r.agent),
      logStart: Float64Array.from(this.log, (r) => r.start),
      logEnd: Float64Array.from(this.log, (r) => r.end),
      logOutcome: Uint8Array.from(this.log, (r) => OUTCOME_CODES.indexOf(r.outcome)),
    };
  }

  /** Overwrites every lane with a save()d state. */
  restore(state: LaneBankState): void {
    const per = LANE_SCALARS.length + 2;
    if (state.scalars.length !== this.lanes.length * per) throw new RangeError("Lane bank state does not match the number of lanes");
    this.lanes.forEach((lane, k) => {
      LANE_SCALARS.forEach((key, j) => (lane[key] = state.scalars[k * per + j] as number));
      lane.open = state.scalars[k * per + LANE_SCALARS.length] === 1;
      lane.splitDone = state.scalars[k * per + LANE_SCALARS.length + 1] === 1;
      lane.clearQueue();
      for (const a of unpack(state.queueAgents, state.queueOffsets, k)) lane.agents.push(a);
      for (const t of unpack(state.queueCommitTimes, state.queueOffsets, k)) lane.commitTimes.push(t);
      for (const r of unpack(state.queueReady, state.queueOffsets, k)) lane.ready.push(r === 1);
      replace(lane.waits, unpack(state.waits, state.waitOffsets, k));
      replace(lane.starts, unpack(state.starts, state.waitOffsets, k));
      replace(lane.busyBins, unpack(state.busyBins, state.busyBinOffsets, k));
      replace(lane.openBins, unpack(state.openBins, state.openBinOffsets, k));
    });
    this.restoreLog(state);
  }

  private restoreLog(state: LaneBankState): void {
    this.log.length = 0;
    for (let i = 0; i < state.logLane.length; i++) {
      this.log.push({
        laneId: state.logLane[i] as number,
        agent: state.logAgent[i] as number,
        start: state.logStart[i] as number,
        end: state.logEnd[i] as number,
        outcome: OUTCOME_CODES[state.logOutcome[i] as number] ?? "pass",
      });
    }
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
    this.touch(lane, now);
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
    lane.attemptStart = now;
    lane.started++;
    lane.waits.push(wait);
    lane.starts.push(now);
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

function replace(target: number[], values: readonly number[]): void {
  target.length = 0;
  for (const v of values) target.push(v);
}
