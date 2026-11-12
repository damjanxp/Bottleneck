import { describe, expect, it } from "vitest";
import { RandomCursor, hash4, mix32, uniform } from "../src/index.ts";

describe("mix32", () => {
  it("returns unsigned 32-bit integers", () => {
    for (const x of [0, 1, -1, 0x7fffffff, 0x80000000, 0xffffffff, 123456789]) {
      const h = mix32(x);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("is a bijection on a sample (no collisions among 200k consecutive inputs)", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200_000; i++) seen.add(mix32(i));
    expect(seen.size).toBe(200_000);
  });

  it("has good avalanche: flipping one input bit flips about half the output bits", () => {
    let flips = 0;
    let trials = 0;
    for (let i = 0; i < 2000; i++) {
      const x = hash4(1, 2, 3, i);
      for (let bit = 0; bit < 32; bit++) {
        let d = (mix32(x) ^ mix32(x ^ (1 << bit))) >>> 0;
        while (d) {
          flips += d & 1;
          d >>>= 1;
        }
        trials++;
      }
    }
    expect(flips / trials).toBeGreaterThan(15.5);
    expect(flips / trials).toBeLessThan(16.5);
  });
});

describe("uniform", () => {
  it("is a pure function of its four inputs", () => {
    expect(uniform(1, 2, 3, 4)).toBe(uniform(1, 2, 3, 4));
    expect(uniform(1, 2, 3, 4)).not.toBe(uniform(1, 2, 3, 5));
    expect(uniform(1, 2, 3, 4)).not.toBe(uniform(1, 2, 4, 4));
    expect(uniform(1, 2, 3, 4)).not.toBe(uniform(1, 3, 3, 4));
    expect(uniform(1, 2, 3, 4)).not.toBe(uniform(2, 2, 3, 4));
  });

  it("pins exact values (part of the determinism contract)", () => {
    expect([uniform(0, 0, 0, 0), uniform(1, 2, 3, 4), uniform(0xffffffff, 14, 999_999, 7)]).toMatchInlineSnapshot(`
      [
        0.008325930102728307,
        0.43214151833672076,
        0.36817105778027326,
      ]
    `);
  });

  it("stays strictly inside (0, 1)", () => {
    let outside = 0;
    for (let i = 0; i < 100_000; i++) {
      const u = uniform(42, 1, i, 0);
      if (!(u > 0 && u < 1)) outside++;
    }
    expect(outside).toBe(0);
  });

  it("has the moments of U(0, 1)", () => {
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const u = uniform(42, 1, i >>> 4, i & 15);
      sum += u;
      sumSq += u * u;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    // Standard error of the mean is sqrt(1/12/n) ≈ 0.00065, so ±0.003 is about 4.6 SE.
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.003);
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.002);
  });

  it("passes a chi-square test on 100 bins, along each of the four inputs", () => {
    const n = 100_000;
    const bins = 100;
    const variants: [string, (i: number) => number][] = [
      ["index", (i) => uniform(7, 1, 0, i)],
      ["entity", (i) => uniform(7, 1, i, 0)],
      ["stream", (i) => uniform(7, i, 0, 0)],
      ["seed", (i) => uniform(i, 1, 0, 0)],
    ];
    for (const [name, draw] of variants) {
      const counts = new Array<number>(bins).fill(0);
      for (let i = 0; i < n; i++) {
        const b = Math.floor(draw(i) * bins);
        counts[b] = (counts[b] as number) + 1;
      }
      const expected = n / bins;
      let chi2 = 0;
      for (const c of counts) chi2 += ((c - expected) * (c - expected)) / expected;
      // 99 degrees of freedom: the 99.9th percentile is about 148.2.
      expect(chi2, `chi-square along ${name}`).toBeLessThan(148.2);
    }
  });

  it("has no correlation between neighbouring indices or neighbouring entities", () => {
    const n = 100_000;
    const correlation = (pair: (i: number) => [number, number]): number => {
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        const [x, y] = pair(i);
        sx += x;
        sy += y;
        sxy += x * y;
        sxx += x * x;
        syy += y * y;
      }
      const cov = sxy / n - (sx / n) * (sy / n);
      return cov / Math.sqrt((sxx / n - (sx / n) ** 2) * (syy / n - (sy / n) ** 2));
    };
    // Standard error of a correlation is 1/sqrt(n) ≈ 0.0032, so 0.015 is about 4.7 SE.
    expect(Math.abs(correlation((i) => [uniform(5, 1, 0, i), uniform(5, 1, 0, i + 1)]))).toBeLessThan(0.015);
    expect(Math.abs(correlation((i) => [uniform(5, 1, i, 0), uniform(5, 1, i + 1, 0)]))).toBeLessThan(0.015);
    expect(Math.abs(correlation((i) => [uniform(5, 1, i, 0), uniform(5, 2, i, 0)]))).toBeLessThan(0.015);
    expect(Math.abs(correlation((i) => [uniform(i, 1, 0, 0), uniform(i + 1, 1, 0, 0)]))).toBeLessThan(0.015);
  });
});

describe("common random numbers", () => {
  it("an agent's draws do not change when other agents or streams are drawn", () => {
    // Run A draws scan times for agents 0..99. Run B also draws walking speeds for every agent
    // and creates 50 extra agents first. Agent k's scan time must be identical in both.
    const runA = Array.from({ length: 100 }, (_, k) => uniform(9, 4, k, 0));
    const extra = Array.from({ length: 50 }, (_, k) => uniform(9, 2, 1000 + k, 0));
    const runB = Array.from({ length: 100 }, (_, k) => {
      uniform(9, 2, k, 0);
      return uniform(9, 4, k, 0);
    });
    expect(extra.length).toBe(50);
    expect(runB).toEqual(runA);
  });
});

describe("RandomCursor", () => {
  it("walks the index of one (seed, stream, entity)", () => {
    const cursor = new RandomCursor(3, 2, 1);
    expect(cursor.next()).toBe(uniform(3, 2, 1, 0));
    expect(cursor.next()).toBe(uniform(3, 2, 1, 1));
    expect(cursor.drawn).toBe(2);
  });
});
