import type { ScanLogRow } from "./scanLog.ts";

export interface ScanLogFitOptions {
  /** Arrival-curve bin width in seconds (default 300). Widened if needed so the curve has at most 200 points. */
  binSeconds?: number;
  /**
   * A gap between two consecutive departures of a lane longer than this counts as an idle period. Default:
   * IDLE_GAP_FACTOR (3) times the median inter-departure gap of the lane's group.
   */
  idleGapSeconds?: number;
}

export interface ScanLogFit {
  lanes: { lane: string; group: string; passes: number; busyIntervals: number; meanServiceTime: number | null }[];
  groups: { group: string; meanServiceTime: number | null; busyIntervals: number }[];
  /** Demand curve points (t = scenario seconds, weight relative to the busiest bin, max 1): usable as scenario arrivals.points. */
  arrivals: { t: number; weight: number }[];
  firstTime: number;
  lastTime: number;
}

/** Idle threshold as a multiple of the group's median inter-departure gap. */
export const IDLE_GAP_FACTOR = 3;

/** "gate-main#2" -> "gate-main"; "gate-main#manual" stays its own group "gate-main#manual". */
export function groupOf(lane: string): string {
  const k = lane.lastIndexOf("#");
  if (k < 0) return lane;
  return lane.slice(k + 1) === "manual" ? lane : lane.slice(0, k);
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 === 1 ? (sorted[(n - 1) / 2] as number) : ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
}

/**
 * Fits service times and the arrival curve from scan-log rows.
 *
 * Service time (spec: busy-period inter-departure intervals only). A "departure" is a row that ends a visit:
 * scan_ok, manual_ok or rejected. scan_fail rows are not departures, so a failed scan followed by its retry
 * is part of the same visit; its time is inside the interval to the next departure (a visit's duration is
 * therefore service time plus any retry time, which is what the engine's "busy time per pass" is too). The log
 * has no service starts, so a lane is taken to be continuously busy between two departures when their gap is
 * at most the idle threshold; the first departure after an idle gap (and the lane's first departure) has no
 * valid interval and is excluded, because the gap would include idle time. The threshold is 3x the median gap
 * of the lane's group (pooled, so quiet lanes are judged against the busy ones), or `idleGapSeconds`. It is
 * a heuristic: it cuts a few percent of genuine long services (slight underestimate) and cannot work on a
 * group that is never busy (then nearly every gap is idle time and the estimate is biased high).
 * Manual lanes form their own group ("<element>#manual").
 *
 * Arrivals: per lane, the first row of each visit (a row not preceded by a scan_fail) marks a first attempt;
 * they are counted per bin at that row's time, manual lanes excluded. Pass a log of one stage (screening
 * is left out of scanLogFromRun by default), otherwise people are counted once per stage.
 */
export function fitScanLog(rows: readonly ScanLogRow[], options: ScanLogFitOptions = {}): ScanLogFit {
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.seconds - b.r.seconds || a.i - b.i)
    .map((x) => x.r);
  const byLane = new Map<string, ScanLogRow[]>();
  for (const r of sorted) {
    const list = byLane.get(r.lane);
    if (list === undefined) byLane.set(r.lane, [r]);
    else list.push(r);
  }
  const laneNames = [...byLane.keys()].sort();

  // Inter-departure gaps per lane, and per group for the idle threshold.
  const laneGaps = new Map<string, number[]>();
  const groupGaps = new Map<string, number[]>();
  for (const name of laneNames) {
    const gaps: number[] = [];
    let prev: number | null = null;
    for (const r of byLane.get(name) as ScanLogRow[]) {
      if (r.event === "scan_fail") continue;
      if (prev !== null) gaps.push(r.seconds - prev);
      prev = r.seconds;
    }
    laneGaps.set(name, gaps);
    const g = groupOf(name);
    const pooled = groupGaps.get(g);
    if (pooled === undefined) groupGaps.set(g, [...gaps]);
    else pooled.push(...gaps);
  }
  const threshold = new Map<string, number>();
  for (const [g, gaps] of groupGaps) threshold.set(g, options.idleGapSeconds ?? IDLE_GAP_FACTOR * median(gaps.sort((a, b) => a - b)));

  const groupSum = new Map<string, { sum: number; n: number }>();
  const lanes: ScanLogFit["lanes"] = [];
  for (const name of laneNames) {
    const g = groupOf(name);
    const limit = threshold.get(g) as number;
    let sum = 0;
    let n = 0;
    for (const gap of laneGaps.get(name) as number[]) {
      if (gap <= limit) {
        sum += gap;
        n++;
      }
    }
    const passes = (byLane.get(name) as ScanLogRow[]).filter((r) => r.event === "scan_ok" || r.event === "manual_ok").length;
    lanes.push({ lane: name, group: g, passes, busyIntervals: n, meanServiceTime: n > 0 ? sum / n : null });
    const acc = groupSum.get(g) ?? { sum: 0, n: 0 };
    acc.sum += sum;
    acc.n += n;
    groupSum.set(g, acc);
  }
  const groups = [...groupSum.keys()].sort().map((group) => {
    const acc = groupSum.get(group) as { sum: number; n: number };
    return { group, meanServiceTime: acc.n > 0 ? acc.sum / acc.n : null, busyIntervals: acc.n };
  });

  // Arrival curve from first attempts.
  const firstTime = sorted.length > 0 ? (sorted[0] as ScanLogRow).seconds : 0;
  const lastTime = sorted.length > 0 ? (sorted[sorted.length - 1] as ScanLogRow).seconds : 0;
  const starts: number[] = [];
  for (const name of laneNames) {
    if (groupOf(name).endsWith("#manual")) continue;
    let afterFail = false;
    for (const r of byLane.get(name) as ScanLogRow[]) {
      if (!afterFail) starts.push(r.seconds);
      afterFail = r.event === "scan_fail";
    }
  }
  const arrivals: ScanLogFit["arrivals"] = [];
  if (starts.length > 0) {
    const span = Math.max(lastTime - firstTime, 1);
    const bin = Math.max(options.binSeconds ?? 300, span / 197);
    const bins = Math.floor(span / bin) + 1;
    const counts = new Array<number>(bins).fill(0);
    for (const s of starts) {
      const k = Math.min(bins - 1, Math.floor((s - firstTime) / bin));
      counts[k] = (counts[k] as number) + 1;
    }
    const peak = Math.max(...counts);
    arrivals.push({ t: Math.round(firstTime), weight: 0 });
    for (let k = 0; k < bins; k++) arrivals.push({ t: Math.round(firstTime + (k + 0.5) * bin), weight: Math.round(((counts[k] as number) / peak) * 1000) / 1000 });
    arrivals.push({ t: Math.round(firstTime + bins * bin), weight: 0 });
  }
  return { lanes, groups, arrivals, firstTime, lastTime };
}
