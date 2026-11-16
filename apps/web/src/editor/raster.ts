/**
 * Painting areas with a brush, and keeping areas connected (redesign 3).
 *
 * Areas are polygons in the venue, but painting is easier on a grid: a stroke (or a traced map
 * region) is rasterised into a mask together with the existing polygons of the same kind that it
 * touches, and the mask is turned back into polygons (outer outline plus holes, simplified). So
 * two walkable parts that overlap or touch become one area, painting over a gap joins them, and
 * erasing cuts holes or splits an area. Pure.
 */

import type { Point, Polygon } from "@bottleneck/schema";
import { fillHoles, simplifyRing, traceOutline, type PixelPoint } from "./trace.ts";

/** A grid over venue space: cell (i, j) covers [x0 + i·cell, x0 + (i+1)·cell) × [y0 + j·cell, …). */
export interface Grid {
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
  data: Uint8Array;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** At most this many cells per grid (memory and time); the cell size grows to stay under it. */
export const MAX_CELLS = 1_500_000;

export function makeGrid(box: Box, cell: number, pad = 2): Grid {
  let c = cell;
  const span = () => ({ w: Math.ceil((box.maxX - box.minX) / c) + 2 * pad, h: Math.ceil((box.maxY - box.minY) / c) + 2 * pad });
  while (span().w * span().h > MAX_CELLS) c *= 1.25;
  const { w, h } = span();
  return { x0: box.minX - pad * c, y0: box.minY - pad * c, cell: c, w, h, data: new Uint8Array(w * h) };
}

export function ringBox(rings: readonly (readonly Point[])[]): Box {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of rings)
    for (const p of r) {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  return b;
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.minX - margin <= b.maxX && b.minX - margin <= a.maxX && a.minY - margin <= b.maxY && b.minY - margin <= a.maxY;
}

/** Sets (value 1) or clears (value 0) every cell whose centre lies inside the polygon (holes respected). */
export function rasterizePolygon(g: Grid, poly: Polygon, value: 0 | 1 = 1): void {
  const rings = [poly.outer, ...(poly.holes ?? [])];
  for (let j = 0; j < g.h; j++) {
    const y = g.y0 + (j + 0.5) * g.cell;
    // Even-odd crossings of this row with every ring edge.
    const xs: number[] = [];
    for (const r of rings)
      for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
        const a = r[i] as Point;
        const b = r[k] as Point;
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil(((xs[n] as number) - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.floor(((xs[n + 1] as number) - g.x0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) g.data[j * g.w + i] = value;
    }
  }
}

/** Paints a disc of radius r (metres) at (cx, cy). */
export function paintDisc(g: Grid, cx: number, cy: number, r: number, value: 0 | 1 = 1): void {
  const i0 = Math.max(0, Math.floor((cx - r - g.x0) / g.cell));
  const i1 = Math.min(g.w - 1, Math.ceil((cx + r - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((cy - r - g.y0) / g.cell));
  const j1 = Math.min(g.h - 1, Math.ceil((cy + r - g.y0) / g.cell));
  const r2 = r * r;
  for (let j = j0; j <= j1; j++) {
    const dy = g.y0 + (j + 0.5) * g.cell - cy;
    for (let i = i0; i <= i1; i++) {
      const dx = g.x0 + (i + 0.5) * g.cell - cx;
      if (dx * dx + dy * dy <= r2) g.data[j * g.w + i] = value;
    }
  }
}

/** Paints a brush stroke: discs along the path, close enough to leave no gaps. */
export function paintStroke(g: Grid, path: readonly Point[], r: number, value: 0 | 1 = 1): void {
  if (path.length === 0) return;
  const step = Math.max(g.cell * 0.5, r * 0.35);
  paintDisc(g, (path[0] as Point).x, (path[0] as Point).y, r, value);
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1] as Point;
    const b = path[k] as Point;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let s = 1; s <= n; s++) paintDisc(g, a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n, r, value);
  }
}

/** Labels 4-connected components of value 1; returns the label per cell (0 = none) and the count. */
export function components(data: Uint8Array, w: number, h: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (!data[start] || labels[start]) continue;
    count++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = count;
    while (head < tail) {
      const i = queue[head++] as number;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j >= 0 && data[j] && !labels[j]) {
          labels[j] = count;
          queue[tail++] = j;
        }
      }
    }
  }
  return { labels, count };
}

const toVenue = (g: Grid, ring: PixelPoint[]): Point[] => ring.map((p) => ({ x: Math.round((g.x0 + p.px * g.cell) * 100) / 100, y: Math.round((g.y0 + p.py * g.cell) * 100) / 100 }));

/**
 * The mask as polygons: one per connected area, with holes; areas smaller than minArea (m²) are
 * dropped and holes smaller than minArea are filled. `epsilon` is the simplification in cells.
 */
export function gridToPolygons(g: Grid, minArea = 1, epsilon = 1.2): Polygon[] {
  const { labels, count } = components(g.data, g.w, g.h);
  const cellArea = g.cell * g.cell;
  const out: Polygon[] = [];
  const sizes = new Int32Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i] as number;
    sizes[l] = (sizes[l] as number) + 1;
  }
  for (let c = 1; c <= count; c++) {
    if ((sizes[c] as number) * cellArea < minArea) continue;
    const mask = new Uint8Array(g.w * g.h);
    for (let i = 0; i < labels.length; i++) if (labels[i] === c) mask[i] = 1;
    const outer = simplifyRing(traceOutline(mask, g.w, g.h), epsilon);
    if (outer.length < 3) continue;
    // Holes: the empty cells inside the area that cannot reach the border.
    const filled = fillHoles(mask, g.w, g.h);
    const holeMask = new Uint8Array(g.w * g.h);
    for (let i = 0; i < mask.length; i++) holeMask[i] = filled[i] && !mask[i] ? 1 : 0;
    const holes: Point[][] = [];
    const hc = components(holeMask, g.w, g.h);
    for (let k = 1; k <= hc.count; k++) {
      const hm = new Uint8Array(g.w * g.h);
      let n = 0;
      for (let i = 0; i < hm.length; i++)
        if (hc.labels[i] === k) {
          hm[i] = 1;
          n++;
        }
      if (n * cellArea < minArea) continue;
      const ring = simplifyRing(traceOutline(hm, g.w, g.h), epsilon);
      if (ring.length >= 3) holes.push(toVenue(g, ring));
    }
    out.push(holes.length > 0 ? { outer: toVenue(g, outer), holes } : { outer: toVenue(g, outer) });
  }
  return out;
}

/** Area of the cells set in the grid, m². */
export function gridArea(g: Grid): number {
  let n = 0;
  for (const v of g.data) n += v;
  return n * g.cell * g.cell;
}
