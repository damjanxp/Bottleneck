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
  private readonly counts: Float64Array;
  private readonly smoothedArea: Float64Array;
  private readonly scratch: Float64Array;
  private readonly tmp: Float64Array;
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
    this.scratch = new Float64Array(n);
    this.tmp = new Float64Array(n);
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
    this.smooth(area, this.smoothedArea);
  }

  /** Density cell of a local point (clamped to the grid). */
  cellAt(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / DENSITY_CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / DENSITY_CELL)));
    return r * this.cols + c;
  }

  /** Starts a new count. */
  clear(): void {
    this.counts.fill(0);
  }

  add(x: number, y: number): void {
    const cell = this.cellAt(x, y);
    this.counts[cell] = (this.counts[cell] as number) + 1;
  }

  /** Smooths the counts into densities and recomputes the speed factors. */
  finish(): void {
    const out = this.scratch;
    this.smooth(this.counts, out);
    const invRhoMax = 1 / this.rhoMax;
    for (let i = 0; i < out.length; i++) {
      const area = this.smoothedArea[i] as number;
      const rho = area > 0 ? (out[i] as number) / area : 0;
      this.density[i] = rho;
      let f = 1;
      if (rho >= FREE_FLOW_DENSITY) {
        f = 1 - exp(-this.gamma * (1 / rho - invRhoMax));
        if (f < MIN_SPEED_FACTOR) f = MIN_SPEED_FACTOR;
      }
      this.speedFactor[i] = f;
    }
  }

  /** Separable three-tap Gaussian: rows, then columns. Weights are normalised over cells that exist. */
  private smooth(src: Float64Array, dst: Float64Array): void {
    const w = this.weightSide;
    const cols = this.cols;
    const rows = this.rows;
    const tmp = this.tmp;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let sum = src[i] as number;
        let norm = 1;
        if (c > 0) {
          sum += w * (src[i - 1] as number);
          norm += w;
        }
        if (c < cols - 1) {
          sum += w * (src[i + 1] as number);
          norm += w;
        }
        tmp[i] = sum / norm;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let sum = tmp[i] as number;
        let norm = 1;
        if (r > 0) {
          sum += w * (tmp[i - cols] as number);
          norm += w;
        }
        if (r < rows - 1) {
          sum += w * (tmp[i + cols] as number);
          norm += w;
        }
        dst[i] = sum / norm;
      }
    }
  }
}

/** Weidmann speed factor v/v0 at density rho (people/m²), with the B4 guards. */
export function weidmannFactor(rho: number, gamma: number, rhoMax: number): number {
  if (rho < FREE_FLOW_DENSITY) return 1;
  const f = 1 - exp(-gamma * (1 / rho - 1 / rhoMax));
  return f < MIN_SPEED_FACTOR ? MIN_SPEED_FACTOR : f;
}
