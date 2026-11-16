/**
 * Sprite atlases for people and cars, drawn with the Canvas 2D API (redesign 3): soft shadows,
 * shaded bodies and details (car windows, headlights, brake lights) that flat vector shapes could
 * not give. Each state keeps its own shape and colour (never colour alone, palette.ts). The canvases
 * are drawn at 2× and handed to PixiJS as textures.
 */

import type { CarShape, CarStyle, Shape, StateStyle } from "./palette.ts";

const SCALE = 2;

function hex(n: number, alpha = 1): string {
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** n lightened (t > 0) or darkened (t < 0) by |t| (0–1). */
function shade(n: number, t: number): string {
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "square":
      ctx.roundRect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7, r * 0.3);
      break;
    case "diamond":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.95, cy + r * 0.75);
      ctx.lineTo(cx - r * 0.95, cy + r * 0.75);
      ctx.closePath();
      break;
    case "cross": {
      const w = r * 0.42;
      const pts = [
        [-r, -r + w],
        [-r + w, -r],
        [0, -w],
        [r - w, -r],
        [r, -r + w],
        [w, 0],
        [r, r - w],
        [r - w, r],
        [0, w],
        [-r + w, r],
        [-r, r - w],
        [-w, 0],
      ];
      pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(cx + (x as number), cy + (y as number)) : ctx.lineTo(cx + (x as number), cy + (y as number))));
      ctx.closePath();
      break;
    }
  }
}

/** People: one cell per state, a shaded token with a soft shadow and a dark rim. */
export function personAtlas(styles: readonly StateStyle[], cell: number, outline: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = cell * styles.length * SCALE;
  c.height = cell * SCALE;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.scale(SCALE, SCALE);
  styles.forEach((s, i) => {
    const cx = i * cell + cell / 2;
    const cy = cell / 2 - 1;
    const r = (cell / 2 - 4) * Math.min(1, s.size);
    // Shadow.
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(cx + 1.2, cy + r * 0.55 + 1.5, r * 0.95, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    // Body: lit from the top left.
    const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.45, r * 0.1, cx, cy, r * 1.1);
    g.addColorStop(0, shade(s.color, 0.45));
    g.addColorStop(0.55, hex(s.color));
    g.addColorStop(1, shade(s.color, -0.25));
    shapePath(ctx, s.shape, cx, cy, r);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = hex(outline, 0.85);
    ctx.stroke();
  });
  return c;
}

/** Cars, seen from above, nose towards +x: body, glass, lights; the state shows in colour and details. */
export function carAtlas(styles: readonly CarStyle[], cw: number, ch: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = cw * styles.length * SCALE;
  c.height = ch * SCALE;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.scale(SCALE, SCALE);
  styles.forEach((s, i) => drawCar(ctx, s.shape, s.color, i * cw, cw, ch));
  return c;
}

function drawCar(ctx: CanvasRenderingContext2D, shape: CarShape, color: number, ox: number, cw: number, ch: number): void {
  const L = cw - 10;
  const W = ch - 10;
  const x0 = ox + 5;
  const y0 = 5;
  const x1 = x0 + L;
  const y1 = y0 + W;
  // Shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.beginPath();
  ctx.roundRect(x0 + 1.5, y0 + 2, L, W, 6);
  ctx.fill();
  // Body.
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, shade(color, -0.15));
  g.addColorStop(0.5, shade(color, 0.25));
  g.addColorStop(1, shade(color, -0.15));
  ctx.beginPath();
  ctx.roundRect(x0, y0, L, W, [5, 8, 8, 5]);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = shape === "parked" ? 2.5 : 1.5;
  ctx.strokeStyle = shape === "parked" ? "rgba(17, 24, 39, 0.95)" : "rgba(255, 255, 255, 0.9)";
  ctx.stroke();
  // Windscreen (front), rear window and roof.
  ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
  ctx.beginPath();
  ctx.moveTo(x1 - 16, y0 + 3);
  ctx.lineTo(x1 - 10, y0 + 5);
  ctx.lineTo(x1 - 10, y1 - 5);
  ctx.lineTo(x1 - 16, y1 - 3);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x0 + 7, y0 + 5);
  ctx.lineTo(x0 + 11, y0 + 4);
  ctx.lineTo(x0 + 11, y1 - 4);
  ctx.lineTo(x0 + 7, y1 - 5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(color, 0.35);
  ctx.beginPath();
  ctx.roundRect(x0 + 13, y0 + 4, L - 31, W - 8, 3);
  ctx.fill();
  // Lights: headlights while moving, brake lights while standing.
  if (shape === "arrow" || shape === "striped") {
    ctx.fillStyle = "rgba(255, 250, 210, 0.95)";
    ctx.fillRect(x1 - 3, y0 + 2, 2.5, 4);
    ctx.fillRect(x1 - 3, y1 - 6, 2.5, 4);
  }
  if (shape === "stopped") {
    ctx.fillStyle = "rgb(239, 68, 68)";
    ctx.fillRect(x0 + 0.5, y0 + 2, 3, 5);
    ctx.fillRect(x0 + 0.5, y1 - 7, 3, 5);
  }
  if (shape === "striped") {
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.fillRect(x0 + 13, (y0 + y1) / 2 - 2, L - 31, 4);
  }
}
