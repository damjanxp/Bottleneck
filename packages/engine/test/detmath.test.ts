import { describe, expect, it } from "vitest";
import { exp, hashFloat64, ldexp, ln, powPositive, uniform } from "../src/index.ts";

/** Relative difference, with an absolute floor for values near zero. */
function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);
}

describe("ln", () => {
  it("handles special values like Math.log", () => {
    expect(ln(1)).toBe(0);
    expect(ln(0)).toBe(-Infinity);
    expect(ln(-0)).toBe(-Infinity);
    expect(ln(Infinity)).toBe(Infinity);
    expect(ln(-1)).toBeNaN();
    expect(ln(NaN)).toBeNaN();
  });

  it("matches Math.log to within 2 units in the last place", () => {
    const xs = [Number.MIN_VALUE, 1e-310, 1e-200, 1e-10, 0.001, 0.5, 0.7071, 0.99999, 1.000001, 1.5, 2, Math.E, 10, 1e10, 1e300, Number.MAX_VALUE];
    for (let i = 0; i < 20000; i++) xs.push(uniform(1, 99, 0, i) * 50);
    for (const x of xs) {
      const expected = Math.log(x);
      const tolerance = Math.abs(expected) < 1e-3 ? 1e-15 * Math.abs(expected) + 1e-300 : 4.5e-16 * Math.abs(expected);
      expect(Math.abs(ln(x) - expected), `ln(${x})`).toBeLessThanOrEqual(tolerance);
    }
  });

  it("is accurate near 1, where cancellation is easy to get wrong", () => {
    for (const d of [1e-15, 1e-12, 1e-9, 1e-6, -1e-9, -1e-6]) {
      const x = 1 + d; // rounded to the nearest double, so compare with the exact log of that double
      expect(relErr(ln(x), Math.log1p(x - 1)), `ln(1 + ${d})`).toBeLessThan(1e-15);
    }
  });
});

describe("exp", () => {
  it("handles special values like Math.exp", () => {
    expect(exp(0)).toBe(1);
    expect(exp(-Infinity)).toBe(0);
    expect(exp(Infinity)).toBe(Infinity);
    expect(exp(800)).toBe(Infinity);
    expect(exp(-800)).toBe(0);
    expect(exp(NaN)).toBeNaN();
  });

  it("matches Math.exp to within a few units in the last place", () => {
    const xs = [-745, -740, -700, -100, -1, -1e-10, 1e-10, 0.5, 1, 2, 10, 100, 700, 709.78];
    for (let i = 0; i < 20000; i++) xs.push(uniform(2, 99, 0, i) * 100 - 50);
    for (const x of xs) {
      const expected = Math.exp(x);
      // Subnormal results have fewer significant bits, so allow one unit of 2^-1074 there.
      const tolerance = expected < 2.2250738585072014e-308 ? 5e-324 : 6e-16 * expected;
      expect(Math.abs(exp(x) - expected), `exp(${x})`).toBeLessThanOrEqual(tolerance);
    }
  });

  it("is the inverse of ln", () => {
    for (let i = 0; i < 1000; i++) {
      const x = uniform(3, 99, 0, i) * 20 - 10;
      expect(relErr(ln(exp(x)), x)).toBeLessThan(1e-13);
    }
  });
});

describe("ldexp and powPositive", () => {
  it("scales by powers of two exactly", () => {
    expect(ldexp(1, 10)).toBe(1024);
    expect(ldexp(3, -2)).toBe(0.75);
    expect(ldexp(1, -1074)).toBe(Number.MIN_VALUE);
    expect(ldexp(1, 1023) * 2).toBe(Infinity);
    expect(ldexp(0.5, 1024)).toBe(2 ** 1023);
  });

  it("computes positive powers", () => {
    expect(relErr(powPositive(2, 10), 1024)).toBeLessThan(1e-14);
    expect(relErr(powPositive(9, 0.5), 3)).toBeLessThan(1e-15);
    expect(powPositive(5, 0)).toBe(1);
  });
});

describe("bit-exact golden values", () => {
  // These pin the exact bits. If they change, the engine's results change everywhere, so any
  // change here must be deliberate (and the self-check hash will change with it).
  it("ln and exp produce the pinned bits", () => {
    const values: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const u = uniform(7, 99, 0, i);
      values.push(ln(u), exp(u * 40 - 20));
    }
    expect(hashFloat64(values)).toMatchInlineSnapshot(`"b036017d03d524f6"`);
  });
});
