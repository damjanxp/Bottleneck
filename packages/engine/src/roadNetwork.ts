/**
 * The road graph cars drive on (spec 4.3): roads and parking aisles turned into directed edges.
 *
 * Building it:
 *   1. Every road and aisle is a polyline in local metres (see geometry.ts).
 *   2. Polylines are cut into pieces at *junctions*: their own end points, every point where the end
 *      of another polyline touches them (within SNAP = 1 m, a T-junction), and extra cut points the
 *      caller asks for (the start of each barrier's approach, see vehicles.ts).
 *   3. Cut points closer than SNAP to each other become one *node*. Each piece becomes one directed
 *      *edge* from node to node in the drawn direction, plus a reverse *twin* edge if the polyline
 *      is two-way. Roads that cross without a junction (an X with no end point on the other) are not
 *      connected: think of a bridge.
 *
 * Routing: shortest *travel time* (length / free speed) between every pair of nodes, computed once
 * with Dijkstra from each node (binary heap; ties broken by node id, edges relaxed in id order, so
 * the result is the same on every machine). For each pair we keep the time, the path length in
 * metres and the first edge of the path. A car only ever needs "which edge next towards node t",
 * so no route lists are stored per car.
 *
 * A *place* on the network is (edge, offset in metres from the edge's start). Cars aim for places:
 * a barrier's stop line, a stall's access point on an aisle, a road end where they leave.
 *
 * Lanes: an edge has `lanes` parallel lanes (per direction). Lane k is drawn offset to the right of
 * the driving direction (the right-hand side in the y-down picture, as for gate lines, D-016):
 * on a two-way road by (k + 0.5) lane widths from the centreline, on a one-way road centred.
 */

export const SNAP = 1;
export const LANE_WIDTH = 3;

export interface PolylineInput {
  /** Local coordinates, at least two points. */
  readonly points: readonly { x: number; y: number }[];
  readonly twoWay: boolean;
  readonly lanes: number;
  /** Free speed in m/s. */
  readonly speed: number;
  readonly publicRoad: boolean;
  /** 0 = road, 1 = aisle. */
  readonly kind: number;
  /** Index of the road (kind 0) or of the parking lot (kind 1) the polyline belongs to. */
  readonly owner: number;
  /** Extra cut points, as distances along the polyline from its first point. */
  readonly cuts: readonly number[];
}

export interface Edge {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  /** Polyline of the edge in driving order (local metres) and cumulative lengths (cum[0] = 0). */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly cum: Float64Array;
  readonly length: number;
  /** Lanes in this direction (a barrier can widen its approach, see widen()). */
  lanes: number;
  readonly speed: number;
  readonly publicRoad: boolean;
  readonly kind: number;
  readonly owner: number;
  readonly polyline: number;
  /** True if the edge runs in the polyline's drawn direction. */
  readonly forward: boolean;
  /** Distance along the polyline (drawn direction) of the piece's first point. */
  readonly pieceStart: number;
  /** The opposite edge of a two-way piece, −1 if none. */
  twin: number;
  readonly twoWay: boolean;
}

/** A place on the network. */
export interface Place {
  edge: number;
  pos: number;
}

export class RoadNetwork {
  readonly edges: Edge[] = [];
  readonly nodeX: number[] = [];
  readonly nodeY: number[] = [];
  /** Outgoing edge ids per node, ascending. */
  readonly out: number[][] = [];
  /** Incoming edge ids per node, ascending. */
  readonly in: number[][] = [];
  readonly polylines: readonly PolylineInput[];
  /** Piece boundaries per polyline: cut distances, ascending; piece k is [cuts[k], cuts[k+1]]. */
  private readonly pieceCuts: number[][] = [];
  /** Forward edge id per polyline piece (−1 if the piece was too short to keep). */
  private readonly pieceEdge: number[][] = [];
  private n = 0;
  /** All-pairs tables, N × N, row = from node. */
  private time = new Float64Array(0);
  private dist = new Float64Array(0);
  private first = new Int32Array(0);

  constructor(polylines: readonly PolylineInput[]) {
    this.polylines = polylines;
    // 1. Cut points per polyline: ends, requested cuts, and T-junctions with other polylines' ends.
    const cuts: number[][] = polylines.map((p) => {
      const total = polylineLength(p.points);
      const list = [0, total];
      for (const c of p.cuts) if (c > 0 && c < total) list.push(c);
      return list;
    });
    polylines.forEach((p, i) => {
      polylines.forEach((q, j) => {
        if (i === j) return;
        for (const end of [q.points[0], q.points[q.points.length - 1]]) {
          if (end === undefined) continue;
          const hit = project(p.points, end.x, end.y);
          const total = cuts[i]![1] as number;
          if (hit.dist < SNAP && hit.along > SNAP && hit.along < total - SNAP) cuts[i]!.push(hit.along);
        }
      });
    });
    // 2. Pieces and nodes.
    polylines.forEach((p, i) => {
      const sorted = Float64Array.from(cuts[i]!).sort();
      const kept: number[] = [];
      for (const c of sorted) if (kept.length === 0 || c - (kept[kept.length - 1] as number) >= 0.01) kept.push(c);
      this.pieceCuts.push(kept);
      const edgesOfPiece: number[] = [];
      for (let k = 0; k + 1 < kept.length; k++) {
        const a = kept[k] as number;
        const b = kept[k + 1] as number;
        const geom = subPolyline(p.points, a, b);
        const n0 = this.node(geom.xs[0] as number, geom.ys[0] as number);
        const n1 = this.node(geom.xs[geom.xs.length - 1] as number, geom.ys[geom.ys.length - 1] as number);
        const fwd = this.addEdge(n0, n1, geom.xs, geom.ys, p, i, true, a);
        edgesOfPiece.push(fwd);
        if (p.twoWay) {
          const rev = this.addEdge(n1, n0, geom.xs.slice().reverse(), geom.ys.slice().reverse(), p, i, false, a);
          (this.edges[fwd] as Edge).twin = rev;
          (this.edges[rev] as Edge).twin = fwd;
        }
      }
      this.pieceEdge.push(edgesOfPiece);
    });
    this.computeRoutes();
  }

  get nodeCount(): number {
    return this.n;
  }

  /** Node at (x, y): an existing node within SNAP (the first one created), else a new one. */
  private node(x: number, y: number): number {
    for (let k = 0; k < this.n; k++) {
      const dx = (this.nodeX[k] as number) - x;
      const dy = (this.nodeY[k] as number) - y;
      if (dx * dx + dy * dy < SNAP * SNAP) return k;
    }
    this.nodeX.push(x);
    this.nodeY.push(y);
    this.out.push([]);
    this.in.push([]);
    return this.n++;
  }

  private addEdge(from: number, to: number, xs: number[], ys: number[], p: PolylineInput, polyline: number, forward: boolean, pieceStart: number): number {
    const cum = new Float64Array(xs.length);
    for (let k = 1; k < xs.length; k++) {
      const dx = (xs[k] as number) - (xs[k - 1] as number);
      const dy = (ys[k] as number) - (ys[k - 1] as number);
      cum[k] = (cum[k - 1] as number) + Math.sqrt(dx * dx + dy * dy);
    }
    const id = this.edges.length;
    this.edges.push({
      id,
      from,
      to,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      cum,
      length: cum[xs.length - 1] as number,
      lanes: p.lanes,
      speed: p.speed,
      publicRoad: p.publicRoad,
      kind: p.kind,
      owner: p.owner,
      polyline,
      forward,
      pieceStart,
      twin: -1,
      twoWay: p.twoWay,
    });
    this.out[from]!.push(id);
    this.in[to]!.push(id);
    return id;
  }

  /** Widens an edge to at least `lanes` lanes (barrier approaches). */
  widen(edge: number, lanes: number): void {
    const e = this.edges[edge] as Edge;
    if (lanes > e.lanes) e.lanes = lanes;
  }

  /**
   * The place `along` metres from the first point of polyline `polyline`, on the edge running in
   * the drawn direction (forward = true) or against it (its twin).
   */
  placeOnPolyline(polyline: number, along: number, forward = true): Place | null {
    const cuts = this.pieceCuts[polyline] as number[];
    const edges = this.pieceEdge[polyline] as number[];
    if (edges.length === 0) return null;
    let k = 0;
    while (k + 1 < edges.length && along > (cuts[k + 1] as number)) k++;
    const e = this.edges[edges[k] as number] as Edge;
    const offset = Math.min(e.length, Math.max(0, along - (cuts[k] as number)));
    if (forward) return { edge: e.id, pos: offset };
    if (e.twin < 0) return null;
    return { edge: e.twin, pos: e.length - offset };
  }

  /** Nearest point of the given polylines to (x, y): polyline index, distance along it, and distance to it. */
  nearestOnPolylines(x: number, y: number, filter: (index: number) => boolean): { polyline: number; along: number; dist: number } | null {
    let best: { polyline: number; along: number; dist: number } | null = null;
    this.polylines.forEach((p, i) => {
      if (!filter(i)) return;
      const hit = project(p.points, x, y);
      if (best === null || hit.dist < best.dist) best = { polyline: i, along: hit.along, dist: hit.dist };
    });
    return best;
  }

  // --- Routing ---

  private computeRoutes(): void {
    const n = this.n;
    this.time = new Float64Array(n * n).fill(Infinity);
    this.dist = new Float64Array(n * n).fill(Infinity);
    this.first = new Int32Array(n * n).fill(-1);
    const heapNode: number[] = [];
    const heapKey: number[] = [];
    const done = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      const row = s * n;
      done.fill(0);
      this.time[row + s] = 0;
      this.dist[row + s] = 0;
      heapNode.length = 0;
      heapKey.length = 0;
      heapPush(heapNode, heapKey, s, 0);
      while (heapNode.length > 0) {
        const u = heapPop(heapNode, heapKey);
        if (done[u] === 1) continue;
        done[u] = 1;
        const tu = this.time[row + u] as number;
        for (const eid of this.out[u] as number[]) {
          const e = this.edges[eid] as Edge;
          const t = tu + e.length / e.speed;
          if (t < (this.time[row + e.to] as number)) {
            this.time[row + e.to] = t;
            this.dist[row + e.to] = (this.dist[row + u] as number) + e.length;
            this.first[row + e.to] = u === s ? eid : (this.first[row + u] as number);
            heapPush(heapNode, heapKey, e.to, t);
          }
        }
      }
    }
  }

  /** First edge of the quickest path from node a to node b; −1 if a = b or b is unreachable. */
  nextEdge(a: number, b: number): number {
    return this.first[a * this.n + b] as number;
  }

  /** Travel time (s) of the quickest path from node a to node b (Infinity if unreachable). */
  nodeTime(a: number, b: number): number {
    return this.time[a * this.n + b] as number;
  }

  /** Length (m) of that path. */
  nodeDistance(a: number, b: number): number {
    return this.dist[a * this.n + b] as number;
  }

  /** Travel time from place (edge, pos) to place (target, targetPos), Infinity if unreachable. */
  timeBetween(edge: number, pos: number, target: number, targetPos: number): number {
    const e = this.edges[edge] as Edge;
    const t = this.edges[target] as Edge;
    if (edge === target && pos <= targetPos) return (targetPos - pos) / e.speed;
    return (e.length - pos) / e.speed + this.nodeTime(e.to, t.from) + targetPos / t.speed;
  }

  /** Driving distance (m) from place to place along the quickest path, Infinity if unreachable. */
  distanceBetween(edge: number, pos: number, target: number, targetPos: number): number {
    const e = this.edges[edge] as Edge;
    const t = this.edges[target] as Edge;
    if (edge === target && pos <= targetPos) return targetPos - pos;
    return e.length - pos + this.nodeDistance(e.to, t.from) + targetPos;
  }

  /**
   * The edge to take at the end of `edge` towards place (target, ·): −1 if `edge` ends where the
   * target edge starts... in which case the next edge is the target itself.
   */
  nextTowards(edge: number, target: number): number {
    const e = this.edges[edge] as Edge;
    const t = this.edges[target] as Edge;
    if (e.to === t.from) return target;
    return this.nextEdge(e.to, t.from);
  }

  /**
   * Position, heading and the lane's sideways offset at `pos` on `edge`, lane `lane`. Writes into
   * `out`: [x, y, hx, hy] in local metres (heading is a unit vector).
   */
  pointAt(edge: number, pos: number, lane: number, out: Float64Array): void {
    const e = this.edges[edge] as Edge;
    const cum = e.cum;
    const last = cum.length - 1;
    let lo = 0;
    let hi = last;
    // Segment k with cum[k] <= pos < cum[k + 1].
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] as number) <= pos) lo = mid;
      else hi = mid;
    }
    const x0 = e.xs[lo] as number;
    const y0 = e.ys[lo] as number;
    const dx = (e.xs[hi] as number) - x0;
    const dy = (e.ys[hi] as number) - y0;
    const seg = (cum[hi] as number) - (cum[lo] as number);
    const f = seg > 0 ? Math.min(1, Math.max(0, (pos - (cum[lo] as number)) / seg)) : 0;
    const hx = seg > 0 ? dx / seg : 1;
    const hy = seg > 0 ? dy / seg : 0;
    const side = e.twoWay ? (lane + 0.5) * LANE_WIDTH : (lane - (e.lanes - 1) / 2) * LANE_WIDTH;
    // Right of the driving direction in the y-down picture: (−hy, hx).
    out[0] = x0 + dx * f - hy * side;
    out[1] = y0 + dy * f + hx * side;
    out[2] = hx;
    out[3] = hy;
  }
}

// ---------------------------------------------------------------------------------------------
// Polyline helpers
// ---------------------------------------------------------------------------------------------

export function polylineLength(points: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as { x: number; y: number };
    const b = points[k] as { x: number; y: number };
    total += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
  }
  return total;
}

/** Closest point of a polyline to (x, y): distance along the polyline and distance to it. */
export function project(points: readonly { x: number; y: number }[], x: number, y: number): { along: number; dist: number; px: number; py: number } {
  let best = { along: 0, dist: Infinity, px: x, py: y };
  let acc = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as { x: number; y: number };
    const b = points[k] as { x: number; y: number };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    if (d < best.dist) best = { along: acc + len * t, dist: d, px, py };
    acc += len;
  }
  return best;
}

/** The part of a polyline between distances a and b along it, as coordinate lists. */
function subPolyline(points: readonly { x: number; y: number }[], a: number, b: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  let acc = 0;
  const at = (k: number, t: number) => {
    const p = points[k - 1] as { x: number; y: number };
    const q = points[k] as { x: number; y: number };
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };
  for (let k = 1; k < points.length; k++) {
    const p = points[k - 1] as { x: number; y: number };
    const q = points[k] as { x: number; y: number };
    const len = Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y));
    const s0 = acc;
    const s1 = acc + len;
    if (s1 >= a && s0 <= b && len > 0) {
      if (xs.length === 0) {
        const s = at(k, Math.max(0, (a - s0) / len));
        xs.push(s.x);
        ys.push(s.y);
      }
      const e = at(k, Math.min(1, (b - s0) / len));
      if (Math.abs(e.x - (xs[xs.length - 1] as number)) > 1e-9 || Math.abs(e.y - (ys[ys.length - 1] as number)) > 1e-9) {
        xs.push(e.x);
        ys.push(e.y);
      }
    }
    acc = s1;
    if (acc > b) break;
  }
  if (xs.length === 1) {
    xs.push(xs[0] as number);
    ys.push(ys[0] as number);
  }
  return { xs, ys };
}

// Binary min-heap on (key, node) for Dijkstra; ties go to the lower node id.
function heapLess(keys: number[], nodes: number[], i: number, j: number): boolean {
  const a = keys[i] as number;
  const b = keys[j] as number;
  return a < b || (a === b && (nodes[i] as number) < (nodes[j] as number));
}

function heapPush(nodes: number[], keys: number[], node: number, key: number): void {
  nodes.push(node);
  keys.push(key);
  let i = nodes.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(keys, nodes, i, p)) break;
    swap(nodes, keys, i, p);
    i = p;
  }
}

function heapPop(nodes: number[], keys: number[]): number {
  const top = nodes[0] as number;
  const lastNode = nodes.pop() as number;
  const lastKey = keys.pop() as number;
  if (nodes.length > 0) {
    nodes[0] = lastNode;
    keys[0] = lastKey;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < nodes.length && heapLess(keys, nodes, l, m)) m = l;
      if (r < nodes.length && heapLess(keys, nodes, r, m)) m = r;
      if (m === i) break;
      swap(nodes, keys, i, m);
      i = m;
    }
  }
  return top;
}

function swap(nodes: number[], keys: number[], i: number, j: number): void {
  const n = nodes[i] as number;
  nodes[i] = nodes[j] as number;
  nodes[j] = n;
  const k = keys[i] as number;
  keys[i] = keys[j] as number;
  keys[j] = k;
}
