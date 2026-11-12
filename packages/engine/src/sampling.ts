/**
 * Connects the schema's Distribution documents to the samplers in distributions.ts.
 *
 * A sampler draws for one entity and one draw number: sample(entity, n). The same (entity, n)
 * always returns the same value for a given seed and stream (decision D-003).
 */

import type { BaseDistribution, Distribution } from "@bottleneck/schema";
import { ln } from "./detmath.ts";
import { sampleCategorical, sampleExponential, sampleNormal, sampleShiftedLognormal, sampleUniform, shiftedLognormalMoments } from "./distributions.ts";
import { uniform } from "./rng.ts";

export type Sampler = (entity: number, n: number) => number;

/** Rejection sampling uses up to this many indices per draw, so draw n starts at index n × 16. */
const INDICES_PER_DRAW = 16;

export function makeSampler(distribution: Distribution, seed: number, stream: number): Sampler {
  if (distribution.kind !== "mixture") return baseSampler(distribution, seed, stream, INDICES_PER_DRAW);
  // Mixture: the last index of the draw's block picks the component; the component draws from the
  // indices before it (a truncated normal gets one rejection attempt fewer).
  const weights = distribution.components.map((c) => c.weight);
  const parts = distribution.components.map((c) => baseSampler(c.distribution, seed, stream, INDICES_PER_DRAW - 1));
  return (entity, n) => {
    const k = sampleCategorical(uniform(seed, stream, entity, n * INDICES_PER_DRAW + INDICES_PER_DRAW - 1), weights);
    return (parts[k] as Sampler)(entity, n);
  };
}

function baseSampler(d: BaseDistribution, seed: number, stream: number, attempts: number): Sampler {
  switch (d.kind) {
    case "fixed":
      return () => d.value;
    case "uniform":
      return (entity, n) => sampleUniform(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.min, d.max);
    case "exponential":
      return (entity, n) => sampleExponential(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.mean);
    case "truncatedNormal":
      return (entity, n) => {
        for (let attempt = 0; attempt < attempts; attempt++) {
          const x = sampleNormal(uniform(seed, stream, entity, n * INDICES_PER_DRAW + attempt), d.mean, d.sd);
          if (x >= d.min && x <= d.max) return x;
        }
        return Math.min(d.max, Math.max(d.min, d.mean));
      };
    case "shiftedLognormal":
      return (entity, n) => sampleShiftedLognormal(uniform(seed, stream, entity, n * INDICES_PER_DRAW), d.shift, d.mu, d.sigma);
  }
}

/** E[X] and E[X²] of a distribution (the truncated normal is approximated by its untruncated moments; a mixture's are exact given its components'). */
export function distributionMoments(d: Distribution): { mean: number; secondMoment: number } {
  switch (d.kind) {
    case "mixture": {
      // Weighted averages of the components' moments, in component order.
      let total = 0;
      let mean = 0;
      let second = 0;
      for (const c of d.components) {
        const m = distributionMoments(c.distribution);
        total += c.weight;
        mean += c.weight * m.mean;
        second += c.weight * m.secondMoment;
      }
      return total > 0 ? { mean: mean / total, secondMoment: second / total } : { mean: 0, secondMoment: 0 };
    }
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
export function shiftedLognormalFromMean(min: number, mean: number, sigma: number): BaseDistribution {
  // E[e^N] = exp(mu + sigma²/2) must equal mean − min, so mu = ln(mean − min) − sigma²/2.
  return { kind: "shiftedLognormal", shift: min, mu: ln(mean - min) - (sigma * sigma) / 2, sigma };
}

/**
 * Service-time presets (spec section 5; all assumed). The turnstile default follows review E2: half
 * the people scan a card (at least 2 s, mean 3 s), half a phone QR code (at least 2.5 s, mean 4.5 s),
 * so the mean is 3.75 s. The screening presets are the bag policies of review E4.
 */
export const SERVICE_TIME_PRESETS = {
  turnstileCard: shiftedLognormalFromMean(2, 3, 0.5),
  turnstileQr: shiftedLognormalFromMean(2.5, 4.5, 0.5),
  turnstile: {
    kind: "mixture",
    components: [
      { weight: 0.5, distribution: shiftedLognormalFromMean(2, 3, 0.5) as BaseDistribution },
      { weight: 0.5, distribution: shiftedLognormalFromMean(2.5, 4.5, 0.5) as BaseDistribution },
    ],
  } as Distribution,
  /** Bag policy "none": walk-through detector and a glance, no bag check. */
  screeningNone: shiftedLognormalFromMean(1.5, 2.5, 0.5),
  /** Bag policy "clearBag": only clear bags allowed, a quick look. */
  screeningClearBag: shiftedLognormalFromMean(2, 4, 0.5),
  /** Bag policy "fullSearch": every bag opened and searched. */
  screeningFullSearch: shiftedLognormalFromMean(4, 10, 0.6),
} as const;
