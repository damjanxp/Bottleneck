/**
 * PixiJS v8 (WebGL) view of a venue and its pedestrians.
 *
 * - Pedestrians are one ParticleContainer; each state has its own colour and shape, cut from one
 *   texture atlas (a ParticleContainer draws from a single texture source).
 * - Venue geometry is drawn from the venue JSON; lanes from the run's lane layout, coloured and
 *   marked by status (open / not open yet / failed).
 * - Cars (Phase 3) are a second ParticleContainer with rotation: small oriented bodies whose colour
 *   and shape both show the state (moving, standing/queued, parked, diverted). Roads, aisles, lots,
 *   stalls, crossings and the public-road boundary come from the run's vehicle layout; barrier
 *   arms are redrawn from the live barrier states (busy or idle). A stall is occupied when a parked
 *   car stands on it.
 * - Rendering is on demand: continuously while playing (to extrapolate between snapshots, review
 *   C3), otherwise only when something changed.
 * - No Assets loader (it spins up blob: workers, which the CSP forbids) and no HTMLText (it
 *   injects <style>); the `pixi.js/unsafe-eval` polyfills replace the shader/particle code
 *   generation that would need `new Function` (D-009).
 */

import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Particle, ParticleContainer, Rectangle, Sprite, Text, Texture } from "pixi.js";
import type { BarrierLaneLive, LaneLayout, LaneLive, VehicleLayout } from "@bottleneck/engine";
import type { Point, Polygon, Venue } from "@bottleneck/schema";
import { AgentState } from "@bottleneck/engine";
import { clampLabel, distanceToSegment, fitCamera, pan, screenToWorld, worldToScreen, zoomAt, type Bounds, type Camera } from "../sim/camera.ts";
import { EXTRAPOLATE_BELOW_SPEED, extrapolationSeconds } from "../sim/extrapolate.ts";
import { RollingSamples } from "../sim/rolling.ts";
import type { Snapshot } from "../sim/SimController.ts";
import { CAR_STYLES, HEATMAP_MAX, LANE_COLORS, ROAD_COLORS, STATE_STYLES, carStyleIndex, heatColor, insideFade, styleIndex, type CarShape, type Shape } from "./palette.ts";
import { barrierArm, chevron, dashSegments, pointsAlong, publicRoadBoundaries, roadWidth, stallCorners, zebraStripes } from "./vehicleGeometry.ts";

const ATLAS_CELL = 32;
/** Car atlas cell (px): the body is CAR_BODY_PX long, nose towards +x. */
const CAR_CELL_W = 64;
const CAR_CELL_H = 32;
const CAR_BODY_PX = 56;
/** Cars are drawn at least this many screen pixels long. */
const CAR_MIN_PX = 9;
/** Label at the public-road boundary (the renderer's only text of its own). */
const PUBLIC_ROAD_LABEL = "Public road | site";
/** Agent marker size: at least this many metres, and at least MIN_PX screen pixels. */
const AGENT_METRES = 0.6;
const MIN_PX = 5;
const CLICK_SLOP_PX = 5;
const LANE_HIT_PX = 14;
/** Labels keep this many pixels from the edge of the view. */
const LABEL_PAD = 6;
/** Snapshots closer than this (simulated s) count as continuous playback, for the Inside fade-out. */
const CONTINUITY_SECONDS = 60;

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

/** A car body in an atlas cell, nose towards +x: colour and shape both carry the state. */
function drawCar(g: Graphics, shape: CarShape, ox: number, color: number): void {
  const x0 = ox + (CAR_CELL_W - CAR_BODY_PX) / 2;
  const x1 = x0 + CAR_BODY_PX;
  const y0 = 6;
  const y1 = CAR_CELL_H - 6;
  const ym = CAR_CELL_H / 2;
  const outline = { width: 2, color: 0xffffff, alpha: 0.95 };
  const nose = x1 - 12;
  switch (shape) {
    case "arrow":
      g.poly([x0, y0, nose, y0, x1, ym, nose, y1, x0, y1]).fill(color).stroke(outline);
      break;
    case "stopped":
      // Square front and a white "pause" mark: standing in a queue.
      g.rect(x0, y0, CAR_BODY_PX, y1 - y0).fill(color).stroke(outline);
      g.rect(x0 + 18, y0 + 4, 5, y1 - y0 - 8).fill(0xffffff);
      g.rect(x0 + 30, y0 + 4, 5, y1 - y0 - 8).fill(0xffffff);
      break;
    case "parked":
      g.roundRect(x0, y0, CAR_BODY_PX, y1 - y0, 4).fill(color);
      break;
    case "striped":
      // Arrow body with a white stripe along it: diverted to another lot.
      g.poly([x0, y0, nose, y0, x1, ym, nose, y1, x0, y1]).fill(color).stroke(outline);
      g.rect(x0 + 4, ym - 2.5, nose - x0 - 6, 5).fill(0xffffff);
      break;
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
  private readonly vehicleLayer = new Graphics();
  private readonly barrierLayer = new Graphics();
  private cars!: ParticleContainer;
  private carTextures: Texture[] = [];
  private carPool: Particle[] = [];
  private vehicleLayout: VehicleLayout | null = null;
  private barrierLive = new Map<number, BarrierLaneLive>();
  private carScale = 0;
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
  /** Per agent: snapshot time at which it was first seen Inside (NaN: not inside; −∞: inside since before a jump). */
  private insideSince = new Float64Array(0);
  private insideTime = Number.NaN;
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
    // Car texture atlas: one cell per car style.
    const gc = new Graphics();
    CAR_STYLES.forEach((s, i) => drawCar(gc, s.shape, i * CAR_CELL_W, s.color));
    const carAtlas = this.app.renderer.generateTexture({ target: gc, frame: new Rectangle(0, 0, CAR_CELL_W * CAR_STYLES.length, CAR_CELL_H), resolution: 2, antialias: true });
    gc.destroy();
    this.carTextures = CAR_STYLES.map((_, i) => new Texture({ source: carAtlas.source, frame: new Rectangle(i * CAR_CELL_W, 0, CAR_CELL_W, CAR_CELL_H) }));
    this.cars = new ParticleContainer({
      texture: carAtlas,
      dynamicProperties: { position: true, vertex: true, uvs: true, color: true, rotation: true },
    });
    this.world.addChild(this.venueLayer, this.vehicleLayer, this.laneLayer, this.barrierLayer, this.cars, this.particles);
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

  setVenue(venue: Venue, lanes: LaneLayout[], vehicleLayout: VehicleLayout | null = null): void {
    this.lanes = lanes;
    this.vehicleLayout = vehicleLayout;
    this.barrierLive = new Map();
    this.laneStates = [];
    this.selectedLane = null;
    this.snapshot = null;
    this.insideSince = new Float64Array(0);
    this.insideTime = Number.NaN;
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
    const payStations = (venue.parkingLots ?? []).flatMap((l) => (l.payStation ? [l.payStation] : []));
    for (const ps of payStations) g.moveTo(ps.line.a.x, ps.line.a.y).lineTo(ps.line.b.x, ps.line.b.y).stroke({ width: 0.35, color: lineColor, alpha: 0.6 });
    // Site roads and lots count towards the fitted view; public roads may run off it.
    if (vehicleLayout) {
      const grow = (p: Point) => {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      };
      for (const r of vehicleLayout.roads) if (!r.publicRoad) r.points.forEach(grow);
      for (const l of vehicleLayout.lots) l.outline.forEach(grow);
    }
    this.drawVehicleLayout();
    this.bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const area = new Rectangle(this.bounds.minX - 300, this.bounds.minY - 300, this.bounds.maxX - this.bounds.minX + 600, this.bounds.maxY - this.bounds.minY + 600);
    this.particles.boundsArea = area;
    this.cars.boundsArea = area;

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
    for (const el of [...venue.screeningStages, ...venue.gateGroups, ...payStations]) {
      const top = el.line.a.y < el.line.b.y ? el.line.a : el.line.b;
      add(el.name, top.x, top.y, -14, 11);
    }
    if (vehicleLayout) {
      for (const l of vehicleLayout.lots) {
        const c = centroid(l.outline);
        add(l.name, c.x, c.y, 0, 13);
      }
      for (const b of vehicleLayout.barriers) add(b.name, b.stopLine.x, b.stopLine.y, 16, 10);
      const mark = publicRoadBoundaries(vehicleLayout)[0];
      if (mark) add(PUBLIC_ROAD_LABEL, mark.x, mark.y, -16, 10);
    }
    this.ensureParticles(0);
    this.ensureCars(0);
    this.userMovedCamera = false;
    this.fit();
  }

  setLaneStates(states: LaneLive[]): void {
    this.laneStates = states;
    this.drawLanes();
    this.markDirty();
  }

  setBarrierStates(states: readonly BarrierLaneLive[]): void {
    if (!this.vehicleLayout) return;
    this.barrierLive = new Map(states.map((l) => [l.laneId, l]));
    this.drawBarriers();
    this.markDirty();
  }

  setSelectedLane(laneId: number | null): void {
    this.selectedLane = laneId;
    this.drawLanes();
    this.markDirty();
  }

  setSnapshot(snapshot: Snapshot | null): void {
    this.snapshot = snapshot;
    if (snapshot) this.trackInside(snapshot);
    this.markDirty();
  }

  /**
   * People who reached the destination fade out (they would otherwise pile up as markers where
   * they arrived). Fading is in simulated time; after a seek, everyone already inside is hidden.
   */
  private trackInside(snap: Snapshot): void {
    const n = snap.agentCount;
    const continuous = this.insideSince.length === n && snap.time >= this.insideTime && snap.time - this.insideTime <= CONTINUITY_SECONDS;
    if (this.insideSince.length !== n) this.insideSince = new Float64Array(n).fill(Number.NaN);
    const since = this.insideSince;
    const b = snap.buffer;
    for (let i = 0; i < n; i++) {
      if (b[4 * n + i] === AgentState.Inside) {
        if (!continuous) since[i] = -Infinity;
        else if (Number.isNaN(since[i] as number)) since[i] = snap.time;
      } else since[i] = Number.NaN;
    }
    this.insideTime = snap.time;
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

  /** Lots, aisles, roads (width from the lane count; dashed centre line or direction chevrons), stalls, crossings and the public-road boundary. */
  private drawVehicleLayout(): void {
    const g = this.vehicleLayer;
    g.clear();
    const L = this.vehicleLayout;
    if (!L) {
      this.drawBarriers();
      return;
    }
    const C = ROAD_COLORS;
    const d = this.dark;
    for (const lot of L.lots) {
      g.poly(lot.outline.flatMap((p) => [p.x, p.y]))
        .fill({ color: d ? C.lotDark : C.lot, alpha: 0.9 })
        .stroke({ width: 0.4, color: d ? 0x94a3b8 : 0x475569, alpha: 0.8 });
    }
    const line = (pts: readonly { x: number; y: number }[], width: number, color: number) => {
      const first = pts[0];
      if (!first || pts.length < 2) return;
      g.moveTo(first.x, first.y);
      for (let k = 1; k < pts.length; k++) g.lineTo((pts[k] as Point).x, (pts[k] as Point).y);
      g.stroke({ width, color, cap: "butt", join: "round" });
    };
    for (const a of L.aisles) line(a.points, 6, d ? C.aisleDark : C.aisle);
    for (const r of L.roads) line(r.points, roadWidth(r, L.laneWidth), r.publicRoad ? (d ? C.publicRoadDark : C.publicRoad) : d ? C.roadDark : C.road);
    for (const r of L.roads) {
      if (r.direction === "twoWay") {
        for (const [x1, y1, x2, y2] of dashSegments(r.points, 3, 3)) g.moveTo(x1, y1).lineTo(x2, y2);
        g.stroke({ width: 0.2, color: C.marking, alpha: 0.9 });
      } else {
        for (const c of pointsAlong(r.points, 12)) {
          const [ax, ay, tx, ty, bx, by] = chevron(c.x, c.y, c.dx, c.dy, 1.6) as [number, number, number, number, number, number];
          g.moveTo(ax, ay).lineTo(tx, ty).lineTo(bx, by);
        }
        g.stroke({ width: 0.25, color: C.marking, alpha: 0.9 });
      }
    }
    for (const lot of L.lots) for (const st of lot.stalls) g.poly(stallCorners(st)).stroke({ width: 0.12, color: C.stall, alpha: 0.8 });
    for (const c of L.crossings) for (const ring of zebraStripes(c.a, c.b, c.width)) g.poly(ring).fill({ color: C.crossing, alpha: 0.95 });
    for (const m of publicRoadBoundaries(L)) {
      // A thick bar across the site road where it leaves the public road.
      const h = m.width / 2 + 1;
      g.moveTo(m.x + m.dy * h, m.y - m.dx * h)
        .lineTo(m.x - m.dy * h, m.y + m.dx * h)
        .stroke({ width: 0.8, color: C.boundary, alpha: 0.95 });
    }
    this.drawBarriers();
  }

  /** Barrier arms: an idle lane is a thin bar, a lane serving a car a thick bar with a dot. */
  private drawBarriers(): void {
    const g = this.barrierLayer;
    g.clear();
    const L = this.vehicleLayout;
    if (!L) return;
    const px = 1 / this.camera.scale;
    for (const b of L.barriers) {
      b.lanes.forEach((pos, k) => {
        const busy = this.barrierLive.get(b.laneIds[k] ?? -1)?.inService ?? false;
        const [x1, y1, x2, y2] = barrierArm(pos, b.heading, L.laneWidth);
        const color = busy ? ROAD_COLORS.barrierBusy : this.dark ? ROAD_COLORS.barrierIdleDark : ROAD_COLORS.barrierIdle;
        g.moveTo(x1, y1)
          .lineTo(x2, y2)
          .stroke({ width: Math.max(busy ? 0.45 : 0.25, (busy ? 3 : 1.5) * px), color });
        if (busy) g.circle(pos.x, pos.y, Math.max(0.5, 3 * px)).fill(color);
      });
    }
  }

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

  private ensureCars(n: number): void {
    while (this.carPool.length < n) this.carPool.push(new Particle({ texture: this.carTextures[0] as Texture, anchorX: 0.5, anchorY: 0.5, alpha: 0 }));
    if (this.cars.particleChildren.length !== n) {
      this.cars.particleChildren.length = 0;
      for (let i = 0; i < n; i++) this.cars.particleChildren.push(this.carPool[i] as Particle);
      this.cars.update();
    }
    this.carScale = 0;
  }

  /** Cars: position (extrapolated like people), heading, and a style per state; Pending, Departed and TurnedAway cars are hidden. */
  private updateCars(dt: number): void {
    const snap = this.snapshot;
    const n = snap ? snap.vehicleCount : 0;
    if (this.cars.particleChildren.length !== n) this.ensureCars(n);
    if (!snap || n === 0) return;
    const b = snap.vehicles;
    const length = this.vehicleLayout?.carLength ?? 4.5;
    const scale = Math.max(length, CAR_MIN_PX / this.camera.scale) / CAR_BODY_PX;
    const rescale = scale !== this.carScale;
    this.carScale = scale;
    const parts = this.cars.particleChildren as Particle[];
    for (let i = 0; i < n; i++) {
      const p = parts[i] as Particle;
      const vx = b[2 * n + i] as number;
      const vy = b[3 * n + i] as number;
      const si = carStyleIndex(b[6 * n + i] as number, vx, vy);
      if (si < 0) {
        p.alpha = 0;
        continue;
      }
      p.texture = this.carTextures[si] as Texture;
      p.alpha = (CAR_STYLES[si] as (typeof CAR_STYLES)[number]).alpha;
      if (rescale || p.scaleX !== scale) {
        p.scaleX = scale;
        p.scaleY = scale;
      }
      p.rotation = Math.atan2(b[5 * n + i] as number, b[4 * n + i] as number);
      p.x = (b[i] as number) + vx * dt;
      p.y = (b[n + i] as number) + vy * dt;
    }
  }

  private updateParticles(now: number): void {
    const snap = this.snapshot;
    if (!snap) {
      if (this.particles.particleChildren.length > 0) this.ensureParticles(0);
      if (this.cars.particleChildren.length > 0) this.ensureCars(0);
      return;
    }
    const n = snap.agentCount;
    if (this.particles.particleChildren.length !== n) this.ensureParticles(n);
    const b = snap.buffer;
    const dt = this.speed < EXTRAPOLATE_BELOW_SPEED ? extrapolationSeconds((now - snap.receivedAt) / 1000, this.speed, this.playing) : 0;
    this.updateCars(dt);
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
      let alpha = style.alpha;
      if (style.state === AgentState.Inside) {
        alpha *= insideFade(snap.time - (this.insideSince[i] ?? Number.NaN));
        if (alpha <= 0) {
          p.alpha = 0;
          continue;
        }
      }
      p.texture = textures[si] as Texture;
      p.alpha = alpha;
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
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    for (const l of this.labels) {
      const s = worldToScreen(c, l.x, l.y);
      // Labels near the venue's edge stay inside the view instead of being clipped.
      const p = clampLabel(s.x, s.y + l.dy, l.text.width / 2, l.text.height / 2, w, h, LABEL_PAD);
      l.text.position.set(p.x, p.y);
    }
    this.drawLanes();
    this.drawBarriers();
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
