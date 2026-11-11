import { PiecewiseLinearCurve, type CurvePoint } from "@bottleneck/engine";

/**
 * Start (scenario seconds) of the 60-minute window with the most expected arrivals, on a
 * 1-minute grid, from the arrival curve. Used by "Jump to peak" before anyone has arrived, so it
 * works from the curve rather than from the run's actual arrivals. Earliest window wins ties.
 */
export function peakWindowStart(points: readonly CurvePoint[], windowSeconds = 3600): number {
  if (points.length < 2) return points[0]?.t ?? 0;
  const curve = new PiecewiseLinearCurve(points);
  const first = Math.floor(curve.start / 60) * 60;
  const last = Math.max(first, curve.end - windowSeconds);
  let best = first;
  let bestShare = -1;
  for (let s = first; s <= last; s += 60) {
    const share = curve.share(s, s + windowSeconds);
    if (share > bestShare + 1e-12) {
      bestShare = share;
      best = s;
    }
  }
  return best;
}
