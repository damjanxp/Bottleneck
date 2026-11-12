/**
 * Which headline numbers apply to an event (spec 4.5): fixed-start events lead with people still
 * outside at the start, open-door events with the share inside by T; both show p95 wait at peak.
 * Also picks the worst lane (longest queue right now).
 */

import type { LaneLayout, LaneLive } from "@bottleneck/engine";
import type { Scenario } from "@bottleneck/schema";
import type { MetricsSummary } from "../workerProtocol.ts";

export type HeadlineKind = "stillOutside" | "p95PeakWait" | "shareInside";

export interface Headline {
  kind: HeadlineKind;
  value: number;
  /** False while the number can still change because its reference time has not come yet. */
  final: boolean;
  /** Scenario time the number refers to, if any. */
  at: number | null;
  /** "Still outside at the start", split: already on site (arrived, not through the gates) and not arrived yet. */
  split?: { onSite: number; notArrived: number };
}

export function headlines(m: MetricsSummary, eventStart: number | null, now: number): Headline[] {
  const out: Headline[] = [];
  if (eventStart !== null && m.stillOutsideAtStart !== null) {
    const h: Headline = { kind: "stillOutside", value: m.stillOutsideAtStart, final: now >= eventStart, at: eventStart };
    if (m.arrivedButOutsideAtStart !== null && m.notYetArrivedAtStart !== null) h.split = { onSite: m.arrivedButOutsideAtStart, notArrived: m.notYetArrivedAtStart };
    out.push(h);
  }
  out.push({ kind: "p95PeakWait", value: m.peakHour.p95Wait, final: now >= m.peakHour.end, at: null });
  if (eventStart === null) {
    out.push({ kind: "shareInside", value: m.shareInside.share, final: now >= m.shareInside.time, at: m.shareInside.time });
  }
  return out;
}

/** Lane with the longest queue (lowest lane id wins ties); null when no queue at all. */
export function worstLane(states: readonly LaneLive[]): LaneLive | null {
  let best: LaneLive | null = null;
  for (const s of states) if (s.queueLength > 0 && (best === null || s.queueLength > best.queueLength)) best = s;
  return best;
}

/** "Bag check lane 2", "Main turnstiles manual lane". */
export function laneLabel(layout: LaneLayout, elementName: string, laneWord: string, manualWord: string): string {
  return layout.manual ? `${elementName} ${manualWord}` : `${elementName} ${laneWord} ${layout.laneIndex + 1}`;
}

/** Lower is better for waits and people outside; higher is better for the share inside. */
export function lowerIsBetter(kind: HeadlineKind): boolean {
  return kind !== "shareInside";
}

export interface HeadlineComparison {
  kind: HeadlineKind;
  before: Headline;
  after: Headline | null;
  /** after − before, when both are known. */
  delta: number | null;
  /** True if after is better, false if worse, null if equal or not both final yet. */
  improved: boolean | null;
}

/** Pairs the headline numbers of two runs by kind (review A9: the "+1 lane" before/after). */
export function compareHeadlines(before: readonly Headline[], after: readonly Headline[]): HeadlineComparison[] {
  return before.map((b) => {
    const a = after.find((x) => x.kind === b.kind) ?? null;
    const delta = a ? a.value - b.value : null;
    let improved: boolean | null = null;
    if (a && delta !== null && a.final && b.final && Math.abs(delta) > 1e-9) improved = lowerIsBetter(b.kind) ? delta < 0 : delta > 0;
    return { kind: b.kind, before: b, after: a, delta, improved };
  });
}

/** Most lanes an element may have (schema: laneCount ≤ 64). */
export const MAX_LANES = 64;

/** The same scenario with one more regular lane at element `elementId`, which has `laneCount` lanes now. */
export function withExtraLane(scenario: Scenario, elementId: string, laneCount: number): Scenario {
  const overrides = { ...(scenario.overrides ?? {}) };
  overrides[elementId] = { ...(overrides[elementId] ?? {}), laneCount: Math.min(MAX_LANES, laneCount + 1) };
  return { ...scenario, overrides };
}
