/**
 * Reading a map screenshot automatically (redesign 3). Online maps draw each kind of ground in its
 * own flat colour (roads white or yellow, parks green, water blue, buildings grey, open ground a
 * light background), so:
 *
 * 1. the image's colours are grouped into a few clusters (k-means on a sample, deterministic);
 * 2. each cluster gets a guess (road, walkable, obstacle, ignore) from its colour and shape: roads
 *    are thin (much of the cluster lies on its own edge), text and lines are dark;
 * 3. the user checks or changes the guesses, and the masks become venue elements: walkable areas
 *    and obstacles as polygons (through the same connected-area code as painting), roads as
 *    centrelines found by thinning the road mask to a one-pixel skeleton (Zhang–Suen).
 *
 * Pure: pixels in, masks and lines out.
 */

import type { Point, Road, Venue } from "@bottleneck/schema";
import { nextId } from "./edits.ts";
import { applyPaint } from "./paint.ts";
import { simplifyPath, type PixelPoint } from "./trace.ts";

export type MapClass = "road" | "walkable" | "obstacle" | "ignore";

export interface Cluster {
  index: number;
  rgb: [number, number, number];
  /** Share of the image's pixels. */
  share: number;
  /** Share of the cluster's pixels that touch another cluster: high for thin shapes such as roads and text. */
  edgeShare: number;
  guess: MapClass;
  /** What the colour probably is, in words ("Roads", "Parks"…). */
  label: string;
}

const dist2 = (a: readonly number[], b: readonly number[]) => ((a[0] as number) - (b[0] as number)) ** 2 + ((a[1] as number) - (b[1] as number)) ** 2 + ((a[2] as number) - (b[2] as number)) ** 2;

/**
 * Groups the image's colours into at most k clusters. Returns the clusters (largest first) and
 * the cluster of every pixel. Deterministic: a fixed sample and farthest-point initial centres.
 */
export function clusterColours(rgba: Uint8ClampedArray, w: number, h: number, k = 9): { clusters: Cluster[]; assignment: Uint8Array } {
  const n = w * h;
  const stride = Math.max(1, Math.floor(n / 20000));
  const sample: [number, number, number][] = [];
  for (let i = 0; i < n; i += stride) sample.push([rgba[i * 4] as number, rgba[i * 4 + 1] as number, rgba[i * 4 + 2] as number]);
  // Initial centres from coarse colour bins: the most common bin first, then each next centre
  // maximises (bin size × squared distance to the nearest centre). Rare colours (anti-aliased
  // edges around text and lines) cannot take a slot from a frequent one such as white streets.
  const bins = new Map<number, { count: number; sum: [number, number, number] }>();
  for (const c of sample) {
    const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    const b = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    b.count++;
    b.sum[0] += c[0];
    b.sum[1] += c[1];
    b.sum[2] += c[2];
    bins.set(key, b);
  }
  const minCount = Math.max(2, sample.length * 0.002);
  const candidates = [...bins.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, b]) => ({ count: b.count, rgb: b.sum.map((v) => v / b.count) as [number, number, number] }))
    .filter((b) => b.count >= minCount);
  const centres: number[][] = [];
  const first = candidates.reduce((best, c) => (c.count > best.count ? c : best), candidates[0] ?? { count: 0, rgb: [128, 128, 128] as [number, number, number] });
  centres.push([...first.rgb]);
  while (centres.length < k) {
    let best: (typeof candidates)[number] | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const d = Math.min(...centres.map((m) => dist2(c.rgb, m)));
      if (d < 100) continue; // within 10 levels of a centre: the same colour
      const score = c.count * d;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) break;
    centres.push([...best.rgb]);
  }
  // Lloyd iterations on the sample.
  const label = new Uint8Array(sample.length);
  for (let it = 0; it < 12; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    sample.forEach((c, i) => {
      let b = 0;
      let bd = Infinity;
      centres.forEach((m, j) => {
        const d = dist2(c, m);
        if (d < bd) {
          bd = d;
          b = j;
        }
      });
      label[i] = b;
      const s = sum[b] as number[];
      s[0] = (s[0] as number) + c[0];
      s[1] = (s[1] as number) + c[1];
      s[2] = (s[2] as number) + c[2];
      s[3] = (s[3] as number) + 1;
    });
    centres.forEach((m, j) => {
      const s = sum[j] as number[];
      if ((s[3] as number) > 0) for (let q = 0; q < 3; q++) m[q] = (s[q] as number) / (s[3] as number);
    });
  }
  // Assign every pixel.
  const assignment = new Uint8Array(n);
  const counts = new Array<number>(centres.length).fill(0);
  for (let i = 0; i < n; i++) {
    const c = [rgba[i * 4] as number, rgba[i * 4 + 1] as number, rgba[i * 4 + 2] as number];
    let b = 0;
    let bd = Infinity;
    centres.forEach((m, j) => {
      const d = dist2(c, m);
      if (d < bd) {
        bd = d;
        b = j;
      }
    });
    assignment[i] = b;
    counts[b] = (counts[b] as number) + 1;
  }
  // Edge share per cluster.
  const edges = new Array<number>(centres.length).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = assignment[i] as number;
      if ((x > 0 && assignment[i - 1] !== a) || (x < w - 1 && assignment[i + 1] !== a) || (y > 0 && assignment[i - w] !== a) || (y < h - 1 && assignment[i + w] !== a)) edges[a] = (edges[a] as number) + 1;
    }
  const raw = centres.map((m, j) => ({ j, rgb: m.map((v) => Math.round(v)) as [number, number, number], share: (counts[j] as number) / n, edgeShare: (counts[j] as number) > 0 ? (edges[j] as number) / (counts[j] as number) : 1 }));
  const order = raw.filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
  const remap = new Uint8Array(centres.length);
  order.forEach((c, idx) => (remap[c.j] = idx));
  for (let i = 0; i < n; i++) assignment[i] = remap[assignment[i] as number] as number;
  const largest = order[0];
  const clusters = order.map((c, idx) => ({ index: idx, rgb: c.rgb, share: c.share, edgeShare: c.edgeShare, ...guessClass(c.rgb, c.edgeShare, c === largest) }));
  return { clusters, assignment };
}

/** A first guess for a map colour, from its hue, lightness and thinness. */
export function guessClass(rgb: readonly [number, number, number], edgeShare: number, largest: boolean): { guess: MapClass; label: string } {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = (r + g + b) / 3;
  const sat = max === 0 ? 0 : (max - min) / max;
  if (lum < 150) return { guess: "ignore", label: "Text and lines" };
  if (b > r + 20 && b > g + 5) return { guess: "obstacle", label: "Water" };
  if (g > r + 10 && g >= b) return { guess: "walkable", label: "Parks and green" };
  if (r > 220 && g > 170 && b < 170 && sat > 0.2) return { guess: "road", label: "Main roads" };
  if (lum > 248 && sat < 0.05) return { guess: edgeShare > 0.12 || !largest ? "road" : "walkable", label: edgeShare > 0.12 || !largest ? "Roads" : "Open ground" };
  if (largest) return { guess: "walkable", label: "Open ground" };
  if (sat < 0.12 && lum < 242) return { guess: "obstacle", label: "Buildings" };
  return { guess: "walkable", label: "Open ground" };
}

/**
 * The pixels of the chosen class, with pixels marked "ignore" (labels, icons, lines) given to the
 * class most of their neighbours have, so text inside a park does not cut holes in it.
 */
export function classMask(assignment: Uint8Array, w: number, h: number, classes: readonly MapClass[], want: MapClass): Uint8Array {
  const cls = new Uint8Array(w * h);
  const code: Record<MapClass, number> = { road: 1, walkable: 2, obstacle: 3, ignore: 0 };
  for (let i = 0; i < w * h; i++) cls[i] = code[classes[assignment[i] as number] ?? "ignore"];
  // Fill unknown pixels from their neighbours, a few passes (labels are a few pixels thick).
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next = cls.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cls[i] !== 0) continue;
        const votes = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) {
              const v = cls[yy * w + xx] as number;
              votes[v] = (votes[v] as number) + 1;
            }
          }
        let best = 0;
        for (let c = 1; c < 4; c++) if ((votes[c] as number) > (votes[best === 0 ? 1 : best] as number) || (best === 0 && (votes[c] as number) > 0)) best = c;
        if (best !== 0) {
          next[i] = best;
          changed = true;
        }
      }
    cls.set(next);
    if (!changed) break;
  }
  const out = new Uint8Array(w * h);
  const target = code[want];
  for (let i = 0; i < w * h; i++) out[i] = cls[i] === target ? 1 : 0;
  return out;
}

/** Zhang–Suen thinning: the mask reduced to one-pixel-wide centre lines (in place). */
export function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = mask.slice();
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? (m[y * w + x] as number) : 0);
  let changed = true;
  const remove: number[] = [];
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      remove.length = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (p[k] === 0 && p[(k + 1) % 8] === 1) a++;
          if (a !== 1) continue;
          const [p2, , p4, , p6, , p8] = p as [number, number, number, number, number, number, number, number];
          if (step === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) remove.push(y * w + x);
        }
      for (const i of remove) m[i] = 0;
      if (remove.length > 0) changed = true;
    }
  }
  return m;
}

const N8 = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const;

/** The skeleton's lines as pixel paths, split at junctions and ends. */
export function skeletonPaths(skel: Uint8Array, w: number, h: number): PixelPoint[][] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && skel[y * w + x] === 1;
  const degree = (x: number, y: number) => N8.reduce((s, [dx, dy]) => s + (on(x + dx, y + dy) ? 1 : 0), 0);
  const usedEdge = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const paths: PixelPoint[][] = [];
  const walk = (sx: number, sy: number, nx: number, ny: number) => {
    const path: PixelPoint[] = [{ px: sx + 0.5, py: sy + 0.5 }];
    let px = sx;
    let py = sy;
    let cx = nx;
    let cy = ny;
    usedEdge.add(key(py * w + px, cy * w + cx));
    for (let guard = 0; guard < w * h; guard++) {
      path.push({ px: cx + 0.5, py: cy + 0.5 });
      if (degree(cx, cy) !== 2) break;
      let moved = false;
      for (const [dx, dy] of N8) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!on(tx, ty) || (tx === px && ty === py)) continue;
        const e = key(cy * w + cx, ty * w + tx);
        if (usedEdge.has(e)) continue;
        usedEdge.add(e);
        px = cx;
        py = cy;
        cx = tx;
        cy = ty;
        moved = true;
        break;
      }
      if (!moved) break;
    }
    paths.push(path);
  };
  // Start at ends and junctions; then any loops left over.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!on(x, y) || degree(x, y) === 2) continue;
      for (const [dx, dy] of N8) if (on(x + dx, y + dy) && !usedEdge.has(key(y * w + x, (y + dy) * w + x + dx))) walk(x, y, x + dx, y + dy);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      for (const [dx, dy] of N8) if (on(x + dx, y + dy) && !usedEdge.has(key(y * w + x, (y + dy) * w + x + dx))) walk(x, y, x + dx, y + dy);
    }
  return paths;
}

/** Road centrelines from a road mask: thinned, split, simplified, short spurs dropped. */
export function roadLines(mask: Uint8Array, w: number, h: number, minPixels: number, epsilon = 1.5): PixelPoint[][] {
  const lines = skeletonPaths(thin(mask, w, h), w, h).map((p) => simplifyPath(p, epsilon));
  const length = (p: PixelPoint[]) => p.slice(1).reduce((s, q, k) => s + Math.hypot(q.px - (p[k] as PixelPoint).px, q.py - (p[k] as PixelPoint).py), 0);
  return lines.filter((p) => p.length >= 2 && length(p) >= minPixels);
}

/** Pixel path to venue points. */
export function toVenuePath(path: readonly PixelPoint[], origin: Point, metresPerPixel: number): Point[] {
  return path.map((p) => ({ x: Math.round((origin.x + p.px * metresPerPixel) * 100) / 100, y: Math.round((origin.y + p.py * metresPerPixel) * 100) / 100 }));
}

export interface DetectionResult {
  venue: Venue;
  walkable: number;
  obstacles: number;
  roads: number;
}

/**
 * Turns the classified image into venue elements: walkable areas and obstacles (merged with the
 * ones already there, as when painting) and roads (two-way, one lane each way, public). Areas under
 * 25 m² and roads under 15 m are dropped as noise.
 */
export function applyDetection(v: Venue, assignment: Uint8Array, w: number, h: number, classes: readonly MapClass[], origin: Point, metresPerPixel: number): DetectionResult {
  const box = { minX: origin.x, minY: origin.y, maxX: origin.x + w * metresPerPixel, maxY: origin.y + h * metresPerPixel };
  let venue = v;
  const counts = { walkable: 0, obstacles: 0, roads: 0 };
  for (const kind of ["walkable", "obstacle"] as const) {
    if (!classes.includes(kind)) continue;
    const mask = classMask(assignment, w, h, classes, kind);
    const before = kind === "walkable" ? venue.walkableAreas.length : venue.obstacles.length;
    venue = applyPaint(
      venue,
      kind,
      box,
      metresPerPixel,
      (g) => {
        for (let j = 0; j < g.h; j++) {
          const py = Math.floor((g.y0 + (j + 0.5) * g.cell - origin.y) / metresPerPixel);
          if (py < 0 || py >= h) continue;
          for (let i = 0; i < g.w; i++) {
            const px = Math.floor((g.x0 + (i + 0.5) * g.cell - origin.x) / metresPerPixel);
            if (px >= 0 && px < w && mask[py * w + px]) g.data[j * g.w + i] = 1;
          }
        }
      },
      25,
    ).venue;
    const after = kind === "walkable" ? venue.walkableAreas.length : venue.obstacles.length;
    if (kind === "walkable") counts.walkable = after - before;
    else counts.obstacles = after - before;
  }
  if (classes.includes("road")) {
    const lines = roadLines(classMask(assignment, w, h, classes, "road"), w, h, 15 / metresPerPixel, Math.max(1, 1 / metresPerPixel));
    const roads: Road[] = [...(venue.roads ?? [])];
    for (const line of lines) {
      const points = toVenuePath(line, origin, metresPerPixel).slice(0, 500);
      const id = nextId({ ...venue, roads }, "road");
      roads.push({ id, name: `Road ${id.split("-").pop()}`, points, direction: "twoWay", laneCount: 1, publicRoad: true });
      counts.roads++;
    }
    venue = { ...venue, roads };
  }
  return { venue, ...counts };
}
