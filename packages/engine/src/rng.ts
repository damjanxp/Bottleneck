/**
 * Counter-based randomness (decision D-003 in docs/PROJECT.md).
 *
 * A normal PRNG is a sequence: the 1000th number depends on how many numbers were drawn before
 * it. In a simulation that is a problem. Add one lane and every later draw shifts, so a
 * "3 lanes vs 5 lanes" comparison differs partly by luck, not only by the change.
 *
 * Here every random number is a pure function of four 32-bit integers:
 *
 *   uniform(seed, stream, entity, index)
 *
 *   seed    the run's seed (from the scenario)
 *   stream  what the number is for: arrival time, free speed, scan time, ... (see RandomStream)
 *   entity  who it is for: usually the agent id
 *   index   which draw of that kind for that entity: 0, 1, 2, ...
 *
 * Agent 42's scan time is the same whether there are 3 lanes or 5, so two runs with the same
 * seed differ only because of the change being compared ("common random numbers").
 *
 * The hash absorbs the four inputs one after another, each through an invertible 32-bit mixer
 * (Chris Wellons' "lowbias32" family, constants by TheIronBorn). Because every step is a
 * bijection, different indices for the same (seed, stream, entity) never collide.
 *
 * Only Math.imul, xor, shifts and + are used, so results are identical in every JS engine.
 */

/** Invertible 32-bit integer mixer with strong avalanche. Returns an unsigned 32-bit integer. */
export function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return x >>> 0;
}

/** Hash of (seed, stream, entity, index) to an unsigned 32-bit integer. */
export function hash4(seed: number, stream: number, entity: number, index: number): number {
  let h = mix32((seed + 0x9e3779b9) | 0);
  h = mix32(((h ^ stream) + 0x85ebca6b) | 0);
  h = mix32(((h ^ entity) + 0xc2b2ae35) | 0);
  h = mix32(((h ^ index) + 0x27d4eb2f) | 0);
  return h;
}

const TWO_POW_32 = 4294967296;

/**
 * Uniform number strictly between 0 and 1 (never exactly 0 or 1, so ln(u) is always finite).
 * Resolution is 2^-32.
 */
export function uniform(seed: number, stream: number, entity: number, index: number): number {
  return (hash4(seed, stream, entity, index) + 0.5) / TWO_POW_32;
}

/**
 * The purpose of each kind of draw. Values are part of the determinism contract:
 * never renumber an existing stream, only add new ones.
 */
export const RandomStream = {
  /** Engine self-check only. */
  SelfCheck: 0,
  ArrivalTime: 1,
  FreeSpeed: 2,
  ScreeningTime: 3,
  ScanTime: 4,
  ScanFailure: 5,
  ScanRetryTime: 6,
  LaneChoice: 7,
  GroupSize: 8,
  SourceChoice: 9,
  CarOccupancy: 10,
  BarrierTime: 11,
  PlateMisread: 12,
  DepartureTime: 13,
  PayTime: 14,
  /** Personal sideways offset on flow-field paths, so a crowd does not walk in single file. */
  PathOffset: 15,
  /** Where around its source an agent appears. */
  SpawnOffset: 16,
  /** Service time at a gate group's manual lane (after a second scan failure). */
  ManualServiceTime: 17,
} as const;
export type RandomStream = (typeof RandomStream)[keyof typeof RandomStream];

/**
 * Convenience for drawing several numbers of one kind for one entity, e.g. rejection sampling.
 * The cursor only remembers the next index; the numbers themselves still come from uniform().
 */
export class RandomCursor {
  private index = 0;

  constructor(
    readonly seed: number,
    readonly stream: number,
    readonly entity: number,
  ) {}

  /** Next uniform number in (0, 1) for this (seed, stream, entity). */
  next(): number {
    return uniform(this.seed, this.stream, this.entity, this.index++);
  }

  /** How many numbers this cursor has drawn so far. */
  get drawn(): number {
    return this.index;
  }
}

/** Normalises any number to a valid 32-bit unsigned seed (scenario seeds are stored as such). */
export function toSeed(value: number): number {
  return value >>> 0;
}
