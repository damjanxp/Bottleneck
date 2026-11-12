/**
 * Flow fields (spec 4.2): for one target, the walking distance from every walkable cell to it, and
 * the neighbour cell to step to next.
 *
 * Built once per target as shortest paths on the 0.5 m grid, 8 neighbours: a straight step costs
 * 0.5 m, a diagonal step 0.5·√2 m. A diagonal step is allowed only if both cells it passes between
 * are walkable, so paths never cut a wall's corner. The next-step choice breaks ties by a fixed
 * neighbour order, so the result is identical on every machine.
 *
 * The search is Dijkstra's algorithm with a *bucket queue* (Dial's algorithm) instead of a binary
 * heap: bucket k holds the cells with a tentative distance in [0.5·k, 0.5·(k + 1)). Every step costs
 * at least 0.5 m, so no cell can improve another cell of the same bucket, and the cells of a bucket
 * can be finalised in any order. The distances are therefore the same shortest-path values,
 * bit for bit, as the heap version computed (each is the minimum over its neighbours of
 * dist + step, evaluated with the same additions), at O(1) per cell instead of O(log n).
 *
 * An agent follows a field by walking towards the centre of `next[cell]`; the distances also give
 * walk times for lane choice (distance / free speed).
 */

import { CELL_SIZE, type WalkGrid } from "./geometry.ts";

/** Neighbour offsets: the four straight ones first, then the diagonals. */
const DC = [1, 0, -1, 0, 1, -1, -1, 1];
const DR = [0, 1, 0, -1, 1, 1, -1, -1];
const STEP = [CELL_SIZE, CELL_SIZE, CELL_SIZE, CELL_SIZE, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2];
/** Bucket width: the cheapest step. */
const BUCKET = CELL_SIZE;
/** A step reaches at most this many buckets ahead, so a ring of BUCKET_RING buckets suffices. */
const BUCKET_RING = 4;

export class FlowField {
  /** Walking distance in metres to the nearest target cell; Infinity if unreachable. */
  readonly dist: Float32Array;
  /** Cell to step to next, −1 at a target cell or where the target is unreachable. */
  readonly next: Int32Array;

  constructor(cellCount: number) {
    this.dist = new Float32Array(cellCount).fill(Infinity);
    this.next = new Int32Array(cellCount).fill(-1);
  }

  /** Distance at a cell (Infinity for cell −1). */
  distanceAt(cell: number): number {
    return cell < 0 ? Infinity : (this.dist[cell] as number);
  }
}

/** Bit d set: a step from the cell in direction d is allowed. Cached per grid (it never changes once built). */
const stepMasks = new WeakMap<WalkGrid, Uint8Array>();

function stepMask(grid: WalkGrid): Uint8Array {
  let mask = stepMasks.get(grid);
  if (mask === undefined) {
    mask = new Uint8Array(grid.cellCount);
    for (let cell = 0; cell < grid.cellCount; cell++) {
      if (grid.walkable[cell] !== 1) continue;
      let bits = 0;
      for (let d = 0; d < 8; d++) if (canStep(grid, cell, d) >= 0) bits |= 1 << d;
      mask[cell] = bits;
    }
    stepMasks.set(grid, mask);
  }
  return mask;
}

/** The neighbour reached by a step from `cell` in direction `d`, or −1 if the step leaves the walkable cells or cuts a corner. */
function canStep(grid: WalkGrid, cell: number, d: number): number {
  const cols = grid.cols;
  const c = cell % cols;
  const r = (cell - c) / cols;
  const nc = c + (DC[d] as number);
  const nr = r + (DR[d] as number);
  if (nc < 0 || nr < 0 || nc >= cols || nr >= grid.rows) return -1;
  const n = nr * cols + nc;
  if (grid.walkable[n] !== 1) return -1;
  if (d >= 4 && (grid.walkable[r * cols + nc] !== 1 || grid.walkable[nr * cols + c] !== 1)) return -1;
  return n;
}

/** Growable stack of cell indices. */
class CellStack {
  cells = new Int32Array(256);
  size = 0;

  push(cell: number): void {
    if (this.size === this.cells.length) {
      const grown = new Int32Array(this.size * 2);
      grown.set(this.cells);
      this.cells = grown;
    }
    this.cells[this.size++] = cell;
  }
}

/** Builds the field towards a set of target cells (non-walkable targets are ignored). */
export function buildFlowField(grid: WalkGrid, targets: readonly number[]): FlowField {
  const field = new FlowField(grid.cellCount);
  const dist = new Float64Array(grid.cellCount).fill(Infinity);
  const done = new Uint8Array(grid.cellCount);
  const mask = stepMask(grid);
  const cols = grid.cols;
  // Cell offset of each direction (used only where the mask allows the step).
  const offset = DC.map((dc, d) => dc + (DR[d] as number) * cols);
  const buckets: CellStack[] = [];
  for (let b = 0; b < BUCKET_RING; b++) buckets.push(new CellStack());
  let pending = 0;
  for (const t of targets) {
    if (t >= 0 && t < grid.cellCount && grid.walkable[t] === 1 && dist[t] !== 0) {
      dist[t] = 0;
      (buckets[0] as CellStack).push(t);
      pending++;
    }
  }
  for (let k = 0; pending > 0; k++) {
    const bucket = buckets[k % BUCKET_RING] as CellStack;
    while (bucket.size > 0) {
      const cell = bucket.cells[--bucket.size] as number;
      pending--;
      if (done[cell] === 1) continue;
      const key = dist[cell] as number;
      done[cell] = 1;
      const bits = mask[cell] as number;
      for (let d = 0; d < 8; d++) {
        if ((bits & (1 << d)) === 0) continue;
        const n = cell + (offset[d] as number);
        if (done[n] === 1) continue;
        const nd = key + (STEP[d] as number);
        if (nd < (dist[n] as number)) {
          dist[n] = nd;
          (buckets[Math.floor(nd / BUCKET) % BUCKET_RING] as CellStack).push(n);
          pending++;
        }
      }
    }
  }
  // Next step: the reachable neighbour with the smallest distance (fixed order breaks ties).
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const own = dist[cell] as number;
    field.dist[cell] = own;
    if (own === Infinity || own === 0) continue;
    let best = -1;
    let bestD = own;
    const bits = mask[cell] as number;
    for (let d = 0; d < 8; d++) {
      if ((bits & (1 << d)) === 0) continue;
      const n = cell + (offset[d] as number);
      const nd = dist[n] as number;
      if (nd < bestD) {
        bestD = nd;
        best = n;
      }
    }
    field.next[cell] = best;
  }
  return field;
}
