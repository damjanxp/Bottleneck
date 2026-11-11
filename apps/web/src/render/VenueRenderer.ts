/**
 * PixiJS v8 (WebGL) view of a venue and its pedestrians.
 *
 * - Pedestrians are one ParticleContainer; each state has its own colour and shape, cut from one
 *   texture atlas (a ParticleContainer draws from a single texture source).
 * - Venue geometry is drawn from the venue JSON; lanes from the run's lane layout, coloured and
 *   marked by status (open / not open yet / failed).
 * - Rendering is on demand: continuously while playing (to extrapolate between snapshots, review
 *   C3), otherwise only when something changed.
 * - No Assets loader (it spins up blob: workers, which the CSP forbids) and no HTMLText (it
 *   injects <style>); the `pixi.js/unsafe-eval` polyfills replace the shader/particle code
 *   generation that would need `new Function` (D-009).
 */

import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite, Text, Texture } from "pixi.js";
import type { LaneLayout, LaneLive } from "@bottleneck/engine";
import type { Point, Polygon, Venue } from "@bottleneck/schema";
import { distanceToSegment, fitCamera, pan, screenToWorld, worldToScreen, zoomAt, type Bounds, type Camera } from "../sim/camera.ts";
import { EXTRAPOLATE_BELOW_SPEED, extrapolationSeconds } from "../sim/extrapolate.ts";
import { RollingSamples } from "../sim/rolling.ts";
import type { Snapshot } from "../sim/SimController.ts";
import { HEATMAP_MAX, LANE_COLORS, STATE_STYLES, heatColor, styleIndex, type Shape } from "./palette.ts";

const ATLAS_CELL = 32;
/** Agent marker size: at least this many metres, and at least MIN_PX screen pixels. */
const AGENT_METRES = 0.6;
const MIN_PX = 5;
const CLICK_SLOP_PX = 5;
const LANE_HIT_PX = 14;

export interface DensityFrame {
  data: Float32Array;
  cols: number;
  rows: number;
  cellSize: number;
  originX: number;
  originY: number;
}

export interface FrameStats {
  frameIntervalP50: number;
  frameIntervalP95: number;
  renderP50: number;
  renderP95: number;
}

function drawShape(g: Graphics, shape: Shape, cx: number, cy: number, r: number, color: number): void {
  const outline = { width: 2, color: 0xffffff, alpha: 0.9 };
  switch (shape) {
    case "circle":
      g.circle(cx, cy, r).fill(color).stroke(outline);
      break;
    case "square":
      g.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7).fill(color).stroke(outline);
      break;
    case "diamond":
      g.poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]).fill(color).stroke(outline);
      break;
    case "triangle":
      g.poly([cx, cy - r, cx + r * 0.95, cy + r * 0.75, cx - r * 0.95, cy + r * 0.75]).fill(color).stroke(outline);
      break;
    case "cross": {
      const w = r * 0.45;
      g.poly([cx - r, cy - r + w, cx - r + w, cy - r, cx, cy - w, cx + r - w, cy - r, cx + r, cy - r + w, cx + w, cy, cx + r, cy + r - w, cx + r - w, cy + r, cx, cy + w, cx - r + w, cy + r, cx - r, cy + r - w, cx - w, cy])
        .fill(color)
        .stroke(outline);
      break;
    }
  }
}

function ringPoints(ring: Point[]): number[] {
  const out: number[] = [];
  for (const p of ring) out.push(p.x, p.y);
  return out;
}

function drawPolygon(g: Graphics, polygon: Polygon, color: number, alpha = 1): void {
  g.poly(ringPoints(polygon.outer)).fill({ color, alpha });
  for (const hole of polygon.holes ?? []) g.poly(ringPoints(hole)).cut();
}

function centroid(ring: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: x / Math.max(1, ring.length), y: y / Math.max(1, ring.length) };
}

interface Label {
  text: Text;
  x: number;
  y: number;
  dy: number;
}

export class VenueRenderer {
  readonly app: Application;
  private readonly host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly dark: boolean;
  private readonly world = new Container();
  private readonly venueLayer = new Graphics();
  private readonly laneLayer = new Graphics();
  private readonly labelLayer = new Container();
  private particles!: ParticleContainer;
  private stateTextures: Texture[] = [];
  private pool: Particle[] = [];
  private heatSprite: Sprite | null = null;
  private heatCanvas: HTMLCanvasElement | null = null;
  private heatTexture: Texture | null = null;
  private labels: Label[] = [];

  private camera: Camera = { scale: 1, x: 0, y: 0 };
  private bounds: Bounds | null = null;
  private userMovedCamera = false;
  private lanes: LaneLayout[] = [];
  private laneStates: LaneLive[] = [];
  private selectedLane: number | null = null;
  private snapshot: Snapshot | null = null;
  private playing = false;
  private speed = 1;
  private particleScale = 0;
  private dirty = true;
  private rafId = 0;
  private lastFrameAt = 0;
  private readonly frameIntervals = new RollingSamples(300);
  private readonly renderTimes = new RollingSamples(300);
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pressStart: { x: number; y: number; moved: boolean } | null = null;
  private pinchDistance = 0;
  private readonly resizeObserver: ResizeObserver;
  private destroyed = false;
  onLaneClick: ((laneId: number) => void) | null = null;

  private constructor(app: Application, host: HTMLElement, canvas: HTMLCanvasElement, dark: boolean) {
    this.app = app;
    this.host = host;
    this.canvas = canvas;
    this.dark = dark;
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
  }

  static async create(host: HTMLElement): Promise<VenueRenderer> {
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full touch-none select-none";
    const app = new Application();
    const rect = host.getBoundingClientRect();
    await app.init({
      canvas,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      preference: "webgl",
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      backgroundAlpha: 0,
      autoStart: false,
      sharedTicker: false,
    });
    app.ticker.stop();
    host.appendChild(canvas);
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const r = new VenueRenderer(app, host, canvas, dark);
    r.setup();
    return r;
  }

  private setup(): void {
    // Agent texture atlas: one cell per state style.
    const g = new Graphics();
    STATE_STYLES.forEach((s, i) => drawShape(g, s.shape, i * ATLAS_CELL + ATLAS_CELL / 2, ATLAS_CELL / 2, (ATLAS_CELL / 2 - 3) * Math.min(1, s.size), s.color));
    const atlas = this.app.renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, ATLAS_CELL * STATE_STYLES.length, ATLAS_CELL), resolution: 2, antialias: true });
    g.destroy();
    this.stateTextures = STATE_STYLES.map((_, i) => new Texture({ source: atlas.source, frame: new Rectangle(i * ATLAS_CELL, 0, ATLAS_CELL, ATLAS_CELL) }));
    this.particles = new ParticleContainer({
      texture: atlas,
      dynamicProperties: { position: true, vertex: true, uvs: true, color: true, rotation: false },
    });
    this.world.addChild(this.venueLayer, this.laneLayer, this.particles);
    this.app.stage.addChild(this.world, this.labelLayer);

    const c = this.canvas;
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    this.resizeObserver.observe(this.host);
    this.requestFrame();
  }

  // ---------------------------------------------------------------------------------------------
  // Scene content
  // ---------------------------------------------------------------------------------------------

  setVenue(venue: Venue, lanes: LaneLayout[]): void {
    this.lanes = lanes;
    this.laneStates = [];
    this.selectedLane = null;
    this.snapshot = null;
    const g = this.venueLayer;
    g.clear();
    const walk = this.dark ? 0x1e293b : 0xffffff;
    const obstacle = this.dark ? 0x475569 : 0x94a3b8;
    const dest = this.dark ? 0x065f46 : 0xd1fae5;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const a of venue.walkableAreas) {
      drawPolygon(g, a.polygon, walk);
      for (const p of a.polygon.outer) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    for (const d of venue.destinations) drawPolygon(g, d.area, dest, 0.9);
    for (const o of venue.obstacles) drawPolygon(g, o.polygon, obstacle);
    const lineColor = this.dark ? 0xcbd5e1 : 0x334155;
    for (const el of [...venue.screeningStages, ...venue.gateGroups]) {
      g.moveTo(el.line.a.x, el.line.a.y).lineTo(el.line.b.x, el.line.b.y).stroke({ width: 0.35, color: lineColor, alpha: 0.6 });
    }
    for (const s of venue.sources) {
      g.circle(s.position.x, s.position.y, 1.6).fill({ color: 0x0072b2, alpha: 0.25 }).stroke({ width: 0.3, color: 0x0072b2 });
    }
    this.bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    this.particles.boundsArea = new Rectangle(this.bounds.minX - 50, this.bounds.minY - 50, this.bounds.maxX - this.bounds.minX + 100, this.bounds.maxY - this.bounds.minY + 100);

    // Labels (screen space, constant size).
    for (const l of this.labels) l.text.destroy();
    this.labels = [];
    this.labelLayer.removeChildren();
    const fill = this.dark ? 0xf1f5f9 : 0x0f172a;
    const stroke = this.dark ? 0x0f172a : 0xffffff;
    const add = (text: string, x: number, y: number, dy = 0, size = 12) => {
      const t = new Text({ text, style: { fontFamily: "system-ui, sans-serif", fontSize: size, fill, stroke: { color: stroke, width: 3 }, align: "center" }, resolution: 2 });
      t.anchor.set(0.5);
      this.labelLayer.addChild(t);
      this.labels.push({ text: t, x, y, dy });
    };
    for (const d of venue.destinations) {
      const c = centroid(d.area.outer);
      add(d.name, c.x, c.y, 0, 13);
    }
    for (const s of venue.sources) add(s.name, s.position.x, s.position.y, -14, 11);
    for (const el of [...venue.screeningStages, ...venue.gateGroups]) {
      const top = el.line.a.y < el.line.b.y ? el.line.a : el.line.b;
      add(el.name, top.x, top.y, -14, 11);
    }
    this.ensureParticles(0);
    this.userMovedCamera = false;
    this.fit();
  }

  setLaneStates(states: LaneLive[]): void {
    this.laneStates = states;
    this.drawLanes();
    this.markDirty();
  }

  setSelectedLane(laneId: number | null): void {
    this.selectedLane = laneId;
    this.drawLanes();
    this.markDirty();
  }

  setSnapshot(snapshot: Snapshot | null): void {
    this.snapshot = snapshot;
    this.markDirty();
  }

  setPlayback(playing: boolean, speed: number): void {
    this.playing = playing;
    this.speed = speed;
    this.markDirty();
  }

  setDensity(frame: DensityFrame | null): void {
    if (!frame) {
      if (this.heatSprite) this.heatSprite.visible = false;
      this.markDirty();
      return;
    }
    if (!this.heatCanvas || this.heatCanvas.width !== frame.cols || this.heatCanvas.height !== frame.rows) {
      this.heatSprite?.destroy();
      this.heatTexture?.destroy(true);
      const c = document.createElement("canvas");
      c.width = frame.cols;
      c.height = frame.rows;
      this.heatCanvas = c;
      this.heatTexture = Texture.from(c);
      this.heatTexture.source.scaleMode = "linear";
      this.heatSprite = new Sprite(this.heatTexture);
      this.world.addChildAt(this.heatSprite, 1);
    }
    const sprite = this.heatSprite as Sprite;
    sprite.position.set(frame.originX, frame.originY);
    sprite.scale.set(frame.cellSize);
    sprite.visible = true;
    const ctx = (this.heatCanvas as HTMLCanvasElement).getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(frame.cols, frame.rows);
    for (let k = 0; k < frame.cols * frame.rows; k++) heatColor(frame.data[k] as number, img.data, k * 4);
    ctx.putImageData(img, 0, 0);
    this.heatTexture?.source.update();
    this.markDirty();
  }

  get heatmapMax(): number {
    return HEATMAP_MAX;
  }

  fit(): void {
    if (!this.bounds) return;
    const r = this.host.getBoundingClientRect();
    this.camera = fitCamera(this.bounds, r.width, r.height);
    this.userMovedCamera = false;
    this.applyCamera();
  }

  frameStats(): FrameStats {
    return {
      frameIntervalP50: this.frameIntervals.percentile(0.5),
      frameIntervalP95: this.frameIntervals.percentile(0.95),
      renderP50: this.renderTimes.percentile(0.5),
      renderP95: this.renderTimes.percentile(0.95),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------------------------

  private drawLanes(): void {
    const g = this.laneLayer;
    g.clear();
    const px = 1 / this.camera.scale;
    for (const lane of this.lanes) {
      const live = this.laneStates[lane.laneId];
      const failed = live?.failed ?? false;
      const open = live?.open ?? false;
      const color = failed ? LANE_COLORS.failed : open ? (this.dark ? LANE_COLORS.openDark : LANE_COLORS.open) : LANE_COLORS.closed;
      if (lane.laneId === this.selectedLane) {
        g.moveTo(lane.queueTail.x, lane.queueTail.y).lineTo(lane.service.x, lane.service.y).stroke({ width: 8 * px, color: LANE_COLORS.selected, alpha: 0.6, cap: "round" });
      }
      g.moveTo(lane.queueTail.x, lane.queueTail.y)
        .lineTo(lane.queueHead.x, lane.queueHead.y)
        .stroke({ width: Math.max(0.12, 2 * px), color, alpha: open || failed ? 0.8 : 0.5 });
      const r = Math.max(0.35, 4 * px);
      if (failed) {
        // Failed: a cross, not only a colour.
        g.moveTo(lane.service.x - r, lane.service.y - r)
          .lineTo(lane.service.x + r, lane.service.y + r)
          .moveTo(lane.service.x + r, lane.service.y - r)
          .lineTo(lane.service.x - r, lane.service.y + r)
          .stroke({ width: Math.max(0.15, 2.5 * px), color });
      } else if (open) {
        g.rect(lane.service.x - r, lane.service.y - r, 2 * r, 2 * r).fill(color);
      } else {
        g.rect(lane.service.x - r, lane.service.y - r, 2 * r, 2 * r).stroke({ width: Math.max(0.1, 1.5 * px), color });
      }
    }
  }

  private ensureParticles(n: number): void {
    while (this.pool.length < n) {
      const p = new Particle({ texture: this.stateTextures[0] as Texture, anchorX: 0.5, anchorY: 0.5, alpha: 0 });
      this.pool.push(p);
    }
    if (this.particles.particleChildren.length !== n) {
      this.particles.particleChildren.length = 0;
      for (let i = 0; i < n; i++) this.particles.particleChildren.push(this.pool[i] as Particle);
      this.particles.update();
    }
    this.particleScale = 0;
  }

  private updateParticles(now: number): void {
    const snap = this.snapshot;
    if (!snap) {
      if (this.particles.particleChildren.length > 0) this.ensureParticles(0);
      return;
    }
    const n = snap.agentCount;
    if (this.particles.particleChildren.length !== n) this.ensureParticles(n);
    const b = snap.buffer;
    const dt = this.speed < EXTRAPOLATE_BELOW_SPEED ? extrapolationSeconds((now - snap.receivedAt) / 1000, this.speed, this.playing) : 0;
    const worldSize = Math.max(AGENT_METRES, MIN_PX / this.camera.scale);
    const baseScale = worldSize / ATLAS_CELL;
    const rescale = baseScale !== this.particleScale;
    this.particleScale = baseScale;
    const textures = this.stateTextures;
    const parts = this.particles.particleChildren as Particle[];
    for (let i = 0; i < n; i++) {
      const p = parts[i] as Particle;
      const si = styleIndex(b[4 * n + i] as number);
      if (si < 0) {
        p.alpha = 0;
        continue;
      }
      const style = STATE_STYLES[si] as (typeof STATE_STYLES)[number];
      p.texture = textures[si] as Texture;
      p.alpha = style.alpha;
      if (rescale || p.scaleX !== baseScale * style.size) {
        p.scaleX = baseScale * style.size;
        p.scaleY = baseScale * style.size;
      }
      if (dt > 0) {
        p.x = (b[i] as number) + (b[2 * n + i] as number) * dt;
        p.y = (b[n + i] as number) + (b[3 * n + i] as number) * dt;
      } else {
        p.x = b[i] as number;
        p.y = b[n + i] as number;
      }
    }
  }

  private applyCamera(): void {
    const c = this.camera;
    this.world.position.set(c.x, c.y);
    this.world.scale.set(c.scale);
    for (const l of this.labels) {
      const s = worldToScreen(c, l.x, l.y);
      l.text.position.set(s.x, s.y + l.dy);
    }
    this.drawLanes();
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.rafId !== 0 || this.destroyed) return;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    const animating = this.playing;
    if (!this.dirty && !animating) {
      this.lastFrameAt = 0;
      return;
    }
    if (animating && this.lastFrameAt > 0) this.frameIntervals.add(now - this.lastFrameAt);
    this.lastFrameAt = animating ? now : 0;
    const t0 = performance.now();
    this.updateParticles(performance.now());
    this.app.render();
    this.renderTimes.add(performance.now() - t0);
    this.dirty = false;
    if (animating) this.requestFrame();
  };

  // ---------------------------------------------------------------------------------------------
  // Interaction: wheel zoom, drag pan, pinch zoom, click on a lane
  // ---------------------------------------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.camera = zoomAt(this.camera, p.x, p.y, Math.exp(-delta * 0.0015));
    this.userMovedCamera = true;
    this.applyCamera();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) this.pressStart = { x: p.x, y: p.y, moved: false };
    else {
      this.pressStart = null;
      this.pinchDistance = this.currentPinchDistance();
    }
  };

  private currentPinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    if (this.pointers.size >= 2) {
      const [a0, b0] = [...this.pointers.values()];
      this.pointers.set(e.pointerId, p);
      const [a1, b1] = [...this.pointers.values()];
      if (!a0 || !b0 || !a1 || !b1) return;
      const d = this.currentPinchDistance();
      const mx0 = (a0.x + b0.x) / 2;
      const my0 = (a0.y + b0.y) / 2;
      const mx1 = (a1.x + b1.x) / 2;
      const my1 = (a1.y + b1.y) / 2;
      let cam = pan(this.camera, mx1 - mx0, my1 - my0);
      if (this.pinchDistance > 0 && d > 0) cam = zoomAt(cam, mx1, my1, d / this.pinchDistance);
      this.pinchDistance = d;
      this.camera = cam;
    } else {
      this.pointers.set(e.pointerId, p);
      this.camera = pan(this.camera, p.x - prev.x, p.y - prev.y);
      if (this.pressStart && Math.abs(p.x - this.pressStart.x) + Math.abs(p.y - this.pressStart.y) > CLICK_SLOP_PX) this.pressStart.moved = true;
    }
    this.userMovedCamera = true;
    this.applyCamera();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const p = this.local(e);
    const press = this.pressStart;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    if (e.type === "pointerup" && press && !press.moved && this.pointers.size === 0) this.click(p.x, p.y);
    if (this.pointers.size === 0) this.pressStart = null;
  };

  private click(sx: number, sy: number): void {
    const w = screenToWorld(this.camera, sx, sy);
    let best = -1;
    let bestDist = LANE_HIT_PX / this.camera.scale;
    for (const lane of this.lanes) {
      const d = distanceToSegment(w.x, w.y, lane.queueTail.x, lane.queueTail.y, lane.service.x, lane.service.y);
      if (d < bestDist) {
        bestDist = d;
        best = lane.laneId;
      }
    }
    if (best >= 0) this.onLaneClick?.(best);
  }

  private handleResize(): void {
    const r = this.host.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.app.renderer.resize(r.width, r.height);
    if (!this.userMovedCamera) this.fit();
    else this.markDirty();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    const c = this.canvas;
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
  }
}
