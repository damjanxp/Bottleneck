/**
 * Venue geometry: the walkable grid (spec 4.2 "the walkable area is rasterised into a 0.5 m grid").
 *
 * Coordinates. The engine works in *local* metres: venue metres minus the minimum corner of the
 * walkable areas' bounding box, rounded to 1/1024 m. Anchoring the grid to the bounding box means
 * translating the whole venue moves the grid with it, so a translated venue gives bit-identical
 * results (review note B7). The rounding absorbs the last-bit error of the subtraction itself,
 * e.g. (5.1 − 0.1) is not exactly 5 in binary.
 *
 * Rasterisation is a scanline fill with the even-odd rule: for each row of cell centres, collect
 * where the row crosses the polygon's edges (outer ring and holes together), sort the crossings and
 * fill between pairs. A cell is walkable if its centre is inside some walkable area (minus its
 * holes) and not inside any obstacle (minus the obstacle's holes). No trigonometry is involved.
 */

import type { Point, Polygon, Venue } from "@bottleneck/schema";

/** Side of a navigation cell in metres. */
export const CELL_SIZE = 0.5;

/** Local coordinates are rounded to this many steps per metre (1/1024 m ≈ 1 mm). */
const QUANTUM = 1024;

export interface LocalFrame {
  /** Venue coordinates of local (0, 0): the bounding-box minimum of the walkable areas. */
  readonly originX: number;
  readonly originY: number;
  /** Size of the bounding box in metres. */
  readonly width: number;
  readonly height: number;
}

/** A point with venue coordinates converted to local coordinates. */
export function toLocal(frame: LocalFrame, p: Point): { x: number; y: number } {
  return {
    x: Math.round((p.x - frame.originX) * QUANTUM) / QUANTUM,
    y: Math.round((p.y - frame.originY) * QUANTUM) / QUANTUM,
  };
}

export function localFrame(venue: Venue): LocalFrame {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const area of venue.walkableAreas) {
    for (const p of area.polygon.outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(minX < maxX && minY < maxY)) throw new RangeError("The venue has no walkable area with a positive size");
  const frame = { originX: minX, originY: minY, width: 0, height: 0 };
  const far = toLocal(frame, { x: maxX, y: maxY });
  return { originX: minX, originY: minY, width: far.x, height: far.y };
}

/** Local-coordinate rings of a polygon (outer first, then holes). */
export type LocalRing = readonly { x: number; y: number }[];

export function localRings(frame: LocalFrame, polygon: Polygon): LocalRing[] {
  const rings: LocalRing[] = [polygon.outer.map((p) => toLocal(frame, p))];
  for (const hole of polygon.holes ?? []) rings.push(hole.map((p) => toLocal(frame, p)));
  return rings;
}

/** Even-odd point-in-polygon test over all rings (so holes are excluded). */
export function insideRings(rings: readonly LocalRing[], px: number, py: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = ring[i] as { x: number; y: number };
      const b = ring[j] as { x: number; y: number };
      if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** The navigation grid: one byte per 0.5 m cell, 1 = walkable. Cell (c, r) has index r·cols + c. */
export class WalkGrid {
  readonly cellSize = CELL_SIZE;
  readonly cols: number;
  readonly rows: number;
  readonly walkable: Uint8Array;

  constructor(readonly frame: LocalFrame) {
    this.cols = Math.max(1, Math.ceil(frame.width / CELL_SIZE));
    this.rows = Math.max(1, Math.ceil(frame.height / CELL_SIZE));
    this.walkable = new Uint8Array(this.cols * this.rows);
  }

  get cellCount(): number {
    return this.cols * this.rows;
  }

  /** Cell index containing a local point, or −1 outside the grid. */
  cellAt(x: number, y: number): number {
    const c = Math.floor(x / CELL_SIZE);
    const r = Math.floor(y / CELL_SIZE);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  isWalkableAt(x: number, y: number): boolean {
    const cell = this.cellAt(x, y);
    return cell >= 0 && this.walkable[cell] === 1;
  }

  centreX(cell: number): number {
    return ((cell % this.cols) + 0.5) * CELL_SIZE;
  }

  centreY(cell: number): number {
    return (Math.floor(cell / this.cols) + 0.5) * CELL_SIZE;
  }

  /** Walkable cell whose centre is closest to (x, y); ties go to the lowest index. −1 if none. */
  nearestWalkable(x: number, y: number): number {
    const own = this.cellAt(x, y);
    if (own >= 0 && this.walkable[own] === 1) return own;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.walkable.length; i++) {
      if (this.walkable[i] !== 1) continue;
      const dx = this.centreX(i) - x;
      const dy = this.centreY(i) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /**
   * Sets `value` in `mask` for every cell whose centre lies inside the polygon (even-odd over all
   * rings), using one scanline per row of cell centres.
   */
  fill(mask: Uint8Array, rings: readonly LocalRing[], value: number): void {
    const xs: number[] = [];
    for (let r = 0; r < this.rows; r++) {
      const py = (r + 0.5) * CELL_SIZE;
      xs.length = 0;
      for (const ring of rings) {
        const n = ring.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const a = ring[i] as { x: number; y: number };
          const b = ring[j] as { x: number; y: number };
          if (a.y > py !== b.y > py) xs.push(((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x);
        }
      }
      if (xs.length < 2) continue;
      const sorted = Float64Array.from(xs).sort();
      for (let k = 0; k + 1 < sorted.length; k += 2) {
        // Cells whose centre (c + 0.5)·size lies in [x0, x1).
        const c0 = Math.max(0, Math.ceil((sorted[k] as number) / CELL_SIZE - 0.5));
        const c1 = Math.min(this.cols, Math.ceil((sorted[k + 1] as number) / CELL_SIZE - 0.5));
        for (let c = c0; c < c1; c++) mask[r * this.cols + c] = value;
      }
    }
  }
}

/** Rasterises the venue's walkable areas minus holes and obstacles. */
export function buildWalkGrid(venue: Venue, frame: LocalFrame): WalkGrid {
  const grid = new WalkGrid(frame);
  for (const area of venue.walkableAreas) grid.fill(grid.walkable, localRings(frame, area.polygon), 1);
  for (const obstacle of venue.obstacles) grid.fill(grid.walkable, localRings(frame, obstacle.polygon), 0);
  return grid;
}
