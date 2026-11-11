/**
 * Hash of a list of numbers, used to prove that two runs produced bit-identical results
 * (invariant 1: the same scenario and seed give the same metrics hash in Node and in Chrome).
 *
 * It hashes the exact Float64 bytes of each number, not a JSON string, because JSON number
 * formatting could hide or invent differences. −0 is treated as 0 and every NaN as one canonical
 * NaN, since those differences carry no meaning in the metrics.
 *
 * Not cryptographic; it only needs to make accidental collisions negligible (64 bits).
 */

import { mix32 } from "./rng.ts";

const scratch = new DataView(new ArrayBuffer(8));

export class Float64Hasher {
  private h1 = 0x243f6a88;
  private h2 = 0x85a308d3;
  private count = 0;

  /** Adds one number to the hash. */
  add(value: number): this {
    if (value === 0) value = 0; // turns −0 into +0
    if (value !== value) value = NaN;
    scratch.setFloat64(0, value);
    this.word(scratch.getUint32(0));
    this.word(scratch.getUint32(4));
    this.count++;
    return this;
  }

  /** Adds every number in the list. */
  addAll(values: ArrayLike<number>): this {
    for (let i = 0; i < values.length; i++) this.add(values[i] as number);
    return this;
  }

  /** How many numbers have been added. */
  get size(): number {
    return this.count;
  }

  /** 16 hex digits. The count of numbers is mixed in, so [] and [0] differ. */
  digest(): string {
    const a = mix32((this.h1 ^ this.count) + 0x6a09e667);
    const b = mix32((this.h2 ^ a) + 0xbb67ae85);
    const c = mix32((a ^ b) + 0x3c6ef372);
    return b.toString(16).padStart(8, "0") + c.toString(16).padStart(8, "0");
  }

  private word(w: number): void {
    this.h1 = mix32((this.h1 ^ w) + 0x9e3779b9);
    this.h2 = mix32((this.h2 + Math.imul(w, 0x85ebca6b)) ^ this.h1);
  }
}

/** Convenience: hash of a whole list of numbers. */
export function hashFloat64(values: ArrayLike<number>): string {
  return new Float64Hasher().addAll(values).digest();
}
