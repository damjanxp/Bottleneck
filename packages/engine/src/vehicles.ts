/**
 * Cars and parking lots (spec 4.3 vehicles, 4.4 departures, 4.5 parking metrics, 6.5).
 *
 * The VehicleWorld owns every car. The pedestrian run (run.ts) owns the people, including the
 * occupants of the cars, and the shared LaneBank: barrier lanes are lanes of the same bank, with
 * ids after the pedestrian lanes, so barriers get exactly the same queueing core (logical FIFO,
 * exact service events, Little's law) as turnstiles.
 *
 * Life of a car (CarPhase):
 *
 *   Pending ─ arrival time ─▶ Backlog (waiting to get onto the road at its source)
 *     ─▶ ToEntry (driving to its lot's entry barrier)
 *     ─▶ AtEntry (committed to one barrier lane; stops at the stop line; served)
 *     ─▶ ToStall (drives along the aisles to its reserved stall's access point)
 *     ─▶ ParkingIn (turns into the stall; blocks the aisle for parkManoeuvre seconds)
 *     ─▶ Parked (occupants get out after carExitDelay; at departure they walk back and board)
 *     ─▶ PullOut (back on the aisle, blocking it for parkManoeuvre seconds)
 *     ─▶ ToExit ─▶ AtExit (served at an exit barrier lane) ─▶ ToSink (drives to a road end) ─▶ Done
 *
 * Car-following (simple, per lane): every edge lane keeps its cars in order, front first. Each tick
 * a car moves at the edge's free speed but never closer than carLength + carGap behind the car in
 * front (no overtaking within a lane), never past a stop line it must obey (a barrier it has not
 * been served at, its target, a crossing with a pedestrian on it), and never onto the next edge
 * unless that edge lane has room (spillback). Speed changes are instant; there is no acceleration.
 *
 * Reservations (review B5):
 *   - Road space: a car only enters an edge lane if it holds fewer cars than its storage
 *     (length / (carLength + carGap), at least 1) *and* the last car there is far enough ahead.
 *     From that moment the space is the car's: nobody else can take it.
 *   - Stalls: a car reserves its stall when it is admitted to the barrier's approach, before it is
 *     served at the entry barrier. A barrier only serves a car that holds a stall, so no car is
 *     ever inside a lot without one.
 *
 * Barrier lanes: a barrier sits on a road at a stop line. The last `barrierApproach` metres of road
 * before it are cut off as the *approach edge* and widened to the barrier's lane count. A car joins
 * a barrier lane (commits, review B3) when it enters the approach: it picks the lane with the fewest
 * committed cars among those with room, and stays in it. Its wait (Wq) runs from that commit to its
 * service start. It is *ready* once it stands at the stop line (and, at an entry, holds a stall).
 *
 * Overflow (A3): when a car reaches the approach of a full (or closed) lot it applies the lot's rule:
 * queue (it is admitted without a stall and waits at the barrier until a stall frees up),
 * divert (once, to the lot `divertTo`: the car is Diverted while driving there, and a second full lot
 * turns it away) or leave (TurnedAway). A turned-away car disappears from the road where it is.
 *
 * Counting (A4): cars have their own AgentState counts (carCountsByState); a car is Pending,
 * Driving, Diverted, Parked, Departed or TurnedAway. Its occupants are people in run.ts: Pending
 * while in the car, then pedestrians, then Driving once back aboard, then Departed.
 *
 * Queue length in metres: each tick, every car that is held up (moved less than half its free
 * distance because of the car in front, a barrier stop line or a full next edge) and is heading for
 * a barrier is a candidate. Sorted by driving distance to the stop line, the queue is the unbroken
 * chain from the stop line backwards: it ends at the first gap of more than 1.5 car spacings (so a
 * car held up somewhere else, e.g. behind a car pulling out of its stall, does not count). Its length
 * is the distance to the back of the last car in the chain, extended by the cars still waiting at a
 * source if the chain reaches back to that source. A car of the chain on a road marked publicRoad (or
 * that backlog at a source on one) means the queue has reached the public road.
 *
 * Everything iterates in id order (edges, lanes, cars within a lane front to back, sources, lots),
 * and all randomness is counter-based (RandomStream.BarrierTime, PlateMisread, SourceChoice), so
 * the results are deterministic.
 */

import type { BarrierServiceType, Distribution, OverflowRule, PaymentMode, Scenario, StallChoice, Venue } from "@bottleneck/schema";
import { AgentState as AgentStateEnum, AGENT_STATE_COUNT } from "./agents.ts";
import { sampleCategorical } from "./distributions.ts";
import { toLocal, type LocalFrame } from "./geometry.ts";
import type { LaneBank, ServiceOutcome } from "./lanes.ts";
import { RandomStream as RandomStreamEnum, uniform } from "./rng.ts";
import { RoadNetwork, polylineLength, project, type PolylineInput } from "./roadNetwork.ts";
import { distributionMoments, makeSampler, type Sampler } from "./sampling.ts";

const AgentState = { ...AgentStateEnum };
const RandomStream = { ...RandomStreamEnum };

// ---------------------------------------------------------------------------------------------
// Defaults (all assumed, spec section 5 and reviews E4/E5)
// ---------------------------------------------------------------------------------------------

const uniformDist = (min: number, max: number): Distribution => ({ kind: "uniform", min, max });

/** A card/cash payment mix: card with probability cardShare (review E5: card is faster). */
export function paymentMix(cardShare: number, card: Distribution, cash: Distribution): Distribution {
  if (cardShare >= 1) return card;
  if (cardShare <= 0) return cash;
  return {
    kind: "mixture",
    components: [
      { weight: cardShare, distribution: card as Exclude<Distribution, { kind: "mixture" }> },
      { weight: 1 - cardShare, distribution: cash as Exclude<Distribution, { kind: "mixture" }> },
    ],
  };
}

export const VEHICLE_DEFAULTS = {
  /** Share of payers paying by card at pay stations and pay-at-barrier exits. */
  cardShare: 0.7,
  /** Relative frequency of cars with 1, 2, 3, 4 people (spec 5, mean ≈ 2.1). */
  occupancy: [0.35, 0.35, 0.18, 0.12],
  carLength: 4.5,
  carGap: 2.5,
  carExitDelay: 20,
  carBoardDelay: 20,
  /** km/h */
  roadSpeed: 25,
  /** km/h */
  aisleSpeed: 8,
  /** Metres of road before a barrier that form its (widened) approach. */
  barrierApproach: 30,
  /** Seconds a car blocks the aisle turning into or out of a stall. */
  parkManoeuvre: 6,
  stallDepth: 5,
  crossingWidth: 4,
  misreadRate: 0.05,
  misreadFallback: uniformDist(15, 30),
} as const;

/** Barrier and payment service times (spec section 5; the payment splits follow review E5). */
export const BARRIER_SERVICE_TIMES = {
  entryTicket: uniformDist(5, 10),
  entryPlate: uniformDist(4, 8),
  entryCard: uniformDist(4, 8),
  /** Exit with a prepaid or validated ticket, a plate or a card. */
  exit: uniformDist(4, 8),
  payAtBarrierCard: uniformDist(15, 25),
  payAtBarrierCash: uniformDist(25, 45),
  payStationCard: uniformDist(20, 35),
  payStationCash: uniformDist(35, 60),
} as const;

/** Suggested car share per event type (review E4, assumed); the scenario's carShare is what a run uses. */
export const CAR_SHARE_DEFAULTS = { fair: 0.55, concert: 0.35, stadium: 0.3, conference: 0.4 } as const;

/** Default service time of a barrier group. */
export function defaultBarrierServiceTime(kind: "entry" | "exit", type: BarrierServiceType, lotPayment: PaymentMode, cardShare: number): Distribution {
  if (type === "payAtBarrier" || (kind === "exit" && lotPayment === "payAtBarrier")) return paymentMix(cardShare, BARRIER_SERVICE_TIMES.payAtBarrierCard, BARRIER_SERVICE_TIMES.payAtBarrierCash);
  if (kind === "exit") return BARRIER_SERVICE_TIMES.exit;
  if (type === "plate") return BARRIER_SERVICE_TIMES.entryPlate;
  if (type === "card") return BARRIER_SERVICE_TIMES.entryCard;
  return BARRIER_SERVICE_TIMES.entryTicket;
}

export function defaultPayStationServiceTime(cardShare: number): Distribution {
  return paymentMix(cardShare, BARRIER_SERVICE_TIMES.payStationCard, BARRIER_SERVICE_TIMES.payStationCash);
}

// ---------------------------------------------------------------------------------------------
// Static model
// ---------------------------------------------------------------------------------------------

export const CarPhase = {
  Pending: 0,
  Backlog: 1,
  ToEntry: 2,
  AtEntry: 3,
  ToStall: 4,
  ParkingIn: 5,
  Parked: 6,
  PullOut: 7,
  ToExit: 8,
  AtExit: 9,
  ToSink: 10,
  Done: 11,
} as const;
const Phase = { ...CarPhase };

const OVERFLOW_QUEUE = 0;
const OVERFLOW_DIVERT = 1;
const OVERFLOW_LEAVE = 2;

const STOP_MARGIN = 0.5;
const AT_STOP = 1e-6;

export interface BarrierGroup {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly kind: "entry" | "exit";
  readonly road: number;
  /** Lot the barrier belongs to (from the lots' barrier lists), −1 if none. */
  lot: number;
  readonly laneCount: number;
  /** LaneBank lane ids, lane-index order. */
  readonly laneIds: number[];
  /** Approach edge and the stop line's offset on it. */
  readonly edge: number;
  readonly stopPos: number;
  readonly serviceType: BarrierServiceType;
  serviceTime: Distribution;
  readonly misreadRate: number;
  readonly fallbackTime: Distribution | null;
  meanBusy: number;
  sampler: Sampler;
  readonly fallback: Sampler | null;
  /** Local position of the stop line (centre of the road). */
  readonly x: number;
  readonly y: number;
  /** Where cars go after this exit barrier: a road end (edge, pos). */
  sinkEdge: number;
  sinkPos: number;
}

export interface LotModel {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly stallCount: number;
  /** Stall centres (local) and the unit vector from the stall's aisle access point to its centre. */
  readonly stallX: Float64Array;
  readonly stallY: Float64Array;
  readonly stallHx: Float64Array;
  readonly stallHy: Float64Array;
  /** Display angle of each stall in degrees (from the venue), NaN if not given. */
  readonly stallAngle: Float64Array;
  /** Access point of each stall on an aisle: forward edge and offset. */
  readonly accessEdge: Int32Array;
  readonly accessPos: Float64Array;
  readonly accessX: Float64Array;
  readonly accessY: Float64Array;
  readonly entryBarriers: number[];
  readonly exitBarriers: number[];
  /** Walking exit (local, as drawn). */
  readonly walkX: number;
  readonly walkY: number;
  readonly overflow: number;
  readonly overflowRule: OverflowRule;
  divertTo: number;
  readonly paymentMode: PaymentMode;
  readonly stallChoice: StallChoice;
  /** Pay station element index in the venue model, −1 if none. */
  payElement: number;
  readonly payStationId: string | null;
  /** Per entry barrier (index into entryBarriers): stall indices in preference order. */
  readonly stallOrder: Int32Array[];
}

export interface VehicleSettings {
  readonly seed: number;
  readonly carLength: number;
  readonly carGap: number;
  readonly exitDelay: number;
  readonly boardDelay: number;
  readonly aisleSpeed: number;
  readonly approach: number;
  readonly manoeuvre: number;
  readonly cardShare: number;
  /** Engine time from which departures happen (the event end), Infinity if no departures. */
  readonly departuresFrom: number;
  readonly tickSeconds: number;
  readonly sampleTicks: number;
  readonly binSeconds: number;
  /** Pedestrian lane count: barrier lanes get bank ids from here on. */
  readonly laneBase: number;
  /** Pay station element index per lot id (from the venue model). */
  readonly payElements: Readonly<Record<string, number>>;
}

/** The cars a run creates (see run.ts): occupants are people first .. first + size − 1. */
export interface CarSpec {
  readonly first: Int32Array;
  readonly size: Uint8Array;
  /** Engine time the car reaches its source. */
  readonly arrival: Float64Array;
}

/** What the world tells the pedestrian run. */
export interface VehicleHooks {
  /** The car parked carExitDelay seconds ago: its occupants get out at its stall. */
  release(car: number): void;
  /** The car was turned away: its occupants never arrive. */
  turnedAway(car: number): void;
  /** The car left the network: its occupants (aboard) have departed. */
  departed(car: number): void;
}

/** Per-car arrays (structure of arrays), in checkpoint order. */
export const CAR_ARRAYS = [
  "state",
  "phase",
  "source",
  "lot",
  "barrier",
  "barrierLane",
  "admitted",
  "ready",
  "stall",
  "diverted",
  "visit",
  "edge",
  "lane",
  "pos",
  "x",
  "y",
  "vx",
  "vy",
  "hx",
  "hy",
  "tEdge",
  "tPos",
  "phaseUntil",
  "passedEntryAt",
  "departAt",
  "expected",
  "aboard",
  "queued",
  "movedTick",
] as const;
export type CarArrayName = (typeof CAR_ARRAYS)[number];

class CarStore {
  readonly state: Uint8Array;
  readonly phase: Uint8Array;
  readonly source: Int32Array;
  readonly lot: Int32Array;
  /** Barrier group the car is heading for or committed to, −1 if none. */
  readonly barrier: Int32Array;
  /** Bank lane id the car is committed to, −1 if none. */
  readonly barrierLane: Int32Array;
  readonly admitted: Uint8Array;
  readonly ready: Uint8Array;
  readonly stall: Int32Array;
  readonly diverted: Uint8Array;
  /** Barrier visits so far (draw index for service times and misreads). */
  readonly visit: Uint8Array;
  readonly edge: Int32Array;
  readonly lane: Int32Array;
  /** Front bumper position along the edge (m). */
  readonly pos: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  /** Target place (stall access or road end), when the phase needs one. */
  readonly tEdge: Int32Array;
  readonly tPos: Float64Array;
  readonly phaseUntil: Float64Array;
  readonly passedEntryAt: Float64Array;
  readonly departAt: Float64Array;
  /** Occupants expected to board at departure, and those aboard. */
  readonly expected: Uint8Array;
  readonly aboard: Uint8Array;
  readonly queued: Uint8Array;
  readonly movedTick: Float64Array;

  constructor(n: number) {
    this.state = new Uint8Array(n);
    this.phase = new Uint8Array(n);
    this.source = new Int32Array(n);
    this.lot = new Int32Array(n).fill(-1);
    this.barrier = new Int32Array(n).fill(-1);
    this.barrierLane = new Int32Array(n).fill(-1);
    this.admitted = new Uint8Array(n);
    this.ready = new Uint8Array(n);
    this.stall = new Int32Array(n).fill(-1);
    this.diverted = new Uint8Array(n);
    this.visit = new Uint8Array(n);
    this.edge = new Int32Array(n).fill(-1);
    this.lane = new Int32Array(n);
    this.pos = new Float64Array(n);
    this.x = new Float64Array(n).fill(NaN);
    this.y = new Float64Array(n).fill(NaN);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.hx = new Float64Array(n).fill(1);
    this.hy = new Float64Array(n);
    this.tEdge = new Int32Array(n).fill(-1);
    this.tPos = new Float64Array(n);
    this.phaseUntil = new Float64Array(n);
    this.passedEntryAt = new Float64Array(n).fill(NaN);
    this.departAt = new Float64Array(n).fill(NaN);
    this.expected = new Uint8Array(n);
    this.aboard = new Uint8Array(n);
    this.queued = new Uint8Array(n);
    this.movedTick = new Float64Array(n).fill(-1);
  }
}

interface SourceModel {
  readonly id: string;
  readonly share: number;
  /** Fixed lot, or −1 for "quickest lot". */
  readonly lot: number;
  /** Places on the road in the drawn direction and against it (null on a one-way road). */
  readonly fwdEdge: number;
  readonly fwdPos: number;
  readonly revEdge: number;
  readonly revPos: number;
  readonly publicRoad: boolean;
}

interface CrossingModel {
  readonly id: string;
  /** Local end points and half width. */
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly half: number;
}

/** Lot state that changes during a run (checkpointed). */
const LOT_SCALARS = ["free", "closed", "closedAt", "inside", "inStalls", "parked", "searchSum", "turnedAway", "divertedAway", "divertedIn", "emptyAt", "maxOccupancy"] as const;
type LotScalar = (typeof LOT_SCALARS)[number];

/** Barrier queue state (checkpointed). */
/** metresSum is the running integral of the queue length (m·s); the window values mirror LaneMetrics. */
const QUEUE_SCALARS = ["maxCars", "maxMetres", "maxAt", "metresSum", "reachedAt", "firstAt", "sumAtFirst", "lastAt", "sumAtLast"] as const;
type QueueScalar = (typeof QUEUE_SCALARS)[number];

export interface VehicleLayout {
  /** Every road (venue order) and every aisle as drawn, in venue metres. */
  readonly roads: readonly { id: string; points: { x: number; y: number }[]; direction: "oneWay" | "twoWay"; laneCount: number; publicRoad: boolean }[];
  readonly aisles: readonly { lotId: string; points: { x: number; y: number }[] }[];
  readonly lots: readonly {
    id: string;
    name: string;
    outline: { x: number; y: number }[];
    walkingExit: { x: number; y: number };
    /** Stall centres (venue metres), the unit vector a parked car faces (from the aisle into the stall), and the drawn angle in degrees (NaN if none). */
    stalls: { x: number; y: number; hx: number; hy: number; angle: number }[];
    entryBarrierIds: string[];
    exitBarrierIds: string[];
    payStationId: string | null;
  }[];
  readonly barriers: readonly {
    id: string;
    name: string;
    kind: "entry" | "exit";
    lotId: string | null;
    roadId: string;
    /** Stop line centre (venue metres) and driving direction there (unit vector). */
    stopLine: { x: number; y: number };
    heading: { x: number; y: number };
    laneCount: number;
    /** LaneBank lane ids (as in metrics.parking.barrierLanes and barrierStates()). */
    laneIds: number[];
    /** Stop position of each lane (venue metres). */
    lanes: { x: number; y: number }[];
  }[];
  readonly crossings: readonly { id: string; a: { x: number; y: number }; b: { x: number; y: number }; width: number }[];
  /** Lane width used to offset multi-lane traffic (m). */
  readonly laneWidth: number;
  readonly carLength: number;
}

export interface BarrierLaneLive {
  readonly laneId: number;
  readonly barrierId: string;
  readonly laneIndex: number;
  /** Cars committed and waiting, excluding the one in service. */
  readonly queueLength: number;
  readonly inService: boolean;
}

export interface LotLive {
  readonly lotId: string;
  readonly stalls: number;
  /** Cars standing in stalls. */
  readonly occupied: number;
  /** Stalls neither occupied nor reserved. */
  readonly free: number;
  readonly closed: boolean;
}

/** Everything about cars that a run reports, before conversion to scenario times. */
export interface VehicleReportInputs {
  readonly world: VehicleWorld;
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export class VehicleWorld {
  readonly carCount: number;
  readonly network: RoadNetwork;
  readonly groups: BarrierGroup[] = [];
  readonly lots: LotModel[] = [];
  readonly sources: SourceModel[] = [];
  readonly crossings: CrossingModel[] = [];
  readonly cars: CarStore;
  readonly spec: CarSpec;
  readonly counts = new Int32Array(AGENT_STATE_COUNT);
  readonly layout: VehicleLayout;
  /** Pedestrians standing on each crossing this tick (written by run.ts after pedestrian movement). */
  readonly pedOnCrossing: Uint8Array;
  /** 1 while a stopped car stands across the crossing (read by run.ts: pedestrians wait). */
  readonly crossingBlocked: Uint8Array;
  readonly barrierLaneCount: number;
  readonly settings: VehicleSettings;
  private bank: LaneBank | null = null;
  private hooks: VehicleHooks | null = null;
  private readonly spacing: number;
  /** Edge lane lists: cars front first. Edge lane index = laneBase[edge] + lane. */
  private readonly laneBaseOf: Int32Array;
  private readonly laneLists: number[][] = [];
  private readonly storage: Int32Array;
  /** Crossing points per edge: [crossing, offset] pairs. */
  private readonly edgeCrossings: number[][] = [];
  /** Barrier group of each barrier lane (index = bank lane id − laneBase). */
  private readonly laneGroup: number[] = [];
  private readonly laneIndexInGroup: number[] = [];
  /** Lot dynamic state. */
  private readonly lotState: Record<LotScalar, number>[];
  private readonly stallOwner: Int32Array[];
  private readonly waiting: number[][];
  private readonly occupancySeries: number[][];
  private readonly queueState: Record<QueueScalar, number>[];
  private readonly laneThroughput: number[][];
  private readonly laneQueueSeries: number[][];
  /** Car ids by (arrival, id). */
  private readonly arrivalOrder: Int32Array;
  private arrivalPtr = 0;
  private readonly backlog: number[][];
  /** Parked cars in park order, with the time their occupants get out. */
  private readonly releaseCars: number[] = [];
  private readonly releaseAt: number[] = [];
  private releasePtr = 0;
  /** Cars whose occupants are all aboard, in boarding order, until they manage to pull out. */
  private readonly leaving: number[] = [];
  private turnedAwayCars = 0;
  private divertedCars = 0;
  private maxBacklog = 0;
  private departedCars = 0;
  private progressed = false;
  private readonly point = new Float64Array(4);
  private readonly queueMetres: Float64Array;
  private readonly queueCars: Int32Array;
  private readonly queueOnPublic: Uint8Array;
  /** Per barrier group, this tick's held cars: driving distance to the stop line, and 1 if on a public road. */
  private readonly heldDist: number[][];
  private readonly heldPublic: number[][];

  constructor(venue: Venue, scenario: Scenario, frame: LocalFrame, spec: CarSpec, settings: VehicleSettings) {
    this.spec = spec;
    this.settings = settings;
    this.carCount = spec.first.length;
    this.spacing = settings.carLength + settings.carGap;
    const overrides = scenario.overrides ?? {};
    const roads = venue.roads ?? [];
    const lots = venue.parkingLots ?? [];
    const barriers = venue.vehicleBarriers ?? [];
    const loc = (p: { x: number; y: number }) => toLocal(frame, p);

    // --- Road network: roads, then aisles; barrier approaches are cut points of their road. ---
    const roadIndex: Record<string, number> = {};
    roads.forEach((r, i) => (roadIndex[r.id] = i));
    const roadPoints = roads.map((r) => r.points.map(loc));
    const cuts: number[][] = roads.map(() => []);
    const barrierAlong: number[] = [];
    for (const b of barriers) {
      const r = roadIndex[b.roadId];
      if (r === undefined) throw new RangeError(`Barrier ${b.id} is on unknown road ${b.roadId}`);
      const p = loc(b.position);
      const along = project(roadPoints[r] as { x: number; y: number }[], p.x, p.y).along;
      barrierAlong.push(along);
      (cuts[r] as number[]).push(Math.max(0, along - settings.approach));
    }
    const polylines: PolylineInput[] = roads.map((r, i) => ({
      points: roadPoints[i] as { x: number; y: number }[],
      twoWay: r.direction === "twoWay",
      lanes: r.laneCount,
      speed: (r.freeSpeed ?? VEHICLE_DEFAULTS.roadSpeed) / 3.6,
      publicRoad: r.publicRoad === true,
      kind: 0,
      owner: i,
      cuts: cuts[i] as number[],
    }));
    lots.forEach((lot, li) => {
      for (const a of lot.aisles) polylines.push({ points: a.points.map(loc), twoWay: true, lanes: 1, speed: settings.aisleSpeed, publicRoad: false, kind: 1, owner: li, cuts: [] });
    });
    const net = new RoadNetwork(polylines);
    this.network = net;

    // --- Lots (static part first: barriers need to know their lot). ---
    const lotIndex: Record<string, number> = {};
    lots.forEach((l, i) => (lotIndex[l.id] = i));
    const barrierIndex: Record<string, number> = {};
    barriers.forEach((b, i) => (barrierIndex[b.id] = i));
    const lotOfBarrier = barriers.map(() => -1);
    lots.forEach((l, li) => {
      for (const id of [...l.entryBarrierIds, ...l.exitBarrierIds]) {
        const b = barrierIndex[id];
        if (b === undefined) throw new RangeError(`Parking lot ${l.id} names unknown barrier ${id}`);
        lotOfBarrier[b] = li;
      }
    });

    // --- Barrier groups and their bank lanes. ---
    let laneId = settings.laneBase;
    barriers.forEach((b, i) => {
      const o = overrides[b.id] ?? {};
      const r = roadIndex[b.roadId] as number;
      const along = barrierAlong[i] as number;
      const place = net.placeOnPolyline(r, along, true);
      if (place === null) throw new RangeError(`Barrier ${b.id}: its road is too short`);
      const laneCount = o.laneCount ?? b.laneCount;
      net.widen(place.edge, laneCount);
      const lotI = lotOfBarrier[i] as number;
      const lot = lotI >= 0 ? lots[lotI] : undefined;
      const lotPayment = (lot && (overrides[lot.id]?.paymentMode ?? lot.paymentMode)) ?? "prepaid";
      const serviceType = o.serviceType ?? b.serviceType;
      const serviceTime = o.serviceTime ?? (o.serviceType === undefined ? b.serviceTime : undefined) ?? defaultBarrierServiceTime(b.kind, serviceType, lotPayment, settings.cardShare);
      const misreadRate = serviceType === "plate" ? (o.scanFailureRate ?? b.misread?.rate ?? VEHICLE_DEFAULTS.misreadRate) : 0;
      const fallbackTime = serviceType === "plate" ? (b.misread?.fallbackTime ?? VEHICLE_DEFAULTS.misreadFallback) : null;
      const laneIds: number[] = [];
      for (let k = 0; k < laneCount; k++) {
        laneIds.push(laneId++);
        this.laneGroup.push(i);
        this.laneIndexInGroup.push(k);
      }
      const stop = loc(b.position);
      const meanBusy = distributionMoments(serviceTime).mean + (fallbackTime ? misreadRate * distributionMoments(fallbackTime).mean : 0);
      this.groups.push({
        index: i,
        id: b.id,
        name: b.name,
        kind: b.kind,
        road: r,
        lot: lotI,
        laneCount,
        laneIds,
        edge: place.edge,
        stopPos: place.pos,
        serviceType,
        serviceTime,
        misreadRate,
        fallbackTime,
        meanBusy,
        sampler: makeSampler(serviceTime, settings.seed, RandomStream.BarrierTime),
        fallback: fallbackTime ? makeSampler(fallbackTime, settings.seed, RandomStream.BarrierTime) : null,
        x: stop.x,
        y: stop.y,
        sinkEdge: place.edge,
        sinkPos: (net.edges[place.edge] as { length: number }).length,
      });
    });
    this.barrierLaneCount = laneId - settings.laneBase;

    // Where a car goes after an exit barrier: the quickest road end (a node without outgoing edges).
    for (const g of this.groups) {
      let best = Infinity;
      for (const e of net.edges) {
        if ((net.out[e.to] as number[]).length > 0) continue;
        const t = net.timeBetween(g.edge, g.stopPos, e.id, e.length);
        if (t < best) {
          best = t;
          g.sinkEdge = e.id;
          g.sinkPos = e.length;
        }
      }
    }

    // --- Lots: stalls, access points, preference orders. ---
    lots.forEach((l, li) => {
      const o = overrides[l.id] ?? {};
      const xs: number[] = [];
      const ys: number[] = [];
      const angles: number[] = [];
      for (const row of l.stallRows ?? []) {
        const a = loc(row.a);
        const b = loc(row.b);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        // Right of a→b in the y-down picture is (−dy, dx)/len (D-016).
        const rx = len > 0 ? -dy / len : 0;
        const ry = len > 0 ? dx / len : 0;
        const depth = row.depth ?? VEHICLE_DEFAULTS.stallDepth;
        const sides = row.side === "both" ? [1, -1] : row.side === "right" ? [1] : [-1];
        for (const s of sides) {
          for (let k = 0; k < row.count; k++) {
            const t = (k + 0.5) / row.count;
            xs.push(a.x + dx * t + rx * s * (depth / 2));
            ys.push(a.y + dy * t + ry * s * (depth / 2));
            angles.push(NaN);
          }
        }
      }
      for (const st of l.stalls ?? []) {
        const p = loc(st.position);
        xs.push(p.x);
        ys.push(p.y);
        angles.push(st.angle ?? NaN);
      }
      const n = xs.length;
      const accessEdge = new Int32Array(n);
      const accessPos = new Float64Array(n);
      const accessX = new Float64Array(n);
      const accessY = new Float64Array(n);
      const hx = new Float64Array(n);
      const hy = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const sx = xs[k] as number;
        const sy = ys[k] as number;
        const hit = net.nearestOnPolylines(sx, sy, (pi) => (polylines[pi] as PolylineInput).kind === 1 && (polylines[pi] as PolylineInput).owner === li);
        if (hit === null) throw new RangeError(`Parking lot ${l.id} has no aisle`);
        const place = net.placeOnPolyline(hit.polyline, hit.along, true) as { edge: number; pos: number };
        accessEdge[k] = place.edge;
        accessPos[k] = place.pos;
        const pr = project(polylines[hit.polyline]!.points, sx, sy);
        accessX[k] = pr.px;
        accessY[k] = pr.py;
        const vx = sx - pr.px;
        const vy = sy - pr.py;
        const vl = Math.sqrt(vx * vx + vy * vy);
        hx[k] = vl > 0 ? vx / vl : 1;
        hy[k] = vl > 0 ? vy / vl : 0;
      }
      const walk = loc(l.walkingExit);
      const entryBarriers = l.entryBarrierIds.map((id) => barrierIndex[id] as number);
      const exitBarriers = l.exitBarrierIds.map((id) => barrierIndex[id] as number);
      const stallChoice = o.stallChoice ?? l.stallChoice ?? "nearestEntry";
      const overflowRule = o.overflow ?? l.overflow ?? { rule: "leave" };
      const paymentMode = o.paymentMode ?? l.paymentMode ?? "prepaid";
      const stallOrder = entryBarriers.map((gi) => {
        const g = this.groups[gi] as BarrierGroup;
        const cost = new Float64Array(n);
        for (let k = 0; k < n; k++) {
          if (stallChoice === "nearestWalkingExit") {
            const dx = (xs[k] as number) - walk.x;
            const dy = (ys[k] as number) - walk.y;
            cost[k] = Math.sqrt(dx * dx + dy * dy);
          } else cost[k] = this.accessTime(g.edge, g.stopPos, accessEdge[k] as number, accessPos[k] as number).time;
        }
        return Int32Array.from({ length: n }, (_, k) => k).sort((a, b) => (cost[a] as number) - (cost[b] as number) || a - b);
      });
      this.lots.push({
        index: li,
        id: l.id,
        name: l.name,
        stallCount: n,
        stallX: Float64Array.from(xs),
        stallY: Float64Array.from(ys),
        stallHx: hx,
        stallHy: hy,
        stallAngle: Float64Array.from(angles),
        accessEdge,
        accessPos,
        accessX,
        accessY,
        entryBarriers,
        exitBarriers,
        walkX: walk.x,
        walkY: walk.y,
        overflow: overflowRule.rule === "queue" ? OVERFLOW_QUEUE : overflowRule.rule === "divert" ? OVERFLOW_DIVERT : OVERFLOW_LEAVE,
        overflowRule,
        divertTo: -1,
        paymentMode,
        stallChoice,
        payElement: l.payStation ? (settings.payElements[l.id] ?? -1) : -1,
        payStationId: l.payStation?.id ?? null,
        stallOrder,
      });
    });
    for (const lot of this.lots) {
      if (lot.overflow === OVERFLOW_DIVERT) {
        const target = lot.overflowRule.divertTo;
        const t = target === undefined ? undefined : lotIndex[target];
        if (t === undefined || t === lot.index) throw new RangeError(`Parking lot ${lot.id}: overflow "divert" needs divertTo naming another lot`);
        lot.divertTo = t;
      }
    }

    // --- Sources ---
    for (const s of venue.vehicleSources ?? []) {
      const p = loc(s.position);
      const hit = net.nearestOnPolylines(p.x, p.y, (pi) => (polylines[pi] as PolylineInput).kind === 0);
      if (hit === null) throw new RangeError(`Vehicle source ${s.id}: the venue has no road`);
      const fwd = net.placeOnPolyline(hit.polyline, hit.along, true) as { edge: number; pos: number };
      const rev = net.placeOnPolyline(hit.polyline, hit.along, false);
      const fixedLot = s.lotId === undefined ? -1 : (lotIndex[s.lotId] ?? -1);
      this.sources.push({
        id: s.id,
        share: s.share,
        lot: fixedLot,
        fwdEdge: fwd.edge,
        fwdPos: fwd.pos,
        revEdge: rev?.edge ?? -1,
        revPos: rev?.pos ?? 0,
        publicRoad: (polylines[hit.polyline] as PolylineInput).publicRoad,
      });
    }

    // --- Crossings: where each crossing segment cuts an edge. ---
    for (const c of venue.crossings ?? []) {
      const a = loc(c.a);
      const b = loc(c.b);
      this.crossings.push({ id: c.id, ax: a.x, ay: a.y, bx: b.x, by: b.y, half: (c.width ?? VEHICLE_DEFAULTS.crossingWidth) / 2 });
    }
    for (const e of net.edges) {
      const list: number[] = [];
      this.crossings.forEach((c, ci) => {
        for (let k = 1; k < e.xs.length; k++) {
          const t = segmentIntersection(e.xs[k - 1] as number, e.ys[k - 1] as number, e.xs[k] as number, e.ys[k] as number, c.ax, c.ay, c.bx, c.by);
          if (t >= 0) {
            list.push(ci, (e.cum[k - 1] as number) + t * ((e.cum[k] as number) - (e.cum[k - 1] as number)));
            break;
          }
        }
      });
      this.edgeCrossings.push(list);
    }
    this.pedOnCrossing = new Uint8Array(this.crossings.length);
    this.crossingBlocked = new Uint8Array(this.crossings.length);

    // --- Edge lanes (after barrier widening). ---
    this.laneBaseOf = new Int32Array(net.edges.length);
    let lanes = 0;
    for (const e of net.edges) {
      this.laneBaseOf[e.id] = lanes;
      lanes += e.lanes;
    }
    this.storage = new Int32Array(lanes);
    for (const e of net.edges) {
      for (let k = 0; k < e.lanes; k++) {
        this.laneLists.push([]);
        this.storage[(this.laneBaseOf[e.id] as number) + k] = Math.max(1, Math.floor(e.length / this.spacing));
      }
    }

    // --- Cars ---
    const n = this.carCount;
    this.cars = new CarStore(n);
    const shares = this.sources.map((s) => s.share);
    for (let c = 0; c < n; c++) {
      const first = spec.first[c] as number;
      this.cars.source[c] = sampleCategorical(uniform(settings.seed, RandomStream.SourceChoice, first, 1), shares);
      this.cars.expected[c] = spec.size[c] as number;
    }
    for (let c = 0; c < n; c++) this.cars.lot[c] = this.lotForSource(this.cars.source[c] as number);
    this.counts[AgentState.Pending] = n;
    const order = Array.from({ length: n }, (_, c) => c);
    order.sort((a, b) => (spec.arrival[a] as number) - (spec.arrival[b] as number) || a - b);
    this.arrivalOrder = Int32Array.from(order);
    this.backlog = this.sources.map(() => []);

    // --- Dynamic lot and barrier state ---
    this.lotState = this.lots.map((l) => ({ free: l.stallCount, closed: 0, closedAt: NaN, inside: 0, inStalls: 0, parked: 0, searchSum: 0, turnedAway: 0, divertedAway: 0, divertedIn: 0, emptyAt: NaN, maxOccupancy: 0 }));
    this.stallOwner = this.lots.map((l) => new Int32Array(l.stallCount).fill(-1));
    this.waiting = this.lots.map(() => []);
    this.occupancySeries = this.lots.map(() => []);
    this.queueState = this.groups.map(() => ({ maxCars: 0, maxMetres: 0, maxAt: NaN, metresSum: 0, reachedAt: NaN, firstAt: NaN, sumAtFirst: 0, lastAt: NaN, sumAtLast: 0 }));
    this.laneThroughput = this.laneGroup.map(() => []);
    this.laneQueueSeries = this.laneGroup.map(() => []);
    this.queueMetres = new Float64Array(this.groups.length);
    this.queueCars = new Int32Array(this.groups.length);
    this.queueOnPublic = new Uint8Array(this.groups.length);
    this.heldDist = this.groups.map(() => []);
    this.heldPublic = this.groups.map(() => []);

    this.layout = this.buildLayout(venue, frame, polylines);
  }

  /** Connects the shared lane bank and the callbacks into the pedestrian run. */
  attach(bank: LaneBank, hooks: VehicleHooks): void {
    this.bank = bank;
    this.hooks = hooks;
  }

  // --- Static helpers ---

  /** Quickest way from a place to a stall access (either direction of a two-way aisle). */
  private accessTime(edge: number, pos: number, accessEdge: number, accessPos: number): { time: number; edge: number; pos: number } {
    const net = this.network;
    const fwd = net.timeBetween(edge, pos, accessEdge, accessPos);
    const twin = (net.edges[accessEdge] as { twin: number }).twin;
    if (twin >= 0) {
      const tpos = (net.edges[twin] as { length: number }).length - accessPos;
      const rev = net.timeBetween(edge, pos, twin, tpos);
      if (rev < fwd) return { time: rev, edge: twin, pos: tpos };
    }
    return { time: fwd, edge: accessEdge, pos: accessPos };
  }

  /** The lot a car from this source heads for: the source's own, else the quickest entry. */
  private lotForSource(source: number): number {
    const s = this.sources[source];
    if (s === undefined) return -1;
    if (s.lot >= 0) return s.lot;
    let best = -1;
    let bestTime = Infinity;
    for (const lot of this.lots) {
      for (const gi of lot.entryBarriers) {
        const t = this.sourceTime(s, gi).time;
        if (t < bestTime) {
          bestTime = t;
          best = lot.index;
        }
      }
    }
    return best;
  }

  /** Time from a source to a barrier's stop line, and which direction of the road to start in. */
  private sourceTime(s: SourceModel, gi: number): { time: number; edge: number; pos: number } {
    const g = this.groups[gi] as BarrierGroup;
    const net = this.network;
    const fwd = net.timeBetween(s.fwdEdge, s.fwdPos, g.edge, g.stopPos);
    if (s.revEdge >= 0) {
      const rev = net.timeBetween(s.revEdge, s.revPos, g.edge, g.stopPos);
      if (rev < fwd) return { time: rev, edge: s.revEdge, pos: s.revPos };
    }
    return { time: fwd, edge: s.fwdEdge, pos: s.fwdPos };
  }

  /** The quickest entry barrier of `lot` from a place, −1 if none is reachable. */
  private bestEntry(lot: number, edge: number, pos: number): number {
    let best = -1;
    let bestTime = Infinity;
    for (const gi of (this.lots[lot] as LotModel).entryBarriers) {
      const g = this.groups[gi] as BarrierGroup;
      const t = this.network.timeBetween(edge, pos, g.edge, g.stopPos);
      if (t < bestTime) {
        bestTime = t;
        best = gi;
      }
    }
    return best;
  }

  // --- State ---

  private setState(c: number, s: number): void {
    const old = this.cars.state[c] as number;
    if (old === s) return;
    this.counts[old] = (this.counts[old] as number) - 1;
    this.counts[s] = (this.counts[s] as number) + 1;
    this.cars.state[c] = s;
    this.progressed = true;
  }

  /** Cars that are on the move or waiting to get onto the road (for the deadlock watchdog). */
  activeCount(): number {
    const backlog = this.arrivalPtr - this.spawned();
    return (this.counts[AgentState.Driving] as number) + (this.counts[AgentState.Diverted] as number) + backlog;
  }

  private spawned(): number {
    let waiting = 0;
    for (const b of this.backlog) waiting += b.length;
    return this.arrivalPtr - waiting;
  }

  /** True once every car is parked, departed or turned away (departures off: parked counts as done). */
  finishedCount(departures: boolean): number {
    const done = (this.counts[AgentState.TurnedAway] as number) + (this.counts[AgentState.Departed] as number);
    return departures ? done : done + (this.counts[AgentState.Parked] as number);
  }

  /** The next car arrival time (engine), Infinity if none is left. */
  nextArrival(): number {
    const c = this.arrivalOrder[this.arrivalPtr];
    return c === undefined ? Infinity : (this.spec.arrival[c] as number);
  }

  lotOfCar(car: number): number {
    return this.cars.lot[car] as number;
  }

  /** Stall centre of a car (local), for its occupants. */
  stallPosition(car: number): { x: number; y: number } {
    const lot = this.lots[this.cars.lot[car] as number] as LotModel;
    const s = this.cars.stall[car] as number;
    return { x: lot.stallX[s] as number, y: lot.stallY[s] as number };
  }

  // --- Lane bank callbacks (barrier lanes) ---

  serviceTime(car: number, laneId: number): number {
    const g = this.groups[this.laneGroup[laneId - this.settings.laneBase] as number] as BarrierGroup;
    return g.sampler(car, this.cars.visit[car] as number);
  }

  outcome(car: number, laneId: number, attempt: number): ServiceOutcome {
    const g = this.groups[this.laneGroup[laneId - this.settings.laneBase] as number] as BarrierGroup;
    if (attempt > 0 || g.misreadRate <= 0 || g.fallback === null) return { kind: "done" };
    const visit = this.cars.visit[car] as number;
    if (uniform(this.settings.seed, RandomStream.PlateMisread, car, visit) >= g.misreadRate) return { kind: "done" };
    // Misread: the slower fallback (ticket or intercom) keeps the lane busy for longer.
    return { kind: "retry", extra: g.fallback(car, 8 + visit) };
  }

  /** A barrier lane started serving a car: the end of the barrier's reporting window so far. */
  onServiceStart(_car: number, laneId: number, time: number): void {
    const q = this.queueState[this.laneGroup[laneId - this.settings.laneBase] as number] as Record<QueueScalar, number>;
    q.lastAt = time;
    q.sumAtLast = q.metresSum;
  }

  onLeave(car: number, laneId: number, time: number): void {
    const k = laneId - this.settings.laneBase;
    const g = this.groups[this.laneGroup[k] as number] as BarrierGroup;
    const cars = this.cars;
    const bin = Math.floor(time / this.settings.binSeconds);
    const series = this.laneThroughput[k] as number[];
    while (series.length <= bin) series.push(0);
    series[bin] = (series[bin] as number) + 1;
    cars.visit[car] = (cars.visit[car] as number) + 1;
    cars.barrierLane[car] = -1;
    cars.ready[car] = 0;
    this.progressed = true;
    const lotI = cars.lot[car] as number;
    const st = this.lotState[lotI];
    if (g.kind === "entry") {
      const lot = this.lots[lotI] as LotModel;
      const s = cars.stall[car] as number;
      const access = this.accessTime(g.edge, g.stopPos, lot.accessEdge[s] as number, lot.accessPos[s] as number);
      cars.phase[car] = Phase.ToStall;
      cars.tEdge[car] = access.edge;
      cars.tPos[car] = access.pos;
      cars.passedEntryAt[car] = time;
      if (st) {
        st.inside += 1;
        st.emptyAt = NaN;
      }
    } else {
      cars.phase[car] = Phase.ToSink;
      cars.tEdge[car] = g.sinkEdge;
      cars.tPos[car] = g.sinkPos;
      if (st) {
        st.inside -= 1;
        if (time >= this.settings.departuresFrom && st.inside === 0 && st.inStalls === 0) st.emptyAt = time;
      }
    }
    cars.barrier[car] = -1;
  }

  // --- Lots ---

  /** Takes the first free stall in the lot's preference order for this entry barrier; −1 if full. */
  private reserveStall(lot: number, entry: number, car: number): number {
    const l = this.lots[lot] as LotModel;
    const st = this.lotState[lot] as Record<LotScalar, number>;
    if (st.free <= 0) return -1;
    const k = Math.max(0, l.entryBarriers.indexOf(entry));
    const order = l.stallOrder[k] as Int32Array;
    const owner = this.stallOwner[lot] as Int32Array;
    for (let i = 0; i < order.length; i++) {
      const s = order[i] as number;
      if (owner[s] === -1) {
        owner[s] = car;
        st.free -= 1;
        this.cars.stall[car] = s;
        return s;
      }
    }
    return -1;
  }

  /** A stall became free: give it to the first car waiting at the lot's entry (rule queue). */
  private releaseStall(lot: number, stall: number): void {
    const st = this.lotState[lot] as Record<LotScalar, number>;
    (this.stallOwner[lot] as Int32Array)[stall] = -1;
    st.free += 1;
    const waiting = this.waiting[lot] as number[];
    while (waiting.length > 0 && st.free > 0 && st.closed === 0) {
      const car = waiting.shift() as number;
      this.reserveStall(lot, this.cars.barrier[car] as number, car);
    }
  }

  /** Timed event: the lot takes no new cars; cars still waiting for a stall leave. */
  closeLot(lot: number, now: number): void {
    const st = this.lotState[lot];
    if (st === undefined || st.closed === 1) return;
    st.closed = 1;
    st.closedAt = now;
    const waiting = this.waiting[lot] as number[];
    while (waiting.length > 0) {
      const car = waiting.shift() as number;
      const laneId = this.cars.barrierLane[car] as number;
      if (laneId >= 0) (this.bank as LaneBank).withdraw(laneId, car);
      this.removeFromLane(car);
      st.turnedAway += 1;
      this.turnAway(car);
    }
  }

  /**
   * A car is about to enter the approach of its lot's entry barrier: reserve a stall, or apply the
   * overflow rule. Returns true if the car may go on to the barrier.
   */
  private admit(car: number): boolean {
    const cars = this.cars;
    const lot = cars.lot[car] as number;
    const l = this.lots[lot] as LotModel;
    const st = this.lotState[lot] as Record<LotScalar, number>;
    cars.admitted[car] = 1;
    if (st.closed === 0 && this.reserveStall(lot, cars.barrier[car] as number, car) >= 0) return true;
    // Full or closed: the overflow rule. A diverted car gets no second chance (A3).
    if (cars.diverted[car] === 0 && st.closed === 0 && l.overflow === OVERFLOW_QUEUE) {
      (this.waiting[lot] as number[]).push(car);
      return true;
    }
    if (cars.diverted[car] === 0 && l.overflow === OVERFLOW_DIVERT && l.divertTo >= 0) {
      const edge = cars.edge[car] as number;
      const pos = cars.pos[car] as number;
      const entry = this.bestEntry(l.divertTo, edge, pos);
      if (entry >= 0 && Number.isFinite(this.network.timeBetween(edge, pos, (this.groups[entry] as BarrierGroup).edge, (this.groups[entry] as BarrierGroup).stopPos))) {
        cars.diverted[car] = 1;
        cars.admitted[car] = 0;
        cars.lot[car] = l.divertTo;
        cars.barrier[car] = entry;
        st.divertedAway += 1;
        (this.lotState[l.divertTo] as Record<LotScalar, number>).divertedIn += 1;
        this.divertedCars += 1;
        this.setState(car, AgentState.Diverted);
        return false;
      }
    }
    st.turnedAway += 1;
    this.removeFromLane(car);
    this.turnAway(car);
    return false;
  }

  private turnAway(car: number): void {
    const cars = this.cars;
    cars.phase[car] = Phase.Done;
    cars.edge[car] = -1;
    this.turnedAwayCars += 1;
    this.setState(car, AgentState.TurnedAway);
    (this.hooks as VehicleHooks).turnedAway(car);
  }

  // --- People ---

  /** An occupant reached the car. Once everyone expected is aboard, the car leaves after carBoardDelay. */
  board(car: number, now: number): void {
    const cars = this.cars;
    cars.aboard[car] = (cars.aboard[car] as number) + 1;
    if ((cars.aboard[car] as number) >= (cars.expected[car] as number) && cars.phase[car] === Phase.Parked && Number.isNaN(cars.departAt[car] as number)) {
      cars.departAt[car] = now + this.settings.boardDelay;
      this.leaving.push(car);
    }
  }

  /** An occupant will never come back (unreachable on foot). */
  occupantLost(car: number): void {
    const cars = this.cars;
    if ((cars.expected[car] as number) > 0) cars.expected[car] = (cars.expected[car] as number) - 1;
  }

  /** Calls fn(car) for every parked car whose occupants get out by `now`, in park order. */
  popReleases(now: number, fn: (car: number) => void): void {
    while (this.releasePtr < this.releaseCars.length && (this.releaseAt[this.releasePtr] as number) <= now) {
      fn(this.releaseCars[this.releasePtr] as number);
      this.releasePtr++;
    }
  }

  // --- Edge lanes ---

  private listOf(edge: number, lane: number): number[] {
    return this.laneLists[(this.laneBaseOf[edge] as number) + lane] as number[];
  }

  private removeFromLane(car: number): void {
    const edge = this.cars.edge[car] as number;
    if (edge < 0) return;
    const list = this.listOf(edge, this.cars.lane[car] as number);
    const k = list.indexOf(car);
    if (k >= 0) list.splice(k, 1);
  }

  /** Lane of `edge` a car can be put into at `pos` (between the cars there), −1 if none has room. */
  private insertLane(edge: number, pos: number, only: number): number {
    const e = this.network.edges[edge] as { lanes: number };
    for (let l = 0; l < e.lanes; l++) {
      if (only >= 0 && l !== only) continue;
      const list = this.listOf(edge, l);
      if (list.length >= (this.storage[(this.laneBaseOf[edge] as number) + l] as number)) continue;
      let ok = true;
      for (const other of list) {
        if (Math.abs((this.cars.pos[other] as number) - pos) < this.spacing) {
          ok = false;
          break;
        }
      }
      if (ok) return l;
    }
    return -1;
  }

  /** Puts a car into an edge lane at `pos`, keeping the list ordered front first. */
  private insertCar(car: number, edge: number, lane: number, pos: number, tick: number): void {
    const list = this.listOf(edge, lane);
    let k = 0;
    while (k < list.length && (this.cars.pos[list[k] as number] as number) > pos) k++;
    list.splice(k, 0, car);
    this.cars.edge[car] = edge;
    this.cars.lane[car] = lane;
    this.cars.pos[car] = pos;
    this.cars.movedTick[car] = tick;
  }

  /** Commits a car to a lane of barrier group g (the bank's FIFO); its lane on the approach is the barrier lane index. */
  private commitBarrier(car: number, g: BarrierGroup, laneIndex: number): void {
    const laneId = g.laneIds[laneIndex] as number;
    const q = this.queueState[g.index] as Record<QueueScalar, number>;
    if (Number.isNaN(q.firstAt)) {
      q.firstAt = this.now;
      q.sumAtFirst = q.metresSum;
    }
    this.cars.barrierLane[car] = laneId;
    this.cars.ready[car] = 0;
    this.cars.phase[car] = g.kind === "entry" ? Phase.AtEntry : Phase.AtExit;
    (this.bank as LaneBank).commit(laneId, car, false);
  }

  /**
   * Barrier lane for a car entering g's approach at `pos`: the lane with the fewest committed cars
   * among those whose approach lane has room (ties: lowest index); −1 if none.
   */
  private pickBarrierLane(g: BarrierGroup, pos: number, atStart: boolean, carry: number): number {
    const bank = this.bank as LaneBank;
    let best = -1;
    let bestCount = Infinity;
    for (let k = 0; k < g.laneCount; k++) {
      const room = atStart ? this.entryRoom(g.edge, k, carry) >= 0 : this.insertLane(g.edge, pos, k) >= 0;
      if (!room) continue;
      const c = bank.committed(g.laneIds[k] as number);
      if (c < bestCount) {
        bestCount = c;
        best = k;
      }
    }
    return best;
  }

  /** Position a car entering lane `lane` of `edge` at its start would take, or −1 if there is no room. */
  private entryRoom(edge: number, lane: number, carry: number): number {
    const list = this.listOf(edge, lane);
    if (list.length >= (this.storage[(this.laneBaseOf[edge] as number) + lane] as number)) return -1;
    const len = (this.network.edges[edge] as { length: number }).length;
    let pos = Math.min(carry, len);
    if (list.length > 0) pos = Math.min(pos, (this.cars.pos[list[list.length - 1] as number] as number) - this.spacing);
    return pos >= 0 ? pos : -1;
  }

  /** Lane with the most room at the start of `edge` (ties: lowest index), −1 if none has any. */
  private freestLane(edge: number, carry: number): { lane: number; pos: number } {
    const e = this.network.edges[edge] as { lanes: number };
    let best = -1;
    let bestPos = -1;
    for (let l = 0; l < e.lanes; l++) {
      const p = this.entryRoom(edge, l, carry);
      if (p > bestPos) {
        bestPos = p;
        best = l;
      }
    }
    return { lane: best, pos: bestPos };
  }

  // --- The tick ---

  /**
   * One tick of the vehicle world, after the pedestrians have moved (pedOnCrossing is current).
   * Returns true if anything changed (for the deadlock watchdog).
   */
  step(now: number, tick: number): boolean {
    this.progressed = false;
    this.now = now;
    const cars = this.cars;
    const dt = this.settings.tickSeconds;
    // 1. Cars ready to leave pull out of their stalls (in boarding order) when the aisle has room.
    for (let k = 0; k < this.leaving.length; ) {
      const car = this.leaving[k] as number;
      if ((cars.departAt[car] as number) <= now && this.pullOut(car, now, tick)) this.leaving.splice(k, 1);
      else k++;
    }
    // 2. Arrivals: cars due join their source's backlog.
    while (this.arrivalPtr < this.arrivalOrder.length) {
      const car = this.arrivalOrder[this.arrivalPtr] as number;
      if ((this.spec.arrival[car] as number) > now) break;
      this.arrivalPtr++;
      const src = cars.source[car] as number;
      const lot = cars.lot[car] as number;
      if (src < 0 || lot < 0) {
        this.turnAway(car);
        continue;
      }
      const s = this.sources[src] as SourceModel;
      cars.barrier[car] = this.bestSourceEntry(s, lot);
      cars.phase[car] = Phase.Backlog;
      (this.backlog[src] as number[]).push(car);
      this.progressed = true;
    }
    // 3. Cars at the head of each backlog get onto the road if there is room.
    let backlogTotal = 0;
    this.sources.forEach((s, si) => {
      const queue = this.backlog[si] as number[];
      while (queue.length > 0) {
        const car = queue[0] as number;
        if (!this.spawn(car, s, tick)) break;
        queue.shift();
      }
      backlogTotal += queue.length;
    });
    if (backlogTotal > this.maxBacklog) this.maxBacklog = backlogTotal;
    // 4. Movement, edge lane by edge lane, front to back.
    for (let li = 0; li < this.laneLists.length; li++) this.moveLane(li, now, tick, dt);
    // 5. Positions, crossings, queues, samples.
    this.afterMove(now, tick, dt);
    return this.progressed;
  }

  /** Entry barrier for a car starting at a source. */
  private bestSourceEntry(s: SourceModel, lot: number): number {
    let best = -1;
    let bestTime = Infinity;
    for (const gi of (this.lots[lot] as LotModel).entryBarriers) {
      const t = this.sourceTime(s, gi).time;
      if (t < bestTime) {
        bestTime = t;
        best = gi;
      }
    }
    return best;
  }

  private spawn(car: number, s: SourceModel, tick: number): boolean {
    const cars = this.cars;
    const gi = cars.barrier[car] as number;
    if (gi < 0) {
      this.turnAway(car);
      return true;
    }
    const start = this.sourceTime(s, gi);
    if (!Number.isFinite(start.time)) {
      this.turnAway(car);
      return true;
    }
    const g = this.groups[gi] as BarrierGroup;
    if (start.edge === g.edge) {
      // Starting right on the approach: admission and lane choice happen here.
      if (cars.admitted[car] === 0) {
        cars.edge[car] = start.edge;
        cars.pos[car] = start.pos;
        if (!this.admit(car)) {
          if (cars.state[car] === AgentState.TurnedAway) return true;
          cars.edge[car] = -1;
          return false;
        }
      }
      const k = this.pickBarrierLane(g, start.pos, false, 0);
      if (k < 0) return false;
      this.insertCar(car, start.edge, k, start.pos, tick);
      this.commitBarrier(car, g, k);
    } else {
      const lane = this.insertLane(start.edge, start.pos, -1);
      if (lane < 0) return false;
      this.insertCar(car, start.edge, lane, start.pos, tick);
      cars.phase[car] = Phase.ToEntry;
    }
    if (cars.state[car] === AgentState.Pending) this.setState(car, AgentState.Driving);
    this.positionOnEdge(car);
    return true;
  }

  private pullOut(car: number, now: number, tick: number): boolean {
    const cars = this.cars;
    const lotI = cars.lot[car] as number;
    const lot = this.lots[lotI] as LotModel;
    const s = cars.stall[car] as number;
    const bank = this.bank as LaneBank;
    // Exit barrier: quickest from the stall, plus the expected wait for its lanes.
    let best = -1;
    let bestCost = Infinity;
    let bestEdge = -1;
    let bestPos = 0;
    for (const gi of lot.exitBarriers) {
      const g = this.groups[gi] as BarrierGroup;
      for (const dir of [0, 1]) {
        let edge = lot.accessEdge[s] as number;
        let pos = lot.accessPos[s] as number;
        if (dir === 1) {
          const twin = (this.network.edges[edge] as { twin: number }).twin;
          if (twin < 0) continue;
          pos = (this.network.edges[twin] as { length: number }).length - pos;
          edge = twin;
        }
        let committed = 0;
        for (const id of g.laneIds) committed += bank.committed(id);
        const cost = this.network.timeBetween(edge, pos, g.edge, g.stopPos) + (committed / g.laneCount) * g.meanBusy;
        if (cost < bestCost) {
          bestCost = cost;
          best = gi;
          bestEdge = edge;
          bestPos = pos;
        }
      }
    }
    if (best < 0 || !Number.isFinite(bestCost)) return false;
    const lane = this.insertLane(bestEdge, bestPos, -1);
    if (lane < 0) return false;
    this.insertCar(car, bestEdge, lane, bestPos, tick);
    cars.barrier[car] = best;
    cars.phase[car] = Phase.PullOut;
    cars.phaseUntil[car] = now + this.settings.manoeuvre;
    cars.admitted[car] = 1;
    const st = this.lotState[lotI] as Record<LotScalar, number>;
    st.inStalls -= 1;
    this.releaseStall(lotI, s);
    this.setState(car, AgentState.Driving);
    return true;
  }

  /** Moves the cars of one edge lane, front to back. */
  private moveLane(li: number, now: number, tick: number, dt: number): void {
    const list = this.laneLists[li] as number[];
    if (list.length === 0) return;
    const cars = this.cars;
    const net = this.network;
    let k = 0;
    while (k < list.length) {
      const car = list[k] as number;
      if (cars.movedTick[car] === tick) {
        k++;
        continue;
      }
      cars.movedTick[car] = tick;
      cars.queued[car] = 0;
      const phase = cars.phase[car] as number;
      const edge = cars.edge[car] as number;
      const e = net.edges[edge] as { length: number; speed: number };
      const pos = cars.pos[car] as number;
      // Manoeuvres hold the car (and its space) in place.
      if (phase === Phase.ParkingIn || phase === Phase.PullOut) {
        if ((cars.phaseUntil[car] as number) <= now) {
          if (phase === Phase.ParkingIn) {
            list.splice(k, 1);
            this.park(car, now);
            continue;
          }
          cars.phase[car] = Phase.ToExit;
          this.progressed = true;
          // The pulled-out car may already stand on its exit barrier's approach.
          const g = this.groups[cars.barrier[car] as number] as BarrierGroup;
          if (edge === g.edge) this.commitBarrier(car, g, Math.min(cars.lane[car] as number, g.laneCount - 1));
        }
        k++;
        continue;
      }
      const vmax = e.speed * dt;
      const desired = pos + vmax;
      // The tightest constraint ahead; `held` if it is one that makes a queue (the car in front,
      // an unserved barrier, a full next edge), as opposed to the car's own target or a crossing.
      let limit = Infinity;
      let held = false;
      let stopsHere = false;
      if (k > 0) {
        limit = (cars.pos[list[k - 1] as number] as number) - this.spacing;
        held = true;
      }
      if (phase === Phase.AtEntry || phase === Phase.AtExit) {
        const g = this.groups[cars.barrier[car] as number] as BarrierGroup;
        if (edge === g.edge) {
          stopsHere = true;
          if (g.stopPos < limit) {
            limit = g.stopPos;
            held = true;
          }
        }
      }
      if ((phase === Phase.ToStall || phase === Phase.ToSink) && edge === cars.tEdge[car] && pos <= (cars.tPos[car] as number) + AT_STOP) {
        stopsHere = true;
        if ((cars.tPos[car] as number) < limit) {
          limit = cars.tPos[car] as number;
          held = false;
        }
      }
      const crossings = this.edgeCrossings[edge] as number[];
      for (let j = 0; j < crossings.length; j += 2) {
        const ci = crossings[j] as number;
        if (this.pedOnCrossing[ci] === 0) continue;
        const line = (crossings[j + 1] as number) - (this.crossings[ci] as CrossingModel).half - STOP_MARGIN;
        if (pos <= line + AT_STOP && line < limit) {
          limit = line;
          held = false;
        }
      }
      if (k === 0 && !stopsHere && desired > e.length && limit >= e.length) {
        // Reaching the end of the edge: on to the next one if it has room.
        const r = this.transfer(car, edge, desired - e.length, tick);
        if (r === 1) {
          list.splice(k, 1);
          continue;
        }
        if (r === 2) {
          // Turned away: already taken off this lane.
          if (list[k] === car) list.splice(k, 1);
          continue;
        }
        // No room ahead: wait at the end of the edge (spillback).
        limit = e.length;
        held = true;
      }
      const newPos = Math.max(pos, Math.min(desired, limit, e.length));
      if (newPos !== pos) this.progressed = true;
      cars.pos[car] = newPos;
      if (held && limit < desired && newPos - pos < 0.5 * vmax) cars.queued[car] = 1;
      this.arrive(car, edge, newPos);
      if (cars.edge[car] !== edge) {
        // Reached its road end: no longer in this list.
        if (list[k] === car) list.splice(k, 1);
        continue;
      }
      k++;
    }
  }

  /**
   * Moves a car from the end of `edge` onto the next edge of its route (the caller removes it from
   * its old lane). Returns 1 if moved, 0 if it must wait (no room), 2 if it was turned away.
   */
  private transfer(car: number, edge: number, carry: number, tick: number): number {
    const cars = this.cars;
    const net = this.network;
    const phase = cars.phase[car] as number;
    const gi = cars.barrier[car] as number;
    const toBarrier = phase === Phase.ToEntry || phase === Phase.ToExit;
    const targetEdge = toBarrier ? (this.groups[gi] as BarrierGroup).edge : (cars.tEdge[car] as number);
    if (targetEdge < 0) return 0;
    const next = net.nextTowards(edge, targetEdge);
    if (next < 0) return 0;
    const g = toBarrier ? (this.groups[gi] as BarrierGroup) : null;
    if (g !== null && next === g.edge) {
      // Entering the barrier's approach: admission (entry), then the barrier lane.
      if (g.kind === "entry" && cars.admitted[car] === 0) {
        if (!this.admit(car)) return cars.state[car] === AgentState.TurnedAway ? 2 : 0;
      }
      const k = this.pickBarrierLane(g, 0, true, carry);
      if (k < 0) return 0;
      const pos = this.entryRoom(g.edge, k, carry);
      this.listOf(g.edge, k).push(car);
      cars.edge[car] = g.edge;
      cars.lane[car] = k;
      cars.pos[car] = pos;
      cars.movedTick[car] = tick;
      this.commitBarrier(car, g, k);
      this.progressed = true;
      this.arrive(car, g.edge, pos);
      return 1;
    }
    const f = this.freestLane(next, carry);
    if (f.lane < 0) return 0;
    this.listOf(next, f.lane).push(car);
    cars.edge[car] = next;
    cars.lane[car] = f.lane;
    cars.pos[car] = f.pos;
    cars.movedTick[car] = tick;
    this.progressed = true;
    this.arrive(car, next, f.pos);
    return 1;
  }

  /** Checks what a car has reached after moving: its stop line, its stall access, its road end. */
  private arrive(car: number, edge: number, pos: number): void {
    const cars = this.cars;
    const phase = cars.phase[car] as number;
    if (phase === Phase.AtEntry || phase === Phase.AtExit) {
      const g = this.groups[cars.barrier[car] as number] as BarrierGroup;
      if (cars.ready[car] === 0 && edge === g.edge && pos >= g.stopPos - AT_STOP && (g.kind === "exit" || (cars.stall[car] as number) >= 0)) {
        cars.ready[car] = 1;
        (this.bank as LaneBank).markReady(cars.barrierLane[car] as number, car);
      }
    } else if (phase === Phase.ToStall && edge === cars.tEdge[car] && pos >= (cars.tPos[car] as number) - AT_STOP) {
      cars.phase[car] = Phase.ParkingIn;
      cars.phaseUntil[car] = this.now + this.settings.manoeuvre;
      this.progressed = true;
    } else if (phase === Phase.ToSink && edge === cars.tEdge[car] && pos >= (cars.tPos[car] as number) - AT_STOP) {
      this.removeFromLane(car);
      cars.edge[car] = -1;
      cars.phase[car] = Phase.Done;
      this.departedCars += 1;
      this.setState(car, AgentState.Departed);
      (this.hooks as VehicleHooks).departed(car);
    }
  }

  private now = 0;

  private park(car: number, now: number): void {
    const cars = this.cars;
    const lotI = cars.lot[car] as number;
    const lot = this.lots[lotI] as LotModel;
    const st = this.lotState[lotI] as Record<LotScalar, number>;
    const s = cars.stall[car] as number;
    cars.edge[car] = -1;
    cars.phase[car] = Phase.Parked;
    st.inStalls += 1;
    st.parked += 1;
    if (st.inStalls > st.maxOccupancy) st.maxOccupancy = st.inStalls;
    st.searchSum += now - (cars.passedEntryAt[car] as number);
    cars.x[car] = lot.stallX[s] as number;
    cars.y[car] = lot.stallY[s] as number;
    cars.hx[car] = lot.stallHx[s] as number;
    cars.hy[car] = lot.stallHy[s] as number;
    cars.vx[car] = 0;
    cars.vy[car] = 0;
    this.setState(car, AgentState.Parked);
    this.releaseCars.push(car);
    this.releaseAt.push(now + this.settings.exitDelay);
  }

  /** Sets a car's x, y and heading from its place on its edge lane. */
  private positionOnEdge(car: number): void {
    const cars = this.cars;
    const p = this.point;
    // The car's centre: half a car length behind its front bumper (clamped to the edge's start).
    this.network.pointAt(cars.edge[car] as number, Math.max(0, (cars.pos[car] as number) - this.settings.carLength / 2), cars.lane[car] as number, p);
    cars.x[car] = p[0] as number;
    cars.y[car] = p[1] as number;
    cars.hx[car] = p[2] as number;
    cars.hy[car] = p[3] as number;
  }

  private afterMove(now: number, tick: number, dt: number): void {
    const cars = this.cars;
    const net = this.network;
    this.crossingBlocked.fill(0);
    this.queueMetres.fill(0);
    this.queueCars.fill(0);
    this.queueOnPublic.fill(0);
    for (const list of this.heldDist) list.length = 0;
    for (const list of this.heldPublic) list.length = 0;
    for (let li = 0; li < this.laneLists.length; li++) {
      const list = this.laneLists[li] as number[];
      for (const car of list) {
        const edge = cars.edge[car] as number;
        const x0 = cars.x[car] as number;
        const y0 = cars.y[car] as number;
        const phase = cars.phase[car] as number;
        if (phase === Phase.ParkingIn || phase === Phase.PullOut) {
          // Turning into or out of the stall: between the access point and the stall centre.
          const lot = this.lots[cars.lot[car] as number] as LotModel;
          const s = cars.stall[car] as number;
          const left = Math.max(0, Math.min(1, ((cars.phaseUntil[car] as number) - now) / this.settings.manoeuvre));
          const f = phase === Phase.ParkingIn ? 1 - left : left;
          const ax = lot.accessX[s] as number;
          const ay = lot.accessY[s] as number;
          cars.x[car] = ax + ((lot.stallX[s] as number) - ax) * f;
          cars.y[car] = ay + ((lot.stallY[s] as number) - ay) * f;
          cars.hx[car] = lot.stallHx[s] as number;
          cars.hy[car] = lot.stallHy[s] as number;
        } else this.positionOnEdge(car);
        cars.vx[car] = Number.isNaN(x0) ? 0 : ((cars.x[car] as number) - x0) / dt;
        cars.vy[car] = Number.isNaN(y0) ? 0 : ((cars.y[car] as number) - y0) / dt;
        // Crossings blocked by a car standing across them.
        const crossings = this.edgeCrossings[edge] as number[];
        if (crossings.length > 0 && Math.abs(cars.vx[car] as number) + Math.abs(cars.vy[car] as number) < 0.1) {
          const front = cars.pos[car] as number;
          for (let j = 0; j < crossings.length; j += 2) {
            const ci = crossings[j] as number;
            const at = crossings[j + 1] as number;
            const half = (this.crossings[ci] as CrossingModel).half;
            if (front >= at - half && front - this.settings.carLength <= at + half) this.crossingBlocked[ci] = 1;
          }
        }
        // Candidates for the queues in front of barriers.
        if (cars.queued[car] === 1 && (phase === Phase.ToEntry || phase === Phase.AtEntry || phase === Phase.ToExit || phase === Phase.AtExit)) {
          const gi = cars.barrier[car] as number;
          const g = this.groups[gi] as BarrierGroup;
          (this.heldDist[gi] as number[]).push(net.distanceBetween(edge, cars.pos[car] as number, g.edge, g.stopPos));
          (this.heldPublic[gi] as number[]).push((net.edges[edge] as { publicRoad: boolean }).publicRoad ? 1 : 0);
        }
      }
    }
    // The unbroken chain of held cars from each stop line backwards.
    const maxGap = 1.5 * this.spacing;
    this.groups.forEach((_, gi) => {
      const dist = this.heldDist[gi] as number[];
      if (dist.length === 0) return;
      const pub = this.heldPublic[gi] as number[];
      const order = dist.map((_, k) => k).sort((a, b) => (dist[a] as number) - (dist[b] as number) || a - b);
      let reach = -Infinity;
      let front = 0;
      for (const k of order) {
        const d = dist[k] as number;
        if (d - front > maxGap) break;
        front = d;
        reach = d;
        this.queueCars[gi] = (this.queueCars[gi] as number) + 1;
        if (pub[k] === 1) this.queueOnPublic[gi] = 1;
      }
      if (reach > -Infinity) this.queueMetres[gi] = reach + this.settings.carLength;
    });
    // Cars that could not get onto the road yet extend the queue beyond their source, but only if
    // the queue on the road already reaches back to the source (a car that briefly cannot pull in
    // next to another one is not a queue).
    this.sources.forEach((s, si) => {
      const queue = this.backlog[si] as number[];
      queue.forEach((car, rank) => {
        const gi = cars.barrier[car] as number;
        if (gi < 0) return;
        const g = this.groups[gi] as BarrierGroup;
        const start = this.sourceTime(s, gi);
        const atSource = net.distanceBetween(start.edge, start.pos, g.edge, g.stopPos);
        if ((this.queueMetres[gi] as number) < atSource - maxGap) return;
        const d = atSource + (rank + 1) * this.spacing;
        if (d > (this.queueMetres[gi] as number)) this.queueMetres[gi] = d;
        this.queueCars[gi] = (this.queueCars[gi] as number) + 1;
        if (s.publicRoad) this.queueOnPublic[gi] = 1;
      });
    });
    this.groups.forEach((_, gi) => {
      const q = this.queueState[gi] as Record<QueueScalar, number>;
      const m = this.queueMetres[gi] as number;
      q.metresSum += m * dt;
      if (m > q.maxMetres) {
        q.maxMetres = m;
        q.maxAt = now;
      }
      if ((this.queueCars[gi] as number) > q.maxCars) q.maxCars = this.queueCars[gi] as number;
      if (this.queueOnPublic[gi] === 1 && Number.isNaN(q.reachedAt)) q.reachedAt = now;
    });
    // Samples: barrier queues every queueSampleInterval, lot occupancy every throughput bin.
    if ((tick + 1) % this.settings.sampleTicks === 0) {
      const bank = this.bank as LaneBank;
      this.laneGroup.forEach((_, k) => (this.laneQueueSeries[k] as number[]).push(bank.queueLength(this.settings.laneBase + k)));
    }
    const binTicks = Math.round(this.settings.binSeconds / dt);
    if ((tick + 1) % binTicks === 0) this.lots.forEach((_, li) => (this.occupancySeries[li] as number[]).push((this.lotState[li] as Record<LotScalar, number>).inStalls));
  }

  // --- Output ---

  writeSnapshot(out: Float32Array, originX: number, originY: number): void {
    const n = this.carCount;
    const c = this.cars;
    for (let i = 0; i < n; i++) {
      out[i] = (c.x[i] as number) + originX;
      out[n + i] = (c.y[i] as number) + originY;
      out[2 * n + i] = c.vx[i] as number;
      out[3 * n + i] = c.vy[i] as number;
      out[4 * n + i] = c.hx[i] as number;
      out[5 * n + i] = c.hy[i] as number;
      out[6 * n + i] = c.state[i] as number;
    }
  }

  barrierStates(): BarrierLaneLive[] {
    const bank = this.bank as LaneBank;
    return this.laneGroup.map((gi, k) => {
      const laneId = this.settings.laneBase + k;
      return { laneId, barrierId: (this.groups[gi] as BarrierGroup).id, laneIndex: this.laneIndexInGroup[k] as number, queueLength: bank.queueLength(laneId), inService: bank.inService(laneId) >= 0 };
    });
  }

  lotStates(): LotLive[] {
    return this.lots.map((l, li) => {
      const st = this.lotState[li] as Record<LotScalar, number>;
      return { lotId: l.id, stalls: l.stallCount, occupied: st.inStalls, free: st.free, closed: st.closed === 1 };
    });
  }

  /** Raw report values (engine times); run.ts turns them into the schema's ParkingMetrics. */
  report(): {
    turnedAwayCars: number;
    divertedCars: number;
    maxBacklog: number;
    departedCars: number;
    lots: { state: Record<LotScalar, number>; occupancy: number[] }[];
    queues: Record<QueueScalar, number>[];
    laneThroughput: number[][];
    laneQueueSeries: number[][];
    laneGroup: number[];
    laneIndexInGroup: number[];
  } {
    return {
      turnedAwayCars: this.turnedAwayCars,
      divertedCars: this.divertedCars,
      maxBacklog: this.maxBacklog,
      departedCars: this.departedCars,
      lots: this.lots.map((_, li) => ({ state: { ...(this.lotState[li] as Record<LotScalar, number>) }, occupancy: [...(this.occupancySeries[li] as number[])] })),
      queues: this.queueState.map((q) => ({ ...q })),
      laneThroughput: this.laneThroughput.map((s) => [...s]),
      laneQueueSeries: this.laneQueueSeries.map((s) => [...s]),
      laneGroup: [...this.laneGroup],
      laneIndexInGroup: [...this.laneIndexInGroup],
    };
  }

  private buildLayout(venue: Venue, frame: LocalFrame, polylines: PolylineInput[]): VehicleLayout {
    const ox = frame.originX;
    const oy = frame.originY;
    const p = this.point;
    const lots = venue.parkingLots ?? [];
    return {
      roads: (venue.roads ?? []).map((r) => ({ id: r.id, points: r.points.map((q) => ({ x: q.x, y: q.y })), direction: r.direction, laneCount: r.laneCount, publicRoad: r.publicRoad === true })),
      aisles: polylines.filter((q) => q.kind === 1).map((q) => ({ lotId: (lots[q.owner] as { id: string }).id, points: q.points.map((pt) => ({ x: pt.x + ox, y: pt.y + oy })) })),
      lots: this.lots.map((l, li) => {
        const v = lots[li] as NonNullable<Venue["parkingLots"]>[number];
        const stalls: { x: number; y: number; hx: number; hy: number; angle: number }[] = [];
        for (let k = 0; k < l.stallCount; k++) stalls.push({ x: (l.stallX[k] as number) + ox, y: (l.stallY[k] as number) + oy, hx: l.stallHx[k] as number, hy: l.stallHy[k] as number, angle: l.stallAngle[k] as number });
        return { id: l.id, name: l.name, outline: v.outline.outer.map((q) => ({ x: q.x, y: q.y })), walkingExit: { x: v.walkingExit.x, y: v.walkingExit.y }, stalls, entryBarrierIds: [...v.entryBarrierIds], exitBarrierIds: [...v.exitBarrierIds], payStationId: l.payStationId };
      }),
      barriers: this.groups.map((g) => {
        const lanes: { x: number; y: number }[] = [];
        for (let k = 0; k < g.laneCount; k++) {
          this.network.pointAt(g.edge, g.stopPos, k, p);
          lanes.push({ x: (p[0] as number) + ox, y: (p[1] as number) + oy });
        }
        this.network.pointAt(g.edge, g.stopPos, 0, p);
        const b = (venue.vehicleBarriers ?? [])[g.index] as NonNullable<Venue["vehicleBarriers"]>[number];
        return {
          id: g.id,
          name: g.name,
          kind: g.kind,
          lotId: g.lot >= 0 ? (this.lots[g.lot] as LotModel).id : null,
          roadId: b.roadId,
          stopLine: { x: g.x + ox, y: g.y + oy },
          heading: { x: p[2] as number, y: p[3] as number },
          laneCount: g.laneCount,
          laneIds: [...g.laneIds],
          lanes,
        };
      }),
      crossings: this.crossings.map((c) => ({ id: c.id, a: { x: c.ax + ox, y: c.ay + oy }, b: { x: c.bx + ox, y: c.by + oy }, width: 2 * c.half })),
      laneWidth: 3,
      carLength: this.settings.carLength,
    };
  }

  // --- Checkpoints ---

  save(): VehicleState {
    const arrays: Record<string, Float64Array | Int32Array | Uint8Array> = {};
    for (const name of CAR_ARRAYS) arrays[name] = this.cars[name].slice();
    return {
      cars: arrays,
      counts: this.counts.slice(),
      laneLists: packInts(this.laneLists),
      backlog: packInts(this.backlog),
      waiting: packInts(this.waiting),
      stallOwner: packInts(this.stallOwner.map((o) => Array.from(o))),
      lotScalars: Float64Array.from(this.lotState.flatMap((s) => LOT_SCALARS.map((k) => s[k]))),
      occupancy: packFloats(this.occupancySeries),
      queueScalars: Float64Array.from(this.queueState.flatMap((s) => QUEUE_SCALARS.map((k) => s[k]))),
      laneThroughput: packFloats(this.laneThroughput),
      laneQueueSeries: packFloats(this.laneQueueSeries),
      releaseCars: Int32Array.from(this.releaseCars),
      releaseAt: Float64Array.from(this.releaseAt),
      leaving: Int32Array.from(this.leaving),
      crossingBlocked: this.crossingBlocked.slice(),
      pedOnCrossing: this.pedOnCrossing.slice(),
      scalars: Float64Array.from([this.arrivalPtr, this.releasePtr, this.turnedAwayCars, this.divertedCars, this.maxBacklog, this.departedCars, this.now]),
    };
  }

  restore(s: VehicleState): void {
    for (const name of CAR_ARRAYS) {
      const src = s.cars[name];
      if (src === undefined) throw new RangeError(`The checkpoint has no car array "${name}"`);
      (this.cars[name] as Float64Array).set(src as Float64Array);
    }
    this.counts.set(s.counts);
    unpackInto(s.laneLists, this.laneLists);
    unpackInto(s.backlog, this.backlog);
    unpackInto(s.waiting, this.waiting);
    const owners: number[][] = this.stallOwner.map(() => []);
    unpackInto(s.stallOwner, owners);
    owners.forEach((o, li) => (this.stallOwner[li] as Int32Array).set(o));
    this.lotState.forEach((st, li) => LOT_SCALARS.forEach((k, j) => (st[k] = s.lotScalars[li * LOT_SCALARS.length + j] as number)));
    unpackInto(s.occupancy, this.occupancySeries);
    this.queueState.forEach((q, gi) => QUEUE_SCALARS.forEach((k, j) => (q[k] = s.queueScalars[gi * QUEUE_SCALARS.length + j] as number)));
    unpackInto(s.laneThroughput, this.laneThroughput);
    unpackInto(s.laneQueueSeries, this.laneQueueSeries);
    this.releaseCars.length = 0;
    this.releaseCars.push(...s.releaseCars);
    this.releaseAt.length = 0;
    this.releaseAt.push(...s.releaseAt);
    this.leaving.length = 0;
    this.leaving.push(...s.leaving);
    this.crossingBlocked.set(s.crossingBlocked);
    this.pedOnCrossing.set(s.pedOnCrossing);
    const sc = s.scalars;
    this.arrivalPtr = sc[0] as number;
    this.releasePtr = sc[1] as number;
    this.turnedAwayCars = sc[2] as number;
    this.divertedCars = sc[3] as number;
    this.maxBacklog = sc[4] as number;
    this.departedCars = sc[5] as number;
    this.now = sc[6] as number;
  }
}

/** A VehicleWorld's dynamic state as typed arrays (part of a run checkpoint). */
export interface VehicleState {
  readonly cars: Readonly<Record<string, Float64Array | Int32Array | Uint8Array>>;
  readonly counts: Int32Array;
  readonly laneLists: PackedInts;
  readonly backlog: PackedInts;
  readonly waiting: PackedInts;
  readonly stallOwner: PackedInts;
  readonly lotScalars: Float64Array;
  readonly occupancy: PackedInts;
  readonly queueScalars: Float64Array;
  readonly laneThroughput: PackedInts;
  readonly laneQueueSeries: PackedInts;
  readonly releaseCars: Int32Array;
  readonly releaseAt: Float64Array;
  readonly leaving: Int32Array;
  readonly crossingBlocked: Uint8Array;
  readonly pedOnCrossing: Uint8Array;
  readonly scalars: Float64Array;
}

export interface PackedInts {
  readonly data: Float64Array;
  readonly offsets: Int32Array;
}

function packInts(lists: readonly (readonly number[])[]): PackedInts {
  return packFloats(lists);
}

function packFloats(lists: readonly (readonly number[])[]): PackedInts {
  const offsets = new Int32Array(lists.length + 1);
  for (let k = 0; k < lists.length; k++) offsets[k + 1] = (offsets[k] as number) + (lists[k] as readonly number[]).length;
  const data = new Float64Array(offsets[lists.length] as number);
  for (let k = 0; k < lists.length; k++) data.set(lists[k] as readonly number[], offsets[k] as number);
  return { data, offsets };
}

function unpackInto(p: PackedInts, into: number[][]): void {
  if (p.offsets.length !== into.length + 1) throw new RangeError("The checkpoint does not match this run");
  for (let k = 0; k < into.length; k++) {
    const list = into[k] as number[];
    list.length = 0;
    for (let i = p.offsets[k] as number; i < (p.offsets[k + 1] as number); i++) list.push(p.data[i] as number);
  }
}

/**
 * Where segment p0→p1 crosses segment q0→q1: the fraction along p (0..1), or −1 if they do not cross.
 */
function segmentIntersection(p0x: number, p0y: number, p1x: number, p1y: number, q0x: number, q0y: number, q1x: number, q1y: number): number {
  const rx = p1x - p0x;
  const ry = p1y - p0y;
  const sx = q1x - q0x;
  const sy = q1y - q0y;
  const den = rx * sy - ry * sx;
  if (den === 0) return -1;
  const qpx = q0x - p0x;
  const qpy = q0y - p0y;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

export { polylineLength };
