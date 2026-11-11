/** Pure formatting helpers for the simulation view. All text templates live in strings.ts. */

import type { Distribution } from "@bottleneck/schema";

const MINUS = "−";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** h:mm:ss or m:ss for a non-negative number of seconds. */
export function formatHms(totalSeconds: number): string {
  const s = Math.floor(Math.abs(totalSeconds) + 1e-9);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/**
 * Clock relative to an anchor: for fixed-start events "T−45:00" / "T+5:00" around the event start;
 * for open-door events "+1:30:00" after opening.
 */
export function formatRelativeClock(scenarioTime: number, anchor: number, fixedStart: boolean): string {
  const d = scenarioTime - anchor;
  const sign = d < 0 ? MINUS : "+";
  return `${fixedStart ? "T" : ""}${sign}${formatHms(d)}`;
}

/** Wall-clock time "HH:MM" for scenario time t, given the 'HH:MM' wall time of t = 0. */
export function formatWallClock(referenceClock: string, t: number, withSeconds = false): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(referenceClock);
  const base = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 : 0;
  const day = 86400;
  const s = (((Math.floor(base + t) % day) + day) % day) as number;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return withSeconds ? `${pad2(h)}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(h)}:${pad2(m)}`;
}

/** Waiting times: "45 s", "3 min 20 s", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  const s = Math.round(Math.max(0, seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m} min` : `${m} min ${r} s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} h ${pad2(m)} min`;
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

export function formatPercent(share: number, digits = 0): string {
  if (!Number.isFinite(share)) return "–";
  return `${(share * 100).toFixed(digits)}%`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/** A distribution as short text, e.g. "uniform 20–40" or "truncated normal (mean 1.3, sd 0.25, 0.5–2.2)". */
export function formatDistribution(d: Distribution, unit = ""): string {
  const u = unit ? ` ${unit}` : "";
  switch (d.kind) {
    case "fixed":
      return `${num(d.value)}${u}`;
    case "uniform":
      return `uniform ${num(d.min)}–${num(d.max)}${u}`;
    case "exponential":
      return `exponential, mean ${num(d.mean)}${u}`;
    case "truncatedNormal":
      return `normal, mean ${num(d.mean)}, sd ${num(d.sd)}, limited to ${num(d.min)}–${num(d.max)}${u}`;
    case "shiftedLognormal":
      return `${num(d.shift)}${u} + lognormal (μ ${num(d.mu)}, σ ${num(d.sigma)})`;
  }
}

export function formatBytesPerSecond(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB/s`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB/s`;
  return `${Math.round(bytes)} B/s`;
}
