/**
 * 2D camera for the venue view: screen = world × scale + offset (venue metres to CSS pixels,
 * y pointing down in both).
 */

export interface Camera {
  scale: number;
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 80;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Camera that shows all of `bounds` centred in a viewport, with a margin (fraction of each side). */
export function fitCamera(bounds: Bounds, width: number, height: number, margin = 0.04): Camera {
  const bw = Math.max(1e-6, bounds.maxX - bounds.minX);
  const bh = Math.max(1e-6, bounds.maxY - bounds.minY);
  const usableW = Math.max(1, width * (1 - 2 * margin));
  const usableH = Math.max(1, height * (1 - 2 * margin));
  const scale = clampScale(Math.min(usableW / bw, usableH / bh));
  return {
    scale,
    x: (width - bw * scale) / 2 - bounds.minX * scale,
    y: (height - bh * scale) / 2 - bounds.minY * scale,
  };
}

/** Zooms by `factor` keeping the world point under screen point (sx, sy) fixed. */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  const scale = clampScale(cam.scale * factor);
  const wx = (sx - cam.x) / cam.scale;
  const wy = (sy - cam.y) / cam.scale;
  return { scale, x: sx - wx * scale, y: sy - wy * scale };
}

export function pan(cam: Camera, dx: number, dy: number): Camera {
  return { scale: cam.scale, x: cam.x + dx, y: cam.y + dy };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

/** Distance from point p to segment ab. */
export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/**
 * Keeps a label of half-size (halfW, halfH) centred at (x, y) fully inside a width × height
 * viewport with `pad` pixels to spare; centred if the viewport is too small for it.
 */
export function clampLabel(x: number, y: number, halfW: number, halfH: number, width: number, height: number, pad = 4): { x: number; y: number } {
  const fit = (v: number, half: number, size: number) => (size < 2 * (half + pad) ? size / 2 : Math.min(size - half - pad, Math.max(half + pad, v)));
  return { x: fit(x, halfW, width), y: fit(y, halfH, height) };
}
