/**
 * Polygon checks for the venue editor (D-066). A self-intersecting polygon ("bow tie") has no
 * clear inside: the engine's point-in-polygon test would give a strange walkable area, so the
 * editor refuses to save one. Rings are lists of points with the closing edge implied.
 *
 * Pure.
 */

import type { Point, Polygon } from "@bottleneck/schema";

/** Twice the signed area; its sign gives the winding direction. */
export function signedArea2(ring: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Point;
    const q = ring[(i + 1) % ring.length] as Point;
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

export function area(ring: readonly Point[]): number {
  return Math.abs(signedArea2(ring)) / 2;
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);
}

/** True if closed segments ab and cd share at least one point (touching counts). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * Pairs of edges (by index of their first point) that cross or touch, other than neighbouring
 * edges meeting at their shared corner. Edge i runs from point i to point i+1 (the last one back to
 * point 0). Also reports repeated points and collinear overlaps of neighbours. O(n²), which is fine
 * for hand-drawn polygons (tens of points).
 */
export function selfIntersections(ring: readonly Point[]): [number, number][] {
  const n = ring.length;
  const out: [number, number][] = [];
  if (n < 3) return out;
  const p = (i: number) => ring[i % n] as Point;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const neighbours = j === i + 1 || (i === 0 && j === n - 1);
      if (neighbours) {
        // Neighbours share one corner; they are only a problem if they fold back over each other.
        const shared = j === i + 1 ? p(j) : p(i);
        const a = j === i + 1 ? p(i) : p(j);
        const b = j === i + 1 ? p(j + 1) : p(i + 1);
        if (orient(a, shared, b) === 0 && (a.x - shared.x) * (b.x - shared.x) + (a.y - shared.y) * (b.y - shared.y) > 0) out.push([i, j]);
        continue;
      }
      if (segmentsIntersect(p(i), p(i + 1), p(j), p(j + 1))) out.push([i, j]);
    }
  }
  return out;
}

/** True if the polygon's outer ring or any hole crosses itself, or has fewer than 3 points or no area. */
export function isDegenerateOrSelfIntersecting(poly: Polygon): boolean {
  const rings = [poly.outer, ...(poly.holes ?? [])];
  return rings.some((r) => r.length < 3 || area(r) === 0 || selfIntersections(r).length > 0);
}

/** The area-weighted centre of a ring (the average of its points if it has no area). */
export function centroidOf(ring: readonly Point[]): Point {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] as Point;
    const q = ring[(i + 1) % ring.length] as Point;
    const f = p.x * q.y - q.x * p.y;
    a += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = Math.max(1, ring.length);
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, y: ring.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
