/**
 * Tracing an area on a map image (redesign 2): the "magic wand" of image editors. The user clicks a
 * spot on an imported map screenshot; the region of similar colour around it is filled, holes in it
 * (labels, icons, small blobs) are closed, its outline is followed around, and the outline is
 * simplified to a polygon with a handful of corners. The editor then adds that polygon as a
 * walkable area, an obstacle or a destination.
 *
 * Works on raw RGBA pixels (from a canvas), so it is pure and tested without a browser.
 */

export interface PixelPoint {
  px: number;
  py: number;
}

/**
 * The 4-connected region around (sx, sy) whose colours are within `tolerance` (Euclidean distance in
 * RGB, 0–441) of the clicked pixel. Returns a mask (1 = in the region) and the region's size.
 */
export function floodRegion(rgba: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number): { mask: Uint8Array; size: number } {
  const mask = new Uint8Array(w * h);
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return { mask, size: 0 };
  const o = (y0 * w + x0) * 4;
  const r0 = rgba[o] as number;
  const g0 = rgba[o + 1] as number;
  const b0 = rgba[o + 2] as number;
  const t2 = tolerance * tolerance;
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = y0 * w + x0;
  mask[y0 * w + x0] = 1;
  let size = 0;
  while (head < tail) {
    const i = queue[head++] as number;
    size++;
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || mask[j]) continue;
      const k = j * 4;
      const dr = (rgba[k] as number) - r0;
      const dg = (rgba[k + 1] as number) - g0;
      const db = (rgba[k + 2] as number) - b0;
      if (dr * dr + dg * dg + db * db <= t2) {
        mask[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  return { mask, size };
}

/** Fills holes: every 0 pixel that cannot reach the image border through 0 pixels becomes 1. */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++] as number;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

/**
 * The outer boundary of the region containing the first set pixel (raster order), as pixel-corner
 * coordinates going clockwise (y down). Follows the edges between set and unset pixels, so a
 * w × h block gives exactly its 4 corners after simplification.
 */
export function traceOutline(mask: Uint8Array, w: number, h: number): PixelPoint[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  let start = -1;
  for (let i = 0; i < w * h; i++)
    if (mask[i]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  // Walk the pixel-edge graph: corners (x, y) in 0..w × 0..h; keep the region on the right.
  const sx = start % w;
  const sy = (start - sx) / w;
  let x = sx;
  let y = sy;
  let dir = 0; // 0 = right, 1 = down, 2 = left, 3 = up
  const out: PixelPoint[] = [];
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const limit = 4 * (w + 1) * (h + 1);
  for (let steps = 0; steps < limit; steps++) {
    out.push({ px: x, py: y });
    // Pixels to the front-left and front-right of the corner, seen in the walking direction.
    const left = (d: number) => {
      // the pixel to the left of the edge leaving (x, y) in direction d
      switch (d) {
        case 0:
          return at(x, y - 1);
        case 1:
          return at(x, y);
        case 2:
          return at(x - 1, y);
        default:
          return at(x - 1, y - 1);
      }
    };
    const right = (d: number) => {
      switch (d) {
        case 0:
          return at(x, y);
        case 1:
          return at(x - 1, y);
        case 2:
          return at(x - 1, y - 1);
        default:
          return at(x, y - 1);
      }
    };
    // Prefer turning left, then straight, then right: the outer boundary with the region on the right.
    let moved = false;
    for (const turn of [3, 0, 1, 2]) {
      const d = (dir + turn) % 4;
      if (right(d) && !left(d)) {
        dir = d;
        x += DX[d] as number;
        y += DY[d] as number;
        moved = true;
        break;
      }
    }
    if (!moved || (x === sx && y === sy)) break;
  }
  return out;
}

function perpendicularDistance(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.px - a.px;
  const dy = b.py - a.py;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.px - a.px, p.py - a.py);
  return Math.abs(dy * p.px - dx * p.py + b.px * a.py - b.py * a.px) / len;
}

function douglasPeucker(points: PixelPoint[], epsilon: number): PixelPoint[] {
  if (points.length < 3) return points;
  let max = 0;
  let index = 0;
  const last = points.length - 1;
  for (let i = 1; i < last; i++) {
    const d = perpendicularDistance(points[i] as PixelPoint, points[0] as PixelPoint, points[last] as PixelPoint);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [points[0] as PixelPoint, points[last] as PixelPoint];
  const left = douglasPeucker(points.slice(0, index + 1), epsilon);
  const right = douglasPeucker(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** Simplifies an open path (Douglas–Peucker); the ends are kept. */
export function simplifyPath(path: PixelPoint[], epsilon: number): PixelPoint[] {
  return douglasPeucker(path, epsilon);
}

/** Simplifies a closed ring (Douglas–Peucker, split at the point farthest from the first). */
export function simplifyRing(ring: PixelPoint[], epsilon: number): PixelPoint[] {
  if (ring.length <= 4) return ring;
  const first = ring[0] as PixelPoint;
  let far = 0;
  let farD = -1;
  ring.forEach((p, k) => {
    const d = Math.hypot(p.px - first.px, p.py - first.py);
    if (d > farD) {
      farD = d;
      far = k;
    }
  });
  const a = douglasPeucker(ring.slice(0, far + 1), epsilon);
  const b = douglasPeucker([...ring.slice(far), first], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export interface TraceOptions {
  /** Colour tolerance, 0–441 (RGB distance). */
  tolerance: number;
  /** Simplification, pixels. */
  epsilon: number;
  /** Regions smaller than this many pixels are refused (a click on a line or a label). */
  minPixels: number;
  /** Regions larger than this share of the image are refused (the click "leaked" into the background). */
  maxShare: number;
}

export const DEFAULT_TRACE: TraceOptions = { tolerance: 32, epsilon: 2.5, minPixels: 60, maxShare: 0.9 };

export type TraceResult = { ok: true; ring: PixelPoint[]; pixels: number } | { ok: false; reason: "outside" | "too-small" | "too-large" };

/** Click → polygon in pixel coordinates. */
export function traceRegion(rgba: Uint8ClampedArray, w: number, h: number, at: PixelPoint, options: TraceOptions = DEFAULT_TRACE): TraceResult {
  if (at.px < 0 || at.py < 0 || at.px >= w || at.py >= h) return { ok: false, reason: "outside" };
  const { mask, size } = floodRegion(rgba, w, h, at.px, at.py, options.tolerance);
  if (size < options.minPixels) return { ok: false, reason: "too-small" };
  if (size > options.maxShare * w * h) return { ok: false, reason: "too-large" };
  const filled = fillHoles(mask, w, h);
  const ring = simplifyRing(traceOutline(filled, w, h), options.epsilon);
  if (ring.length < 3) return { ok: false, reason: "too-small" };
  return { ok: true, ring, pixels: size };
}
