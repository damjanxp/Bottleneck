/**
 * Agents as a structure of arrays (one typed array per attribute, indexed by agent id).
 *
 * Typed arrays keep 10,000+ agents cache-friendly and make the renderer snapshot a plain copy.
 * Every agent is created up front (as Pending) with all its personal random draws, and is in
 * exactly one AgentState at any time, so the counts per state always sum to the number of agents
 * created (conservation, invariant 7.1-3).
 */

/**
 * The one agent state enum, shared by people and cars (vehicles.ts keeps the cars' own counts).
 * People: Pending (not arrived yet, or still in the car they came in), Walking, Queuing, InService,
 * Inside, Driving (back in their car on the way out), Departed (left the site), TurnedAway.
 * Cars: Pending, Driving, Parked, Departed, TurnedAway, Diverted (driving to its second lot, A3).
 */
export const AgentState = {
  /** Created, not yet arrived (or an occupant still in the car, review A4). */
  Pending: 0,
  /** Walking on the flow fields: to a lane decision point, or inside towards a destination. */
  Walking: 1,
  /** Committed to a lane and waiting for service (walking to the line, in the line, or spilled back). */
  Queuing: 2,
  /** Being served at a lane. */
  InService: 3,
  /** Reached a destination: done. */
  Inside: 4,
  /** A car on the road or in an aisle; a person aboard a car that is leaving. */
  Driving: 5,
  /** A car in its stall. */
  Parked: 6,
  /** Left the site: on foot past their source, or in a car that drove off. */
  Departed: 7,
  /** Gave up or could not reach any lane or destination: done. */
  TurnedAway: 8,
  /** A car redirected once to another lot, while it drives there. */
  Diverted: 9,
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];
export const AGENT_STATE_COUNT = 10;
export const AGENT_STATE_NAMES = ["Pending", "Walking", "Queuing", "InService", "Inside", "Driving", "Parked", "Departed", "TurnedAway", "Diverted"] as const;

/** What a Walking or Queuing agent is doing right now (finer than the state, engine-internal). */
export const Mode = {
  /** Walking towards the lanes of its current stage, not yet committed. */
  Approach: 0,
  /** Committed, walking towards the back of its lane's line (or waiting near it if it is full). */
  ToLine: 1,
  /** Standing in the lane's physical queue area. */
  InLine: 2,
  /** In service at the lane's service point. */
  Service: 3,
  /** Through the gates, walking to a destination. */
  ToDestination: 4,
  /** Committed nowhere because every lane of its stage has failed; retried each tick. */
  NoLane: 5,
  Done: 6,
  /** Out of the car: walking straight from the stall to the lot's walking exit (off the walking grid). */
  ExitCar: 7,
  /** Departing on foot: walking back to the source they came from. */
  ToHome: 8,
  /** Departing by car: walking to the lot's walking exit (after the pay station, if any). */
  ToLot: 9,
  /** Departing by car: walking straight from the walking exit to the car (off the grid). */
  ToCar: 10,
} as const;

/** Which part of the journey an agent is in. */
export const Stage = {
  /** Before the first lanes (screening, or gates if there is no screening). */
  Entry: 0,
  /** Through screening, before the gates. */
  Gates: 1,
  /** Through the gates. */
  Inside: 2,
  /** On the way out (departures; a driver's visit to the pay station happens at this stage). */
  Leaving: 3,
} as const;

/** Every per-agent array of AgentStore, in a fixed order (run checkpoints copy them by name). */
export const AGENT_ARRAYS = [
  "x",
  "y",
  "vx",
  "vy",
  "arrivalTime",
  "freeSpeed",
  "source",
  "offsetX",
  "offsetY",
  "state",
  "mode",
  "stage",
  "stageSet",
  "lane",
  "queuePos",
  "ready",
  "jockeyed",
  "waitStart",
  "totalWait",
  "gateStart",
  "insideTime",
  "group",
  "lineJoin",
  "demandCounted",
  "car",
  "departTime",
  "departDue",
  "tx",
  "ty",
] as const;
export type AgentArrayName = (typeof AGENT_ARRAYS)[number];

export class AgentStore {
  readonly count: number;
  // Kinematics (Float64 for exact, platform-independent arithmetic; snapshots convert to Float32).
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  // Personal draws, fixed at creation.
  readonly arrivalTime: Float64Array;
  readonly freeSpeed: Float64Array;
  readonly source: Int32Array;
  readonly offsetX: Float64Array;
  readonly offsetY: Float64Array;
  // State.
  readonly state: Uint8Array;
  readonly mode: Uint8Array;
  readonly stage: Uint8Array;
  /** Stage set (group of lane elements) the agent is heading for. */
  readonly stageSet: Int32Array;
  /** Lane the agent is committed to or served at, −1 if none. */
  readonly lane: Int32Array;
  /** Position in the lane's FIFO (0 = next), refreshed every tick; −1 if not queued. */
  readonly queuePos: Int32Array;
  readonly ready: Uint8Array;
  readonly jockeyed: Uint8Array;
  // Timing for metrics.
  /** Start of the current stage's wait (first commit at this stage), NaN if not waiting. */
  readonly waitStart: Float64Array;
  /** Sum of completed waits over all stages, seconds. */
  readonly totalWait: Float64Array;
  /** First gate service start (engine time), NaN if none yet. */
  readonly gateStart: Float64Array;
  /** Time the agent reached a destination (engine time), NaN if not yet. */
  readonly insideTime: Float64Array;
  /** Group: the id of the group's first member (its leader); the agent's own id when alone. */
  readonly group: Int32Array;
  /** When the agent physically joined its current lane's line (queue area or spill-back), NaN if not (yet). */
  readonly lineJoin: Float64Array;
  /** Stage + 1 of the last stage at which the agent was counted as demand for an element, 0 if none. */
  readonly demandCounted: Uint8Array;
  /** The car the person came in (and leaves in), −1 for people on foot. */
  readonly car: Int32Array;
  /** Engine time the person wants to leave (departures), Infinity if never. */
  readonly departTime: Float64Array;
  /** 1 if the departure time came before the person was inside: they leave on arrival. */
  readonly departDue: Uint8Array;
  /** Target of a straight walk off the grid (ExitCar, ToCar), local metres. */
  readonly tx: Float64Array;
  readonly ty: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
    this.vx = new Float64Array(count);
    this.vy = new Float64Array(count);
    this.arrivalTime = new Float64Array(count);
    this.freeSpeed = new Float64Array(count);
    this.source = new Int32Array(count);
    this.offsetX = new Float64Array(count);
    this.offsetY = new Float64Array(count);
    this.state = new Uint8Array(count);
    this.mode = new Uint8Array(count);
    this.stage = new Uint8Array(count);
    this.stageSet = new Int32Array(count);
    this.lane = new Int32Array(count).fill(-1);
    this.queuePos = new Int32Array(count).fill(-1);
    this.ready = new Uint8Array(count);
    this.jockeyed = new Uint8Array(count);
    this.waitStart = new Float64Array(count).fill(NaN);
    this.totalWait = new Float64Array(count);
    this.gateStart = new Float64Array(count).fill(NaN);
    this.insideTime = new Float64Array(count).fill(NaN);
    this.group = Int32Array.from({ length: count }, (_, i) => i);
    this.lineJoin = new Float64Array(count).fill(NaN);
    this.demandCounted = new Uint8Array(count);
    this.car = new Int32Array(count).fill(-1);
    this.departTime = new Float64Array(count).fill(Infinity);
    this.departDue = new Uint8Array(count);
    this.tx = new Float64Array(count);
    this.ty = new Float64Array(count);
  }
}
