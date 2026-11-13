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
 * Groups (review E3): people arrive in groups of consecutive ids (sizes from groupSizes). A group
 * shares its leader's arrival time and source, walks at its slowest member's speed, and the first
 * member to decide at a stage picks the lane for the others (if it is still open and reachable).
 *
 * Checkpoints (review C1): saveCheckpoint() copies every piece of dynamic state into typed arrays;
 * restoreRun() rebuilds the static parts from the venue and scenario and continues bit-identically.
 *
 * Lane failure (timed laneFail): the lane finishes its current person and serves nobody else.
 * Its queue is reassigned in arrival order, each person to the open lane of the same element with
 * the lowest walk time + expected wait (or any element of the same stage set if all are failed),
 * keeping their wait clock running.
 *
 * Cars (Phase 3, vehicles.ts). If the venue has roads, a vehicle source and a parking lot, the first
 * round(carShare × attendance) people come by car: consecutive ids, one car per run of 1-4 people
 * (occupancy distribution). They are Pending while in the car (review A4); the VehicleWorld drives,
 * queues and parks the car, and carExitDelay seconds after it parks its occupants get out at the
 * stall, walk straight to the lot's walking exit (off the walking grid) and from there on are
 * pedestrians like any other (gates, or straight to a destination if the venue has no gates).
 * People and cars are counted separately: countsByState() for people, carCountsByState() for cars,
 * each summing to its own total at every tick. Barrier lanes live in the same LaneBank (ids after
 * the pedestrian lanes). The vehicle tick runs after pedestrian movement.
 *
 * Departures (spec 4.4), only if the scenario has a departure curve: each group (and each car's
 * occupants) draws a departure time. Whoever is inside by then leaves; whoever is not leaves as soon
 * as they get in. People on foot walk back to the source they came from and are Departed there
 * (they cross the gate lines without being scanned: the lanes are just points on the walking grid).
 * Car users walk to their lot's walking exit and straight on to their car; the driver first queues at
 * the lot's pay station if it has one and the lot's payment mode is payStation. Once everyone is
 * aboard (state Driving) the car leaves after carBoardDelay, drives to an exit barrier and off the
 * network; its occupants are then Departed.
 *
 * End of a run: everyone done (people Inside or TurnedAway and cars Parked or TurnedAway without
 * departures; people and cars Departed or TurnedAway with departures: `drained`), the horizon, or
 * the watchdog (D-023: people walking or queuing, or cars on the move, and nothing changed for
 * watchdogMinutes while nothing is scheduled: no gate opening, timed event or departure to come).
 */

import type {
  BagPolicy,
  DepartureMetrics,
  Distribution,
  ElementReport,
  LanePeriod,
  LaneReport,
  ParkingMetrics,
  RecordedMetrics,
  ResolvedParameters,
  Scenario,
  Venue,
  WaitStats,
} from "@bottleneck/schema";
import { AGENT_ARRAYS, AGENT_STATE_COUNT, AgentState as AgentStateEnum, AgentStore, Mode as ModeEnum, Stage as StageEnum } from "./agents.ts";
import { PiecewiseLinearCurve, resolveArrivalPoints, resolveDeparturePoints } from "./arrivals.ts";
import { DensityGrid } from "./density.ts";
import { exp } from "./detmath.ts";
import { sampleCategorical } from "./distributions.ts";
import { buildFlowField, type FlowField } from "./flowField.ts";
import { Float64Hasher } from "./hash.ts";
import { EventKind as EventKindEnum, LaneBank, percentileNearestRank, type LaneBankState, type ServiceRecord } from "./lanes.ts";
import { RandomStream as RandomStreamEnum, toSeed, uniform } from "./rng.ts";
import { SERVICE_TIME_PRESETS, makeSampler, type Sampler } from "./sampling.ts";
import { Simulation, TICK_SECONDS as TICK, type EventHandler } from "./simulation.ts";
import { toLocal } from "./geometry.ts";
import { buildVenueModel, type LaneElement, type LaneGeometry, type VenueModel } from "./venueModel.ts";
import { VEHICLE_DEFAULTS, VehicleWorld, defaultPayStationServiceTime, type BarrierLaneLive, type LotLive, type VehicleLayout, type VehicleState } from "./vehicles.ts";

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

/**
 * writeVehicleSnapshot() fills a Float32Array the same way for cars, one block of `vehicleCount`
 * values per field: x, y (venue metres, the centre of the car on its lane), vx, vy (m/s, for
 * extrapolation), hx, hy (unit heading: kept while stopped, pointing into the stall when parked),
 * state (an AgentState value; Pending, Departed and TurnedAway cars are not on the map).
 * Field f of car c: buffer[f·vehicleCount + c].
 */
export const VehicleSnapshotField = { X: 0, Y: 1, VX: 2, VY: 3, HX: 4, HY: 5, State: 6 } as const;
export const VEHICLE_SNAPSHOT_FIELDS = 7;

export function vehicleSnapshotLength(vehicleCount: number): number {
  return VEHICLE_SNAPSHOT_FIELDS * vehicleCount;
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

/**
 * Built-in defaults, all assumptions. A scenario's `parameters` override the first group (see
 * ScenarioParameters in /schema/scenario.schema.json); the rest are engine settings.
 */
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
  manualLaneServiceTime: { kind: "uniform", min: 20, max: 40 } as Distribution,
  /** Relative frequency of groups of 1, 2, 3, 4, 5 people (review E3). */
  groupSizes: [0.3, 0.4, 0.15, 0.1, 0.05],
  densitySigma: 0.7,
  /** Deadlock watchdog: stop if nothing changes for this many simulated minutes. */
  watchdogMinutes: 10,
  /** Queue lengths are sampled this often (s). */
  queueSampleInterval: 10,
  /** Throughput is counted per bin of this length (s). */
  throughputBin: 60,
  /** "Share inside by T": T is this many seconds before a fixed start (open door: after opening). */
  shareInsideLead: 600,
  /** Element utilisation is judged over windows of this many throughput bins (E1). */
  utilisationWindowBins: 5,
  /** "The crunch is over" once the element's windowed utilisation falls below this (E1). */
  reliefUtilisation: 0.85,
} as const;

/** Screening service times per bag policy (review E4; assumed values, see SERVICE_TIME_PRESETS). */
export const BAG_POLICY_SERVICE_TIME: Record<BagPolicy, Distribution> = {
  none: SERVICE_TIME_PRESETS.screeningNone,
  clearBag: SERVICE_TIME_PRESETS.screeningClearBag,
  fullSearch: SERVICE_TIME_PRESETS.screeningFullSearch,
};

export type { ResolvedParameters };

export interface RunOptions {
  /** Replaces RUN_DEFAULTS for this run (tests, experiments); the scenario's own parameters still win. */
  defaults?: Partial<{ decisionDistance: number; logitScale: number; slotSpacing: number; jockeyThreshold: number; watchdogMinutes: number; groupSizes: number[] }>;
}

// ---------------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------------

export interface LaneLayout {
  readonly laneId: number;
  readonly elementId: string;
  readonly elementKind: "screening" | "gate" | "payStation";
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

export type { LaneReport };

/** Everything a run reports (spec 4.5): the stored metrics (RecordedMetrics, /schema/run.schema.json) plus the resolved parameters. */
export interface RunMetrics extends RecordedMetrics {
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
  /** Every completed service attempt so far in time order, in engine seconds (a retry is one record per attempt). Not part of metricsHash. */
  serviceLog(): ServiceRecord[];
  /** The complete dynamic state, for restoreRun() (review C1: replay seeks restore the nearest checkpoint). */
  saveCheckpoint(): RunCheckpoint;
  /** Number of cars (0 if nobody comes by car). */
  readonly vehicleCount: number;
  /** Static drawing data for roads, aisles, lots, stalls, barriers and crossings; null without cars. */
  readonly vehicleLayout: VehicleLayout | null;
  /** Cars per AgentState (sums to vehicleCount). */
  carCountsByState(): number[];
  /** Car positions etc., layout VehicleSnapshotField (needs vehicleSnapshotLength(vehicleCount) floats). */
  writeVehicleSnapshot(out: Float32Array): void;
  /** Live state of every barrier lane. */
  barrierStates(): BarrierLaneLive[];
  /** Live state of every parking lot. */
  lotStates(): LotLive[];
  /** Internal state for tests and tools; not a stable API. */
  readonly debug: RunDebug;
}

export interface RunDebug {
  readonly model: VenueModel;
  readonly agents: AgentStore;
  readonly bank: LaneBank;
  readonly laneFailed: Uint8Array;
  readonly vehicles: VehicleWorld | null;
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
/** Demand (people choosing an element) is counted per minute; peak demand is the best 60 of them. */
const DEMAND_BIN = 60;

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
  /** Agents Walking, Queuing or InService (plus some that finished this tick), in id order. */
  private readonly active: Int32Array;
  private activeCount = 0;
  private activeStale = false;
  private readonly arrived: number[] = [];
  /** Per leader and stage (Entry, Gates): the lane the group chose, and the stage set it was chosen in. */
  private readonly groupLane: Int32Array;
  private readonly groupLaneSet: Int32Array;
  /** Per element: people choosing it per DEMAND_BIN seconds (first commitment at that stage). */
  private readonly demand: number[][];
  /** Per lane, aligned with the bank's waits(): wait from physically joining the line to service start. */
  private readonly queueWaits: number[][];
  // Settings
  private readonly decisionDistance: number;
  private readonly logitScale: number;
  private readonly nearestShare: number;
  private readonly jockeyThreshold: number;
  private readonly watchdog: number;
  private readonly sampleTicks: number;
  private readonly logitWeights: number[] = [];
  private readonly logitLanes: number[] = [];
  // Cars and departures (Phase 3)
  readonly vehicleCount: number;
  readonly vehicleLayout: VehicleLayout | null;
  private readonly world: VehicleWorld | null;
  private readonly pedLaneCount: number;
  private readonly carPeople: number;
  private readonly carFirst: Int32Array;
  private readonly carSize: Uint8Array;
  /** Walking exit of each lot as a point on the walking grid (local). */
  private readonly lotWalkX: Float64Array;
  private readonly lotWalkY: Float64Array;
  /** Flow fields for departures: back to each pedestrian source, and to each lot's walking exit. */
  private readonly homeFields: (FlowField | null)[];
  private readonly lotFields: (FlowField | null)[];
  private readonly departuresOn: boolean;
  private readonly eventEndAt: number;
  /** People with a finite departure time, by (time, id). */
  private readonly depOrder: Int32Array;
  private depPtr = 0;
  private firstDepartureAt = NaN;
  private lastDepartureAt = NaN;
  private carTurnedAwayPeople = 0;
  /** People who got out of a car, in the order they did (they are not in `order`). */
  private readonly released: number[] = [];
  private readonly crossingWait: boolean;

  constructor(venue: Venue, scenario: Scenario, options: RunOptions = {}) {
    // Precedence: the scenario's parameters, then options.defaults, then RUN_DEFAULTS.
    const d = { ...RUN_DEFAULTS, ...(options.defaults ?? {}), ...definedOnly(scenario.parameters ?? {}) };
    const params = scenario.parameters ?? {};
    const freeSpeed = params.freeWalkingSpeed ?? RUN_DEFAULTS.freeWalkingSpeed;
    this.nearestShare = params.nearestLaneShare ?? RUN_DEFAULTS.nearestLaneShare;
    const speedDensity = venue.parameters?.speedDensity ?? RUN_DEFAULTS.speedDensity;
    const manualLaneServiceTime = d.manualLaneServiceTime;
    const groupSizes = [...d.groupSizes];
    const bagPolicy = params.bagPolicy ?? null;
    this.decisionDistance = d.decisionDistance;
    this.logitScale = d.logitScale;
    this.jockeyThreshold = d.jockeyThreshold;
    this.watchdog = d.watchdogMinutes * 60;
    this.sampleTicks = Math.round(RUN_DEFAULTS.queueSampleInterval / TICK_SECONDS);
    this.seed = toSeed(scenario.seed);

    const cardShare = params.cardShare ?? VEHICLE_DEFAULTS.cardShare;
    this.model = buildVenueModel(venue, scenario, {
      slotSpacing: d.slotSpacing,
      manualServiceTime: manualLaneServiceTime,
      screeningServiceTime: bagPolicy === null ? null : BAG_POLICY_SERVICE_TIME[bagPolicy],
      payStationServiceTime: defaultPayStationServiceTime(cardShare),
    });
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
    // Cars (review A4): people 0 .. carPeople − 1, one car per run of consecutive ids, sized by the
    // occupancy distribution (drawn by the car's first occupant). Only on a venue that has roads,
    // a vehicle source and a parking lot; otherwise carShare is ignored and everyone walks.
    const vehicleVenue = (venue.parkingLots ?? []).length > 0 && (venue.roads ?? []).length > 0 && (venue.vehicleSources ?? []).some((s) => s.share > 0);
    const carShare = vehicleVenue ? Math.min(1, Math.max(0, scenario.carShare)) : 0;
    const carPeople = Math.min(attendance, Math.round(carShare * attendance));
    this.carPeople = carPeople;
    const occupancy = [...(params.occupancy ?? VEHICLE_DEFAULTS.occupancy)];
    const carFirst: number[] = [];
    const carSize: number[] = [];
    {
      let total = 0;
      for (const w of occupancy) total += w;
      let i = 0;
      while (i < carPeople) {
        const size = occupancy.length > 1 && total > 0 ? 1 + sampleCategorical(uniform(this.seed, RandomStream.CarOccupancy, i, 0), occupancy) : 1;
        const end = Math.min(carPeople, i + size);
        for (let j = i; j < end; j++) {
          agents.group[j] = i;
          agents.car[j] = carFirst.length;
        }
        carFirst.push(i);
        carSize.push(end - i);
        i = end;
      }
    }
    this.carFirst = Int32Array.from(carFirst);
    this.carSize = Uint8Array.from(carSize);
    const carArrival = new Float64Array(carFirst.length);
    // Groups (review E3): consecutive ids, within the attendance and within each bus burst.
    formGroups(agents.group, carPeople, attendance, groupSizes, this.seed);
    let earliest = Infinity;
    for (let c = 0; c < carFirst.length; c++) {
      carArrival[c] = curve.sample(uniform(this.seed, RandomStream.ArrivalTime, carFirst[c] as number, 0));
      if ((carArrival[c] as number) < earliest) earliest = carArrival[c] as number;
    }
    for (let i = 0; i < n; i++) {
      const leader = agents.group[i] as number;
      if (i < carPeople) {
        // In a car: they arrive when they get out of it (A4).
        agents.arrivalTime[i] = Infinity;
        agents.source[i] = -1;
      } else if (i < attendance) {
        if (leader === i) {
          agents.arrivalTime[i] = curve.sample(uniform(this.seed, RandomStream.ArrivalTime, i, 0));
          agents.source[i] = model.sourceShares.length > 0 ? sampleCategorical(uniform(this.seed, RandomStream.SourceChoice, i, 0), model.sourceShares) : -1;
        } else {
          // A group arrives together, at its leader's source.
          agents.arrivalTime[i] = agents.arrivalTime[leader] as number;
          agents.source[i] = agents.source[leader] as number;
        }
      }
      agents.freeSpeed[i] = speedSampler(i, 0);
      agents.offsetX[i] = (2 * uniform(this.seed, RandomStream.PathOffset, i, 0) - 1) * PATH_OFFSET;
      agents.offsetY[i] = (2 * uniform(this.seed, RandomStream.PathOffset, i, 1) - 1) * PATH_OFFSET;
    }
    let next = attendance;
    for (const b of bursts) {
      if (b.kind !== "busBurst") continue;
      const src = sourceIndex[b.sourceId] ?? -1;
      const count = Math.max(0, Math.floor(b.count));
      formGroups(agents.group, next, next + count, groupSizes, this.seed);
      for (let k = 0; k < count; k++, next++) {
        agents.arrivalTime[next] = b.at;
        agents.source[next] = src;
      }
    }
    // A group walks at the pace of its slowest member.
    for (let i = n - 1; i >= 0; i--) {
      const leader = agents.group[i] as number;
      if ((agents.freeSpeed[i] as number) < (agents.freeSpeed[leader] as number)) agents.freeSpeed[leader] = agents.freeSpeed[i] as number;
    }
    for (let i = 0; i < n; i++) agents.freeSpeed[i] = agents.freeSpeed[agents.group[i] as number] as number;
    this.active = new Int32Array(n);
    this.groupLane = new Int32Array(2 * n).fill(-1);
    this.groupLaneSet = new Int32Array(2 * n).fill(-1);
    for (let i = 0; i < n; i++) if ((agents.arrivalTime[i] as number) < earliest) earliest = agents.arrivalTime[i] as number;
    for (const e of scenario.timedEvents ?? []) if (e.at < earliest) earliest = e.at;

    // --- Clock ---
    const tl = scenario.timeline;
    this.timeOffset = earliest < tl.gatesOpen ? Math.floor(earliest / 60) * 60 - 60 : tl.gatesOpen;
    for (let i = 0; i < n; i++) agents.arrivalTime[i] = (agents.arrivalTime[i] as number) - this.timeOffset;
    for (let c = 0; c < carArrival.length; c++) carArrival[c] = (carArrival[c] as number) - this.timeOffset;
    this.horizon = tl.horizon - this.timeOffset;
    this.gatesOpenAt = tl.gatesOpen - this.timeOffset;
    this.eventStartAt = tl.eventStart === null ? null : tl.eventStart - this.timeOffset;
    const shareInsideAt = params.shareInsideAt ?? (tl.eventStart === null ? tl.gatesOpen + 3600 : tl.eventStart - RUN_DEFAULTS.shareInsideLead);

    // Arrival order: by (time, id). People in cars are not in it: they arrive when they get out.
    const order = Array.from({ length: n - carPeople }, (_, i) => i + carPeople);
    order.sort((a, b) => (agents.arrivalTime[a] as number) - (agents.arrivalTime[b] as number) || a - b);
    this.order = Int32Array.from(order);
    this.counts[AgentState.Pending] = n;

    // --- Departures (spec 4.4): one draw per group (a car's occupants are one group). ---
    this.departuresOn = scenario.departures !== undefined;
    this.eventEndAt = tl.eventEnd - this.timeOffset;
    let departureCurve: { t: number; weight: number }[] | null = null;
    if (scenario.departures !== undefined) {
      const dc = new PiecewiseLinearCurve(resolveDeparturePoints(scenario.departures, tl));
      departureCurve = dc.points.map((p) => ({ t: p.t, weight: p.weight }));
      for (let i = 0; i < n; i++) {
        const leader = agents.group[i] as number;
        agents.departTime[i] = leader === i ? dc.sample(uniform(this.seed, RandomStream.DepartureTime, i, 0)) - this.timeOffset : (agents.departTime[leader] as number);
      }
      const dep = Array.from({ length: n }, (_, i) => i);
      dep.sort((a, b) => (agents.departTime[a] as number) - (agents.departTime[b] as number) || a - b);
      this.depOrder = Int32Array.from(dep);
    } else this.depOrder = new Int32Array(0);

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
      { name: "vehicles", update: () => this.moveVehicles() },
      { name: "density", update: () => this.updateDensity() },
      { name: "metric sampling", update: () => this.sample() },
    ]);
    this.elementSamplers = model.elements.map((el) => makeSampler(el.serviceTime, this.seed, el.kind === "screening" ? RandomStream.ScreeningTime : el.kind === "payStation" ? RandomStream.PayTime : RandomStream.ScanTime));
    this.retrySamplers = model.elements.map((el) => (el.retryTime ? makeSampler(el.retryTime, this.seed, RandomStream.ScanRetryTime) : null));
    this.manualSampler = makeSampler(manualLaneServiceTime, this.seed, RandomStream.ManualServiceTime);

    // --- Cars (vehicles.ts): barrier lanes come after the pedestrian lanes in the one bank. ---
    this.pedLaneCount = model.lanes.length;
    const carLength = params.carLength ?? VEHICLE_DEFAULTS.carLength;
    const carGap = params.carGap ?? VEHICLE_DEFAULTS.carGap;
    const carExitDelay = params.carExitDelay ?? VEHICLE_DEFAULTS.carExitDelay;
    const carBoardDelay = params.carBoardDelay ?? VEHICLE_DEFAULTS.carBoardDelay;
    const aisleSpeed = params.aisleSpeed ?? VEHICLE_DEFAULTS.aisleSpeed;
    const parkManoeuvre = params.parkManoeuvre ?? VEHICLE_DEFAULTS.parkManoeuvre;
    this.world =
      carFirst.length > 0
        ? new VehicleWorld(
            venue,
            scenario,
            model.frame,
            { first: this.carFirst, size: this.carSize, arrival: carArrival },
            {
              seed: this.seed,
              carLength,
              carGap,
              exitDelay: carExitDelay,
              boardDelay: carBoardDelay,
              aisleSpeed: aisleSpeed / 3.6,
              approach: VEHICLE_DEFAULTS.barrierApproach,
              manoeuvre: parkManoeuvre,
              cardShare,
              departuresFrom: this.departuresOn ? this.eventEndAt : Infinity,
              tickSeconds: TICK_SECONDS,
              sampleTicks: this.sampleTicks,
              binSeconds: RUN_DEFAULTS.throughputBin,
              laneBase: model.lanes.length,
              payElements: model.payElements,
            },
          )
        : null;
    const world = this.world;
    this.vehicleCount = world?.carCount ?? 0;
    this.vehicleLayout = world?.layout ?? null;
    this.crossingWait = world !== null && world.crossings.length > 0;
    const pedLanes = model.lanes.length;
    this.bank = new LaneBank(
      this.sim,
      {
        serviceTime: (agent, lane) => (lane >= pedLanes ? (world as VehicleWorld).serviceTime(agent, lane) : this.serviceTime(agent, lane)),
        outcome: (agent, lane, attempt) => (lane >= pedLanes ? (world as VehicleWorld).outcome(agent, lane, attempt) : this.outcome(agent, lane, attempt)),
        onServiceStart: (agent, lane, time) => {
          if (lane < pedLanes) this.onServiceStart(agent, lane, time);
          else (world as VehicleWorld).onServiceStart(agent, lane, time);
        },
        onLeave: (agent, lane, time, served) => (lane >= pedLanes ? (world as VehicleWorld).onLeave(agent, lane, time) : this.onLeave(agent, lane, time, served)),
      },
      model.lanes.length + (world?.barrierLaneCount ?? 0),
      { binSeconds: RUN_DEFAULTS.throughputBin, splitAt: this.eventStartAt ?? Infinity },
    );
    if (world !== null) {
      world.attach(this.bank, {
        release: (car) => this.releaseCar(car),
        turnedAway: (car) => this.carTurnedAway(car),
        departed: (car) => this.carDeparted(car),
      });
    }
    // Walking exits on the grid, and the departure flow fields.
    const lots = venue.parkingLots ?? [];
    this.lotWalkX = new Float64Array(lots.length);
    this.lotWalkY = new Float64Array(lots.length);
    lots.forEach((l, li) => {
      const p = toLocal(model.frame, l.walkingExit);
      const cell = model.grid.isWalkableAt(p.x, p.y) ? model.grid.cellAt(p.x, p.y) : model.grid.nearestWalkable(p.x, p.y);
      this.lotWalkX[li] = cell >= 0 && !model.grid.isWalkableAt(p.x, p.y) ? model.grid.centreX(cell) : p.x;
      this.lotWalkY[li] = cell >= 0 && !model.grid.isWalkableAt(p.x, p.y) ? model.grid.centreY(cell) : p.y;
    });
    this.homeFields = venue.sources.map((_, si) => (this.departuresOn ? buildFlowField(model.grid, [model.grid.cellAt(model.sourceX[si] as number, model.sourceY[si] as number)]) : null));
    this.lotFields = lots.map((_, li) => (this.departuresOn && world !== null ? buildFlowField(model.grid, [model.grid.cellAt(this.lotWalkX[li] as number, this.lotWalkY[li] as number)]) : null));
    this.laneFailed = new Uint8Array(model.lanes.length);
    this.queueSeries = model.lanes.map(() => []);
    this.throughput = model.lanes.map(() => []);
    this.queueWaits = model.lanes.map(() => []);
    this.demand = model.elements.map(() => []);

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
      if (e.kind === "lotClose") {
        const li = (venue.parkingLots ?? []).findIndex((l) => l.id === e.lotId);
        if (li >= 0 && this.world !== null) this.addAction(e.at - this.timeOffset, () => (this.world as VehicleWorld).closeLot(li, this.sim.now));
        continue;
      }
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
      manualLaneServiceTime,
      densitySigma: RUN_DEFAULTS.densitySigma,
      watchdogMinutes: d.watchdogMinutes,
      queueSampleInterval: RUN_DEFAULTS.queueSampleInterval,
      throughputBin: RUN_DEFAULTS.throughputBin,
      shareInsideAt,
      groupSizes,
      bagPolicy,
      arrivalCurve: curve.points.map((p) => ({ t: p.t, weight: p.weight })),
      elements: model.elements.map((el) => ({
        id: el.id,
        kind: el.kind,
        laneCount: el.laneCount,
        queueLength: el.queueLength,
        serviceTime: el.serviceTime,
        scanFailureRate: el.scanFailureRate,
        retryTime: el.retryTime,
        meanBusyTime: el.meanService,
      })),
      departureCurve,
      vehicles:
        world === null
          ? null
          : {
              carShare,
              carPeople,
              occupancy,
              cardShare,
              carLength,
              carGap,
              carExitDelay,
              carBoardDelay,
              aisleSpeed,
              barrierApproach: VEHICLE_DEFAULTS.barrierApproach,
              parkManoeuvre,
              barriers: world.groups.map((g) => ({
                id: g.id,
                kind: g.kind,
                lotId: g.lot >= 0 ? (world.lots[g.lot] as { id: string }).id : null,
                laneCount: g.laneCount,
                serviceType: g.serviceType,
                serviceTime: g.serviceTime,
                misreadRate: g.misreadRate,
                fallbackTime: g.fallbackTime,
                meanBusyTime: g.meanBusy,
              })),
              lots: world.lots.map((l) => ({ id: l.id, stalls: l.stallCount, stallChoice: l.stallChoice, overflow: l.overflowRule, paymentMode: l.paymentMode, payStationId: l.payStationId })),
            },
    };
    this.debug = { model, agents, bank: this.bank, laneFailed: this.laneFailed, vehicles: world };
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
    const c = this.counts;
    // People are done when Inside (or Departed, if they leave) or TurnedAway; cars when Parked (or Departed) or TurnedAway.
    const finished = (this.departuresOn ? (c[AgentState.Departed] as number) : (c[AgentState.Inside] as number)) + (c[AgentState.TurnedAway] as number);
    const carsFinished = this.world === null ? 0 : this.world.finishedCount(this.departuresOn);
    if (finished === this.agentCount && carsFinished === this.vehicleCount) {
      this.isDone = true;
      this.isDrained = true;
    } else if (this.sim.now >= this.horizon) {
      this.isDone = true;
    } else {
      const active = (c[AgentState.Walking] as number) + (c[AgentState.Queuing] as number) + (c[AgentState.InService] as number) + (this.world === null ? 0 : this.world.activeCount());
      // Waiting for the gates to open, a scheduled timed event or departures still to come is not a deadlock.
      const waitingForTimeline = this.sim.now < this.gatesOpenAt || this.pendingActions > 0 || this.depPtr < this.depOrder.length;
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

  carCountsByState(): number[] {
    return this.world === null ? new Array<number>(AGENT_STATE_COUNT).fill(0) : Array.from(this.world.counts);
  }

  writeVehicleSnapshot(out: Float32Array): void {
    const n = this.vehicleCount;
    if (out.length < VEHICLE_SNAPSHOT_FIELDS * n) throw new RangeError(`Vehicle snapshot buffer needs ${VEHICLE_SNAPSHOT_FIELDS * n} floats, got ${out.length}`);
    this.world?.writeSnapshot(out, this.model.frame.originX, this.model.frame.originY);
  }

  barrierStates(): BarrierLaneLive[] {
    return this.world === null ? [] : this.world.barrierStates();
  }

  lotStates(): LotLive[] {
    return this.world === null ? [] : this.world.lotStates();
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
    if (s === AgentState.Inside || s === AgentState.TurnedAway) this.activeStale = true;
  }

  /**
   * Rebuilds the active list (agents Walking, Queuing or InService, in id order): drops agents that
   * have finished and merges in the ids in `added`. The tick systems iterate this list instead of
   * every agent; it is always in id order, so the results are the same as a loop over all agents.
   */
  private refreshActive(added: number[]): void {
    if (added.length === 0 && !this.activeStale) return;
    const a = this.agents;
    added.sort((x, y) => x - y);
    const old = this.active.slice(0, this.activeCount);
    let n = 0;
    let j = 0;
    for (let k = 0; k <= old.length; k++) {
      const i = k < old.length ? (old[k] as number) : Infinity;
      while (j < added.length && (added[j] as number) < i) this.active[n++] = added[j++] as number;
      if (k === old.length) break;
      const st = a.state[i] as number;
      if (st === AgentState.Walking || st === AgentState.Queuing || st === AgentState.InService) this.active[n++] = i;
    }
    this.activeCount = n;
    this.activeStale = false;
  }

  private commit(i: number, lane: number): void {
    const a = this.agents;
    a.lane[i] = lane;
    a.mode[i] = Mode.ToLine;
    a.ready[i] = 0;
    a.lineJoin[i] = NaN;
    const geom = this.model.lanes[lane] as LaneGeometry;
    // The venue-wide wait (meanWait, p95Wait) is about getting in; a pay-station wait is only in its lane's metrics.
    if (Number.isNaN(a.waitStart[i] as number) && a.stage[i] !== Stage.Leaving) a.waitStart[i] = this.sim.now;
    const stage = (a.stage[i] as number) + 1;
    if (!geom.manual && a.demandCounted[i] !== stage) {
      // First commitment at this stage: one person of demand for the element.
      a.demandCounted[i] = stage;
      const bin = Math.floor(this.sim.now / DEMAND_BIN);
      const series = this.demand[geom.element] as number[];
      while (series.length <= bin) series.push(0);
      series[bin] = (series[bin] as number) + 1;
    }
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
    if (!Number.isNaN(a.waitStart[agent] as number)) a.totalWait[agent] = (a.totalWait[agent] as number) + (time - (a.waitStart[agent] as number));
    a.waitStart[agent] = NaN;
    const join = a.lineJoin[agent] as number;
    (this.queueWaits[lane] as number[]).push(Number.isNaN(join) ? 0 : time - join);
    a.lineJoin[agent] = NaN;
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
    } else if (el.kind === "payStation") {
      // Paid: on to the car.
      this.toLot(agent);
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
    const added = this.arrived;
    added.length = 0;
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
      if (!m.hasEntryLanes) {
        // A venue without gates (a stand-alone car park): straight to a destination.
        a.stage[i] = Stage.Inside;
        a.mode[i] = Mode.ToDestination;
        if (m.destinationField.distanceAt(m.grid.cellAt(x, y)) === Infinity) {
          this.turnAway(i);
          continue;
        }
      } else {
        const set = m.stageSets[0];
        if (set === undefined || set.field.distanceAt(m.grid.cellAt(x, y)) === Infinity) {
          this.turnAway(i);
          continue;
        }
      }
      this.setState(i, AgentState.Walking);
      added.push(i);
    }
    // People getting out of their parked cars.
    if (this.world !== null) this.world.popReleases(now, (car) => this.releaseCar(car));
    // Departures due now: whoever is inside leaves; whoever is not yet inside leaves on arrival.
    if (this.departuresOn) {
      while (this.depPtr < this.depOrder.length) {
        const i = this.depOrder[this.depPtr] as number;
        if ((a.departTime[i] as number) > now) break;
        this.depPtr++;
        const st = a.state[i] as number;
        if (st === AgentState.Inside) this.startDeparture(i, added);
        else if (st !== AgentState.TurnedAway && st !== AgentState.Departed && st !== AgentState.Driving) a.departDue[i] = 1;
      }
    }
    this.refreshActive(added);
  }

  private turnAway(i: number): void {
    this.agents.mode[i] = Mode.Done;
    this.unreachable++;
    this.setState(i, AgentState.TurnedAway);
    const car = this.agents.car[i] as number;
    if (car >= 0 && this.world !== null) this.world.occupantLost(car);
  }

  // --- Cars and departures (Phase 3) ---

  /** A pedestrian (just out of a car, or arrived on foot) starts on the walking grid at its current position. */
  private enterOnFoot(i: number): void {
    const a = this.agents;
    const m = this.model;
    a.stage[i] = Stage.Entry;
    a.stageSet[i] = 0;
    const cell = m.grid.cellAt(a.x[i] as number, a.y[i] as number);
    if (m.hasEntryLanes) {
      a.mode[i] = Mode.Approach;
      if ((m.stageSets[0] as { field: FlowField }).field.distanceAt(cell) === Infinity) this.turnAway(i);
    } else {
      // A venue without gates (a stand-alone car park): straight to a destination.
      a.stage[i] = Stage.Inside;
      a.mode[i] = Mode.ToDestination;
      if (m.destinationField.distanceAt(cell) === Infinity) this.turnAway(i);
    }
  }

  /** Hook: a car parked carExitDelay seconds ago; its occupants get out at the stall. */
  private releaseCar(car: number): void {
    const a = this.agents;
    const world = this.world as VehicleWorld;
    const lot = world.lotOfCar(car);
    const stall = world.stallPosition(car);
    const first = this.carFirst[car] as number;
    const now = this.sim.now;
    for (let i = first; i < first + (this.carSize[car] as number); i++) {
      if (a.state[i] !== AgentState.Pending) continue;
      a.x[i] = stall.x;
      a.y[i] = stall.y;
      a.vx[i] = 0;
      a.vy[i] = 0;
      a.tx[i] = this.lotWalkX[lot] as number;
      a.ty[i] = this.lotWalkY[lot] as number;
      a.mode[i] = Mode.ExitCar;
      a.stage[i] = Stage.Entry;
      a.arrivalTime[i] = now;
      this.released.push(i);
      this.arrived.push(i);
      this.setState(i, AgentState.Walking);
    }
  }

  /** Hook: a car was turned away; its occupants never arrive. */
  private carTurnedAway(car: number): void {
    const a = this.agents;
    const first = this.carFirst[car] as number;
    for (let i = first; i < first + (this.carSize[car] as number); i++) {
      if (a.state[i] !== AgentState.Pending) continue;
      a.mode[i] = Mode.Done;
      this.carTurnedAwayPeople++;
      this.setState(i, AgentState.TurnedAway);
    }
  }

  /** Hook: a car drove off the network with its occupants aboard. */
  private carDeparted(car: number): void {
    const a = this.agents;
    const first = this.carFirst[car] as number;
    for (let i = first; i < first + (this.carSize[car] as number); i++) {
      if (a.state[i] !== AgentState.Driving) continue;
      this.departed(i);
    }
  }

  private departed(i: number): void {
    const now = this.sim.now;
    this.agents.mode[i] = Mode.Done;
    if (Number.isNaN(this.firstDepartureAt)) this.firstDepartureAt = now;
    this.lastDepartureAt = now;
    this.setState(i, AgentState.Departed);
  }

  /**
   * Person i leaves (spec 4.4): on foot back to their source; by car to the lot's walking exit and
   * the car, the driver (the car's first occupant) via the pay station if the lot has one and pays there.
   * `added` collects agents that become active (null if i is already active).
   */
  private startDeparture(i: number, added: number[] | null): void {
    const a = this.agents;
    const m = this.model;
    a.departDue[i] = 0;
    a.stage[i] = Stage.Leaving;
    a.lane[i] = -1;
    const cell = m.grid.cellAt(a.x[i] as number, a.y[i] as number);
    const car = a.car[i] as number;
    if (car < 0) {
      const src = a.source[i] as number;
      const field = src >= 0 ? this.homeFields[src] : null;
      if (field === null || field === undefined || field.distanceAt(cell) === Infinity) {
        // Nowhere to walk back to on the grid: they leave from where they are.
        this.departed(i);
        return;
      }
      a.mode[i] = Mode.ToHome;
    } else {
      const world = this.world as VehicleWorld;
      const lot = world.lots[world.lotOfCar(car)];
      const el = lot !== undefined && lot.paymentMode === "payStation" ? lot.payElement : -1;
      const paySet = el >= 0 ? (m.elements[el] as LaneElement).paySet : -1;
      const payField = paySet >= 0 ? (m.stageSets[paySet] as { field: FlowField }).field : null;
      if (i === this.carFirst[car] && payField !== null && payField.distanceAt(cell) !== Infinity) {
        a.stageSet[i] = paySet;
        a.mode[i] = Mode.Approach;
      } else this.toLot(i);
    }
    this.setState(i, AgentState.Walking);
    if (added !== null) added.push(i);
  }

  /** Walk to the car's lot: along the grid to the walking exit, then straight to the car. */
  private toLot(i: number): void {
    const a = this.agents;
    const car = a.car[i] as number;
    const world = this.world as VehicleWorld;
    const lot = world.lotOfCar(car);
    const field = this.lotFields[lot] ?? null;
    a.stage[i] = Stage.Leaving;
    if (field !== null && field.distanceAt(this.model.grid.cellAt(a.x[i] as number, a.y[i] as number)) !== Infinity) a.mode[i] = Mode.ToLot;
    else this.toCar(i);
  }

  private toCar(i: number): void {
    const a = this.agents;
    const stall = (this.world as VehicleWorld).stallPosition(a.car[i] as number);
    a.tx[i] = stall.x;
    a.ty[i] = stall.y;
    a.mode[i] = Mode.ToCar;
  }

  /** The vehicle tick, after pedestrian movement. */
  private moveVehicles(): void {
    if (this.world !== null && this.world.step(this.sim.now, this.sim.tick)) this.lastProgress = this.sim.now;
  }

  /** True if a step from (x0, y0) to (x1, y1) walks onto a crossing that a stopped car stands across. */
  private waitsAtCrossing(x0: number, y0: number, x1: number, y1: number): boolean {
    const w = this.world as VehicleWorld;
    for (let c = 0; c < w.crossings.length; c++) {
      if (w.crossingBlocked[c] === 0) continue;
      const cr = w.crossings[c] as { ax: number; ay: number; bx: number; by: number; half: number };
      if (segmentDistance(x1, y1, cr.ax, cr.ay, cr.bx, cr.by) <= cr.half && segmentDistance(x0, y0, cr.ax, cr.ay, cr.bx, cr.by) > cr.half) return true;
    }
    return false;
  }

  /** 2. Lane decisions, jockeying, and the FIFO positions used by movement. */
  private assignLanes(): void {
    const a = this.agents;
    const grid = this.model.grid;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k] as number;
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
    // A group chooses together: follow the lane a member already chose at this stage, if usable.
    const slot = 2 * (a.group[i] as number) + Math.min(1, a.stage[i] as number);
    const shared = this.groupLane[slot] as number;
    if (shared >= 0 && this.groupLaneSet[slot] === a.stageSet[i] && this.laneFailed[shared] === 0 && (m.lanes[shared] as LaneGeometry).field.distanceAt(cell) !== Infinity) {
      this.commit(i, shared);
      return;
    }
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
    this.groupLane[slot] = choice;
    this.groupLaneSet[slot] = a.stageSet[i] as number;
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
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k] as number;
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
          if (a.departDue[i] === 1) this.startDeparture(i, null);
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
            if (Number.isNaN(a.lineJoin[i] as number)) a.lineJoin[i] = this.sim.now;
            this.lastProgress = this.sim.now;
          }
        } else {
          // Spilled back: stand in the walkable area behind the queue area, roughly in rows.
          const stopAt = ARRIVE_AT_LINE + this.parameters.slotSpacing * (1 + Math.floor((pos - geom.capacity) / geom.perRow));
          if (dist > stopAt) this.follow(i, geom.field, v0 * factor);
          else {
            this.still(i);
            // Standing in the spill-back behind the queue area: physically in the line.
            if (Number.isNaN(a.lineJoin[i] as number)) a.lineJoin[i] = this.sim.now;
          }
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
      } else if (mode === Mode.ExitCar || mode === Mode.ToCar) {
        // Inside the lot, off the walking grid: a straight walk at free speed.
        walkedSomewhere = true;
        if (this.straightOffGrid(i, a.tx[i] as number, a.ty[i] as number, v0)) {
          if (mode === Mode.ExitCar) this.enterOnFoot(i);
          else {
            const car = a.car[i] as number;
            a.mode[i] = Mode.Done;
            this.setState(i, AgentState.Driving);
            (this.world as VehicleWorld).board(car, this.sim.now);
          }
        }
      } else if (mode === Mode.ToHome || mode === Mode.ToLot) {
        const field = mode === Mode.ToHome ? (this.homeFields[a.source[i] as number] as FlowField) : (this.lotFields[(this.world as VehicleWorld).lotOfCar(a.car[i] as number)] as FlowField);
        const factor = dens.speedFactor[dens.cellAt(x0, y0)] as number;
        if (this.follow(i, field, v0 * factor)) walkedSomewhere = true;
        if (field.distanceAt(grid.cellAt(a.x[i] as number, a.y[i] as number)) === 0) {
          if (mode === Mode.ToHome) this.departed(i);
          else this.toCar(i);
        }
      } else {
        this.still(i);
      }
    }
    if (walkedSomewhere) this.lastProgress = this.sim.now;
    if (this.crossingWait) this.countOnCrossings();
  }

  /** Marks the crossings with a pedestrian on them (cars stop for them in the vehicle tick). */
  private countOnCrossings(): void {
    const a = this.agents;
    const w = this.world as VehicleWorld;
    w.pedOnCrossing.fill(0);
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k] as number;
      const st = a.state[i] as number;
      const mode = a.mode[i] as number;
      if ((st !== AgentState.Walking && st !== AgentState.Queuing) || mode === Mode.ExitCar || mode === Mode.ToCar) continue;
      for (let c = 0; c < w.crossings.length; c++) {
        const cr = w.crossings[c] as { ax: number; ay: number; bx: number; by: number; half: number };
        if (segmentDistance(a.x[i] as number, a.y[i] as number, cr.ax, cr.ay, cr.bx, cr.by) <= cr.half) w.pedOnCrossing[c] = 1;
      }
    }
  }

  /** Straight move ignoring the walking grid (inside a parking lot); true once the target is reached. */
  private straightOffGrid(i: number, tx: number, ty: number, speed: number): boolean {
    const a = this.agents;
    const x = a.x[i] as number;
    const y = a.y[i] as number;
    const dx = tx - x;
    const dy = ty - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const step = speed * TICK_SECONDS;
    const nx = step >= len ? tx : x + (dx * step) / len;
    const ny = step >= len ? ty : y + (dy * step) / len;
    a.vx[i] = (nx - x) / TICK_SECONDS;
    a.vy[i] = (ny - y) / TICK_SECONDS;
    a.x[i] = nx;
    a.y[i] = ny;
    return step >= len;
  }

  private still(i: number): void {
    this.agents.vx[i] = 0;
    this.agents.vy[i] = 0;
  }

  /** Moves agent i to (nx, ny) if that point is walkable; reports success. */
  private tryMove(i: number, nx: number, ny: number): boolean {
    if (!this.model.grid.isWalkableAt(nx, ny)) return false;
    const a = this.agents;
    if (this.crossingWait && this.waitsAtCrossing(a.x[i] as number, a.y[i] as number, nx, ny)) return false;
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
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k] as number;
      const s = a.state[i] as number;
      // People walking inside a parking lot are off the walking grid and not counted.
      if ((s === AgentState.Walking || s === AgentState.Queuing || s === AgentState.InService) && a.mode[i] !== Mode.ExitCar && a.mode[i] !== Mode.ToCar) g.add(a.x[i] as number, a.y[i] as number);
    }
    g.finish();
  }

  /** 5. Metric sampling. */
  private sample(): void {
    // Only active cells can be non-zero; adding 0 elsewhere would change nothing.
    const g = this.densityGrid;
    const d = g.density;
    const active = g.active;
    for (let k = 0; k < g.activeCount; k++) {
      const c = active[k] as number;
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
    const split = this.eventStartAt;
    const lanes: LaneReport[] = this.model.lanes.map((l) => {
      const el = this.model.elements[l.element] as LaneElement;
      const raw = this.bank.metrics(l.id);
      const preOpen = Math.min(Math.max(0, this.gatesOpenAt - raw.windowStart), raw.windowEnd - raw.windowStart);
      const waits = this.bank.waits(l.id);
      const starts = this.bank.starts(l.id);
      const queueWaits = this.queueWaits[l.id] as number[];
      const period = (side: "before" | "after"): LanePeriod => {
        const w: number[] = [];
        const q: number[] = [];
        for (let k = 0; k < waits.length; k++) {
          if (((starts[k] as number) < (split as number)) === (side === "before")) {
            w.push(waits[k] as number);
            q.push(queueWaits[k] as number);
          }
        }
        const ws = waitStats(w);
        return { started: ws.count, meanWait: ws.mean, p95Wait: ws.p95, maxWait: ws.max, queueWait: waitStats(q), utilisation: this.bank.periodUtilisation(l.id, side) };
      };
      return {
        laneId: l.id,
        elementId: el.id,
        elementKind: el.kind,
        laneIndex: l.laneIndex,
        manual: l.manual,
        laneType: l.manual ? "manual" : "regular",
        metrics: { ...raw, failedTime: Math.max(0, raw.failedTime - preOpen) },
        queueWait: waitStats(queueWaits),
        beforeStart: split === null ? null : period("before"),
        afterStart: split === null ? null : period("after"),
        throughput: [...(this.throughput[l.id] as number[])],
        queueLength: [...(this.queueSeries[l.id] as number[])],
      };
    });
    const elements = this.model.elements.map((el) => this.elementReport(el));

    // Agents that have arrived, in arrival order (people out of cars arrive when they get out).
    const arrived: number[] = [];
    for (let k = 0; k < this.nextArrival; k++) arrived.push(this.order[k] as number);
    if (this.released.length > 0) {
      for (const i of this.released) arrived.push(i);
      arrived.sort((x, y) => (a.arrivalTime[x] as number) - (a.arrivalTime[y] as number) || x - y);
    }
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
    let outsideArrived = 0;
    for (let i = 0; i < this.agentCount; i++) {
      if ((a.insideTime[i] as number) <= shareAt) insideBy++;
      const gs = a.gateStart[i] as number;
      if (this.eventStartAt !== null && (Number.isNaN(gs) || gs > this.eventStartAt)) {
        outside++;
        if ((a.arrivalTime[i] as number) <= this.eventStartAt) outsideArrived++;
      }
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
      elements,
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
      arrivedButOutsideAtStart: this.eventStartAt === null ? null : outsideArrived,
      notYetArrivedAtStart: this.eventStartAt === null ? null : outside - outsideArrived,
      density: {
        cols: this.densityGrid.cols,
        rows: this.densityGrid.rows,
        cellSize: this.densityGrid.cellSize,
        mean: Array.from(this.densitySum, (v) => v / dt),
        max: Array.from(this.densityMax),
      },
      departures: this.departureMetrics(),
      parking: this.parkingMetrics(),
      parameters: this.parameters,
    };
  }

  private departureMetrics(): DepartureMetrics | null {
    if (!this.departuresOn) return null;
    const scenarioTime = (t: number) => (Number.isNaN(t) ? null : t + this.timeOffset);
    return {
      departedPeople: this.counts[AgentState.Departed] as number,
      departedCars: this.world === null ? 0 : (this.world.counts[AgentState.Departed] as number),
      firstDepartureAt: scenarioTime(this.firstDepartureAt),
      lastDepartureAt: scenarioTime(this.lastDepartureAt),
    };
  }

  /** Spec 4.5 Parking, from the vehicle world (times converted to scenario time). */
  private parkingMetrics(): ParkingMetrics | null {
    const w = this.world;
    if (w === null) return null;
    const r = w.report();
    const toScenario = (t: number) => (Number.isNaN(t) ? null : t + this.timeOffset);
    const eventEnd = this.eventEndAt + this.timeOffset;
    return {
      carCount: w.carCount,
      carCountsByState: Array.from(w.counts),
      carPeople: this.carPeople,
      turnedAwayCars: r.turnedAwayCars,
      divertedCars: r.divertedCars,
      turnedAwayPeople: this.carTurnedAwayPeople,
      maxSourceBacklog: r.maxBacklog,
      lots: w.lots.map((l, li) => {
        const st = (r.lots[li] as { state: Record<string, number>; occupancy: number[] }).state;
        const occupancy = (r.lots[li] as { occupancy: number[] }).occupancy;
        const emptyAt = toScenario(st.emptyAt as number);
        return {
          lotId: l.id,
          stalls: l.stallCount,
          parked: st.parked as number,
          maxOccupancy: st.maxOccupancy as number,
          occupancy,
          meanSearchTime: (st.parked as number) > 0 ? (st.searchSum as number) / (st.parked as number) : 0,
          turnedAway: st.turnedAway as number,
          divertedAway: st.divertedAway as number,
          divertedIn: st.divertedIn as number,
          closedAt: toScenario(st.closedAt as number),
          emptyAt,
          timeToEmpty: emptyAt === null ? null : emptyAt - eventEnd,
        };
      }),
      barriers: w.groups.map((g, gi) => {
        const q = r.queues[gi] as Record<string, number>;
        return {
          barrierId: g.id,
          kind: g.kind,
          lotId: g.lot >= 0 ? (w.lots[g.lot] as { id: string }).id : null,
          maxQueueCars: q.maxCars as number,
          maxQueueMetres: q.maxMetres as number,
          maxQueueAt: toScenario(q.maxAt as number),
          meanQueueMetres: (q.lastAt as number) > (q.firstAt as number) ? ((q.sumAtLast as number) - (q.sumAtFirst as number)) / ((q.lastAt as number) - (q.firstAt as number)) : 0,
          reachedPublicRoadAt: toScenario(q.reachedAt as number),
        };
      }),
      barrierLanes: r.laneGroup.map((gi, k) => {
        const g = w.groups[gi] as { id: string; kind: "entry" | "exit" };
        const laneId = this.pedLaneCount + k;
        return {
          laneId,
          barrierId: g.id,
          kind: g.kind,
          laneIndex: r.laneIndexInGroup[k] as number,
          metrics: this.bank.metrics(laneId),
          throughput: [...(r.laneThroughput[k] as number[])],
          queueLength: [...(r.laneQueueSeries[k] as number[])],
        };
      }),
    };
  }

  /**
   * Capacity against demand for one element (review E1). Capacity = regular lanes × 3600 / mean busy
   * time per person. Demand = people choosing the element per minute; its peak is the busiest
   * 60 minutes. Utilisation per throughput bin = busy / open time of the regular lanes; the peak and
   * "below 85%" use windows of utilisationWindowBins bins, so a single quiet minute does not count.
   */
  private elementReport(el: LaneElement): ElementReport {
    const bin = RUN_DEFAULTS.throughputBin;
    const busy: number[] = [];
    const open: number[] = [];
    for (const l of el.laneIds) {
      const b = this.bank.bins(l);
      for (let k = 0; k < b.busy.length; k++) busy[k] = (busy[k] ?? 0) + (b.busy[k] as number);
      for (let k = 0; k < b.open.length; k++) open[k] = (open[k] ?? 0) + (b.open[k] as number);
    }
    const bins = Math.max(busy.length, open.length);
    const utilisation: number[] = [];
    for (let k = 0; k < bins; k++) utilisation.push((open[k] ?? 0) > 0 ? (busy[k] ?? 0) / (open[k] as number) : 0);
    const w = RUN_DEFAULTS.utilisationWindowBins;
    const windowed: number[] = [];
    for (let k = 0; k < bins; k++) {
      let b = 0;
      let o = 0;
      for (let j = Math.max(0, k - w + 1); j <= k; j++) {
        b += busy[j] ?? 0;
        o += open[j] ?? 0;
      }
      windowed.push(o > 0 ? b / o : 0);
    }
    let peakK = -1;
    let peak = 0;
    for (let k = 0; k < bins; k++) {
      if ((windowed[k] as number) > peak) {
        peak = windowed[k] as number;
        peakK = k;
      }
    }
    let below = -1;
    if (peak >= RUN_DEFAULTS.reliefUtilisation) {
      for (let k = peakK + 1; k < bins; k++) {
        if ((windowed[k] as number) < RUN_DEFAULTS.reliefUtilisation) {
          below = k;
          break;
        }
      }
    }
    // Peak demand: the busiest 60 one-minute bins (earliest wins).
    const demand = this.demand[el.index] as number[];
    const span = Math.round(3600 / DEMAND_BIN);
    let peakDemand = 0;
    let peakDemandBin = -1;
    let sum = 0;
    for (let k = 0; k < demand.length; k++) {
      sum += demand[k] as number;
      if (k >= span) sum -= demand[k - span] as number;
      if (sum > peakDemand) {
        peakDemand = sum;
        peakDemandBin = Math.max(0, k - span + 1);
      }
    }
    const capacity = el.meanService > 0 ? (el.laneCount * 3600) / el.meanService : 0;
    return {
      elementId: el.id,
      kind: el.kind,
      laneCount: el.laneCount,
      meanBusyTime: el.meanService,
      capacityPerHour: capacity,
      peakDemandPerHour: peakDemand,
      peakDemandStart: peakDemandBin < 0 ? null : peakDemandBin * DEMAND_BIN + this.timeOffset,
      utilisation,
      peakUtilisation: peak,
      peakUtilisationAt: peakK < 0 ? null : (peakK + 1) * bin + this.timeOffset,
      below85At: below < 0 ? null : (below + 1) * bin + this.timeOffset,
    };
  }

  /**
   * Hash of the metrics over a fixed order (decision D-006). Booleans are 1/0, null is NaN.
   *   agentCount, drained, deadlock, time, unreachable, countsByState[0..9],
   *   for each lane in id order: laneIndex, manual, then LaneMetrics in the order
   *     arrivals, started, served, windowStart, windowEnd, meanWait, p95Wait, maxWait, meanQueue,
   *     maxQueue, arrivalRate, utilisation, failedTime, queuedAtWindowEnd, littleLawError,
   *   then throughput.length and its values, queueLength.length and its values,
   *   queueWait (count, mean, p95, max), then beforeStart and afterStart: NaN if null, else
   *     started, meanWait, p95Wait, maxWait, queueWait (count, mean, p95, max), utilisation;
   *   for each element in model order: laneCount, meanBusyTime, capacityPerHour,
   *     peakDemandPerHour, peakDemandStart, utilisation.length and its values, peakUtilisation,
   *     peakUtilisationAt, below85At;
   *   peakHour start, end, arrivals, p95Wait; meanWait, p95Wait; shareInside time, share;
   *   stillOutsideAtStart, arrivedButOutsideAtStart, notYetArrivedAtStart;
   *   density cols, rows, cellSize, every mean value, every max value;
   *   then, only if departures is not null: departedPeople, departedCars, firstDepartureAt,
   *     lastDepartureAt;
   *   then, only if parking is not null: carCount, carCountsByState[0..9], carPeople,
   *     turnedAwayCars, divertedCars, turnedAwayPeople, maxSourceBacklog; for each lot in venue
   *     order: stalls, parked, maxOccupancy, occupancy.length and its values, meanSearchTime,
   *     turnedAway, divertedAway, divertedIn, closedAt, emptyAt, timeToEmpty; for each barrier in
   *     venue order: maxQueueCars, maxQueueMetres, maxQueueAt, meanQueueMetres, reachedPublicRoadAt;
   *     for each barrier lane in lane id order: laneIndex, the 15 LaneMetrics values (as for
   *     pedestrian lanes), throughput.length and its values, queueLength.length and its values.
   * A run without cars and without departures therefore hashes exactly the numbers it did before
   * Phase 3. The parameters are not hashed: they are inputs, stored alongside.
   */
  metricsHash(): string {
    return hashMetrics(this.metrics());
  }

  serviceLog(): ServiceRecord[] {
    return this.bank.serviceLog();
  }

  // --- Checkpoints (review C1) ---

  saveCheckpoint(): RunCheckpoint {
    const sim = this.sim.saveState();
    const events = sim.events;
    const agents: Record<string, Float64Array | Int32Array | Uint8Array> = {};
    for (const name of AGENT_ARRAYS) agents[name] = this.agents[name].slice();
    return {
      version: 1,
      seed: this.seed,
      agentCount: this.agentCount,
      laneCount: this.model.lanes.length,
      time: sim.now,
      scalars: Float64Array.from([
        sim.ticks,
        sim.now,
        sim.nextSeq,
        this.nextArrival,
        this.gatesAreOpen ? 1 : 0,
        this.pendingActions,
        this.densityTime,
        this.lastProgress,
        this.unreachable,
        this.isDone ? 1 : 0,
        this.isDrained ? 1 : 0,
        this.isDeadlock ? 1 : 0,
        this.depPtr,
        this.firstDepartureAt,
        this.lastDepartureAt,
        this.carTurnedAwayPeople,
      ]),
      counts: this.counts.slice(),
      laneFailed: this.laneFailed.slice(),
      agents,
      groupLane: this.groupLane.slice(),
      groupLaneSet: this.groupLaneSet.slice(),
      events: {
        time: Float64Array.from(events, (e) => e.time),
        kind: Int32Array.from(events, (e) => e.kind),
        id: Int32Array.from(events, (e) => e.id),
        seq: Float64Array.from(events, (e) => e.seq),
        payload: Float64Array.from(events, (e) => e.payload),
      },
      lanes: this.bank.save(),
      queueSeries: packSeries(this.queueSeries),
      throughput: packSeries(this.throughput),
      queueWaits: packSeries(this.queueWaits),
      demand: packSeries(this.demand),
      densitySum: this.densitySum.slice(),
      densityMax: this.densityMax.slice(),
      released: Int32Array.from(this.released),
      vehicles: this.world === null ? null : this.world.save(),
    };
  }

  /** Overwrites this freshly created run's state with a checkpoint taken from a run of the same venue and scenario. */
  restore(cp: RunCheckpoint): void {
    if (cp.version !== 1 || cp.seed !== this.seed || cp.agentCount !== this.agentCount || cp.laneCount !== this.model.lanes.length) {
      throw new RangeError("The checkpoint was taken from a different venue or scenario");
    }
    const sc = cp.scalars;
    const events = [];
    for (let k = 0; k < cp.events.time.length; k++) {
      events.push({ time: cp.events.time[k] as number, kind: cp.events.kind[k] as number, id: cp.events.id[k] as number, seq: cp.events.seq[k] as number, payload: cp.events.payload[k] as number });
    }
    this.sim.restoreState({ ticks: sc[0] as number, now: sc[1] as number, nextSeq: sc[2] as number, events });
    this.nextArrival = sc[3] as number;
    this.gatesAreOpen = sc[4] === 1;
    this.pendingActions = sc[5] as number;
    this.densityTime = sc[6] as number;
    this.lastProgress = sc[7] as number;
    this.unreachable = sc[8] as number;
    this.isDone = sc[9] === 1;
    this.isDrained = sc[10] === 1;
    this.isDeadlock = sc[11] === 1;
    this.depPtr = sc[12] as number;
    this.firstDepartureAt = sc[13] as number;
    this.lastDepartureAt = sc[14] as number;
    this.carTurnedAwayPeople = sc[15] as number;
    this.released.length = 0;
    for (const i of cp.released) this.released.push(i);
    if (this.world !== null) {
      if (cp.vehicles === null) throw new RangeError("The checkpoint has no vehicle state");
      this.world.restore(cp.vehicles);
    }
    this.counts.set(cp.counts);
    this.laneFailed.set(cp.laneFailed);
    for (const name of AGENT_ARRAYS) {
      const src = cp.agents[name];
      if (src === undefined) throw new RangeError(`The checkpoint has no agent array "${name}"`);
      (this.agents[name] as Float64Array).set(src as Float64Array);
    }
    this.groupLane.set(cp.groupLane);
    this.groupLaneSet.set(cp.groupLaneSet);
    this.bank.restore(cp.lanes);
    unpackSeries(cp.queueSeries, this.queueSeries);
    unpackSeries(cp.throughput, this.throughput);
    unpackSeries(cp.queueWaits, this.queueWaits);
    unpackSeries(cp.demand, this.demand);
    this.densitySum.set(cp.densitySum);
    this.densityMax.set(cp.densityMax);
    this.activeCount = 0;
    this.activeStale = false;
    const added: number[] = [];
    for (let i = 0; i < this.agentCount; i++) {
      const st = this.agents.state[i] as number;
      if (st === AgentState.Walking || st === AgentState.Queuing || st === AgentState.InService) added.push(i);
    }
    this.refreshActive(added);
    // The density grid is a pure function of the positions at the end of the last tick.
    this.updateDensity();
  }
}

/**
 * A run's complete dynamic state at a tick boundary, as a plain object of typed arrays (cheap to
 * structured-clone or transfer from a Web Worker). Everything static (grid, flow fields, personal
 * draws) is rebuilt from the venue and scenario by restoreRun().
 */
export interface RunCheckpoint {
  readonly version: 1;
  readonly seed: number;
  readonly agentCount: number;
  readonly laneCount: number;
  /** Engine time of the checkpoint (seconds from the start of the run). */
  readonly time: number;
  /** ticks, now, nextSeq, nextArrival, gatesAreOpen, pendingActions, densityTime, lastProgress, unreachable, done, drained, deadlock, depPtr, firstDepartureAt, lastDepartureAt, carTurnedAwayPeople. */
  readonly scalars: Float64Array;
  readonly counts: Int32Array;
  readonly laneFailed: Uint8Array;
  /** Every AgentStore array by name (AGENT_ARRAYS). */
  readonly agents: Readonly<Record<string, Float64Array | Int32Array | Uint8Array>>;
  readonly groupLane: Int32Array;
  readonly groupLaneSet: Int32Array;
  /** The event queue in heap order. */
  readonly events: { time: Float64Array; kind: Int32Array; id: Int32Array; seq: Float64Array; payload: Float64Array };
  readonly lanes: LaneBankState;
  readonly queueSeries: PackedSeries;
  readonly throughput: PackedSeries;
  readonly queueWaits: PackedSeries;
  readonly demand: PackedSeries;
  readonly densitySum: Float64Array;
  readonly densityMax: Float64Array;
  /** People who got out of cars, in order. */
  readonly released: Int32Array;
  /** The vehicle world's state, null for a run without cars. */
  readonly vehicles: VehicleState | null;
}

/** Lists of numbers concatenated: list k is data[offsets[k] .. offsets[k + 1]). */
export interface PackedSeries {
  readonly data: Float64Array;
  readonly offsets: Int32Array;
}

function packSeries(lists: readonly (readonly number[])[]): PackedSeries {
  const offsets = new Int32Array(lists.length + 1);
  for (let k = 0; k < lists.length; k++) offsets[k + 1] = (offsets[k] as number) + (lists[k] as readonly number[]).length;
  const data = new Float64Array(offsets[lists.length] as number);
  for (let k = 0; k < lists.length; k++) data.set(lists[k] as readonly number[], offsets[k] as number);
  return { data, offsets };
}

function unpackSeries(p: PackedSeries, into: number[][]): void {
  if (p.offsets.length !== into.length + 1) throw new RangeError("The checkpoint does not match this run");
  for (let k = 0; k < into.length; k++) {
    const list = into[k] as number[];
    list.length = 0;
    for (let i = p.offsets[k] as number; i < (p.offsets[k + 1] as number); i++) list.push(p.data[i] as number);
  }
}

/** Count, mean, nearest-rank p95 and max of a list of waits. */
function waitStats(values: readonly number[]): WaitStats {
  let sum = 0;
  let max = 0;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  return { count: values.length, mean: values.length > 0 ? sum / values.length : 0, p95: percentileNearestRank(values, 0.95), max };
}

/** The entries of an object whose value is not undefined (so they can override defaults in a spread). */
function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) if (o[key] !== undefined) out[key] = o[key];
  return out;
}

/**
 * Splits agents [from, to) into groups of consecutive ids. Each group's size is drawn by its first
 * member (the leader) from the relative frequencies `sizes` (sizes[k] for k + 1 people), cut short
 * at `to`. Every member's group[] entry is set to the leader's id.
 */
function formGroups(group: Int32Array, from: number, to: number, sizes: readonly number[], seed: number): void {
  let total = 0;
  for (const w of sizes) total += w;
  let i = from;
  while (i < to) {
    const size = sizes.length > 1 && total > 0 ? 1 + sampleCategorical(uniform(seed, RandomStream.GroupSize, i, 0), sizes) : 1;
    const end = Math.min(to, i + size);
    for (let j = i; j < end; j++) group[j] = i;
    i = end;
  }
}

function hashPeriod(h: Float64Hasher, p: LanePeriod | null): void {
  if (p === null) {
    h.add(NaN);
    return;
  }
  h.add(p.started).add(p.meanWait).add(p.p95Wait).add(p.maxWait);
  h.add(p.queueWait.count).add(p.queueWait.mean).add(p.queueWait.p95).add(p.queueWait.max).add(p.utilisation);
}

const nullToNaN = (v: number | null): number => (v === null ? NaN : v);

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
    h.add(l.queueWait.count).add(l.queueWait.mean).add(l.queueWait.p95).add(l.queueWait.max);
    hashPeriod(h, l.beforeStart);
    hashPeriod(h, l.afterStart);
  }
  for (const e of m.elements) {
    h.add(e.laneCount).add(e.meanBusyTime).add(e.capacityPerHour).add(e.peakDemandPerHour).add(nullToNaN(e.peakDemandStart));
    h.add(e.utilisation.length).addAll(e.utilisation).add(e.peakUtilisation).add(nullToNaN(e.peakUtilisationAt)).add(nullToNaN(e.below85At));
  }
  h.add(m.peakHour.start).add(m.peakHour.end).add(m.peakHour.arrivals).add(m.peakHour.p95Wait);
  h.add(m.meanWait).add(m.p95Wait).add(m.shareInside.time).add(m.shareInside.share);
  h.add(nullToNaN(m.stillOutsideAtStart)).add(nullToNaN(m.arrivedButOutsideAtStart)).add(nullToNaN(m.notYetArrivedAtStart));
  h.add(m.density.cols).add(m.density.rows).add(m.density.cellSize).addAll(m.density.mean).addAll(m.density.max);
  const d = m.departures;
  if (d !== null) h.add(d.departedPeople).add(d.departedCars).add(nullToNaN(d.firstDepartureAt)).add(nullToNaN(d.lastDepartureAt));
  const p = m.parking;
  if (p !== null) {
    h.add(p.carCount).addAll(p.carCountsByState).add(p.carPeople).add(p.turnedAwayCars).add(p.divertedCars).add(p.turnedAwayPeople).add(p.maxSourceBacklog);
    for (const l of p.lots) {
      h.add(l.stalls).add(l.parked).add(l.maxOccupancy).add(l.occupancy.length).addAll(l.occupancy).add(l.meanSearchTime);
      h.add(l.turnedAway).add(l.divertedAway).add(l.divertedIn).add(nullToNaN(l.closedAt)).add(nullToNaN(l.emptyAt)).add(nullToNaN(l.timeToEmpty));
    }
    for (const b of p.barriers) h.add(b.maxQueueCars).add(b.maxQueueMetres).add(nullToNaN(b.maxQueueAt)).add(b.meanQueueMetres).add(nullToNaN(b.reachedPublicRoadAt));
    for (const l of p.barrierLanes) {
      const x = l.metrics;
      h.add(l.laneIndex);
      h.add(x.arrivals).add(x.started).add(x.served).add(x.windowStart).add(x.windowEnd).add(x.meanWait).add(x.p95Wait).add(x.maxWait);
      h.add(x.meanQueue).add(x.maxQueue).add(x.arrivalRate).add(x.utilisation).add(x.failedTime).add(x.queuedAtWindowEnd).add(x.littleLawError);
      h.add(l.throughput.length).addAll(l.throughput).add(l.queueLength.length).addAll(l.queueLength);
    }
  }
  return h.digest();
}

/** Distance from (px, py) to the segment a–b. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + dx * t - px;
  const y = ay + dy * t - py;
  return Math.sqrt(x * x + y * y);
}

/** Creates a pedestrian run of `scenario` on `venue`. All work that does not change over time (grid, flow fields, personal draws) happens here. */
export function createRun(venue: Venue, scenario: Scenario, options?: RunOptions): Run {
  return new PedestrianRun(venue, scenario, options);
}

/**
 * Recreates a run from a checkpoint taken with run.saveCheckpoint() on the same venue, scenario and
 * options. Stepping it on gives bit-identical results to the run the checkpoint came from.
 */
export function restoreRun(venue: Venue, scenario: Scenario, checkpoint: RunCheckpoint, options?: RunOptions): Run {
  const run = new PedestrianRun(venue, scenario, options);
  run.restore(checkpoint);
  return run;
}
