/**
 * Server jobs (spec 6.4): building the request bodies, and turning results into sentences, table
 * rows and chart data. Pure; tested in api.test.ts. The result shapes follow
 * apps/api/src/Bottleneck.Api/Features/Jobs/JobAggregator.cs.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import { formatDuration, formatHms, formatPercent, formatWallClock } from "../sim/format.ts";
import type { JobKind, JobResponse, JobStatus, JobSummary } from "./client.ts";

// ---- Request bodies

/** Either a scenario stored on the server, or an inline document (validated by the server like a write). */
export type JobScenario = { scenarioId: string } | { scenario: Scenario };

export type SweepMetric = "peakHourP95Wait" | "p95Wait" | "meanWait" | "elementP95Wait";
export type SweepRule = "mean" | "ci";
export const SWEEP_METRICS: SweepMetric[] = ["peakHourP95Wait", "p95Wait", "meanWait", "elementP95Wait"];

export interface BatchForm {
  seeds: number;
}
export interface LaneSweepForm {
  elementId: string;
  minLanes: number;
  maxLanes: number;
  seedsPerPoint: number;
  /** Target wait, seconds. */
  targetWait: number;
  metric: SweepMetric;
  rule: SweepRule;
}
export interface GateSweepForm {
  /** Candidate gate-opening times, scenario seconds (e.g. −5400 = 90 min before the start). */
  gatesOpen: number[];
  /** 0..1 */
  targetShareInside: number;
  seedsPerPoint: number;
  rule: SweepRule;
}

/** A request id for idempotent submits: one per form submission, reused on retries and double clicks. */
export function newRequestId(random: () => string = () => crypto.randomUUID()): string {
  return random();
}

export function batchRequest(requestId: string, on: JobScenario, f: BatchForm): Record<string, unknown> & { requestId: string } {
  return { requestId, kind: "batch", ...on, seeds: f.seeds };
}

export function laneSweepRequest(requestId: string, on: JobScenario, f: LaneSweepForm): Record<string, unknown> & { requestId: string } {
  return { requestId, kind: "laneSweep", ...on, elementId: f.elementId, minLanes: f.minLanes, maxLanes: f.maxLanes, seedsPerPoint: f.seedsPerPoint, targetWait: f.targetWait, metric: f.metric, rule: f.rule };
}

export function gateSweepRequest(requestId: string, on: JobScenario, f: GateSweepForm): Record<string, unknown> & { requestId: string } {
  return { requestId, kind: "gateOpeningSweep", ...on, gatesOpen: f.gatesOpen, targetShareInside: f.targetShareInside, seedsPerPoint: f.seedsPerPoint, rule: f.rule };
}

/**
 * Candidate gate openings typed as minutes before the event start, e.g. "120, 105, 90, 75, 60",
 * into scenario seconds relative to the start (`eventStart`), sorted earliest first. Errors as text.
 */
export function parseGateCandidates(text: string, eventStart: number, maxPoints = 24): { values: number[] } | { error: string } {
  const parts = text
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return { error: "Enter at least one time, in minutes before the start (e.g. 120, 90, 60)." };
  const values: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return { error: `“${p}” is not a positive number of minutes before the start.` };
    const t = eventStart - Math.round(n * 60);
    if (!values.includes(t)) values.push(t);
  }
  if (values.length > maxPoints) return { error: `At most ${maxPoints} candidate times.` };
  return { values: values.sort((a, b) => a - b) };
}

/** Elements a lane sweep can vary: gate groups, screening stages and vehicle barriers, with their lane counts. */
export function sweepElements(venue: Venue, scenario?: Scenario): { id: string; name: string; kind: "gate" | "screening" | "barrier"; laneCount: number }[] {
  const lanes = (id: string, own: number) => scenario?.overrides?.[id]?.laneCount ?? own;
  return [
    ...venue.gateGroups.map((g) => ({ id: g.id, name: g.name, kind: "gate" as const, laneCount: lanes(g.id, g.laneCount) })),
    ...venue.screeningStages.map((s) => ({ id: s.id, name: s.name, kind: "screening" as const, laneCount: lanes(s.id, s.laneCount) })),
    ...(venue.vehicleBarriers ?? []).map((b) => ({ id: b.id, name: b.name, kind: "barrier" as const, laneCount: lanes(b.id, b.laneCount) })),
  ];
}

// ---- Results

export interface StatSummary {
  n: number;
  mean: number | null;
  sd: number;
  ci95HalfWidth: number | null;
  low: number | null;
  high: number | null;
}

export interface BatchResult {
  kind: "batch";
  engineVersion: string;
  seeds: number[];
  runs: number;
  metrics: Record<string, StatSummary>;
}
export interface LaneSweepPoint {
  laneCount: number;
  target: StatSummary;
  meetsByMean: boolean;
  meetsByCi: boolean;
  metrics: Record<string, StatSummary>;
}
export interface LaneSweepResult {
  kind: "laneSweep";
  engineVersion: string;
  seeds: number[];
  runs: number;
  elementId: string;
  metric: SweepMetric;
  metricKey: string;
  targetWait: number;
  rule: SweepRule;
  points: LaneSweepPoint[];
  smallestLaneCountByMean: number | null;
  smallestLaneCountByCi: number | null;
  answer: number | null;
}
export interface GateSweepPoint {
  gatesOpen: number;
  shareInsideAtStart: StatSummary;
  meetsByMean: boolean;
  meetsByCi: boolean;
  metrics: Record<string, StatSummary>;
}
export interface GateSweepResult {
  kind: "gateOpeningSweep";
  engineVersion: string;
  seeds: number[];
  runs: number;
  targetShareInside: number;
  rule: SweepRule;
  points: GateSweepPoint[];
  latestGatesOpenByMean: number | null;
  latestGatesOpenByCi: number | null;
  answer: number | null;
}
export type JobResult = BatchResult | LaneSweepResult | GateSweepResult;

export function jobResult(job: JobResponse): JobResult | null {
  const r = job.result;
  if (!r || typeof r !== "object") return null;
  const kind = (r as { kind?: unknown }).kind;
  if (kind !== "batch" && kind !== "laneSweep" && kind !== "gateOpeningSweep") return null;
  return r as unknown as JobResult;
}

export const KIND_LABEL: Record<JobKind, string> = { batch: "Batch", laneSweep: "Lane sweep", gateOpeningSweep: "Gate-opening sweep" };
export const STATUS_LABEL: Record<JobStatus, string> = { queued: "queued", running: "running", succeeded: "finished", failed: "failed", cancelled: "cancelled" };

/** "running: 7 of 20 runs" etc. */
export function jobStatusText(j: JobSummary & { cancelRequested?: boolean }): string {
  const p = j.progress;
  if (j.status === "running") return `${j.cancelRequested ? "cancelling" : "running"}: ${p.completedRuns} of ${p.totalRuns} runs`;
  if (j.status === "queued") return `queued (${p.totalRuns} runs)`;
  if (j.status === "failed") return `failed${j.error ? `: ${j.error}` : ""}`;
  if (j.status === "cancelled") return `cancelled after ${p.completedRuns} of ${p.totalRuns} runs`;
  return `finished: ${p.totalRuns} runs`;
}

export function progressFraction(j: JobSummary): number {
  return j.progress.totalRuns > 0 ? Math.min(1, j.progress.completedRuns / j.progress.totalRuns) : 0;
}

// Metric keys → label and kind of number.
type Unit = "seconds" | "share" | "people" | "metres" | "cars";
const HEADLINE: { key: string; label: string; unit: Unit }[] = [
  { key: "peakHourP95Wait", label: "Peak-hour p95 wait", unit: "seconds" },
  { key: "p95Wait", label: "p95 wait (everyone)", unit: "seconds" },
  { key: "meanWait", label: "Mean wait", unit: "seconds" },
  { key: "shareInside", label: "Share inside", unit: "share" },
  { key: "stillOutsideAtStart", label: "Still outside at the start", unit: "people" },
  { key: "parking/timeToEmpty", label: "Car parks empty after", unit: "seconds" },
  { key: "parking/maxEntryQueueMetres", label: "Longest entry queue (cars)", unit: "metres" },
  { key: "parking/maxExitQueueMetres", label: "Longest exit queue (cars)", unit: "metres" },
  { key: "parking/turnedAwayCars", label: "Cars turned away", unit: "cars" },
];

export const METRIC_LABEL: Record<SweepMetric, string> = {
  peakHourP95Wait: "Peak-hour p95 wait",
  p95Wait: "p95 wait (everyone)",
  meanWait: "Mean wait",
  elementP95Wait: "p95 queue wait at this element (worst lane)",
};

function formatIn(unit: Unit, x: number): string {
  switch (unit) {
    case "seconds":
      return formatDuration(x);
    case "share":
      return formatPercent(x, 1);
    case "metres":
      return `${Math.round(x)} m`;
    default:
      return x.toFixed(x >= 100 ? 0 : 1);
  }
}

/** The ± part, with the same precision as the mean it belongs to. */
function halfWidthIn(unit: Unit, h: number, mean: number): string {
  if (unit === "seconds") return formatDuration(h);
  if (unit === "share") return `${(h * 100).toFixed(1)} pts`;
  if (unit === "metres") return `${Math.round(h)} m`;
  return h.toFixed(mean >= 100 ? 0 : 1);
}

/** "12 min 30 s ± 1 min 05 s" (mean ± 95% CI half-width); "–" without data. */
export function formatStat(s: StatSummary | undefined, unit: Unit): string {
  if (!s || s.mean === null || !Number.isFinite(s.mean)) return "–";
  const mean = formatIn(unit, s.mean);
  return s.ci95HalfWidth !== null && Number.isFinite(s.ci95HalfWidth) ? `${mean} ± ${halfWidthIn(unit, s.ci95HalfWidth, s.mean)}` : mean;
}

export interface StatRow {
  key: string;
  label: string;
  value: string;
  n: number;
}

/** Headline rows of a batch (mean ± 95% CI over the seeds). Missing metrics are left out. */
export function batchRows(r: BatchResult, elementName: (id: string) => string = (id) => id): StatRow[] {
  const rows: StatRow[] = [];
  for (const h of HEADLINE) {
    const s = r.metrics[h.key];
    if (s && s.n > 0) rows.push({ key: h.key, label: h.label, value: formatStat(s, h.unit), n: s.n });
  }
  for (const key of Object.keys(r.metrics).sort()) {
    const m = /^elements\/([^/]+)\/p95Wait$/.exec(key);
    const s = r.metrics[key];
    if (m && s && s.n > 0) rows.push({ key, label: `${elementName(m[1] as string)}: p95 queue wait (worst lane)`, value: formatStat(s, "seconds"), n: s.n });
  }
  return rows;
}

/** The two answers of a lane sweep, in words. */
export function laneSweepSentences(r: LaneSweepResult, elementName: string): { main: string; byMean: string; byCi: string } {
  const target = formatDuration(r.targetWait);
  const what = r.metric === "elementP95Wait" ? `the p95 queue wait at ${elementName}` : METRIC_LABEL[r.metric].toLowerCase();
  const range = `${r.points[0]?.laneCount ?? "?"}–${r.points[r.points.length - 1]?.laneCount ?? "?"}`;
  const say = (n: number | null) => (n === null ? `no lane count in ${range} meets it` : `${n} lane${n === 1 ? "" : "s"}`);
  const chosen = r.rule === "ci" ? r.smallestLaneCountByCi : r.smallestLaneCountByMean;
  return {
    main: chosen === null ? `No lane count of ${elementName} from ${range} keeps ${what} at or below ${target}.` : `${elementName} needs ${chosen} lane${chosen === 1 ? "" : "s"} to keep ${what} at or below ${target}.`,
    byMean: `By the mean over the seeds: ${say(r.smallestLaneCountByMean)}.`,
    byCi: `By the whole 95% interval (cautious): ${say(r.smallestLaneCountByCi)}.`,
  };
}

/** Chart data for a lane sweep: x = lane counts; mean with CI bars; the target as a line. */
export function laneSweepChart(r: LaneSweepResult): { x: number[]; mean: (number | null)[]; low: (number | null)[]; high: (number | null)[]; target: number[]; highlight: number | null } {
  const x = r.points.map((p) => p.laneCount);
  const fin = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
  return {
    x,
    mean: r.points.map((p) => fin(p.target.mean)),
    low: r.points.map((p) => fin(p.target.low ?? p.target.mean)),
    high: r.points.map((p) => fin(p.target.high ?? p.target.mean)),
    target: x.map(() => r.targetWait),
    highlight: r.rule === "ci" ? r.smallestLaneCountByCi : r.smallestLaneCountByMean,
  };
}

/** A gate-opening time in words: "19:00 (1:30:00 before the start)". */
export function gateTimeText(t: number, eventStart: number, referenceClock: string): string {
  const before = eventStart - t;
  const rel = before > 0 ? `${formatHms(before)} before the start` : before === 0 ? "at the start" : `${formatHms(-before)} after the start`;
  return `${formatWallClock(referenceClock, t)} (${rel})`;
}

/**
 * E6: the sentence that leads the comparison view once a gate-opening sweep has finished, e.g.
 * "Latest gate opening for 95% inside by the start: 19:00 (1:30:00 before the start)".
 */
export function gateSweepHeadline(r: GateSweepResult, timeline: { eventStart: number | null; referenceClock: string }): { main: string; byMean: string; byCi: string } {
  const share = formatPercent(r.targetShareInside);
  const start = timeline.eventStart ?? 0;
  const say = (t: number | null) => (t === null ? "none of the candidate times" : gateTimeText(t, start, timeline.referenceClock));
  const chosen = r.rule === "ci" ? r.latestGatesOpenByCi : r.latestGatesOpenByMean;
  return {
    main: chosen === null ? `No candidate gate opening gets ${share} inside by the start.` : `Latest gate opening for ${share} inside by the start: ${say(chosen)}.`,
    byMean: `By the mean over the seeds: ${say(r.latestGatesOpenByMean)}.`,
    byCi: `By the whole 95% interval (cautious): ${say(r.latestGatesOpenByCi)}.`,
  };
}

/** Table rows for a gate-opening sweep, latest opening first. */
export function gateSweepRows(r: GateSweepResult, timeline: { eventStart: number | null; referenceClock: string }): { gatesOpen: number; time: string; share: string; meets: string }[] {
  const start = timeline.eventStart ?? 0;
  return [...r.points]
    .sort((a, b) => b.gatesOpen - a.gatesOpen)
    .map((p) => ({
      gatesOpen: p.gatesOpen,
      time: gateTimeText(p.gatesOpen, start, timeline.referenceClock),
      share: formatStat(p.shareInsideAtStart, "share"),
      meets: p.meetsByCi ? "✓ yes (whole interval)" : p.meetsByMean ? "✓ by the mean" : "✗ no",
    }));
}
