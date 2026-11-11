import { describe, expect, it } from "vitest";
import {
  RandomCursor,
  normalInverseCdf,
  sampleCategorical,
  sampleExponential,
  sampleShiftedLognormal,
  sampleTruncatedNormal,
  sampleUniform,
  shiftedLognormalMoments,
  uniform,
} from "../src/index.ts";

const N = 200_000;

function moments(sample: (i: number) => number): { mean: number; sd: number; min: number; max: number } {
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < N; i++) {
    const x = sample(i);
    sum += x;
    sumSq += x * x;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const mean = sum / N;
  return { mean, sd: Math.sqrt(sumSq / N - mean * mean), min, max };
}

describe("normalInverseCdf", () => {
  it("matches known quantiles", () => {
    expect(normalInverseCdf(0.5)).toBeCloseTo(0, 12);
    expect(normalInverseCdf(0.975)).toBeCloseTo(1.959963985, 7);
    expect(normalInverseCdf(0.025)).toBeCloseTo(-1.959963985, 7);
    expect(normalInverseCdf(0.999)).toBeCloseTo(3.090232306, 7);
    expect(normalInverseCdf(1e-9)).toBeCloseTo(-5.997807015, 6);
  });

  it("is antisymmetric around 0.5", () => {
    for (const p of [0.001, 0.01, 0.1, 0.3, 0.49]) {
      expect(normalInverseCdf(p)).toBeCloseTo(-normalInverseCdf(1 - p), 9);
    }
  });
});

describe("samplers", () => {
  it("uniform range has the right mean", () => {
    const m = moments((i) => sampleUniform(uniform(1, 1, i, 0), 2.5, 7));
    expect(m.mean).toBeCloseTo(4.75, 1);
    expect(m.min).toBeGreaterThanOrEqual(2.5);
    expect(m.max).toBeLessThan(7);
  });

  it("exponential has mean and sd equal to its mean parameter", () => {
    const m = moments((i) => sampleExponential(uniform(1, 2, i, 0), 10));
    expect(Math.abs(m.mean - 10) / 10).toBeLessThan(0.01);
    expect(Math.abs(m.sd - 10) / 10).toBeLessThan(0.02);
  });

  it("truncated normal (default walking speed) stays in bounds with the expected mean", () => {
    const m = moments((i) => sampleTruncatedNormal(new RandomCursor(1, 3, i), 1.3, 0.25, 0.5, 2.2));
    expect(m.min).toBeGreaterThanOrEqual(0.5);
    expect(m.max).toBeLessThanOrEqual(2.2);
    // Truncation at −3.2σ / +3.6σ barely moves the mean or the sd.
    expect(m.mean).toBeCloseTo(1.3, 2);
    expect(m.sd).toBeCloseTo(0.25, 2);
  });

  it("shifted lognormal matches its analytic mean and second moment", () => {
    const shift = 2.5;
    const mu = 0.2;
    const sigma = 0.6;
    const m = moments((i) => sampleShiftedLognormal(uniform(1, 4, i, 0), shift, mu, sigma));
    const analytic = shiftedLognormalMoments(shift, mu, sigma);
    expect(m.min).toBeGreaterThan(shift);
    expect(Math.abs(m.mean - analytic.mean) / analytic.mean).toBeLessThan(0.005);
    const secondMoment = m.sd * m.sd + m.mean * m.mean;
    expect(Math.abs(secondMoment - analytic.secondMoment) / analytic.secondMoment).toBeLessThan(0.02);
  });

  it("categorical follows its weights", () => {
    const weights = [0.35, 0.35, 0.18, 0.12];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const k = sampleCategorical(uniform(1, 10, i, 0), weights);
      counts[k] = (counts[k] as number) + 1;
    }
    counts.forEach((c, k) => expect(c / N).toBeCloseTo(weights[k] as number, 2));
  });
});
