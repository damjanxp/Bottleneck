/**
 * Turns the finished runs of a comparison into rows for the view: one row per headline measure with
 * a cell per scenario and a difference against the first scenario (the baseline), and the
 * capacity-against-demand numbers per element. Pure; tested in compare.test.ts.
 */

import type { ElementReport } from "@bottleneck/schema";
import type { RunResult } from "../batchProtocol.ts";
import { compareBatches, compareValues, formatSummary, formatValue, measureValue, measuresFor, summariseMeasure, type Difference, type Measure } from "./measures.ts";

export interface MeasureRow {
  measure: Measure;
  /** One text per scenario. */
  cells: string[];
  /** Against the baseline; index 0 (the baseline itself) is always null. */
  differences: (Difference | null)[];
}

/**
 * `runs[i]` holds scenario i's runs, in seed order. Paired means every scenario used the same seeds.
 * A single seed shows plain values; several show mean ± 95% CI.
 */
export function measureRows(runs: readonly (readonly RunResult[])[], fixedStart: boolean, paired: boolean): MeasureRow[] {
  const base = runs[0] ?? [];
  return measuresFor(fixedStart)
    .map((measure) => {
      const values = runs.map((rs) => rs.map((r) => measureValue(r.metrics, measure.key)));
      const cells = values.map((vs) => {
        if (vs.length === 1) return vs[0] === null || vs[0] === undefined ? "–" : formatValue(measure.unit, vs[0]);
        const s = summariseMeasure(vs);
        return s ? formatSummary(measure.unit, s) : "–";
      });
      const baseValues = values[0] ?? [];
      const differences = values.map((vs, i) => {
        if (i === 0 || base.length === 0) return null;
        if (vs.length === 1 && baseValues.length === 1) return compareValues(measure, baseValues[0] ?? null, vs[0] ?? null);
        return compareBatches(measure, baseValues, vs, paired);
      });
      return { measure, cells, differences };
    })
    .filter((row) => row.cells.some((c) => c !== "–"));
}

export interface CapacityCell {
  laneCount: number;
  capacityPerHour: number;
  peakDemandPerHour: number;
  peakUtilisation: number;
  /** Peak demand above capacity: the element cannot keep up at its busiest hour. */
  overloaded: boolean;
}

export interface CapacityRow {
  elementId: string;
  kind: ElementReport["kind"];
  /** One cell per scenario (its first run); null if that run has no such element. */
  cells: (CapacityCell | null)[];
}

export function capacityRows(firstRuns: readonly (RunResult | null)[]): CapacityRow[] {
  const rows: CapacityRow[] = [];
  firstRuns.forEach((r, i) => {
    for (const e of r?.metrics.elements ?? []) {
      let row = rows.find((x) => x.elementId === e.elementId);
      if (!row) {
        row = { elementId: e.elementId, kind: e.kind, cells: firstRuns.map(() => null) };
        rows.push(row);
      }
      row.cells[i] = { laneCount: e.laneCount, capacityPerHour: e.capacityPerHour, peakDemandPerHour: e.peakDemandPerHour, peakUtilisation: e.peakUtilisation, overloaded: e.peakDemandPerHour > e.capacityPerHour };
    }
  });
  return rows;
}

/** How each run ended, in words, if not every run drained. */
export function endNotes(runs: readonly (readonly RunResult[])[], labels: readonly string[]): string[] {
  const notes: string[] = [];
  runs.forEach((rs, i) => {
    const notDrained = rs.filter((r) => !r.metrics.drained).length;
    const deadlocks = rs.filter((r) => r.metrics.deadlock).length;
    const label = labels[i] ?? `Scenario ${i + 1}`;
    if (deadlocks > 0) notes.push(`${label}: ${deadlocks} of ${rs.length} run${rs.length === 1 ? "" : "s"} stopped by the deadlock watchdog.`);
    else if (notDrained > 0) notes.push(`${label}: ${notDrained} of ${rs.length} run${rs.length === 1 ? "" : "s"} reached the end of the simulated period with people still outside; their waits are a lower bound.`);
  });
  return notes;
}
