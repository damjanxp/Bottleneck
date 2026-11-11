/**
 * Deterministic math.
 *
 * JavaScript guarantees that + − × ÷ and Math.sqrt give the same IEEE-754 result on every
 * engine, but Math.exp, Math.log, Math.pow, Math.sin, ... are only "implementation-approximated":
 * V8 in Node and V8 in Chrome usually agree, but nothing promises it, and other engines differ.
 * So the engine never calls them. It uses the functions in this file instead, which are built
 * only from the guaranteed operations (plus exact operations such as comparisons, Math.floor,
 * Math.round, Math.abs and reading/writing a double's bits).
 *
 * Accuracy is within a few units in the last place of the true value, which is far more than a
 * crowd simulation needs. What matters is that the result is bit-identical everywhere.
 */

// Scratch buffer for reading and writing the bits of a double. DataView is big-endian by default,
// so the layout does not depend on the machine's byte order.
const scratch = new DataView(new ArrayBuffer(8));

/** ln(2) split into a high part with trailing zero bits (so k·LN2_HI is exact) and a small rest. */
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.9082149292705877e-10;
const INV_LN2 = 1.4426950408889634;
const SQRT2 = 1.4142135623730951;
const TWO_POW_54 = 18014398509481984;

/** Largest x with exp(x) finite, and smallest x with exp(x) > 0. */
const EXP_OVERFLOW = 709.782712893384;
const EXP_UNDERFLOW = -745.1332191019412;

/** 2^k for an integer k in [-1022, 1023], built directly from the exponent bits. */
function pow2(k: number): number {
  scratch.setUint32(0, (k + 1023) << 20);
  scratch.setUint32(4, 0);
  return scratch.getFloat64(0);
}

/** y · 2^k for any integer k, split into steps so intermediate values stay in range. */
export function ldexp(y: number, k: number): number {
  while (k > 1023) {
    y *= pow2(1023);
    k -= 1023;
  }
  while (k < -1022) {
    if (k >= -1022 - 54) {
      // Result is subnormal: scale exactly within the normal range, then round once.
      return y * pow2(k + 54) * pow2(-54);
    }
    y *= pow2(-1022);
    k += 1022;
  }
  return y * pow2(k);
}

/** Natural logarithm. Same special cases as Math.log. */
export function ln(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;

  let k = 0;
  scratch.setFloat64(0, x);
  let hi = scratch.getUint32(0);
  if (hi >>> 20 === 0) {
    // Subnormal: scale into the normal range first.
    x *= TWO_POW_54;
    k -= 54;
    scratch.setFloat64(0, x);
    hi = scratch.getUint32(0);
  }
  k += ((hi >>> 20) & 0x7ff) - 1023;

  // Replace the exponent with 0 to get the mantissa m in [1, 2).
  scratch.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = scratch.getFloat64(0);
  if (m > SQRT2) {
    m /= 2; // exact
    k += 1;
  }
  // Now x = m · 2^k with m in [√2/2, √2]. Use ln(m) = 2·atanh(s) with s = (m − 1)/(m + 1),
  // |s| ≤ 0.1716, so the odd series 2(s + s³/3 + s⁵/5 + ...) converges very quickly.
  const f = m - 1;
  const s = f / (2 + f);
  const z = s * s;
  const series =
    1 +
    z *
      (1 / 3 +
        z *
          (1 / 5 +
            z *
              (1 / 7 +
                z *
                  (1 / 9 +
                    z *
                      (1 / 11 +
                        z *
                          (1 / 13 +
                            z * (1 / 15 + z * (1 / 17 + z * (1 / 19 + z * (1 / 21 + z * (1 / 23)))))))))));
  return k * LN2_HI + (2 * s * series + k * LN2_LO);
}

/** e^x. Same special cases as Math.exp. */
export function exp(x: number): number {
  if (x !== x) return NaN;
  if (x > EXP_OVERFLOW) return Infinity;
  if (x < EXP_UNDERFLOW) return 0;
  if (x === 0) return 1;

  // x = k·ln2 + r with |r| ≤ ln2/2, so e^x = 2^k · e^r.
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;

  // Taylor series of e^r to degree 16 in nested (Horner) form; the dropped terms are < 1e-19.
  let p = 1;
  for (let n = 16; n >= 1; n--) {
    p = 1 + (r / n) * p;
  }
  return ldexp(p, k);
}

/** x^y for x > 0, as exp(y · ln x). Integer powers should use plain multiplication instead. */
export function powPositive(x: number, y: number): number {
  if (x === 1 || y === 0) return 1;
  return exp(y * ln(x));
}
