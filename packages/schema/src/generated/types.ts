/* eslint-disable */
// GENERATED FILE - do not edit by hand.
// Source: /schema/*.schema.json. Regenerate with: npm run schema:gen

/**
 * Element or document id: letters, digits, '-' and '_', starting with a letter or digit.
 */
export type Id = string;
export type Name = string;
/**
 * A closed polygon outline. The last point connects back to the first; do not repeat it.
 *
 * @minItems 3
 * @maxItems 2000
 */
export type Ring = Point[];
/**
 * A random quantity, such as a service time in seconds or a walking speed in m/s: one of the base kinds, or a mixture of them.
 */
export type Distribution = BaseDistribution | MixtureDistribution;
/**
 * A single (non-mixture) distribution.
 */
export type BaseDistribution =
  | FixedDistribution
  | UniformDistribution
  | ExponentialDistribution
  | TruncatedNormalDistribution
  | ShiftedLognormalDistribution;
export type Probability = number;
/**
 * Picks the arrival preset and which headline metrics apply. 'fair' is open-door (no fixed start).
 */
export type EventType = "concert" | "stadium" | "fair" | "conference";
/**
 * Simulated time in seconds. Absolute times are relative to the scenario's t = 0 (see Scenario.timeline).
 */
export type Seconds = number;
/**
 * Bag policy at the screening stages; picks their service time (assumed values): 'none' (walk-through only, mean 2.5 s, at least 1.5 s), 'clearBag' (clear bags only, mean 4 s, at least 2 s), 'fullSearch' (every bag searched, mean 10 s, at least 4 s). Unset: the venue's own screening times. An element override's serviceTime still wins.
 */
export type BagPolicy = "none" | "clearBag" | "fullSearch";
export type TimedEvent = LaneFailEvent | LaneReopenEvent | BusBurstEvent;

/**
 * Every document type in /schema. Generated only to emit all types into one file.
 */
export interface SchemaBundle {
  venue?: Venue;
  scenario?: Scenario;
  run?: RunRecord;
}
/**
 * One site: background image, scale and every drawn element. Geometry is stored in metres, never pixels. Vehicle elements (roads, barriers, lots, crossings) are added in Phase 3.
 */
export interface Venue {
  schemaVersion: 1;
  id?: Id;
  name: Name;
  description?: string;
  /**
   * Credit for the map the venue was drawn from, e.g. '© OpenStreetMap contributors'.
   */
  attribution?: string;
  background?: Background;
  parameters?: VenueParameters;
  /**
   * @maxItems 500
   */
  walkableAreas: WalkableArea[];
  /**
   * @maxItems 2000
   */
  obstacles: Obstacle[];
  /**
   * @maxItems 200
   */
  sources: PedestrianSource[];
  /**
   * @maxItems 100
   */
  screeningStages: ScreeningStage[];
  /**
   * @maxItems 100
   */
  gateGroups: GateGroup[];
  /**
   * @maxItems 100
   */
  destinations: Destination[];
}
/**
 * The map image the venue is drawn on. Display only: the simulation never reads it. origin is where the image top-left corner sits, in venue metres.
 */
export interface Background {
  /**
   * Relative path (examples) or stored upload name (backend).
   */
  image: string;
  widthPx: number;
  heightPx: number;
  metresPerPixel: number;
  origin: Point;
}
/**
 * A position in metres in the venue's own coordinate system (x to the right, y down, like the background image).
 */
export interface Point {
  x: number;
  y: number;
}
/**
 * Venue-scope assumptions (spec section 5). Missing values use the built-in defaults.
 */
export interface VenueParameters {
  speedDensity?: {
    gamma: number;
    /**
     * people per m²
     */
    rhoMax: number;
  };
}
/**
 * Where pedestrians may walk. Everything else blocks them; holes are obstacles.
 */
export interface WalkableArea {
  id: Id;
  name?: Name;
  polygon: Polygon;
}
export interface Polygon {
  outer: Ring;
  /**
   * @maxItems 200
   */
  holes?: Ring[];
}
/**
 * An area pedestrians cannot enter, even inside a walkable area.
 */
export interface Obstacle {
  id: Id;
  name?: Name;
  polygon: Polygon;
}
/**
 * Where pedestrians appear: a bus or tram stop, a street entrance.
 */
export interface PedestrianSource {
  id: Id;
  name: Name;
  position: Point;
  /**
   * Relative weight of arrivals from this source (weights are normalised over all pedestrian sources).
   */
  share: number;
}
/**
 * Security or bag-check lanes in front of one or more gate groups.
 */
export interface ScreeningStage {
  id: Id;
  name: Name;
  line: LaneLine;
  laneCount: number;
  /**
   * Length of each lane's queue area in metres.
   */
  queueLength: number;
  serviceTime: Distribution;
}
/**
 * The line the lanes of a gate group or screening stage stand on. Lanes are spaced evenly along it. People pass from the outside to the inside. The inside is the side where cross(b − a, p − a) > 0: in the venue's y-down picture, the right-hand side when looking from a towards b.
 */
export interface LaneLine {
  a: Point;
  b: Point;
}
/**
 * Always the same value.
 */
export interface FixedDistribution {
  kind: "fixed";
  value: number;
}
export interface UniformDistribution {
  kind: "uniform";
  min: number;
  max: number;
}
export interface ExponentialDistribution {
  kind: "exponential";
  mean: number;
}
/**
 * Normal(mean, sd) limited to [min, max] by redrawing.
 */
export interface TruncatedNormalDistribution {
  kind: "truncatedNormal";
  mean: number;
  sd: number;
  min: number;
  max: number;
}
/**
 * shift + e^N with N ~ Normal(mu, sigma). Never below shift, with a long right tail. mu and sigma are the parameters of the underlying normal, so E[S] and E[S²] are exact (needed for the Pollaczek-Khinchine test).
 */
export interface ShiftedLognormalDistribution {
  kind: "shiftedLognormal";
  shift: number;
  mu: number;
  sigma: number;
}
/**
 * A weighted mix of base distributions, e.g. turnstile scans that are 50% card (about 3 s) and 50% phone QR code (about 4.5 s). Each draw first picks a component with probability weight / (sum of weights), then draws from it. E[S] and E[S²] are the weighted averages of the components' moments, so they stay exact.
 */
export interface MixtureDistribution {
  kind: "mixture";
  /**
   * @minItems 1
   * @maxItems 8
   */
  components: MixtureComponent[];
}
export interface MixtureComponent {
  weight: number;
  distribution: BaseDistribution;
}
/**
 * A group of identical turnstile lanes between outside and inside. screeningStageId names the screening stage people pass before these gates, if any.
 */
export interface GateGroup {
  id: Id;
  name: Name;
  screeningStageId?: Id;
  line: LaneLine;
  laneCount: number;
  /**
   * Length of each lane's queue area in metres.
   */
  queueLength: number;
  serviceTime: Distribution;
  scanFailure: {
    rate: Probability;
    retryTime: Distribution;
  };
}
/**
 * Where pedestrians go once inside (hall, stage). They finish when they reach it.
 */
export interface Destination {
  id: Id;
  name: Name;
  area: Polygon;
}
/**
 * All inputs for one run against a venue. Times are seconds relative to t = 0; for fixed-start events t = 0 is the event start, for open-door events it is the opening time.
 */
export interface Scenario {
  schemaVersion: 1;
  id?: Id;
  venueId: Id;
  name: Name;
  eventType: EventType;
  timeline: Timeline;
  attendance: number;
  carShare: Probability;
  arrivals: DemandCurve;
  departures?: DemandCurve;
  seed: number;
  parameters?: ScenarioParameters;
  /**
   * Per-element changes, keyed by element id (e.g. a different lane count for gate group 'gate-b').
   */
  overrides?: {
    [k: string]: ElementOverride | undefined;
  };
  /**
   * @maxItems 500
   */
  timedEvents?: TimedEvent[];
}
/**
 * horizon: the run stops here even if people are still queuing (it then reports not drained). eventStart is null for open-door events.
 */
export interface Timeline {
  /**
   * Wall-clock time of t = 0 for display, 24-hour 'HH:MM'.
   */
  referenceClock: string;
  gatesOpen: Seconds;
  /**
   * Fixed start, or null for open-door events.
   */
  eventStart: Seconds | null;
  eventEnd: Seconds;
  horizon: Seconds;
}
/**
 * How arrivals (or departures) spread over time: a named preset, optionally replaced by points that the UI smooths into a curve.
 */
export interface DemandCurve {
  preset: "concert" | "stadium" | "fair" | "conference" | "custom";
  /**
   * @minItems 2
   * @maxItems 200
   */
  points?: {
    t: Seconds;
    weight: number;
  }[];
}
/**
 * Scenario-scope assumptions (spec section 5). Missing values use the built-in defaults (all assumed); the run stores the full resolved set. nearestLaneShare: share of people who take the lane with the shortest walk instead of choosing by expected cost (default 0.3). manualLaneServiceTime: service time at a gate group manual lane, used after a second scan failure (default uniform 20-40 s). shareInsideAt: reference time T of the share-inside-by-T metric, in scenario seconds (default 10 minutes before a fixed start, or 1 hour after the gates open for open-door events).
 */
export interface ScenarioParameters {
  freeWalkingSpeed?: Distribution;
  nearestLaneShare?: Probability;
  /**
   * People choose a lane once the walk to the nearest lane of their stage is at most this many metres (default 20, assumed).
   */
  decisionDistance?: number;
  /**
   * Logit scale τ of the lane choice in seconds: a lane whose walk plus expected wait costs τ seconds more is e times less likely to be chosen (default 15, assumed).
   */
  logitScale?: number;
  /**
   * Distance between people standing in a queue line, in metres (default 0.6, assumed).
   */
  slotSpacing?: number;
  /**
   * A queued person switches lane (at most once per stage) only to a lane with at least this many fewer people (default 3, assumed).
   */
  jockeyThreshold?: number;
  manualLaneServiceTime?: Distribution;
  /**
   * Deadlock watchdog: the run stops if nothing changes for this many simulated minutes (default 10).
   */
  watchdogMinutes?: number;
  shareInsideAt?: Seconds;
  /**
   * People arrive in groups that walk together and choose the same lane. groupSizes[k] is the relative frequency of groups of k + 1 people (default [0.30, 0.40, 0.15, 0.10, 0.05] for sizes 1-5, assumed). [1] means everyone arrives alone.
   *
   * @minItems 1
   * @maxItems 8
   */
  groupSizes?: number[];
  bagPolicy?: BagPolicy;
}
export interface ElementOverride {
  laneCount?: number;
  serviceTime?: Distribution;
  scanFailureRate?: Probability;
}
export interface LaneFailEvent {
  kind: "laneFail";
  at: Seconds;
  groupId: Id;
  laneIndex: number;
}
export interface LaneReopenEvent {
  kind: "laneReopen";
  at: Seconds;
  groupId: Id;
  laneIndex: number;
}
/**
 * N people appear at once at a source (a full bus or tram arriving).
 */
export interface BusBurstEvent {
  kind: "busBurst";
  at: Seconds;
  sourceId: Id;
  count: number;
}
/**
 * The stored result of one seeded run: metrics plus everything needed to reproduce it, not every frame. scenario is a full copy of the scenario as it was run (it includes the seed). Lane windows are engine times (seconds from the start of the run); other times are scenario times (engine time + parameters.timeOffset).
 */
export interface RunRecord {
  schemaVersion: 1;
  id?: Id;
  engineVersion: string;
  createdAt: string;
  /**
   * 'job' runs were computed by the backend and are trusted; 'clientReported' runs were uploaded from a browser.
   */
  origin: "job" | "clientReported";
  scenario: Scenario;
  /**
   * Hash of the venue geometry the run used, so comparisons can tell whether runs share a venue.
   */
  venueHash: string;
  parameters: ResolvedParameters;
  metrics: RecordedMetrics;
  /**
   * Hash of the canonical Float64 dump of the metrics (determinism check).
   */
  metricsHash: string;
}
/**
 * The full parameter set a run used: built-in defaults (assumed) plus the venue's and scenario's values.
 */
export interface ResolvedParameters {
  seed: number;
  attendance: number;
  /**
   * Scenario time of engine time 0.
   */
  timeOffset: number;
  horizon: number;
  gatesOpen: number;
  eventStart: number | null;
  freeWalkingSpeed: Distribution;
  nearestLaneShare: number;
  speedDensity: SpeedDensity;
  decisionDistance: number;
  logitScale: number;
  slotSpacing: number;
  jockeyThreshold: number;
  manualLaneServiceTime: Distribution;
  densitySigma: number;
  watchdogMinutes: number;
  queueSampleInterval: number;
  throughputBin: number;
  /**
   * Scenario time T of the share-inside-by-T metric.
   */
  shareInsideAt: number;
  /**
   * Relative frequency of groups of 1, 2, ... people.
   */
  groupSizes: number[];
  /**
   * Bag policy at the screening stages, or null for the venue's own screening times.
   */
  bagPolicy: BagPolicy | null;
  arrivalCurve: ArrivalCurvePoint[];
  elements: ResolvedElement[];
}
/**
 * Weidmann speed-density parameters.
 */
export interface SpeedDensity {
  gamma: number;
  rhoMax: number;
}
export interface ArrivalCurvePoint {
  t: number;
  weight: number;
}
/**
 * A screening stage or gate group as the run used it (overrides and bag policy applied).
 */
export interface ResolvedElement {
  id: Id;
  kind: "screening" | "gate";
  laneCount: number;
  queueLength: number;
  serviceTime: Distribution;
  scanFailureRate: number;
  retryTime: Distribution | null;
  /**
   * Expected time a lane is busy per person, including scan retries (s).
   */
  meanBusyTime: number;
}
/**
 * Run metrics (spec section 4.5).
 */
export interface RecordedMetrics {
  agentCount: number;
  drained: boolean;
  deadlock: boolean;
  /**
   * Scenario time the metrics were taken at.
   */
  time: number;
  /**
   * Agents per AgentState (Pending, Walking, Queuing, InService, Inside, Driving, Parked, Departed, TurnedAway, Diverted).
   */
  countsByState: number[];
  unreachable: number;
  lanes: LaneReport[];
  elements: ElementReport[];
  peakHour: PeakHour;
  meanWait: number;
  p95Wait: number;
  shareInside: ShareInside;
  /**
   * Fixed-start events: people whose gate service starts after the event start, or never (spec 4.5). Null for open-door events.
   */
  stillOutsideAtStart: number | null;
  /**
   * The part of stillOutsideAtStart that had already arrived on site by the event start.
   */
  arrivedButOutsideAtStart: number | null;
  /**
   * The part of stillOutsideAtStart that arrived after the event start.
   */
  notYetArrivedAtStart: number | null;
  density: DensitySummary;
}
/**
 * One lane: a regular lane of a screening stage or gate group, or a gate group's manual lane.
 */
export interface LaneReport {
  laneId: number;
  elementId: Id;
  elementKind: "screening" | "gate";
  laneIndex: number;
  /**
   * True for a gate group's manual lane: people whose scan failed twice are sent there, nobody chooses it.
   */
  manual: boolean;
  /**
   * 'manual' for a gate group's manual lane, otherwise 'regular'.
   */
  laneType: "regular" | "manual";
  metrics: LaneMetrics;
  queueWait: WaitStats;
  /**
   * Services that started before the event start; null for open-door events.
   */
  beforeStart: LanePeriod | null;
  /**
   * Services that started at or after the event start; null for open-door events.
   */
  afterStart: LanePeriod | null;
  /**
   * People served per throughputBin seconds, bins from engine time 0.
   */
  throughput: number[];
  /**
   * Queue length (excluding the one in service) every queueSampleInterval seconds from engine time one interval.
   */
  queueLength: number[];
}
/**
 * Queueing statistics of one lane over its reporting window (first commitment to last service start, engine time). Waits (Wq) run from commitment to the lane to service start.
 */
export interface LaneMetrics {
  arrivals: number;
  started: number;
  served: number;
  windowStart: number;
  windowEnd: number;
  meanWait: number;
  p95Wait: number;
  maxWait: number;
  meanQueue: number;
  maxQueue: number;
  arrivalRate: number;
  utilisation: number;
  failedTime: number;
  queuedAtWindowEnd: number;
  littleLawError: number;
}
/**
 * Waits measured from physically joining the line (reaching the queue area, or the spill-back behind it) to service start, in seconds.
 */
export interface WaitStats {
  count: number;
  mean: number;
  p95: number;
  max: number;
}
/**
 * A lane's services on one side of the event start (spec 4.5).
 */
export interface LanePeriod {
  started: number;
  meanWait: number;
  p95Wait: number;
  maxWait: number;
  queueWait: WaitStats;
  /**
   * Busy time / open time of the lane within its reporting window on this side of the event start.
   */
  utilisation: number;
}
/**
 * Capacity against demand for one screening stage or gate group (review E1).
 */
export interface ElementReport {
  elementId: Id;
  kind: "screening" | "gate";
  laneCount: number;
  /**
   * Expected time a lane is busy per person, including scan retries (s).
   */
  meanBusyTime: number;
  /**
   * laneCount × 3600 / meanBusyTime: people per hour the regular lanes can serve.
   */
  capacityPerHour: number;
  /**
   * Most people choosing this element within any 60-minute window (1-minute steps).
   */
  peakDemandPerHour: number;
  /**
   * Scenario time at which that window starts; null if nobody came.
   */
  peakDemandStart: number | null;
  /**
   * Busy time / open time of the regular lanes per throughputBin, bins from engine time 0.
   */
  utilisation: number[];
  /**
   * Highest utilisation over a 5-bin window.
   */
  peakUtilisation: number;
  /**
   * Scenario time at the end of that window; null if the lanes were never busy.
   */
  peakUtilisationAt: number | null;
  /**
   * Scenario time at the end of the first 5-bin window after the peak with utilisation below 85%: when the crunch is over. Null if the peak stayed under 85% or utilisation did not fall below it before the run ended.
   */
  below85At: number | null;
}
/**
 * The 60-minute window (scenario time, 1-minute steps) with the most arrivals, and the nearest-rank p95 total wait of the people who arrived in it.
 */
export interface PeakHour {
  start: number;
  end: number;
  arrivals: number;
  p95Wait: number;
}
/**
 * Share of all agents inside (at a destination) by scenario time `time`.
 */
export interface ShareInside {
  time: number;
  share: number;
}
/**
 * Time-aggregated density (people/m²) on the 2 m density grid, row-major cols × rows.
 */
export interface DensitySummary {
  cols: number;
  rows: number;
  cellSize: number;
  mean: number[];
  max: number[];
}
