/**
 * The headline numbers a comparison shows, how to read them from a run's metrics, and how to say a
 * difference in words ("p95 wait, peak arrival hour: 27 min → 2 min (better)"). Batches show
 * mean ± 95% CI over the seeds; with paired seeds the verdict comes from the CI of the per-seed
 * differences. Pure; tested in compare.test.ts.
 */

import { summarise, type Summary } from "@bottleneck/analysis";
import { formatCount, formatDuration, formatPercent } from "../sim/format.ts";
import { timeToEmpty } from "../sim/parking.ts";
import type { MetricsSummary } from "../workerProtocol.ts";

export type MeasureKey = "stillOutside" | "onSite" | "notArrived" | "p95PeakWait" | "meanWait" | "p95Wait" | "shareInside";
/** "flag" is 1 (yes) or 0 (no) per run; a batch shows the share of seeds where it happened. */
export type MeasureUnit = "people" | "duration" | "share" | "cars" | "metres" | "flag";

export interface Measure {
  /** A MeasureKey, or "parking.…", "lot.<id>.…", "barrier.<id>.…" for the car measures. */
  key: string;
  label: string;
  unit: MeasureUnit;
  lowerIsBetter: boolean;
  /** Shown indented under the measure above it (the outside-at-start split, per-lot and per-barrier rows). */
  sub: boolean;
  /** The value of this measure in one run's metrics, or null if it does not apply. */
  read: (m: MetricsSummary) => number | null;
}

const MEASURES: Record<MeasureKey, Omit<Measure, "key" | "read">> = {
  stillOutside: { label: "Still outside at the start", unit: "people", lowerIsBetter: true, sub: false },
  onSite: { label: "of them already on site", unit: "people", lowerIsBetter: true, sub: true },
  notArrived: { label: "of them not arrived yet", unit: "people", lowerIsBetter: true, sub: true },
  p95PeakWait: { label: "p95 wait, peak arrival hour", unit: "duration", lowerIsBetter: true, sub: false },
  meanWait: { label: "Mean wait, everyone", unit: "duration", lowerIsBetter: true, sub: false },
  p95Wait: { label: "p95 wait, everyone", unit: "duration", lowerIsBetter: true, sub: false },
  shareInside: { label: "Share inside by the reference time", unit: "share", lowerIsBetter: false, sub: false },
};

/** The measures for a fixed-start event (leading with people outside at the start) or an open-door one. */
export function measuresFor(fixedStart: boolean): Measure[] {
  const keys: MeasureKey[] = fixedStart ? ["stillOutside", "onSite", "notArrived", "p95PeakWait", "meanWait", "p95Wait", "shareInside"] : ["shareInside", "p95PeakWait", "meanWait", "p95Wait"];
  return keys.map((key) => ({ key, ...MEASURES[key], read: (m: MetricsSummary) => measureValue(m, key) }));
}

/**
 * Car and parking measures (spec 4.4, 4.5) for the lots and barriers of `sample` (a run of the
 * baseline): the headline numbers, then one block per lot and per barrier. Empty without cars.
 * Lower is better for all of them: time until the lots are empty, queues, cars turned away or
 * diverted, search time, and whether an entry queue reached the public road.
 */
export function parkingMeasures(sample: MetricsSummary | null, name: (id: string) => string): Measure[] {
  const p = sample?.parking;
  if (!p) return [];
  const flag = (b: boolean) => (b ? 1 : 0);
  const out: Measure[] = [
    { key: "parking.timeToEmpty", label: "Time until the car park is empty (after the event end)", unit: "duration", lowerIsBetter: true, sub: false, read: (m) => (m.parking ? timeToEmpty(m.parking, m.departures, true).seconds : null) },
    { key: "parking.exitQueue", label: "Longest exit queue", unit: "metres", lowerIsBetter: true, sub: false, read: (m) => maxQueue(m, "exit") },
    { key: "parking.entryQueue", label: "Longest entry queue", unit: "metres", lowerIsBetter: true, sub: false, read: (m) => maxQueue(m, "entry") },
    { key: "parking.publicRoad", label: "Entry queue reached the public road", unit: "flag", lowerIsBetter: true, sub: false, read: (m) => (m.parking ? flag(m.parking.barriers.some((b) => b.kind === "entry" && b.reachedPublicRoadAt !== null)) : null) },
    { key: "parking.turnedAway", label: "Cars turned away", unit: "cars", lowerIsBetter: true, sub: false, read: (m) => m.parking?.turnedAwayCars ?? null },
    { key: "parking.diverted", label: "Cars diverted to another lot", unit: "cars", lowerIsBetter: true, sub: false, read: (m) => m.parking?.divertedCars ?? null },
  ];
  for (const lot of p.lots) {
    const id = lot.lotId;
    const get = (m: MetricsSummary) => m.parking?.lots.find((l) => l.lotId === id);
    out.push(
      { key: `lot.${id}.timeToEmpty`, label: `${name(id)}: time until empty`, unit: "duration", lowerIsBetter: true, sub: true, read: (m) => get(m)?.timeToEmpty ?? null },
      { key: `lot.${id}.turnedAway`, label: `${name(id)}: cars turned away`, unit: "cars", lowerIsBetter: true, sub: true, read: (m) => get(m)?.turnedAway ?? null },
      { key: `lot.${id}.search`, label: `${name(id)}: mean time to find a stall`, unit: "duration", lowerIsBetter: true, sub: true, read: (m) => get(m)?.meanSearchTime ?? null },
    );
  }
  for (const b of p.barriers) {
    const id = b.barrierId;
    const get = (m: MetricsSummary) => m.parking?.barriers.find((x) => x.barrierId === id);
    out.push(
      { key: `barrier.${id}.maxQueue`, label: `${name(id)}: longest queue`, unit: "metres", lowerIsBetter: true, sub: true, read: (m) => get(m)?.maxQueueMetres ?? null },
      { key: `barrier.${id}.meanQueue`, label: `${name(id)}: mean queue`, unit: "metres", lowerIsBetter: true, sub: true, read: (m) => get(m)?.meanQueueMetres ?? null },
    );
    if (b.kind === "entry") out.push({ key: `barrier.${id}.publicRoad`, label: `${name(id)}: queue reached the public road`, unit: "flag", lowerIsBetter: true, sub: true, read: (m) => { const x = get(m); return x ? flag(x.reachedPublicRoadAt !== null) : null; } });
  }
  return out;
}

function maxQueue(m: MetricsSummary, kind: "entry" | "exit"): number | null {
  const bs = m.parking?.barriers.filter((b) => b.kind === kind) ?? [];
  return bs.length === 0 ? null : Math.max(...bs.map((b) => b.maxQueueMetres));
}

export function measureValue(m: MetricsSummary, key: MeasureKey): number | null {
  switch (key) {
    case "stillOutside":
      return m.stillOutsideAtStart;
    case "onSite":
      return m.arrivedButOutsideAtStart;
    case "notArrived":
      return m.notYetArrivedAtStart;
    case "p95PeakWait":
      return m.peakHour.p95Wait;
    case "meanWait":
      return m.meanWait;
    case "p95Wait":
      return m.p95Wait;
    case "shareInside":
      return m.shareInside.share;
  }
}

export function formatValue(unit: MeasureUnit, v: number): string {
  switch (unit) {
    case "people":
      return `${formatCount(v)} people`;
    case "duration":
      return formatDuration(v);
    case "share":
      return formatPercent(v, 1);
    case "cars":
      return `${formatCount(v)} cars`;
    case "metres":
      return `${formatCount(v)} m`;
    case "flag":
      return v >= 1 ? "yes" : v <= 0 ? "no" : `yes in ${formatPercent(v)} of seeds`;
  }
}

/** A signed difference: "−1,135 people", "+3 min 20 s", "+4.5 points". */
export function formatDelta(unit: MeasureUnit, d: number): string {
  const sign = d < 0 ? "−" : "+";
  const a = Math.abs(d);
  switch (unit) {
    case "people":
      return `${sign}${formatCount(a)} people`;
    case "duration":
      return `${sign}${formatDuration(a)}`;
    case "share":
      return `${sign}${(a * 100).toFixed(1)} points`;
    case "cars":
      return `${sign}${formatCount(a)} cars`;
    case "metres":
      return `${sign}${formatCount(a)} m`;
    case "flag":
      return `${sign}${(a * 100).toFixed(0)} points`;
  }
}

/** Differences smaller than this are "no change" (a person, half a second, 0.05 percentage points). */
function negligible(unit: MeasureUnit): number {
  return unit === "people" || unit === "cars" || unit === "metres" || unit === "duration" ? 0.5 : unit === "flag" ? 0.01 : 0.0005;
}

export type Verdict = "better" | "worse" | "same" | "unclear";

export interface Difference {
  measure: Measure;
  /** Text for the baseline and the other value ("14 min", "14 min ± 1 min"). */
  from: string;
  to: string;
  delta: string;
  verdict: Verdict;
  /** The whole difference in words, e.g. "p95 wait, peak arrival hour: 27 min → 2 min (−25 min, better)". */
  sentence: string;
}

export const VERDICT_WORDS: Record<Verdict, string> = {
  better: "better",
  worse: "worse",
  same: "no change",
  unclear: "no clear difference",
};

function verdictOf(m: Measure, d: number): Verdict {
  if (Math.abs(d) < negligible(m.unit)) return "same";
  return (d < 0) === m.lowerIsBetter ? "better" : "worse";
}

/** One run against one run (same seed: common random numbers). Null if either value is missing. */
export function compareValues(m: Measure, base: number | null, other: number | null): Difference | null {
  if (base === null || other === null || !Number.isFinite(base) || !Number.isFinite(other)) return null;
  const d = other - base;
  const verdict = verdictOf(m, d);
  const from = formatValue(m.unit, base);
  const to = formatValue(m.unit, other);
  const delta = formatDelta(m.unit, d);
  const sentence = verdict === "same" ? `${m.label}: ${from} → ${to} (no change)` : `${m.label}: ${from} → ${to} (${delta}, ${VERDICT_WORDS[verdict]})`;
  return { measure: m, from, to, delta, verdict, sentence };
}

/** "14 min ± 1 min" (mean ± 95% CI half-width); just the mean for a single run. */
export function formatSummary(unit: MeasureUnit, s: Summary): string {
  if (!Number.isFinite(s.mean)) return "–";
  if (s.n < 2 || !Number.isFinite(s.ci95HalfWidth)) return formatValue(unit, s.mean);
  if (unit === "flag") return formatValue(unit, s.mean);
  const half = unit === "people" || unit === "cars" ? `${formatCount(s.ci95HalfWidth)}` : unit === "metres" ? `${formatCount(s.ci95HalfWidth)} m` : unit === "duration" ? formatDuration(s.ci95HalfWidth) : `${(s.ci95HalfWidth * 100).toFixed(1)} points`;
  return `${formatValue(unit, s.mean)} ± ${half}`;
}

export function summariseMeasure(values: readonly (number | null)[]): Summary | null {
  if (values.length === 0 || values.some((v) => v === null || !Number.isFinite(v))) return null;
  return summarise(values as number[]);
}

/**
 * Batch against batch over the same seeds (paired). The verdict is "better"/"worse" only if the 95%
 * CI of the per-seed differences excludes 0; otherwise "no clear difference" (within the noise).
 * Unpaired batches (different seeds) compare the two means' CIs: a verdict only if they do not overlap.
 */
export function compareBatches(m: Measure, base: readonly (number | null)[], other: readonly (number | null)[], paired: boolean): Difference | null {
  const a = summariseMeasure(base);
  const b = summariseMeasure(other);
  if (!a || !b) return null;
  if (a.n < 2 || b.n < 2) return compareValues(m, a.mean, b.mean);
  const from = formatSummary(m.unit, a);
  const to = formatSummary(m.unit, b);
  let verdict: Verdict;
  let delta: string;
  if (paired && base.length === other.length) {
    const diffs = other.map((v, k) => (v as number) - (base[k] as number));
    const d = summarise(diffs);
    delta = `${formatDelta(m.unit, d.mean)} ± ${formatDelta(m.unit, d.ci95HalfWidth).slice(1)}`;
    if (diffs.every((x) => Math.abs(x) < negligible(m.unit))) verdict = "same";
    else if (Math.abs(d.mean) > d.ci95HalfWidth) verdict = verdictOf(m, d.mean);
    else verdict = "unclear";
  } else {
    const d = b.mean - a.mean;
    delta = formatDelta(m.unit, d);
    if (Math.abs(d) < negligible(m.unit)) verdict = "same";
    else if (Math.abs(d) > a.ci95HalfWidth + b.ci95HalfWidth) verdict = verdictOf(m, d);
    else verdict = "unclear";
  }
  const sentence = `${m.label}: ${from} → ${to} (${delta}, ${VERDICT_WORDS[verdict]})`;
  return { measure: m, from, to, delta, verdict, sentence };
}
