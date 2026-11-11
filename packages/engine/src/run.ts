/**
 * A pedestrian run: venue + scenario in, a steppable simulation out (spec 4.1, 4.2, 4.5).
 *
 * Designed for a Web Worker driver:
 *
 *   const run = createRun(venue, scenario);
 *   while (!run.done) { run.step(); ... run.writeSnapshot(buffer) ~20 times per second ... }
 *   const m = run.metrics(); const h = run.metricsHash();
 *
 * Time. Engine time starts at 0. Engine time 0 is scenario time `timeOffset`: the scenario's
 * gatesOpen, or, if anyone arrives (or a timed event happens) before the gates open, the earliest
 * such time rounded down to a whole minute, minus one minute. toScenarioTime() converts.
 *
 * One tick (0.25 s), after the event core has processed every event due in the tick (D-004:
 * service completions, then timed scenario events such as lane failures):
 *   1. arrivals: Pending agents whose arrival time has come appear at their source;
 *   2. lane assignment: agents within the decision distance choose and commit to a lane;
 *      queued agents may jockey once; lane FIFO positions are refreshed;
 *   3. movement: along flow fields at Weidmann speed, or along the queue line at free speed;
 *      reaching the line makes an agent ready for service (lanes.ts starts the service then);
 *   4. density: the 2 m density grid for the next tick's speeds;
 *   5. metric sampling: queue lengths every 10 s, the time-aggregated density grid.
 *
 * Lane choice (spec 4.2). With probability nearestLaneShare the agent takes the open lane with the
 * shortest walk. Otherwise it picks by logit: P(lane) ∝ exp(−cost/τ), with cost = walk time +
 * (people committed to the lane, including the one in service) × mean service time, and
 * τ = logitScale seconds. Commitment is immediate, so the next agent in the same tick already sees
 * the new count. The wait starts at commit (review B3).
 *
 * Jockeying: at most once per stage, only for someone standing at the line (in the queue area or
 * spilled back behind it), only to a lane of the same element with at least 3 fewer people than are
 * ahead of them, to the back of that lane.
 *
 * Lane failure (timed laneFail): the lane finishes its current person and serves nobody else.
 * Its queue is reassigned in arrival order, each person to the open lane of the same element with
 * the lowest walk time + expected wait (or any element of the same stage set if all are failed),
 * keeping their wait clock running.
 */

import type { Distribution, Scenario, Venue } from "@bottleneck/schema";
import { AGENT_STATE_COUNT, AgentState as AgentStateEnum, AgentStore, Mode as ModeEnum, Stage as StageEnum } from "./agents.ts";
import { PiecewiseLinearCurve, resolveArrivalPoints, type CurvePoint } from "./arrivals.ts";
import { DensityGrid } from "./density.ts";
import { exp } from "./detmath.ts";
import { sampleCategorical } from "./distributions.ts";
import type { FlowField } from "./flowField.ts";
import { Float64Hasher } from "./hash.ts";
import { EventKind as EventKindEnum, LaneBank, percentileNearestRank, type LaneMetrics } from "./lanes.ts";
import { RandomStream as RandomStreamEnum, toSeed, uniform } from "./rng.ts";
import { makeSampler, type Sampler } from "./sampling.ts";
import { Simulation, TICK_SECONDS as TICK, type EventHandler } from "./simulation.ts";
import { buildVenueModel, type LaneElement, type LaneGeometry, type VenueModel } from "./venueModel.ts";

// ---------------------------------------------------------------------------------------------
// Snapshot layout
// ---------------------------------------------------------------------------------------------

/**
 * writeSnapshot() fills a Float32Array as a structure of arrays, one block of `agentCount` values
 * per field, in this order: x, y (venue metres), vx, vy (m/s, for renderer extrapolation, review
 * C3), state (an AgentState value). Value of field f for agent i: buffer[f·agentCount + i].
 */
export const SnapshotField = { X: 0, Y: 1, VX: 2, VY: 3, State: 4 } as const;
export const SNAPSHOT_FIELDS = 5;

export function snapshotLength(agentCount: number): number {
  return SNAPSHOT_FIELDS * agentCount;
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

/** Engine-side defaults that the schema does not (yet) let a scenario set. All are assumptions. */
export const RUN_DEFAULTS = {
  freeWalkingSpeed: { kind: "truncatedNormal", mean: 1.3, sd: 0.25, min: 0.5, max: 2.2 },
  nearestLaneShare: 0.3,
  speedDensity: { gamma: 1.913, rhoMax: 5.4 },
  /** Agents choose a lane when the walk to the nearest lane of their stage is at most this (m). */
  decisionDistance: 20,
  /** Logit scale τ in seconds: a lane costing τ seconds more is e times less likely. */
  logitScale: 15,
  /** Distance between people standing in a queue line (m). */
  slotSpacing: 0.6,
  /** A queued person jockeys only to a lane with at least this many fewer people. */
  jockeyThreshold: 3,
  manualServiceTime: { kind: "uniform", min: 20, max: 40 },
  densitySigma: 0.7,
  /** Deadlock watchdog: stop if nothing changes for this many simulated minutes. */
  watchdogMinutes: 10,
  /** Queue lengths are sampled this often (s). */
  queueSampleInterval: 10,
  /** Throughput is counted per bin of this length (s). */
  throughputBin: 60,
  /** "Share inside by T": T is this many seconds before a fixed start (open door: after opening). */
  shareInsideLead: 600,
} as const;

export interface ResolvedParameters {
  seed: number;
  attendance: number;
  timeOffset: number;
  horizon: number;
  gatesOpen: number;
  eventStart: number | null;
  freeWalkingSpeed: Distribution;
  nearestLaneShare: number;
  speedDensity: { gamma: number; rhoMax: number };
  decisionDistance: number;
  logitScale: number;
  slotSpacing: number;
  jockeyThreshold: number;
  manualServiceTime: Distribution;
  densitySigma: number;
  watchdogMinutes: number;
  queueSampleInterval: number;
  throughputBin: number;
  shareInsideAt: number;
  arrivalCurve: CurvePoint[];
  elements: {
    id: string;
    kind: "screening" | "gate";
    laneCount: number;
    queueLength: number;
    serviceTime: Distribution;
    scanFailureRate: number;
    retryTime: Distribution | null;
  }[];
}

export interface RunOptions {
  /** Overrides RUN_DEFAULTS for this run (tests, experiments). */
  defaults?: Partial<{ decisionDistance: number; logitScale: number; slotSpacing: number; jockeyThreshold: number; watchdogMinutes: number }>;
}

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

export interface LaneLayout {
  readonly laneId: number;
  readonly elementId: string;
  readonly elementKind: "screening" | "gate";
  readonly laneIndex: number;
  readonly manual: boolean;
  /** Venue coordinates. */
  readonly service: { x: number; y: number };
  readonly exit: { x: number; y: number };
  /** Head and tail of the physical queue area. */
  readonly queueHead: { x: number; y: number };
  readonly queueTail: { x: number; y: number };
  readonly capacity: number;
}

export interface LaneLive {
  readonly laneId: number;
  /** Waiting, excluding the person in service (includes people still walking to the line). */
  readonly queueLength: number;
  readonly inService: boolean;
  readonly open: boolean;
  /** Failed by a timed event (as opposed to not open yet). */
  readonly failed: boolean;
}

export interface LiveDensity {
  /** People per m², row-major, `cols × rows`; updated every tick (same array object). */
  readonly data: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  /** Venue coordinates of the grid's top-left corner. */
  readonly originX: number;
  readonly originY: number;
}

export interface LaneReport {
  laneId: number;
  elementId: string;
  elementKind: "screening" | "gate";
  laneIndex: number;
  manual: boolean;
  /** From lanes.ts; failedTime excludes the time before the gates opened. */
  metrics: LaneMetrics;
  /** People served per throughputBin seconds, bins from engine time 0. */
  throughput: number[];
  /** Queue length (excluding the one in service) every queueSampleInterval seconds from engine time 1 interval. */
  queueLength: number[];
}

export interface RunMetrics {
  agentCount: number;
  drained: boolean;
  deadlock: boolean;
  /** Scenario time the metrics were taken at. */
  time: number;
  countsByState: number[];
  /** Agents that could not reach any lane or destination (TurnedAway). */
  unreachable: number;
  lanes: LaneReport[];
  /** The 60-minute window (scenario time, 1-minute steps) with the most arrivals. */
  peakHour: { start: number; end: number; arrivals: number; p95Wait: number };
  /** Mean and nearest-rank p95 of every arrived agent's total wait (all stages), s. */
  meanWait: number;
  p95Wait: number;
  shareInside: { time: number; share: number };
  /** Fixed-start events: people whose gate service starts after the event start (or never). */
  stillOutsideAtStart: number | null;
  /** Time-aggregated density (people/m²) on the live density grid. */
  density: { cols: number; rows: number; cellSize: number; mean: number[]; max: number[] };
  parameters: ResolvedParameters;
}

export interface Run {
  readonly agentCount: number;
  /** Engine time in seconds (0 at the start of the run). */
  readonly time: number;
  /** Scenario time of engine time 0. */
  readonly timeOffset: number;
  readonly done: boolean;
  /** True once every agent is Inside or TurnedAway. */
  readonly drained: boolean;
  /** True if the deadlock watchdog stopped the run. */
  readonly deadlock: boolean;
  readonly lanes: readonly LaneLayout[];
  readonly density: LiveDensity;
  readonly parameters: ResolvedParameters;
  /** Advances one 0.25 s tick (does nothing once done). */
  step(): void;
  toScenarioTime(engineTime: number): number;
  toEngineTime(scenarioTime: number): number;
  countsByState(): number[];
  writeSnapshot(out: Float32Array): void;
  laneStates(): LaneLive[];
  metrics(): RunMetrics;
  metricsHash(): string;
  /** Internal state for tests and tools; not a stable API. */
  readonly debug: RunDebug;
}

export interface RunDebug {
  readonly model: VenueModel;
  readonly agents: AgentStore;
  readonly bank: LaneBank;
  readonly laneFailed: Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------------------------

// Module-local copies of imported constants: hot loops read them millions of times, and some
// module loaders (Vitest's) turn every access to an imported binding into a getter call.
const AgentState = { ...AgentStateEnum };
const Mode = { ...ModeEnum };
const Stage = { ...StageEnum };
const EventKind = { ...EventKindEnum };
const RandomStream = { ...RandomStreamEnum };
const TICK_SECONDS = TICK;

const ARRIVE_AT_LINE = 0.75;
const SLOT_REACHED = 1e-6;
const PATH_OFFSET = 0.15;
const SPAWN_RADIUS = 1;

type TimedAction = () => void;

class PedestrianRun implements Run {
  readonly agentCount: number;
  readonly timeOffset: number;
  readonly parameters: ResolvedParameters;
  readonly lanes: LaneLayout[];
  readonly density: LiveDensity;
  readonly debug: RunDebug;

  private readonly model: VenueModel;
  private readonly sim: Simulation<number>;
  private readonly bank: LaneBank;
  private readonly agents: AgentStore;
  private readonly densityGrid: DensityGrid;
  private readonly seed: number;
  private readonly counts = new Int32Array(AGENT_STATE_COUNT);
  private readonly order: Int32Array;
  private nextArrival = 0;
  private readonly laneFailed: Uint8Array;
  private gatesAreOpen: boolean;
  private readonly horizon: number;
  private readonly gatesOpenAt: number;
  private readonly eventStartAt: number | null;
  private readonly actions: TimedAction[] = [];
  private pendingActions = 0;
  private readonly elementSamplers: Sampler[];
  private readonly retrySamplers: (Sampler | null)[];
  private readonly manualSampler: Sampler;
  private readonly queueSeries: number[][];
  private readonly throughput: number[][];
  private readonly densitySum: Float64Array;
  private readonly densityMax: Float64Array;
  private densityTime = 0;
  private lastProgress = 0;
  private unreachable = 0;
  private isDone = false;
  private isDrained = false;
  private isDeadlock = false;
  // Settings
  private readonly decisionDistance: number;
  private readonly logitScale: number;
  private readonly nearestShare: number;
  private readonly jockeyThreshold: number;
  private readonly watchdog: number;
  private readonly sampleTicks: number;
  private readonly logitWeights: number[] = [];
  private readonly logitLanes: number[] = [];

  constructor(venue: Venue, scenario: Scenario, options: RunOptions = {}) {
    const d = { ...RUN_DEFAULTS, ...(options.defaults ?? {}) };
    const params = scenario.parameters ?? {};
    const freeSpeed = params.freeWalkingSpeed ?? RUN_DEFAULTS.freeWalkingSpeed;
    this.nearestShare = params.nearestLaneShare ?? RUN_DEFAULTS.nearestLaneShare;
    const speedDensity = venue.parameters?.speedDensity ?? RUN_DEFAULTS.speedDensity;
    this.decisionDistance = d.decisionDistance;
    this.logitScale = d.logitScale;
    this.jockeyThreshold = d.jockeyThreshold;
    this.watchdog = d.watchdogMinutes * 60;
    this.sampleTicks = Math.round(RUN_DEFAULTS.queueSampleInterval / TICK_SECONDS);
    this.seed = toSeed(scenario.seed);

    this.model = buildVenueModel(venue, scenario, { slotSpacing: d.slotSpacing, manualServiceTime: RUN_DEFAULTS.manualServiceTime });
    const model = this.model;

    // --- Arrivals: every agent is created now, with its personal draws (D-003). ---
    const curvePoints = resolveArrivalPoints(scenario.arrivals, scenario.timeline);
    const curve = new PiecewiseLinearCurve(curvePoints);
    const bursts = (scenario.timedEvents ?? []).filter((e) => e.kind === "busBurst");
    let burstTotal = 0;
    for (const b of bursts) if (b.kind === "busBurst") burstTotal += Math.max(0, Math.floor(b.count));
    const attendance = Math.max(0, Math.floor(scenario.attendance));
    const n = attendance + burstTotal;
    this.agentCount = n;
    const agents = new AgentStore(n);
    this.agents = agents;
    const speedSampler = makeSampler(freeSpeed, this.seed, RandomStream.FreeSpeed);
    const sourceIndex: Record<string, number> = {};
    venue.sources.forEach((s, i) => (sourceIndex[s.id] = i));
    let earliest = Infinity;
    for (let i = 0; i < n; i++) {
      if (i < attendance) {
        agents.arrivalTime[i] = curve.sample(uniform(this.seed, RandomStream.ArrivalTime, i, 0));
        agents.source[i] = model.sourceShares.length > 0 ? sampleCategorical(uniform(this.seed, RandomStream.SourceChoice, i, 0), model.sourceShares) : -1;
      }
      agents.freeSpeed[i] = speedSampler(i, 0);
      agents.offsetX[i] = (2 * uniform(this.seed, RandomStream.PathOffset, i, 0) - 1) * PATH_OFFSET;
      agents.offsetY[i] = (2 * uniform(this.seed, RandomStream.PathOffset, i, 1) - 1) * PATH_OFFSET;
    }
    let next = attendance;
    for (const b of bursts) {
      if (b.kind !== "busBurst") continue;
      const src = sourceIndex[b.sourceId] ?? -1;
      for (let k = 0; k < Math.max(0, Math.floor(b.count)); k++, next++) {
        agents.arrivalTime[next] = b.at;
        agents.source[next] = src;
      }
    }
    for (let i = 0; i < n; i++) if ((agents.arrivalTime[i] as number) < earliest) earliest = agents.arrivalTime[i] as number;
    for (const e of scenario.timedEvents ?? []) if (e.at < earliest) earliest = e.at;

    // --- Clock ---
    const tl = scenario.timeline;
    this.timeOffset = earliest < tl.gatesOpen ? Math.floor(earliest / 60) * 60 - 60 : tl.gatesOpen;
    for (let i = 0; i < n; i++) agents.arrivalTime[i] = (agents.arrivalTime[i] as number) - this.timeOffset;
    this.horizon = tl.horizon - this.timeOffset;
    this.gatesOpenAt = tl.gatesOpen - this.timeOffset;
    this.eventStartAt = tl.eventStart === null ? null : tl.eventStart - this.timeOffset;
    const shareInsideAt = tl.eventStart === null ? tl.gatesOpen + 3600 : tl.eventStart - RUN_DEFAULTS.shareInsideLead;

    // Arrival order: by (time, id).
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => (agents.arrivalTime[a] as number) - (agents.arrivalTime[b] as number) || a - b);
    this.order = Int32Array.from(order);
    this.counts[AgentState.Pending] = n;

    // --- Lanes and events ---
    const handlers = new Map<number, EventHandler<number>>([
      [EventKind.ServiceComplete, (event) => this.bank.handleServiceComplete(event)],
      [
        EventKind.Timed,
        (event) => {
          this.pendingActions--;
          (this.actions[event.payload] as TimedAction)();
        },
      ],
    ]);
    const densityGrid = new DensityGrid(model.grid, RUN_DEFAULTS.densitySigma, speedDensity.gamma, speedDensity.rhoMax);
    this.densityGrid = densityGrid;
    this.sim = new Simulation<number>(handlers, [
      { name: "arrivals", update: () => this.arrivals() },
      { name: "lane assignment", update: () => this.assignLanes() },
      { name: "movement", update: () => this.move() },
      { name: "density", update: () => this.updateDensity() },
      { name: "metric sampling", update: () => this.sample() },
    ]);
    this.elementSamplers = model.elements.map((el) => makeSampler(el.serviceTime, this.seed, el.kind === "screening" ? RandomStream.ScreeningTime : RandomStream.ScanTime));
    this.retrySamplers = model.elements.map((el) => (el.retryTime ? makeSampler(el.retryTime, this.seed, RandomStream.ScanRetryTime) : null));
    this.manualSampler = makeSampler(RUN_DEFAULTS.manualServiceTime, this.seed, RandomStream.ManualServiceTime);
    this.bank = new LaneBank(
      this.sim,
      {
        serviceTime: (agent, lane) => this.serviceTime(agent, lane),
        outcome: (agent, lane, attempt) => this.outcome(agent, lane, attempt),
        onServiceStart: (agent, lane, time) => this.onServiceStart(agent, lane, time),
        onLeave: (agent, lane, time, served) => this.onLeave(agent, lane, time, served),
      },
      model.lanes.length,
    );
    this.laneFailed = new Uint8Array(model.lanes.length);
    this.queueSeries = model.lanes.map(() => []);
    this.throughput = model.lanes.map(() => []);

    // Gates closed until gatesOpen: lanes take commitments but serve nobody.
    this.gatesAreOpen = this.gatesOpenAt <= 0;
    if (!this.gatesAreOpen) {
      for (let l = 0; l < model.lanes.length; l++) this.bank.fail(l);
      this.addAction(this.gatesOpenAt, () => {
        this.gatesAreOpen = true;
        for (let l = 0; l < model.lanes.length; l++) if (this.laneFailed[l] === 0) this.bank.reopen(l);
      });
    }
    for (const e of scenario.timedEvents ?? []) {
      if (e.kind === "busBurst") continue;
      const el = model.elements.find((x) => x.id === e.groupId);
      if (el === undefined || e.laneIndex < 0 || e.laneIndex >= el.laneCount) continue;
      const lane = el.laneIds[e.laneIndex] as number;
      const at = e.at - this.timeOffset;
      if (e.kind === "laneFail") this.addAction(at, () => this.failLane(lane));
      else this.addAction(at, () => this.reopenLane(lane));
    }

    // --- Static outputs ---
    const ox = model.frame.originX;
    const oy = model.frame.originY;
    this.lanes = model.lanes.map((l) => {
      const el = model.elements[l.element] as LaneElement;
      return {
        laneId: l.id,
        elementId: el.id,
        elementKind: el.kind,
        laneIndex: l.laneIndex,
        manual: l.manual,
        service: { x: l.serviceX + ox, y: l.serviceY + oy },
        exit: { x: l.exitX + ox, y: l.exitY + oy },
        queueHead: { x: (l.slotX[0] as number) + ox, y: (l.slotY[0] as number) + oy },
        queueTail: { x: (l.slotX[l.capacity - 1] as number) + ox, y: (l.slotY[l.capacity - 1] as number) + oy },
        capacity: l.capacity,
      };
    });
    this.density = { data: densityGrid.density, cols: densityGrid.cols, rows: densityGrid.rows, cellSize: densityGrid.cellSize, originX: ox, originY: oy };
    this.densitySum = new Float64Array(densityGrid.density.length);
    this.densityMax = new Float64Array(densityGrid.density.length);
    this.parameters = {
      seed: this.seed,
      attendance,
      timeOffset: this.timeOffset,
      horizon: tl.horizon,
      gatesOpen: tl.gatesOpen,
      eventStart: tl.eventStart,
      freeWalkingSpeed: freeSpeed,
      nearestLaneShare: this.nearestShare,
      speedDensity: { gamma: speedDensity.gamma, rhoMax: speedDensity.rhoMax },
      decisionDistance: d.decisionDistance,
      logitScale: d.logitScale,
      slotSpacing: d.slotSpacing,
      jockeyThreshold: d.jockeyThreshold,
      manualServiceTime: RUN_DEFAULTS.manualServiceTime,
      densitySigma: RUN_DEFAULTS.densitySigma,
      watchdogMinutes: d.watchdogMinutes,
      queueSampleInterval: RUN_DEFAULTS.queueSampleInterval,
      throughputBin: RUN_DEFAULTS.throughputBin,
      shareInsideAt,
      arrivalCurve: curve.points.map((p) => ({ t: p.t, weight: p.weight })),
      elements: model.elements.map((el) => ({
        id: el.id,
        kind: el.kind,
        laneCount: el.laneCount,
        queueLength: el.queueLength,
        serviceTime: el.serviceTime,
        scanFailureRate: el.scanFailureRate,
        retryTime: el.retryTime,
      })),
    };
    this.debug = { model, agents, bank: this.bank, laneFailed: this.laneFailed };
    if (n === 0) {
      this.isDone = true;
      this.isDrained = true;
    }
  }

  // --- Public API ---

  get time(): number {
    return this.sim.now;
  }
  get done(): boolean {
    return this.isDone;
  }
  get drained(): boolean {
    return this.isDrained;
  }
  get deadlock(): boolean {
    return this.isDeadlock;
  }

  toScenarioTime(engineTime: number): number {
    return engineTime + this.timeOffset;
  }
  toEngineTime(scenarioTime: number): number {
    return scenarioTime - this.timeOffset;
  }

  step(): void {
    if (this.isDone) return;
    this.sim.step();
    const finished = (this.counts[AgentState.Inside] as number) + (this.counts[AgentState.TurnedAway] as number);
    if (finished === this.agentCount) {
      this.isDone = true;
      this.isDrained = true;
    } else if (this.sim.now >= this.horizon) {
      this.isDone = true;
    } else {
      const active = this.agentCount - finished - (this.counts[AgentState.Pending] as number);
      // Waiting for the gates to open or for a scheduled lane reopening is not a deadlock.
      const waitingForTimeline = this.sim.now < this.gatesOpenAt || this.pendingActions > 0;
      if (active > 0 && !waitingForTimeline && this.sim.now - this.lastProgress >= this.watchdog) {
        this.isDone = true;
        this.isDeadlock = true;
      }
    }
  }

  countsByState(): number[] {
    return Array.from(this.counts);
  }

  writeSnapshot(out: Float32Array): void {
    const n = this.agentCount;
    if (out.length < SNAPSHOT_FIELDS * n) throw new RangeError(`Snapshot buffer needs ${SNAPSHOT_FIELDS * n} floats, got ${out.length}`);
    const a = this.agents;
    const ox = this.model.frame.originX;
    const oy = this.model.frame.originY;
    for (let i = 0; i < n; i++) {
      out[i] = (a.x[i] as number) + ox;
      out[n + i] = (a.y[i] as number) + oy;
      out[2 * n + i] = a.vx[i] as number;
      out[3 * n + i] = a.vy[i] as number;
      out[4 * n + i] = a.state[i] as number;
    }
  }

  laneStates(): LaneLive[] {
    return this.model.lanes.map((l) => ({
      laneId: l.id,
      queueLength: this.bank.queueLength(l.id),
      inService: this.bank.inService(l.id) >= 0,
      open: this.bank.isOpen(l.id),
      failed: this.laneFailed[l.id] === 1,
    }));
  }

  // --- Time-line actions ---

  private addAction(at: number, action: TimedAction): void {
    const id = this.actions.length;
    this.actions.push(action);
    this.pendingActions++;
    this.sim.schedule(Math.max(0, at), EventKind.Timed, id, id);
  }

  private failLane(lane: number): void {
    if (this.laneFailed[lane] === 1) return;
    this.laneFailed[lane] = 1;
    const displaced = this.bank.fail(lane);
    for (const agent of displaced) this.reassign(agent, lane);
    this.lastProgress = this.sim.now;
  }

  private reopenLane(lane: number): void {
    if (this.laneFailed[lane] === 0) return;
    this.laneFailed[lane] = 0;
    if (this.gatesAreOpen) this.bank.reopen(lane);
    this.lastProgress = this.sim.now;
  }

  // --- State bookkeeping ---

  private setState(i: number, s: number): void {
    const old = this.agents.state[i] as number;
    if (old === s) return;
    this.counts[old] = (this.counts[old] as number) - 1;
    this.counts[s] = (this.counts[s] as number) + 1;
    this.agents.state[i] = s;
    this.lastProgress = this.sim.now;
  }

  private commit(i: number, lane: number): void {
    const a = this.agents;
    a.lane[i] = lane;
    a.mode[i] = Mode.ToLine;
    a.ready[i] = 0;
    if (Number.isNaN(a.waitStart[i] as number)) a.waitStart[i] = this.sim.now;
    this.setState(i, AgentState.Queuing);
    this.bank.commit(lane, i, false);
    a.queuePos[i] = this.bank.queueLength(lane) - 1;
  }

  // --- Lane callbacks ---

  private serviceTime(agent: number, lane: number): number {
    const geom = this.model.lanes[lane] as LaneGeometry;
    if (geom.manual) return this.manualSampler(agent, 0);
    return (this.elementSamplers[geom.element] as Sampler)(agent, 0);
  }

  private outcome(agent: number, lane: number, attempt: number): { kind: "done" } | { kind: "retry"; extra: number } | { kind: "reject" } {
    const geom = this.model.lanes[lane] as LaneGeometry;
    const el = this.model.elements[geom.element] as LaneElement;
    if (geom.manual || el.kind !== "gate" || el.scanFailureRate <= 0) return { kind: "done" };
    if (uniform(this.seed, RandomStream.ScanFailure, agent, attempt) >= el.scanFailureRate) return { kind: "done" };
    if (attempt === 0) return { kind: "retry", extra: (this.retrySamplers[geom.element] as Sampler)(agent, 0) };
    return { kind: "reject" };
  }

  private onServiceStart(agent: number, lane: number, time: number): void {
    const a = this.agents;
    a.totalWait[agent] = (a.totalWait[agent] as number) + (time - (a.waitStart[agent] as number));
    a.waitStart[agent] = NaN;
    const geom = this.model.lanes[lane] as LaneGeometry;
    if ((this.model.elements[geom.element] as LaneElement).kind === "gate" && Number.isNaN(a.gateStart[agent] as number)) a.gateStart[agent] = time;
    a.mode[agent] = Mode.Service;
    a.queuePos[agent] = -1;
    this.setState(agent, AgentState.InService);
  }

  private onLeave(agent: number, lane: number, time: number, served: boolean): void {
    const a = this.agents;
    const geom = this.model.lanes[lane] as LaneGeometry;
    const el = this.model.elements[geom.element] as LaneElement;
    this.lastProgress = time;
    if (!served) {
      // Second scan failure: off to the gate group's manual lane, a new wait.
      a.waitStart[agent] = time;
      a.jockeyed[agent] = 1;
      this.commit(agent, el.manualLaneId);
      return;
    }
    const bin = Math.floor(time / RUN_DEFAULTS.throughputBin);
    const series = this.throughput[lane] as number[];
    while (series.length <= bin) series.push(0);
    series[bin] = (series[bin] as number) + 1;

    a.x[agent] = geom.exitX;
    a.y[agent] = geom.exitY;
    a.vx[agent] = 0;
    a.vy[agent] = 0;
    a.lane[agent] = -1;
    a.ready[agent] = 0;
    a.jockeyed[agent] = 0;
    if (el.kind === "screening") {
      a.stage[agent] = Stage.Gates;
      a.stageSet[agent] = el.nextStageSet;
      a.mode[agent] = Mode.Approach;
    } else {
      a.stage[agent] = Stage.Inside;
      a.mode[agent] = Mode.ToDestination;
      if (this.model.destinationField.distanceAt(this.model.grid.cellAt(geom.exitX, geom.exitY)) === Infinity) {
        this.turnAway(agent);
        return;
      }
    }
    this.setState(agent, AgentState.Walking);
  }

  // --- Tick systems ---

  /** 1. Pending agents whose arrival time has come appear at their source. */
  private arrivals(): void {
    const now = this.sim.now;
    const a = this.agents;
    const m = this.model;
    while (this.nextArrival < this.order.length) {
      const i = this.order[this.nextArrival] as number;
      if ((a.arrivalTime[i] as number) > now) break;
      this.nextArrival++;
      const src = a.source[i] as number;
      if (src < 0) {
        this.turnAway(i);
        continue;
      }
      let x = m.sourceX[src] as number;
      let y = m.sourceY[src] as number;
      const jx = x + (2 * uniform(this.seed, RandomStream.SpawnOffset, i, 0) - 1) * SPAWN_RADIUS;
      const jy = y + (2 * uniform(this.seed, RandomStream.SpawnOffset, i, 1) - 1) * SPAWN_RADIUS;
      if (m.grid.isWalkableAt(jx, jy)) {
        x = jx;
        y = jy;
      }
      a.x[i] = x;
      a.y[i] = y;
      a.stage[i] = Stage.Entry;
      a.stageSet[i] = 0;
      a.mode[i] = Mode.Approach;
      const set = m.stageSets[0];
      if (set === undefined || set.field.distanceAt(m.grid.cellAt(x, y)) === Infinity) {
        this.turnAway(i);
        continue;
      }
      this.setState(i, AgentState.Walking);
    }
  }

  private turnAway(i: number): void {
    this.agents.mode[i] = Mode.Done;
    this.unreachable++;
    this.setState(i, AgentState.TurnedAway);
  }

  /** 2. Lane decisions, jockeying, and the FIFO positions used by movement. */
  private assignLanes(): void {
    const a = this.agents;
    const grid = this.model.grid;
    for (let i = 0; i < this.agentCount; i++) {
      const mode = a.mode[i] as number;
      const state = a.state[i] as number;
      if (state === AgentState.Walking && mode === Mode.Approach) {
        const set = this.model.stageSets[a.stageSet[i] as number];
        if (set === undefined) continue;
        const dist = set.field.distanceAt(grid.cellAt(a.x[i] as number, a.y[i] as number));
        if (dist <= this.decisionDistance) this.decide(i);
      } else if (mode === Mode.NoLane) {
        const lane = this.bestOpenLane(i, -1);
        if (lane >= 0) this.commit(i, lane);
      } else if (state === AgentState.Queuing && a.jockeyed[i] === 0 && (mode === Mode.InLine || mode === Mode.ToLine)) {
        this.maybeJockey(i);
      }
    }
    // FIFO positions, head first.
    for (let l = 0; l < this.model.lanes.length; l++) {
      this.bank.forEachQueued(l, (agent, position) => {
        a.queuePos[agent] = position;
      });
    }
  }

  private decide(i: number): void {
    const a = this.agents;
    const m = this.model;
    const set = m.stageSets[a.stageSet[i] as number];
    if (set === undefined) return;
    const cell = m.grid.cellAt(a.x[i] as number, a.y[i] as number);
    const v0 = a.freeSpeed[i] as number;
    const k = (a.stage[i] as number) * 2;
    const lanes = this.logitLanes;
    const costs = this.logitWeights;
    lanes.length = 0;
    costs.length = 0;
    let nearest = -1;
    let nearestDist = Infinity;
    let minCost = Infinity;
    for (const l of set.laneIds) {
      if (this.laneFailed[l] === 1) continue;
      const geom = m.lanes[l] as LaneGeometry;
      const dist = geom.field.distanceAt(cell);
      if (dist === Infinity) continue;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = l;
      }
      const cost = dist / v0 + this.bank.committed(l) * (m.elements[geom.element] as LaneElement).meanService;
      if (cost < minCost) minCost = cost;
      lanes.push(l);
      costs.push(cost);
    }
    if (lanes.length === 0) {
      // Every lane of this stage has failed: wait here (the wait clock runs) until one reopens.
      if (Number.isNaN(a.waitStart[i] as number)) a.waitStart[i] = this.sim.now;
      a.mode[i] = Mode.NoLane;
      this.setState(i, AgentState.Queuing);
      return;
    }
    let choice: number;
    if (uniform(this.seed, RandomStream.LaneChoice, i, k) < this.nearestShare) choice = nearest;
    else {
      for (let j = 0; j < costs.length; j++) costs[j] = exp(-((costs[j] as number) - minCost) / this.logitScale);
      choice = lanes[sampleCategorical(uniform(this.seed, RandomStream.LaneChoice, i, k + 1), costs)] as number;
    }
    this.commit(i, choice);
  }

  /**
   * Open lane with the lowest walk time + expected wait, for reassignment after a failure.
   * Prefers lanes of element `preferElement` (−1: any element of the agent's stage set).
   */
  private bestOpenLane(i: number, preferElement: number): number {
    const a = this.agents;
    const m = this.model;
    const set = m.stageSets[a.stageSet[i] as number];
    if (set === undefined) return -1;
    const cell = m.grid.cellAt(a.x[i] as number, a.y[i] as number);
    const v0 = a.freeSpeed[i] as number;
    let best = -1;
    let bestCost = Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      for (const l of set.laneIds) {
        if (this.laneFailed[l] === 1) continue;
        const geom = m.lanes[l] as LaneGeometry;
        if (pass === 0 && preferElement >= 0 && geom.element !== preferElement) continue;
        const dist = geom.field.distanceAt(cell);
        if (dist === Infinity) continue;
        const cost = dist / v0 + this.bank.committed(l) * (m.elements[geom.element] as LaneElement).meanService;
        if (cost < bestCost) {
          bestCost = cost;
          best = l;
        }
      }
    }
    return best;
  }

  private reassign(i: number, fromLane: number): void {
    const a = this.agents;
    const geom = this.model.lanes[fromLane] as LaneGeometry;
    const lane = this.bestOpenLane(i, geom.element);
    if (lane >= 0) {
      this.commit(i, lane);
    } else {
      a.lane[i] = -1;
      a.queuePos[i] = -1;
      a.ready[i] = 0;
      a.mode[i] = Mode.NoLane;
    }
  }

  private maybeJockey(i: number): void {
    const a = this.agents;
    const m = this.model;
    const lane = a.lane[i] as number;
    if (lane < 0) return;
    const geom = m.lanes[lane] as LaneGeometry;
    if (geom.manual) return;
    const pos = a.queuePos[i] as number;
    if (pos < 0) return;
    // Only someone standing at the line can see the other lanes.
    if (a.mode[i] === Mode.ToLine && pos < geom.capacity) return;
    const ahead = pos + (this.bank.inService(lane) >= 0 ? 1 : 0);
    const el = m.elements[geom.element] as LaneElement;
    let best = -1;
    let bestCount = ahead - this.jockeyThreshold + 1;
    let bestGap = Infinity;
    for (const l of el.laneIds) {
      if (l === lane || this.laneFailed[l] === 1) continue;
      const c = this.bank.committed(l);
      const gap = Math.abs((m.lanes[l] as LaneGeometry).laneIndex - geom.laneIndex);
      if (c < bestCount || (c === bestCount && best >= 0 && gap < bestGap)) {
        best = l;
        bestCount = c;
        bestGap = gap;
      }
    }
    if (best < 0) return;
    if (!this.bank.withdraw(lane, i)) return;
    a.jockeyed[i] = 1;
    this.commit(i, best);
  }

  /** 3. Movement. */
  private move(): void {
    const a = this.agents;
    const m = this.model;
    const grid = m.grid;
    const dens = this.densityGrid;
    let walkedSomewhere = false;
    for (let i = 0; i < this.agentCount; i++) {
      const state = a.state[i] as number;
      if (state !== AgentState.Walking && state !== AgentState.Queuing && state !== AgentState.InService) continue;
      const x0 = a.x[i] as number;
      const y0 = a.y[i] as number;
      const v0 = a.freeSpeed[i] as number;
      const mode = a.mode[i] as number;
      if (mode === Mode.Approach || mode === Mode.ToDestination) {
        const field = mode === Mode.Approach ? (m.stageSets[a.stageSet[i] as number] as { field: FlowField }).field : m.destinationField;
        const factor = dens.speedFactor[dens.cellAt(x0, y0)] as number;
        if (this.follow(i, field, v0 * factor)) walkedSomewhere = true;
        if (mode === Mode.ToDestination && field.distanceAt(grid.cellAt(a.x[i] as number, a.y[i] as number)) === 0) {
          a.mode[i] = Mode.Done;
          a.insideTime[i] = this.sim.now;
          this.setState(i, AgentState.Inside);
        }
      } else if (mode === Mode.ToLine) {
        const geom = m.lanes[a.lane[i] as number] as LaneGeometry;
        const pos = Math.max(0, a.queuePos[i] as number);
        const dist = geom.field.distanceAt(grid.cellAt(x0, y0));
        const factor = dens.speedFactor[dens.cellAt(x0, y0)] as number;
        if (pos < geom.capacity) {
          if (dist > ARRIVE_AT_LINE) this.follow(i, geom.field, v0 * factor);
          else this.still(i);
          if (geom.field.distanceAt(grid.cellAt(a.x[i] as number, a.y[i] as number)) <= ARRIVE_AT_LINE) {
            a.mode[i] = Mode.InLine;
            this.lastProgress = this.sim.now;
          }
        } else {
          // Spilled back: stand in the walkable area behind the queue area, roughly in rows.
          const stopAt = ARRIVE_AT_LINE + this.parameters.slotSpacing * (1 + Math.floor((pos - geom.capacity) / geom.perRow));
          if (dist > stopAt) this.follow(i, geom.field, v0 * factor);
          else this.still(i);
        }
      } else if (mode === Mode.InLine) {
        const lane = a.lane[i] as number;
        const geom = m.lanes[lane] as LaneGeometry;
        const slot = Math.min(Math.max(0, a.queuePos[i] as number), geom.capacity - 1);
        const reached = this.straight(i, geom.slotX[slot] as number, geom.slotY[slot] as number, v0);
        if (reached && a.ready[i] === 0) {
          // In the physical line: moving up from here is visual only (D-004), so the agent is ready.
          a.ready[i] = 1;
          this.bank.markReady(lane, i);
        }
      } else if (mode === Mode.Service) {
        const geom = m.lanes[a.lane[i] as number] as LaneGeometry;
        this.straight(i, geom.serviceX, geom.serviceY, v0);
      } else {
        this.still(i);
      }
    }
    if (walkedSomewhere) this.lastProgress = this.sim.now;
  }

  private still(i: number): void {
    this.agents.vx[i] = 0;
    this.agents.vy[i] = 0;
  }

  /** Moves agent i to (nx, ny) if that point is walkable; reports success. */
  private tryMove(i: number, nx: number, ny: number): boolean {
    if (!this.model.grid.isWalkableAt(nx, ny)) return false;
    const a = this.agents;
    a.vx[i] = (nx - (a.x[i] as number)) / TICK_SECONDS;
    a.vy[i] = (ny - (a.y[i] as number)) / TICK_SECONDS;
    a.x[i] = nx;
    a.y[i] = ny;
    return true;
  }

  /** One step along a flow field at the given speed; true if the agent moved. */
  private follow(i: number, field: FlowField, speed: number): boolean {
    const a = this.agents;
    const grid = this.model.grid;
    const x = a.x[i] as number;
    const y = a.y[i] as number;
    const next = field.next[grid.cellAt(x, y)] ?? -1;
    if (next < 0) {
      this.still(i);
      return false;
    }
    const tx = grid.centreX(next) + (a.offsetX[i] as number);
    const ty = grid.centreY(next) + (a.offsetY[i] as number);
    const dx = tx - x;
    const dy = ty - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const step = speed * TICK_SECONDS;
    if (len <= 1e-9) {
      this.still(i);
      return false;
    }
    const f = step / len;
    if (this.tryMove(i, x + dx * f, y + dy * f)) return true;
    if (this.tryMove(i, tx, ty)) return true;
    if (this.tryMove(i, x + dx * f, y)) return true;
    if (this.tryMove(i, x, y + dy * f)) return true;
    this.still(i);
    return false;
  }

  /** Straight move towards a target at the given speed; true once the target is reached. */
  private straight(i: number, tx: number, ty: number, speed: number): boolean {
    const a = this.agents;
    const x = a.x[i] as number;
    const y = a.y[i] as number;
    const dx = tx - x;
    const dy = ty - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len <= SLOT_REACHED) {
      this.still(i);
      return true;
    }
    const step = speed * TICK_SECONDS;
    if (step >= len) {
      if (this.tryMove(i, tx, ty)) return true;
    } else if (this.tryMove(i, x + (dx * step) / len, y + (dy * step) / len)) return false;
    // Blocked (should not happen on a walkable queue line): fall back to the lane's flow field.
    const lane = a.lane[i] as number;
    if (lane >= 0) this.follow(i, (this.model.lanes[lane] as LaneGeometry).field, speed);
    else this.still(i);
    return false;
  }

  /** 4. Density for the next tick's speeds. */
  private updateDensity(): void {
    const a = this.agents;
    const g = this.densityGrid;
    g.clear();
    for (let i = 0; i < this.agentCount; i++) {
      const s = a.state[i] as number;
      if (s === AgentState.Walking || s === AgentState.Queuing || s === AgentState.InService) g.add(a.x[i] as number, a.y[i] as number);
    }
    g.finish();
  }

  /** 5. Metric sampling. */
  private sample(): void {
    const d = this.densityGrid.density;
    for (let c = 0; c < d.length; c++) {
      const v = d[c] as number;
      this.densitySum[c] = (this.densitySum[c] as number) + v * TICK_SECONDS;
      if (v > (this.densityMax[c] as number)) this.densityMax[c] = v;
    }
    this.densityTime += TICK_SECONDS;
    if ((this.sim.tick + 1) % this.sampleTicks === 0) {
      for (let l = 0; l < this.model.lanes.length; l++) (this.queueSeries[l] as number[]).push(this.bank.queueLength(l));
    }
  }

  // --- Metrics ---

  /** Total wait of agent i so far: completed stage waits plus the current one. */
  private waitOf(i: number): number {
    const a = this.agents;
    const ws = a.waitStart[i] as number;
    return (a.totalWait[i] as number) + (Number.isNaN(ws) ? 0 : this.sim.now - ws);
  }

  metrics(): RunMetrics {
    const a = this.agents;
    const now = this.sim.now;
    const lanes: LaneReport[] = this.model.lanes.map((l) => {
      const el = this.model.elements[l.element] as LaneElement;
      const raw = this.bank.metrics(l.id);
      const preOpen = Math.min(Math.max(0, this.gatesOpenAt - raw.windowStart), raw.windowEnd - raw.windowStart);
      return {
        laneId: l.id,
        elementId: el.id,
        elementKind: el.kind,
        laneIndex: l.laneIndex,
        manual: l.manual,
        metrics: { ...raw, failedTime: Math.max(0, raw.failedTime - preOpen) },
        throughput: [...(this.throughput[l.id] as number[])],
        queueLength: [...(this.queueSeries[l.id] as number[])],
      };
    });

    // Agents that have arrived, in arrival order.
    const arrived: number[] = [];
    for (let k = 0; k < this.nextArrival; k++) arrived.push(this.order[k] as number);
    const allWaits: number[] = [];
    let waitSum = 0;
    for (const i of arrived) {
      if (a.state[i] === AgentState.TurnedAway) continue; // never reached a lane
      const w = this.waitOf(i);
      allWaits.push(w);
      waitSum += w;
    }

    // Peak arrival hour: 60-minute window on a 1-minute grid with the most arrivals (earliest wins).
    let peakStart = 0;
    let peakCount = 0;
    if (arrived.length > 0) {
      const first = a.arrivalTime[arrived[0] as number] as number;
      const last = a.arrivalTime[arrived[arrived.length - 1] as number] as number;
      let lo = 0;
      let hi = 0;
      for (let s = Math.floor(first / 60) * 60; s <= last; s += 60) {
        while (lo < arrived.length && (a.arrivalTime[arrived[lo] as number] as number) < s) lo++;
        while (hi < arrived.length && (a.arrivalTime[arrived[hi] as number] as number) < s + 3600) hi++;
        if (hi - lo > peakCount) {
          peakCount = hi - lo;
          peakStart = s;
        }
      }
    }
    const peakWaits: number[] = [];
    for (const i of arrived) {
      const t = a.arrivalTime[i] as number;
      if (t >= peakStart && t < peakStart + 3600 && a.state[i] !== AgentState.TurnedAway) peakWaits.push(this.waitOf(i));
    }

    const shareAt = this.parameters.shareInsideAt - this.timeOffset;
    let insideBy = 0;
    let outside = 0;
    for (let i = 0; i < this.agentCount; i++) {
      if ((a.insideTime[i] as number) <= shareAt) insideBy++;
      const gs = a.gateStart[i] as number;
      if (this.eventStartAt !== null && (Number.isNaN(gs) || gs > this.eventStartAt)) outside++;
    }

    const dt = this.densityTime > 0 ? this.densityTime : 1;
    return {
      agentCount: this.agentCount,
      drained: this.isDrained,
      deadlock: this.isDeadlock,
      time: now + this.timeOffset,
      countsByState: this.countsByState(),
      unreachable: this.unreachable,
      lanes,
      peakHour: {
        start: peakStart + this.timeOffset,
        end: peakStart + 3600 + this.timeOffset,
        arrivals: peakCount,
        p95Wait: percentileNearestRank(peakWaits, 0.95),
      },
      meanWait: allWaits.length > 0 ? waitSum / allWaits.length : 0,
      p95Wait: percentileNearestRank(allWaits, 0.95),
      shareInside: { time: this.parameters.shareInsideAt, share: this.agentCount > 0 ? insideBy / this.agentCount : 0 },
      stillOutsideAtStart: this.eventStartAt === null ? null : outside,
      density: {
        cols: this.densityGrid.cols,
        rows: this.densityGrid.rows,
        cellSize: this.densityGrid.cellSize,
        mean: Array.from(this.densitySum, (v) => v / dt),
        max: Array.from(this.densityMax),
      },
      parameters: this.parameters,
    };
  }

  /**
   * Hash of the metrics over a fixed order (decision D-006). Booleans are 1/0, null is NaN.
   *   agentCount, drained, deadlock, time, unreachable, countsByState[0..9],
   *   for each lane in id order: laneIndex, manual, then LaneMetrics in the order
   *     arrivals, started, served, windowStart, windowEnd, meanWait, p95Wait, maxWait, meanQueue,
   *     maxQueue, arrivalRate, utilisation, failedTime, queuedAtWindowEnd, littleLawError,
   *   then throughput.length and its values, queueLength.length and its values;
   *   peakHour start, end, arrivals, p95Wait; meanWait, p95Wait; shareInside time, share;
   *   stillOutsideAtStart; density cols, rows, cellSize, every mean value, every max value.
   * The parameters are not hashed: they are inputs, stored alongside.
   */
  metricsHash(): string {
    return hashMetrics(this.metrics());
  }
}

export function hashMetrics(m: RunMetrics): string {
  const h = new Float64Hasher();
  h.add(m.agentCount)
    .add(m.drained ? 1 : 0)
    .add(m.deadlock ? 1 : 0)
    .add(m.time)
    .add(m.unreachable)
    .addAll(m.countsByState);
  for (const l of m.lanes) {
    const x = l.metrics;
    h.add(l.laneIndex).add(l.manual ? 1 : 0);
    h.add(x.arrivals).add(x.started).add(x.served).add(x.windowStart).add(x.windowEnd).add(x.meanWait).add(x.p95Wait).add(x.maxWait);
    h.add(x.meanQueue).add(x.maxQueue).add(x.arrivalRate).add(x.utilisation).add(x.failedTime).add(x.queuedAtWindowEnd).add(x.littleLawError);
    h.add(l.throughput.length).addAll(l.throughput).add(l.queueLength.length).addAll(l.queueLength);
  }
  h.add(m.peakHour.start).add(m.peakHour.end).add(m.peakHour.arrivals).add(m.peakHour.p95Wait);
  h.add(m.meanWait).add(m.p95Wait).add(m.shareInside.time).add(m.shareInside.share);
  h.add(m.stillOutsideAtStart === null ? NaN : m.stillOutsideAtStart);
  h.add(m.density.cols).add(m.density.rows).add(m.density.cellSize).addAll(m.density.mean).addAll(m.density.max);
  return h.digest();
}

/** Creates a pedestrian run of `scenario` on `venue`. All work that does not change over time (grid, flow fields, personal draws) happens here. */
export function createRun(venue: Venue, scenario: Scenario, options?: RunOptions): Run {
  return new PedestrianRun(venue, scenario, options);
}
