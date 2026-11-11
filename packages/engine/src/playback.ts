/**
 * Turns real (wall-clock) time into a whole number of simulation ticks.
 *
 * At 1× one real second runs 4 ticks (4 × 0.25 s); at 60× it runs 240. The tick length never
 * changes. Fractions of a tick are carried over to the next call, so over time the simulation
 * keeps exact pace with the chosen speed.
 *
 * If the engine cannot keep up (a slow machine, a huge scenario), at most `maxTicksPerCall` ticks
 * run per call and the rest is dropped, so the UI never freezes trying to catch up. The simulation
 * then runs slower than requested, but its results are unchanged.
 *
 * This uses no clock itself: the caller passes in elapsed real seconds.
 */

import { TICK_SECONDS } from "./simulation.ts";

export const MIN_SPEED = 1;
export const MAX_SPEED = 60;

export class PlaybackPacer {
  private carry = 0;
  private speedValue: number;

  constructor(
    speed = 1,
    readonly maxTicksPerCall = 2400,
  ) {
    this.speedValue = PlaybackPacer.clampSpeed(speed);
  }

  static clampSpeed(speed: number): number {
    if (!Number.isFinite(speed)) return MIN_SPEED;
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  }

  get speed(): number {
    return this.speedValue;
  }

  set speed(value: number) {
    this.speedValue = PlaybackPacer.clampSpeed(value);
  }

  /** Number of ticks to run for `realSeconds` of elapsed wall-clock time. */
  ticksFor(realSeconds: number): number {
    if (!(realSeconds > 0)) return 0;
    const exact = this.carry + (realSeconds * this.speedValue) / TICK_SECONDS;
    // The tiny epsilon absorbs rounding in the running sum (60 frames of 1/60 s must give 4 ticks,
    // not 3.9999999). The carry may then be a hair below zero, which is harmless.
    let ticks = Math.floor(exact + 1e-9);
    this.carry = exact - ticks;
    if (ticks > this.maxTicksPerCall) {
      ticks = this.maxTicksPerCall;
      this.carry = 0;
    }
    return ticks;
  }

  /** Forgets any carried fraction, e.g. after pause or seek. */
  reset(): void {
    this.carry = 0;
  }
}
