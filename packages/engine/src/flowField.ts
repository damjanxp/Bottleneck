/**
 * Flow fields (spec 4.2): for one target, the walking distance from every walkable cell to it, and
 * the neighbour cell to step to next.
 *
 * Built once per target with Dijkstra's algorithm on the 0.5 m grid, 8 neighbours: a straight step
 * costs 0.5 m, a diagonal step 0.5·√2 m. A diagonal step is allowed only if both cells it passes
 * between are walkable, so paths never cut a wall's corner. The priority queue orders cells by
 * (distance, cell index), and the next-step choice breaks ties by a fixed neighbour order, so the
 * result is identical on every machine.
 *
 * An agent follows a field by walking towards the centre of `next[cell]`; the distances also give
 * walk times for lane choice (distance / free speed).
 */

import { CELL_SIZE, type WalkGrid } from "./geometry.ts";

/** Neighbour offsets: the four straight ones first, then the diagonals. */
const DC = [1, 0, -1, 0, 1, -1, -1, 1];
const DR = [0, 1, 0, -1, 1, 1, -1, -1];
const STEP = [CELL_SIZE, CELL_SIZE, CELL_SIZE, CELL_SIZE, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2, CELL_SIZE * Math.SQRT2];

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

/** Binary min-heap of (key, cell) pairs in typed arrays; ties ordered by cell index. */
class CellHeap {
  private keys = new Float64Array(1024);
  private cells = new Int32Array(1024);
  size = 0;

  push(key: number, cell: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      k.set(this.keys);
      this.keys = k;
      const c = new Int32Array(this.size * 2);
      c.set(this.cells);
      this.cells = c;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = this.keys[p] as number;
      if (pk < key || (pk === key && (this.cells[p] as number) < cell)) break;
      this.keys[i] = pk;
      this.cells[i] = this.cells[p] as number;
      i = p;
    }
    this.keys[i] = key;
    this.cells[i] = cell;
  }

  /** Removes the minimum; read it from topKey/topCell before calling. */
  pop(): void {
    const n = --this.size;
    if (n === 0) return;
    const key = this.keys[n] as number;
    const cell = this.cells[n] as number;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      const right = child + 1;
      if (right < n) {
        const lk = this.keys[child] as number;
        const rk = this.keys[right] as number;
        if (rk < lk || (rk === lk && (this.cells[right] as number) < (this.cells[child] as number))) child = right;
      }
      const ck = this.keys[child] as number;
      if (ck > key || (ck === key && (this.cells[child] as number) > cell)) break;
      this.keys[i] = ck;
      this.cells[i] = this.cells[child] as number;
      i = child;
    }
    this.keys[i] = key;
    this.cells[i] = cell;
  }

  get topKey(): number {
    return this.keys[0] as number;
  }

  get topCell(): number {
    return this.cells[0] as number;
  }
}

/** True if a step from `cell` in direction `d` stays on walkable cells (and does not cut a corner). */
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

/** Builds the field towards a set of target cells (non-walkable targets are ignored). */
export function buildFlowField(grid: WalkGrid, targets: readonly number[]): FlowField {
  const field = new FlowField(grid.cellCount);
  const dist = new Float64Array(grid.cellCount).fill(Infinity);
  const done = new Uint8Array(grid.cellCount);
  const heap = new CellHeap();
  const sortedTargets = Int32Array.from(targets).sort();
  for (const t of sortedTargets) {
    if (t >= 0 && grid.walkable[t] === 1 && dist[t] !== 0) {
      dist[t] = 0;
      heap.push(0, t);
    }
  }
  while (heap.size > 0) {
    const key = heap.topKey;
    const cell = heap.topCell;
    heap.pop();
    if (done[cell] === 1 || key > (dist[cell] as number)) continue;
    done[cell] = 1;
    for (let d = 0; d < 8; d++) {
      const n = canStep(grid, cell, d);
      if (n < 0 || done[n] === 1) continue;
      const nd = key + (STEP[d] as number);
      if (nd < (dist[n] as number)) {
        dist[n] = nd;
        heap.push(nd, n);
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
    for (let d = 0; d < 8; d++) {
      const n = canStep(grid, cell, d);
      if (n < 0) continue;
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
