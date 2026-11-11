/**
 * Which headline numbers apply to an event (spec 4.5): fixed-start events lead with people still
 * outside at the start, open-door events with the share inside by T; both show p95 wait at peak.
 * Also picks the worst lane (longest queue right now).
 */

import type { LaneLayout, LaneLive } from "@bottleneck/engine";
import type { MetricsSummary } from "../workerProtocol.ts";

export type HeadlineKind = "stillOutside" | "p95PeakWait" | "shareInside";

export interface Headline {
  kind: HeadlineKind;
  value: number;
  /** False while the number can still change because its reference time has not come yet. */
  final: boolean;
  /** Scenario time the number refers to, if any. */
  at: number | null;
}

export function headlines(m: MetricsSummary, eventStart: number | null, now: number): Headline[] {
  const out: Headline[] = [];
  if (eventStart !== null && m.stillOutsideAtStart !== null) {
    out.push({ kind: "stillOutside", value: m.stillOutsideAtStart, final: now >= eventStart, at: eventStart });
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
