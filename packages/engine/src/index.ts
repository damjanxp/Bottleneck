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
