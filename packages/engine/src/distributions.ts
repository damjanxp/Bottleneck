/**
 * Probability distributions, all driven by uniforms from rng.ts and math from detmath.ts.
 *
 * Each sampler takes the uniform number(s) it needs instead of a generator, so the caller decides
 * which (stream, entity, index) every draw comes from. Single-uniform samplers use the inverse
 * CDF, so one random number always produces one sample.
 */

import { exp, ln } from "./detmath.ts";
import type { RandomCursor } from "./rng.ts";

/** Uniform on [min, max). */
export function sampleUniform(u: number, min: number, max: number): number {
  return min + (max - min) * u;
}

/** Exponential with the given mean (e.g. Poisson inter-arrival times). */
export function sampleExponential(u: number, mean: number): number {
  return -mean * ln(u);
}

// Coefficients of Peter Acklam's rational approximation of the standard normal inverse CDF.
// Relative error below 1.15e-9 over the whole range, which is plenty for a simulation.
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/** Standard normal inverse CDF: the z with P(Z ≤ z) = p, for p in (0, 1). */
export function normalInverseCdf(p: number): number {
  const [a0, a1, a2, a3, a4, a5] = A as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = B as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = C as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = D as [number, number, number, number];

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * ln(p));
    return (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  if (p > P_HIGH) {
    const q = Math.sqrt(-2 * ln(1 - p));
    return -(((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) / ((((d0 * q + d1) * q + d2) * q + d3) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) / (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
}

/** Normal with the given mean and standard deviation. */
export function sampleNormal(u: number, mean: number, sd: number): number {
  return mean + sd * normalInverseCdf(u);
}

/**
 * Normal truncated to [min, max], by rejection: draw until a value lands inside.
 * With the default walking-speed bounds (−3.2σ to +3.6σ) more than 99.8% of first draws are
 * accepted. After 64 rejections (practically impossible for sensible bounds) the value is clamped,
 * so the sampler always terminates.
 */
export function sampleTruncatedNormal(cursor: RandomCursor, mean: number, sd: number, min: number, max: number): number {
  for (let attempt = 0; attempt < 64; attempt++) {
    const x = sampleNormal(cursor.next(), mean, sd);
    if (x >= min && x <= max) return x;
  }
  return Math.min(max, Math.max(min, mean));
}

/**
 * Shifted lognormal: shift + e^N where N ~ Normal(mu, sigma).
 * Used for service times: never below `shift`, with a long right tail (a slow scan now and then).
 */
export function sampleShiftedLognormal(u: number, shift: number, mu: number, sigma: number): number {
  return shift + exp(mu + sigma * normalInverseCdf(u));
}

/** E[S] and E[S²] of a shifted lognormal, needed for the Pollaczek–Khinchine formula. */
export function shiftedLognormalMoments(shift: number, mu: number, sigma: number): { mean: number; secondMoment: number } {
  const m1 = exp(mu + (sigma * sigma) / 2); // E[e^N]
  const m2 = exp(2 * mu + 2 * sigma * sigma); // E[e^2N]
  return {
    mean: shift + m1,
    secondMoment: shift * shift + 2 * shift * m1 + m2,
  };
}

/** Picks an index from non-negative weights (they need not sum to 1). */
export function sampleCategorical(u: number, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let target = u * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] as number;
    if (target < 0) return i;
  }
  return weights.length - 1;
}
