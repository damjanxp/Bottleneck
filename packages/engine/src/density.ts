/**
 * Crowd density and the Weidmann speed–density relation (spec 4.2, review note B4).
 *
 * Density is measured on a coarse 2 m grid anchored like the walking grid. Every tick:
 *   1. count the people standing or walking in each 2 m cell;
 *   2. smooth the counts with a separable Gaussian kernel (σ ≈ 0.7 m, three taps per axis);
 *   3. divide by the equally smoothed *walkable area* of the cells, so a cell that is half wall is
 *      not reported as half as crowded as it really is.
 *
 * Speed then follows Weidmann: v = v0 · (1 − exp(−γ · (1/ρ − 1/ρmax))), with two guards from
 * review B4: v = v0 below ρ = 0.1 /m² (avoids 1/0), and never below 0.1·v0 (so a crowd at ρmax
 * still creeps instead of freezing forever). The factor v/v0 is computed once per density cell.
 *
 * Performance: a venue grid has tens of thousands of cells but people occupy only a few hundred,
 * so steps 2–3 only visit the 3 × 3 neighbourhoods of occupied cells (the "active" cells). Every
 * other cell has an exact 0 in every term of the smoothing, so its density is 0 and its factor 1;
 * the result is bit-identical to a pass over the whole grid.
 */

import { exp } from "./detmath.ts";
import { CELL_SIZE, type WalkGrid } from "./geometry.ts";

export const DENSITY_CELL = 2;
/** Below this density people walk at their free speed. */
export const FREE_FLOW_DENSITY = 0.1;
/** Lower bound of v/v0. */
export const MIN_SPEED_FACTOR = 0.1;

export class DensityGrid {
  readonly cellSize = DENSITY_CELL;
  readonly cols: number;
  readonly rows: number;
  /** People per m², smoothed, updated every tick. */
  readonly density: Float32Array;
  /** v/v0 per cell from the Weidmann relation. */
  readonly speedFactor: Float64Array;
  /**
   * The first `activeCount` entries are the cells whose density may be non-zero after the last
   * finish(): the 3 × 3 neighbourhoods of the occupied cells. Everywhere else the density is 0.
   */
  readonly active: Int32Array;
  activeCount = 0;
  private readonly counts: Float64Array;
  private readonly smoothedArea: Float64Array;
  private readonly tmp: Float64Array;
  private readonly mark: Uint8Array;
  private readonly occupied: Int32Array;
  private occupiedCount = 0;
  private readonly weightSide: number;

  constructor(
    grid: WalkGrid,
    sigma: number,
    private readonly gamma: number,
    private readonly rhoMax: number,
  ) {
    this.cols = Math.max(1, Math.ceil((grid.cols * CELL_SIZE) / DENSITY_CELL));
    this.rows = Math.max(1, Math.ceil((grid.rows * CELL_SIZE) / DENSITY_CELL));
    const n = this.cols * this.rows;
    this.density = new Float32Array(n);
    this.speedFactor = new Float64Array(n).fill(1);
    this.counts = new Float64Array(n);
    this.tmp = new Float64Array(n);
    this.mark = new Uint8Array(n);
    this.occupied = new Int32Array(n);
    this.active = new Int32Array(n);
    this.smoothedArea = new Float64Array(n);
    // Weight of the neighbouring cell (2 m away) relative to the centre: exp(−d²/2σ²).
    this.weightSide = exp(-(DENSITY_CELL * DENSITY_CELL) / (2 * sigma * sigma));
    const area = new Float64Array(n);
    const per = DENSITY_CELL / CELL_SIZE;
    for (let cell = 0; cell < grid.cellCount; cell++) {
      if (grid.walkable[cell] !== 1) continue;
      const c = Math.floor((cell % grid.cols) / per);
      const r = Math.floor(Math.floor(cell / grid.cols) / per);
      area[r * this.cols + c] = (area[r * this.cols + c] as number) + CELL_SIZE * CELL_SIZE;
    }
    for (let i = 0; i < n; i++) this.tmp[i] = this.rowPass(area, i);
    for (let i = 0; i < n; i++) this.smoothedArea[i] = this.columnPass(this.tmp, i);
    this.tmp.fill(0);
  }

  /** Density cell of a local point (clamped to the grid). */
  cellAt(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / DENSITY_CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / DENSITY_CELL)));
    return r * this.cols + c;
  }

  /** Starts a new count. */
  clear(): void {
    const counts = this.counts;
    const occupied = this.occupied;
    for (let k = 0; k < this.occupiedCount; k++) counts[occupied[k] as number] = 0;
    this.occupiedCount = 0;
  }

  add(x: number, y: number): void {
    const cell = this.cellAt(x, y);
    const c = this.counts[cell] as number;
    if (c === 0) this.occupied[this.occupiedCount++] = cell;
    this.counts[cell] = c + 1;
  }

  /** Smooths the counts into densities and recomputes the speed factors (active cells only). */
  finish(): void {
    const cols = this.cols;
    const rows = this.rows;
    const mark = this.mark;
    const active = this.active;
    const density = this.density;
    const factor = this.speedFactor;
    // Forget the previous tick's active cells.
    for (let k = 0; k < this.activeCount; k++) {
      const i = active[k] as number;
      density[i] = 0;
      factor[i] = 1;
      mark[i] = 0;
    }
    let count = 0;
    for (let k = 0; k < this.occupiedCount; k++) {
      const cell = this.occupied[k] as number;
      const c = cell % cols;
      const r = (cell - c) / cols;
      const r0 = r > 0 ? r - 1 : 0;
      const r1 = r < rows - 1 ? r + 1 : r;
      const c0 = c > 0 ? c - 1 : 0;
      const c1 = c < cols - 1 ? c + 1 : c;
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          const i = rr * cols + cc;
          if (mark[i] === 0) {
            mark[i] = 1;
            active[count++] = i;
          }
        }
      }
    }
    this.activeCount = count;
    // Row pass where it can be non-zero; tmp stays 0 everywhere else.
    const tmp = this.tmp;
    const counts = this.counts;
    for (let k = 0; k < count; k++) {
      const i = active[k] as number;
      tmp[i] = this.rowPass(counts, i);
    }
    const invRhoMax = 1 / this.rhoMax;
    for (let k = 0; k < count; k++) {
      const i = active[k] as number;
      const smoothed = this.columnPass(tmp, i);
      const area = this.smoothedArea[i] as number;
      const rho = area > 0 ? smoothed / area : 0;
      density[i] = rho;
      let f = 1;
      if (rho >= FREE_FLOW_DENSITY) {
        f = 1 - exp(-this.gamma * (1 / rho - invRhoMax));
        if (f < MIN_SPEED_FACTOR) f = MIN_SPEED_FACTOR;
      }
      factor[i] = f;
    }
    for (let k = 0; k < count; k++) tmp[active[k] as number] = 0;
  }

  /** Three-tap Gaussian along the row at cell i; weights normalised over the cells that exist. */
  private rowPass(src: Float64Array, i: number): number {
    const w = this.weightSide;
    const c = i % this.cols;
    let sum = src[i] as number;
    let norm = 1;
    if (c > 0) {
      sum += w * (src[i - 1] as number);
      norm += w;
    }
    if (c < this.cols - 1) {
      sum += w * (src[i + 1] as number);
      norm += w;
    }
    return sum / norm;
  }

  /** Three-tap Gaussian along the column at cell i. */
  private columnPass(src: Float64Array, i: number): number {
    const w = this.weightSide;
    const cols = this.cols;
    let sum = src[i] as number;
    let norm = 1;
    if (i >= cols) {
      sum += w * (src[i - cols] as number);
      norm += w;
    }
    if (i < (this.rows - 1) * cols) {
      sum += w * (src[i + cols] as number);
      norm += w;
    }
    return sum / norm;
  }
}

/** Weidmann speed factor v/v0 at density rho (people/m²), with the B4 guards. */
export function weidmannFactor(rho: number, gamma: number, rhoMax: number): number {
  if (rho < FREE_FLOW_DENSITY) return 1;
  const f = 1 - exp(-gamma * (1 / rho - 1 / rhoMax));
  return f < MIN_SPEED_FACTOR ? MIN_SPEED_FACTOR : f;
}
