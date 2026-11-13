/**
 * Geometry for drawing roads, stalls, barriers and crossings (venue metres, y down). Pure: the
 * renderer turns these numbers into PixiJS graphics; tested in vehicleGeometry.test.ts.
 */

import type { VehicleLayout } from "@bottleneck/engine";

export interface Pt {
  x: number;
  y: number;
}

/** Drawn stall size (m): a stall is this wide across and `depth` deep along the parked car. */
export const STALL_WIDTH = 2.5;
export const STALL_DEPTH = 5;

/** Corners of a stall as a flat [x0, y0, x1, y1, …] ring; `hx, hy` is the unit vector from the aisle into the stall. */
export function stallCorners(s: { x: number; y: number; hx: number; hy: number }, width = STALL_WIDTH, depth = STALL_DEPTH): number[] {
  let hx = s.hx;
  let hy = s.hy;
  const len = Math.hypot(hx, hy);
  if (!(len > 0)) {
    hx = 1;
    hy = 0;
  } else {
    hx /= len;
    hy /= len;
  }
  const px = -hy;
  const py = hx;
  const d = depth / 2;
  const w = width / 2;
  return [s.x - hx * d - px * w, s.y - hy * d - py * w, s.x + hx * d - px * w, s.y + hy * d - py * w, s.x + hx * d + px * w, s.y + hy * d + py * w, s.x - hx * d + px * w, s.y - hy * d + py * w];
}

/** Full drawn width of a road: lanes per direction × lane width, both directions for a two-way road. */
export function roadWidth(road: { direction: "oneWay" | "twoWay"; laneCount: number }, laneWidth: number): number {
  return Math.max(1, road.laneCount) * laneWidth * (road.direction === "twoWay" ? 2 : 1);
}

export function polylineLength(points: readonly Pt[]): number {
  let len = 0;
  for (let k = 1; k < points.length; k++) len += Math.hypot((points[k] as Pt).x - (points[k - 1] as Pt).x, (points[k] as Pt).y - (points[k - 1] as Pt).y);
  return len;
}

/** Points every `spacing` metres along a polyline (starting at spacing/2), each with the unit driving direction there. */
export function pointsAlong(points: readonly Pt[], spacing: number): { x: number; y: number; dx: number; dy: number }[] {
  const out: { x: number; y: number; dx: number; dy: number }[] = [];
  if (points.length < 2 || !(spacing > 0)) return out;
  let next = spacing / 2;
  let walked = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Pt;
    const b = points[k] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    while (next <= walked + len) {
      const f = next - walked;
      out.push({ x: a.x + dx * f, y: a.y + dy * f, dx, dy });
      next += spacing;
    }
    walked += len;
  }
  return out;
}

/** Dashed line along a polyline: [x1, y1, x2, y2] per dash. */
export function dashSegments(points: readonly Pt[], dash: number, gap: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (!(dash > 0) || gap < 0) return out;
  let phase = 0; // position within the current dash+gap period
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Pt;
    const b = points[k] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    let pos = 0;
    while (pos < len) {
      if (phase < dash) {
        const run = Math.min(dash - phase, len - pos);
        out.push([a.x + dx * pos, a.y + dy * pos, a.x + dx * (pos + run), a.y + dy * (pos + run)]);
        pos += run;
        phase += run;
      } else {
        const run = Math.min(dash + gap - phase, len - pos);
        pos += run;
        phase += run;
      }
      if (phase >= dash + gap) phase = 0;
    }
  }
  return out;
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(p: Pt, points: readonly Pt[]): number {
  let best = Infinity;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Pt;
    const b = points[k] as Pt;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)));
  }
  if (points.length === 1) best = Math.hypot(p.x - (points[0] as Pt).x, p.y - (points[0] as Pt).y);
  return best;
}

/** Roads join within this distance (the venue schema says 1 m); a little slack for drawing. */
const JOIN_DISTANCE = 1.5;

export interface BoundaryMark {
  roadId: string;
  /** Where the site road meets the public road. */
  x: number;
  y: number;
  /** Unit direction of the site road at that end, pointing into the site. */
  dx: number;
  dy: number;
  /** Drawn width of the site road. */
  width: number;
}

/**
 * Where each site road meets a public road: a queue backing up past this mark stands on the public
 * road (spec 4.3). One mark per road end that touches a public road.
 */
export function publicRoadBoundaries(layout: VehicleLayout): BoundaryMark[] {
  const publicRoads = layout.roads.filter((r) => r.publicRoad);
  const out: BoundaryMark[] = [];
  if (publicRoads.length === 0) return out;
  for (const r of layout.roads) {
    if (r.publicRoad || r.points.length < 2) continue;
    const ends: [Pt, Pt][] = [
      [r.points[0] as Pt, r.points[1] as Pt],
      [r.points[r.points.length - 1] as Pt, r.points[r.points.length - 2] as Pt],
    ];
    for (const [end, inner] of ends) {
      if (!publicRoads.some((p) => distanceToPolyline(end, p.points) <= JOIN_DISTANCE)) continue;
      const len = Math.hypot(inner.x - end.x, inner.y - end.y) || 1;
      const dx = (inner.x - end.x) / len;
      const dy = (inner.y - end.y) / len;
      // Put the mark at the edge of the public road, not on its centre line.
      const pr = publicRoads.find((p) => distanceToPolyline(end, p.points) <= JOIN_DISTANCE) as (typeof publicRoads)[number];
      const off = Math.min(len / 2, roadWidth(pr, layout.laneWidth) / 2 + 0.5);
      out.push({ roadId: r.id, x: end.x + dx * off, y: end.y + dy * off, dx, dy, width: roadWidth(r, layout.laneWidth) });
    }
  }
  return out;
}

/** Zebra stripes of a crossing a–b (across the road), `width` metres wide along the road: one ring per stripe. */
export function zebraStripes(a: Pt, b: Pt, width: number, stripe = 0.5): number[][] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return [];
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  // Along the road (perpendicular to a–b).
  const vx = -uy;
  const vy = ux;
  const w = width / 2;
  const out: number[][] = [];
  for (let s = 0; s + stripe <= len + 1e-9; s += 2 * stripe) {
    const x0 = a.x + ux * s;
    const y0 = a.y + uy * s;
    const x1 = a.x + ux * (s + stripe);
    const y1 = a.y + uy * (s + stripe);
    out.push([x0 - vx * w, y0 - vy * w, x1 - vx * w, y1 - vy * w, x1 + vx * w, y1 + vy * w, x0 + vx * w, y0 + vy * w]);
  }
  return out;
}

/** A barrier arm across one lane: the segment perpendicular to the driving direction through the stop position. */
export function barrierArm(stop: Pt, heading: Pt, laneWidth: number): [number, number, number, number] {
  const len = Math.hypot(heading.x, heading.y) || 1;
  const px = -heading.y / len;
  const py = heading.x / len;
  const h = (laneWidth * 0.9) / 2;
  return [stop.x - px * h, stop.y - py * h, stop.x + px * h, stop.y + py * h];
}

/** A small chevron pointing along (dx, dy) at (x, y), `size` metres long: [x1, y1, tip x, tip y, x2, y2]. */
export function chevron(x: number, y: number, dx: number, dy: number, size: number): number[] {
  const px = -dy;
  const py = dx;
  const h = size / 2;
  return [x - dx * h + px * h, y - dy * h + py * h, x + dx * h, y + dy * h, x - dx * h - px * h, y - dy * h - py * h];
}
