/**
 * @bottleneck/engine — public API.
 *
 * Pure TypeScript: no DOM, no network, no clock, no Math.random. The same code runs in the
 * browser's Web Worker and headless in Node, and produces bit-identical results in both.
 */

export const ENGINE_VERSION = "0.0.1";

export { exp, ldexp, ln, powPositive } from "./detmath.ts";
export {
  normalInverseCdf,
  sampleCategorical,
  sampleExponential,
  sampleNormal,
  sampleShiftedLognormal,
  sampleTruncatedNormal,
  sampleUniform,
  shiftedLognormalMoments,
} from "./distributions.ts";
export { EventQueue, type SimEvent } from "./eventQueue.ts";
export { Float64Hasher, hashFloat64 } from "./hash.ts";
export { MAX_SPEED, MIN_SPEED, PlaybackPacer } from "./playback.ts";
export { RandomCursor, RandomStream, hash4, mix32, toSeed, uniform } from "./rng.ts";
export { EXPECTED_SELF_CHECK_HASH, runSelfCheck, type SelfCheckResult } from "./selfCheck.ts";
export { Simulation, TICK_SECONDS, type EventHandler, type TickSystem } from "./simulation.ts";
export { EventKind, LaneBank, percentileNearestRank, type LaneCallbacks, type LaneMetrics, type ServiceOutcome } from "./lanes.ts";
export { distributionMoments, makeSampler, shiftedLognormalFromMean, type Sampler } from "./sampling.ts";
export { AGENT_STATE_COUNT, AGENT_STATE_NAMES, AgentState } from "./agents.ts";
export { PiecewiseLinearCurve, resolveArrivalPoints, type CurvePoint } from "./arrivals.ts";
export { DENSITY_CELL, weidmannFactor } from "./density.ts";
export { CELL_SIZE } from "./geometry.ts";
export {
  RUN_DEFAULTS,
  SNAPSHOT_FIELDS,
  SnapshotField,
  createRun,
  hashMetrics,
  snapshotLength,
  type LaneLayout,
  type LaneLive,
  type LaneReport,
  type LiveDensity,
  type ResolvedParameters,
  type Run,
  type RunDebug,
  type RunMetrics,
  type RunOptions,
} from "./run.ts";
