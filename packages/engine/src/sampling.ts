/**
 * Connects the schema's Distribution documents to the samplers in distributions.ts.
 *
 * A sampler draws for one entity and one draw number: sample(entity, n). The same (entity, n)
 * always returns the same value for a given seed and stream (decision D-003).
 */

import type { Distribution } from "@bottleneck/schema";
import { ln } from "./detmath.ts";
import { sampleExponential, sampleNormal, sampleShiftedLognormal, sampleUniform, shiftedLognormalMoments } from "./distributions.ts";
import { uniform } from "./rng.ts";

export type Sampler = (entity: number, n: number) => number;

/** Rejection sampling uses up to this many indices per draw, so draw n starts at index n × 16. */
const INDICES_PER_DRAW = 16;

export function makeSampler(distribution: Distribution, seed: number, stream: number): Sampler {
  const d = distribution;
  switch (d.kind) {
    case "fixed":
      return () => d.value;
    case "uniform":
      return (entity, n) => sampleUniform(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.min, d.max);
    case "exponential":
      return (entity, n) => sampleExponential(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.mean);
    case "truncatedNormal":
      return (entity, n) => {
        for (let attempt = 0; attempt < INDICES_PER_DRAW; attempt++) {
          const x = sampleNormal(uniform(seed, stream, entity, n * INDICES_PER_DRAW + attempt), d.mean, d.sd);
          if (x >= d.min && x <= d.max) return x;
        }
        return Math.min(d.max, Math.max(d.min, d.mean));
      };
    case "shiftedLognormal":
      return (entity, n) => sampleShiftedLognormal(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.shift, d.mu, d.sigma);
  }
}

/** E[X] and E[X²] of a distribution (the truncated normal is approximated by its untruncated moments). */
export function distributionMoments(d: Distribution): { mean: number; secondMoment: number } {
  switch (d.kind) {
    case "fixed":
      return { mean: d.value, secondMoment: d.value * d.value };
    case "uniform":
      return { mean: (d.min + d.max) / 2, secondMoment: (d.min * d.min + d.min * d.max + d.max * d.max) / 3 };
    case "exponential":
      return { mean: d.mean, secondMoment: 2 * d.mean * d.mean };
    case "truncatedNormal":
      return { mean: d.mean, secondMoment: d.mean * d.mean + d.sd * d.sd };
    case "shiftedLognormal":
      return shiftedLognormalMoments(d.shift, d.mu, d.sigma);
  }
}

/**
 * Builds a shifted lognormal from friendly numbers: the minimum, the mean and the coefficient of
 * variation of the part above the minimum. Presets use this to turn "2.5 s minimum, 4 s mean" into
 * exact (shift, mu, sigma) parameters.
 */
export function shiftedLognormalFromMean(min: number, mean: number, sigma: number): Distribution {
  // E[e^N] = exp(mu + sigma²/2) must equal mean − min, so mu = ln(mean − min) − sigma²/2.
  return { kind: "shiftedLognormal", shift: min, mu: ln(mean - min) - (sigma * sigma) / 2, sigma };
}
