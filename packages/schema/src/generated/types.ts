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
 * A random quantity, such as a service time in seconds or a walking speed in m/s.
 */
export type Distribution =
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
 * The line the lanes of a gate group or screening stage stand on. Lanes are spaced evenly along it. People pass from the right-hand side of a→b to the left-hand side (the inside).
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
 * Scenario-scope assumptions (spec section 5). Missing values use the built-in defaults; the run stores the full resolved set.
 */
export interface ScenarioParameters {
  freeWalkingSpeed?: Distribution;
  nearestLaneShare?: Probability;
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
 * The stored result of one seeded run: metrics plus everything needed to reproduce it, not every frame. The metrics shape is filled in during Phase 1. scenario is a full copy of the scenario as it was run (it includes the seed).
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
  /**
   * The full resolved parameter set (defaults plus overrides) the run used.
   */
  parameters: {
    [k: string]: unknown | undefined;
  };
  /**
   * Run metrics (spec section 4.5). Structure defined in Phase 1.
   */
  metrics: {
    [k: string]: unknown | undefined;
  };
  /**
   * Hash of the canonical Float64 dump of the metrics (determinism check).
   */
  metricsHash: string;
}
