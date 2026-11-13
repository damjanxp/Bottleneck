/**
 * Arrival curves (spec section 5, "Arrival presets"; review note E3).
 *
 * An arrival curve is a piecewise-linear *density* over scenario time: points (t, weight), linear
 * in between, zero outside. Each agent's arrival time is one inverse-CDF draw from it, so one
 * uniform number always gives one arrival time (common random numbers, D-003).
 *
 * The presets below are assumptions written as a few points, in scenario seconds (t = 0 is the
 * event start for fixed-start events and the opening time for open-door events):
 *
 * - concert: gates open 90 min before; peak 45–60 min before; about 20% arrive in the last
 *   15 min before the start (late tail, review E3) and about 11% in the first 30 min after it.
 *   Shares: before −60 min 19%, −60…−45 min 20%, −45…−15 min 30%, last 15 min 20%, after 11%.
 * - stadium: peak 30–45 min before kick-off, about 5% after kick-off.
 * - conference: peak 30–15 min before the first session, about 6% after it.
 * - fair (open door): flat with a late-morning and an early-afternoon bump over the opening hours
 *   (0 … eventEnd); nobody arrives in the last 15% of the opening hours.
 */

import type { DemandCurve, Timeline } from "@bottleneck/schema";

export interface CurvePoint {
  readonly t: number;
  readonly weight: number;
}

const CONCERT: CurvePoint[] = pts([-5400, 0], [-4800, 0.3], [-3600, 0.95], [-2700, 1], [-1800, 0.6], [-900, 0.8], [-450, 1.2], [0, 0.7], [600, 0.3], [1800, 0]);
const STADIUM: CurvePoint[] = pts([-5400, 0], [-4500, 0.3], [-3600, 0.6], [-2700, 1], [-1800, 1], [-900, 0.6], [0, 0.35], [900, 0]);
const CONFERENCE: CurvePoint[] = pts([-3600, 0], [-2700, 0.25], [-1800, 1], [-900, 1], [0, 0.3], [900, 0]);

function pts(...pairs: [number, number][]): CurvePoint[] {
  return pairs.map(([t, weight]) => ({ t, weight }));
}

/** The points of a demand curve: custom points if given, otherwise the preset's. */
export function resolveArrivalPoints(curve: DemandCurve, timeline: Timeline): CurvePoint[] {
  if (curve.points !== undefined && curve.points.length >= 2) return curve.points.map((p) => ({ t: p.t, weight: p.weight }));
  switch (curve.preset) {
    case "concert":
      return CONCERT;
    case "stadium":
      return STADIUM;
    case "conference":
      return CONFERENCE;
    case "fair": {
      const d = Math.max(3600, timeline.eventEnd);
      return pts([0, 0.6], [0.2 * d, 1], [0.35 * d, 0.7], [0.5 * d, 0.95], [0.7 * d, 0.5], [0.85 * d, 0]);
    }
    case "custom":
      throw new RangeError("A custom arrival curve needs at least two points");
  }
}

/**
 * Departure curves (spec 4.4 and section 5, all assumed), placed relative to the event end E
 * (timeline.eventEnd, scenario seconds):
 *
 * - concert: a few leave early, the rush right after the end: about 81% leave within 30 min after
 *   E (and 7% before it).
 * - stadium: about 85% within 20 min after the final whistle.
 * - fair (open door): spread over the last 3 hours of opening, rising towards closing time.
 * - conference: spread over the last hour.
 *
 * Custom points are taken as they are (scenario times). Each person's departure time is one
 * inverse-CDF draw (RandomStream.DepartureTime, by group leader, so groups leave together).
 */
export function resolveDeparturePoints(curve: DemandCurve, timeline: Timeline): CurvePoint[] {
  if (curve.points !== undefined && curve.points.length >= 2) return curve.points.map((p) => ({ t: p.t, weight: p.weight }));
  const e = timeline.eventEnd;
  const rel = (...pairs: [number, number][]): CurvePoint[] => pairs.map(([t, weight]) => ({ t: e + t, weight }));
  switch (curve.preset) {
    case "concert":
      return rel([-600, 0], [0, 0.4], [300, 1], [1200, 0.9], [1800, 0.35], [3000, 0]);
    case "stadium":
      return rel([-300, 0], [0, 0.3], [180, 1], [900, 0.9], [1200, 0.3], [2100, 0]);
    case "fair":
      return rel([-10800, 0.2], [-5400, 0.7], [-1800, 1], [0, 0.8], [300, 0]);
    case "conference":
      return rel([-3600, 0.2], [-1800, 0.5], [-300, 1], [0, 1], [600, 0]);
    case "custom":
      throw new RangeError("A custom departure curve needs at least two points");
  }
}

/** Piecewise-linear density with an exact inverse-CDF sampler. */
export class PiecewiseLinearCurve {
  readonly points: readonly CurvePoint[];
  /** Cumulative mass at each point (unnormalised). */
  private readonly cumulative: Float64Array;
  readonly totalMass: number;

  constructor(points: readonly CurvePoint[]) {
    const sorted = [...points].sort((a, b) => a.t - b.t);
    for (const p of sorted) if (!(p.weight >= 0) || !Number.isFinite(p.t)) throw new RangeError("Arrival curve points need finite times and non-negative weights");
    this.points = sorted;
    this.cumulative = new Float64Array(sorted.length);
    let mass = 0;
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1] as CurvePoint;
      const b = sorted[i] as CurvePoint;
      mass += ((a.weight + b.weight) / 2) * (b.t - a.t);
      this.cumulative[i] = mass;
    }
    if (!(mass > 0)) throw new RangeError("The arrival curve has no mass");
    this.totalMass = mass;
  }

  get start(): number {
    return (this.points[0] as CurvePoint).t;
  }

  get end(): number {
    return (this.points[this.points.length - 1] as CurvePoint).t;
  }

  /** Time t with P(T ≤ t) = u, for u in (0, 1). */
  sample(u: number): number {
    const target = u * this.totalMass;
    let i = 1;
    while (i < this.points.length - 1 && (this.cumulative[i] as number) < target) i++;
    const a = this.points[i - 1] as CurvePoint;
    const b = this.points[i] as CurvePoint;
    const h = b.t - a.t;
    const m = target - (this.cumulative[i - 1] as number);
    if (h <= 0) return a.t;
    // Mass from a.t to a.t + x is w0·x + (w1 − w0)·x²/(2h) = m; solve the quadratic for x.
    const w0 = a.weight;
    const slope = (b.weight - a.weight) / h;
    let x: number;
    if (m <= 0) x = 0;
    else if (slope === 0) x = w0 > 0 ? m / w0 : 0;
    else {
      const disc = w0 * w0 + 2 * slope * m;
      // Numerically stable root of (slope/2)x² + w0·x − m = 0.
      x = (2 * m) / (w0 + Math.sqrt(Math.max(0, disc)));
    }
    return a.t + Math.min(h, Math.max(0, x));
  }

  /** Share of the mass in [t0, t1). */
  share(t0: number, t1: number): number {
    return (this.massBefore(t1) - this.massBefore(t0)) / this.totalMass;
  }

  private massBefore(t: number): number {
    if (t <= this.start) return 0;
    if (t >= this.end) return this.totalMass;
    let i = 1;
    while ((this.points[i] as CurvePoint).t < t) i++;
    const a = this.points[i - 1] as CurvePoint;
    const b = this.points[i] as CurvePoint;
    const x = t - a.t;
    const h = b.t - a.t;
    return (this.cumulative[i - 1] as number) + a.weight * x + ((b.weight - a.weight) * x * x) / (2 * h);
  }
}
