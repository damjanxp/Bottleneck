import type { LaneLayout, ServiceRecord } from "@bottleneck/engine";

export type ScanLogEvent = "scan_ok" | "scan_fail" | "manual_ok" | "rejected";

export interface ScanLogRow {
  /** Local clock time "HH:MM:SS.sss" on the scenario's reference-clock day (wraps at 24 h). */
  time: string;
  /** Scenario time in seconds relative to t = 0 (may be negative). This column is what the importer uses. */
  seconds: number;
  /** "<elementId>#<lane number from 1>", or "<elementId>#manual" for the manual lane. */
  lane: string;
  event: ScanLogEvent;
}

export interface ScanLogOptions {
  /** Include screening lanes (every completed screening attempt becomes "scan_ok"). Default false. */
  includeScreening?: boolean;
}

const DAY_MS = 86400 * 1000;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** "HH:MM:SS.sss" for `referenceClock` ("HH:MM") plus `seconds`, wrapped into one day. */
export function formatClock(referenceClock: string, seconds: number): string {
  const [h, m] = referenceClock.split(":").map(Number) as [number, number];
  const ms = Math.round((h * 3600 + m * 60 + seconds) * 1000);
  const wrapped = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  const whole = Math.floor(wrapped / 1000);
  return `${pad(Math.floor(whole / 3600), 2)}:${pad(Math.floor((whole % 3600) / 60), 2)}:${pad(whole % 60, 2)}.${pad(wrapped % 1000, 3)}`;
}

/** Lane name used in the log. */
export function laneName(layout: LaneLayout): string {
  return `${layout.elementId}#${layout.manual ? "manual" : layout.laneIndex + 1}`;
}

/**
 * Turns the engine's service log into fake turnstile and barrier logs: one row per completed attempt at its
 * end time. A failed first scan is "scan_fail"; a pass is "scan_ok" (or "manual_ok" on the manual lane); an
 * agent whose retry also fails is "rejected" (it then goes to the manual lane).
 * `timeOffset` is the run's scenario time of engine time 0 (Run.timeOffset).
 */
export function scanLogFromRun(
  records: readonly ServiceRecord[],
  lanes: readonly LaneLayout[],
  timeOffset: number,
  referenceClock: string,
  options: ScanLogOptions = {},
): ScanLogRow[] {
  const byId = new Map<number, LaneLayout>();
  for (const l of lanes) byId.set(l.laneId, l);
  const rows: ScanLogRow[] = [];
  for (const r of records) {
    const layout = byId.get(r.laneId);
    if (layout === undefined) continue;
    if (layout.elementKind === "screening" && options.includeScreening !== true) continue;
    const event: ScanLogEvent = r.outcome === "retry" ? "scan_fail" : r.outcome === "reject" ? "rejected" : layout.manual ? "manual_ok" : "scan_ok";
    const seconds = Math.round((r.end + timeOffset) * 1000) / 1000;
    rows.push({ time: formatClock(referenceClock, seconds), seconds, lane: laneName(layout), event });
  }
  return rows;
}

export function toScanLogCsv(rows: readonly ScanLogRow[]): string {
  const lines = ["time,seconds,lane,event"];
  for (const r of rows) lines.push(`${r.time},${r.seconds.toFixed(3)},${r.lane},${r.event}`);
  return lines.join("\n") + "\n";
}

const EVENTS: readonly string[] = ["scan_ok", "scan_fail", "manual_ok", "rejected"];
const CLOCK = /^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Tolerant CSV reader: trims cells, skips blank lines, accepts the columns in any order (named in a header
 * line), and reports each bad line (1-based line numbers) in `errors` instead of throwing.
 */
export function parseScanLogCsv(text: string): { rows: ScanLogRow[]; errors: string[] } {
  const rows: ScanLogRow[] = [];
  const errors: string[] = [];
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  let columns: { time: number; seconds: number; lane: number; event: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (raw === "") continue;
    const cells = raw.split(",").map((c) => c.trim());
    if (columns === null) {
      const idx = (name: string): number => cells.findIndex((c) => c.toLowerCase() === name);
      columns = { time: idx("time"), seconds: idx("seconds"), lane: idx("lane"), event: idx("event") };
      if (columns.seconds < 0 || columns.lane < 0 || columns.event < 0) {
        errors.push(`Line ${i + 1}: the header must name the columns time, seconds, lane and event (got "${raw}")`);
        return { rows, errors };
      }
      continue;
    }
    const secondsText = cells[columns.seconds] ?? "";
    const seconds = Number(secondsText);
    const lane = cells[columns.lane] ?? "";
    const event = (cells[columns.event] ?? "").toLowerCase();
    const time = columns.time >= 0 ? (cells[columns.time] ?? "") : "";
    if (secondsText === "" || !Number.isFinite(seconds)) errors.push(`Line ${i + 1}: seconds is not a number ("${secondsText}")`);
    else if (lane === "") errors.push(`Line ${i + 1}: lane is empty`);
    else if (!EVENTS.includes(event)) errors.push(`Line ${i + 1}: unknown event "${event}" (expected ${EVENTS.join(", ")})`);
    else if (time !== "" && !CLOCK.test(time)) errors.push(`Line ${i + 1}: time "${time}" is not HH:MM:SS.sss`);
    else rows.push({ time, seconds, lane, event: event as ScanLogEvent });
  }
  return { rows, errors };
}
