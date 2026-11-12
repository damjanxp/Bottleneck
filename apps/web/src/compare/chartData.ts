/**
 * Data for the comparison charts: queue length over time per gate group or screening stage (sum
 * of its regular lanes) or per single lane, one series per scenario, on a shared time axis. Pure.
 */

import type { ElementReport } from "@bottleneck/schema";
import type { RunResult } from "../batchProtocol.ts";

export interface OverlaySeries {
  /** Scenario times, ascending, the union over all runs. */
  x: number[];
  /** One array per run, aligned with x; null where that run has no sample. */
  ys: (number | null)[][];
}

/** Queue samples of one element (all regular lanes summed) or one lane (`laneIndex`), in scenario time. */
export function queueSamples(r: RunResult, elementId: string, laneIndex: number | null): { x: number[]; y: number[] } {
  const lanes = r.metrics.lanes.filter((l) => l.elementId === elementId && !l.manual && (laneIndex === null || l.laneIndex === laneIndex));
  const n = Math.max(0, ...lanes.map((l) => l.queueLength.length));
  const x: number[] = [];
  const y: number[] = [];
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (const l of lanes) sum += l.queueLength[k] ?? 0;
    x.push(r.startTime + (k + 1) * r.queueSampleInterval);
    y.push(sum);
  }
  return { x, y };
}

/** Aligns several (x, y) series on the union of their x values. */
export function alignSeries(series: readonly { x: readonly number[]; y: readonly number[] }[]): OverlaySeries {
  const xs = [...new Set(series.flatMap((s) => s.x))].sort((a, b) => a - b);
  const index = new Map(xs.map((t, k) => [t, k]));
  const ys = series.map((s) => {
    const out: (number | null)[] = new Array<number | null>(xs.length).fill(null);
    s.x.forEach((t, k) => {
      out[index.get(t) as number] = s.y[k] as number;
    });
    return out;
  });
  return { x: xs, ys };
}

/** The elements to chart, in the venue's order of the first run, and the most lanes each has in any run. */
export function chartElements(results: readonly RunResult[]): { elementId: string; kind: ElementReport["kind"]; maxLanes: number }[] {
  const out: { elementId: string; kind: ElementReport["kind"]; maxLanes: number }[] = [];
  for (const r of results) {
    for (const e of r.metrics.elements) {
      const found = out.find((o) => o.elementId === e.elementId);
      if (found) found.maxLanes = Math.max(found.maxLanes, e.laneCount);
      else out.push({ elementId: e.elementId, kind: e.kind, maxLanes: e.laneCount });
    }
  }
  return out;
}

/** Time of the highest value in a series, for "the queue peaks at …" text. */
export function peakOf(x: readonly number[], y: readonly (number | null)[]): { t: number; value: number } | null {
  let best: { t: number; value: number } | null = null;
  y.forEach((v, k) => {
    if (v !== null && (best === null || v > best.value)) best = { t: x[k] as number, value: v };
  });
  return best;
}
