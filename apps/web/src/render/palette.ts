/**
 * Colours and shapes for the venue view. Agent colours are from the Okabe–Ito palette, which
 * stays distinguishable with the common colour-vision deficiencies, and every state also has its
 * own shape, so colour is never the only cue.
 */

import { AgentState } from "@bottleneck/engine";

export type Shape = "circle" | "square" | "diamond" | "triangle" | "cross";

export type DrawnState = "Walking" | "Queuing" | "InService" | "Inside" | "TurnedAway";

export interface StateStyle {
  state: number;
  key: DrawnState;
  color: number;
  css: string;
  shape: Shape;
  alpha: number;
  /** Relative size. */
  size: number;
}

export const STATE_STYLES: readonly StateStyle[] = [
  { state: AgentState.Walking, key: "Walking", color: 0x0072b2, css: "#0072B2", shape: "circle", alpha: 1, size: 1 },
  { state: AgentState.Queuing, key: "Queuing", color: 0xe69f00, css: "#E69F00", shape: "square", alpha: 1, size: 1 },
  { state: AgentState.InService, key: "InService", color: 0xcc79a7, css: "#CC79A7", shape: "diamond", alpha: 1, size: 1.15 },
  { state: AgentState.Inside, key: "Inside", color: 0x009e73, css: "#009E73", shape: "triangle", alpha: 0.45, size: 0.9 },
  { state: AgentState.TurnedAway, key: "TurnedAway", color: 0x555555, css: "#555555", shape: "cross", alpha: 0.8, size: 1 },
];

/** Index into STATE_STYLES for an agent state, or −1 when the agent is not drawn (Pending, vehicles). */
export function styleIndex(state: number): number {
  switch (state) {
    case AgentState.Walking:
      return 0;
    case AgentState.Queuing:
      return 1;
    case AgentState.InService:
      return 2;
    case AgentState.Inside:
      return 3;
    case AgentState.TurnedAway:
      return 4;
    default:
      return -1;
  }
}

export const LANE_COLORS = {
  open: 0x1e293b,
  openDark: 0xe2e8f0,
  closed: 0x94a3b8,
  failed: 0xd55e00,
  selected: 0x56b4e9,
} as const;

/** Sequential yellow-to-red ramp for the density heatmap (people per m²). */
const RAMP: [number, number, number][] = [
  [255, 255, 178],
  [254, 204, 92],
  [253, 141, 60],
  [240, 59, 32],
  [189, 0, 38],
];
export const HEATMAP_MIN = 0.3;
export const HEATMAP_MAX = 4;

/** RGBA for a density value; alpha 0 below HEATMAP_MIN. */
export function heatColor(density: number, out: Uint8ClampedArray, offset: number): void {
  if (!(density >= HEATMAP_MIN)) {
    out[offset + 3] = 0;
    return;
  }
  const t = Math.min(1, (density - HEATMAP_MIN) / (HEATMAP_MAX - HEATMAP_MIN));
  const pos = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = RAMP[i] as [number, number, number];
  const b = RAMP[i + 1] as [number, number, number];
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
  out[offset + 3] = 90 + 130 * t;
}

/** People who reached the destination fade out over this many simulated seconds, then are hidden. */
export const INSIDE_FADE_SECONDS = 30;

/** Opacity factor for someone Inside for `age` simulated seconds (1 on arrival, 0 after the fade). */
export function insideFade(age: number): number {
  if (Number.isNaN(age)) return 0;
  return Math.min(1, Math.max(0, 1 - age / INSIDE_FADE_SECONDS));
}

// ---------------------------------------------------------------------------------------------
// Cars (Phase 3)
// ---------------------------------------------------------------------------------------------

/** How a car is drawn: an arrow-nosed body while moving, a body with a stop bar while standing, plain while parked. */
export type CarShape = "arrow" | "stopped" | "parked" | "striped";

export type CarDrawnState = "CarDriving" | "CarStopped" | "CarParked" | "CarDiverted";

export interface CarStyle {
  key: CarDrawnState;
  color: number;
  css: string;
  shape: CarShape;
  alpha: number;
}

/** Index into CAR_STYLES: Driving (moving), Driving but standing (queued at a barrier, behind another car or at a crossing), Parked, Diverted. */
export const CAR_STYLES: readonly CarStyle[] = [
  { key: "CarDriving", color: 0x0072b2, css: "#0072B2", shape: "arrow", alpha: 1 },
  { key: "CarStopped", color: 0xe69f00, css: "#E69F00", shape: "stopped", alpha: 1 },
  { key: "CarParked", color: 0x64748b, css: "#64748B", shape: "parked", alpha: 0.85 },
  { key: "CarDiverted", color: 0xcc79a7, css: "#CC79A7", shape: "striped", alpha: 1 },
];

/** Below this speed (m/s) a driving car counts as standing (queued). */
export const CAR_STOPPED_SPEED = 0.3;

/** Index into CAR_STYLES for a car's state and speed, or −1 when the car is not on the map (Pending, Departed, TurnedAway). */
export function carStyleIndex(state: number, vx: number, vy: number): number {
  switch (state) {
    case AgentState.Driving:
      return vx * vx + vy * vy < CAR_STOPPED_SPEED * CAR_STOPPED_SPEED ? 1 : 0;
    case AgentState.Parked:
      return 2;
    case AgentState.Diverted:
      return 3;
    default:
      return -1;
  }
}

export const ROAD_COLORS = {
  road: 0x9ca3af,
  roadDark: 0x52525b,
  publicRoad: 0x6b7280,
  publicRoadDark: 0x3f3f46,
  aisle: 0xcbd5e1,
  aisleDark: 0x475569,
  marking: 0xffffff,
  lot: 0xe2e8f0,
  lotDark: 0x334155,
  stall: 0x64748b,
  boundary: 0xd55e00,
  barrierIdle: 0x1e293b,
  barrierIdleDark: 0xe2e8f0,
  barrierBusy: 0xcc79a7,
  crossing: 0xffffff,
} as const;
