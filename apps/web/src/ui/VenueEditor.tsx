import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import type { Point, Polygon, Venue } from "@bottleneck/schema";
import { CLASS_CODE, NO_OVERRIDE, applyDetection, classMap, cleanOptions, clusterColours, type Cluster, type MapClass } from "../editor/autodetect.ts";
import { calibrate, pixelToVenue, venueToPixel } from "../editor/calibration.ts";
import { addGate, addRoad, addSource, blankVenue, deleteElement, handles, moveHandle, newVenueId, scaleVenue, type Handle } from "../editor/edits.ts";
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "../editor/history.ts";
import { mergePolygon, paintPath } from "../editor/paint.ts";
import { AREA_KINDS, changeKind, duplicateElement, elementAt, moveElement, polygonOf, shapePoints, type AreaKind, type ShapeKind } from "../editor/shapes.ts";
import { OsmError, osmToVenue, parseOsm } from "../editor/osm.ts";
import { DEFAULT_TRACE, simplifyPath, traceRegion } from "../editor/trace.ts";
import { applyFix, checkVenue, hasErrors, type VenueProblem } from "../editor/venueChecks.ts";
import { knownVenues } from "../library/catalog.ts";
import { deleteUserVenue, storeUserVenue } from "../library/userVenues.ts";
import type { SchemaValidator } from "../library/validate.ts";
import { browserStore, downscaledSize, loadVenueImage, removeVenueImage, saveVenueImage } from "../library/venueImages.ts";
import { strings } from "../strings.ts";
import { loadVenueValidator } from "../validation/loadValidator.ts";
import { InfoTip } from "./icons.tsx";
import { centroidOf } from "../editor/geometry.ts";
import { btn, btnGhost, btnPrimary, btnSmall, card, cardTitle, input, labelText, overlay, select } from "./styles.ts";
import type { Server } from "./useServer.ts";

const E = strings.venueEditor;
type Tool = "select" | ShapeKind | "area" | "eraser" | "source" | "gate" | "road" | "calibrate" | "trace" | "fix";
type Style = "points" | "paint";
const SHAPE_TOOLS: ShapeKind[] = ["rectangle", "circle", "lshape", "ushape"];
const KEY_TO_TOOL: Record<string, Tool> = { v: "select", r: "rectangle", c: "circle", l: "lshape", u: "ushape", a: "area", e: "eraser", s: "source", g: "gate", d: "road", k: "calibrate", t: "trace" };
const isShape = (t: Tool): t is ShapeKind => (SHAPE_TOOLS as string[]).includes(t);
const LANE_WIDTH = 3.5;
const CLASSES: MapClass[] = ["road", "walkable", "obstacle", "ignore"];
/** Detection preview colours: the same meaning as in the editor's key. Cleaned-up pixels (text, widgets, icons) show in magenta. */
const CLASS_RGBA: Record<MapClass, [number, number, number, number]> = { road: [31, 41, 55, 200], walkable: [20, 184, 166, 105], obstacle: [220, 38, 38, 140], ignore: [0, 0, 0, 0] };
const CLEANED_RGBA: [number, number, number, number] = [217, 70, 239, 200];
type Layer = "image" | "detection" | "walkable" | "obstacles" | "destinations" | "roads" | "parking" | "names" | "problems";
const LAYERS: Layer[] = ["image", "detection", "walkable", "obstacles", "destinations", "roads", "parking", "names", "problems"];

/** The map image in this page view: its data URL and pixels (for tracing and detection). */
interface MapImage {
  url: string;
  w: number;
  h: number;
  pixels: Uint8ClampedArray;
}

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Detection {
  clusters: Cluster[];
  assignment: Uint8Array;
  classes: MapClass[];
  /** Painted corrections per pixel (a class code or NO_OVERRIDE). */
  overrides: Uint8Array;
  preview: string | null;
}

function bounds(v: Venue): View {
  const pts: Point[] = [];
  const grow = (p: Point) => pts.push(p);
  v.walkableAreas.forEach((e) => e.polygon.outer.forEach(grow));
  v.obstacles.forEach((e) => e.polygon.outer.forEach(grow));
  v.destinations.forEach((e) => e.area.outer.forEach(grow));
  v.sources.forEach((e) => grow(e.position));
  (v.roads ?? []).forEach((r) => r.points.forEach(grow));
  [...v.gateGroups, ...v.screeningStages].forEach((e) => {
    grow(e.line.a);
    grow(e.line.b);
  });
  if (v.background) {
    const b = v.background;
    grow(b.origin);
    grow({ x: b.origin.x + b.widthPx * b.metresPerPixel, y: b.origin.y + b.heightPx * b.metresPerPixel });
  }
  if (pts.length === 0) return { x: 0, y: 0, w: 100, h: 60 };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(10, Math.max(...xs) - minX);
  const h = Math.max(6, Math.max(...ys) - minY);
  return { x: minX - w * 0.05, y: minY - h * 0.05, w: w * 1.1, h: h * 1.1 };
}

const pts = (ring: readonly Point[]) => ring.map((p) => `${p.x},${p.y}`).join(" ");
/** A polygon with holes as an SVG path (filled even-odd). */
const polyPath = (poly: Polygon) => [poly.outer, ...(poly.holes ?? [])].map((r) => `M${r.map((p) => `${p.x},${p.y}`).join("L")}Z`).join("");
const linePath = (line: readonly Point[]) => `M${line.map((p) => `${p.x},${p.y}`).join("L")}`;

/** Decodes an image (file or data URL), downscales it and returns its data URL and pixels. */
async function decodeImage(src: string, keepUrl: boolean): Promise<MapImage> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { w, h } = downscaledSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  return { url: keepUrl ? src : canvas.toDataURL("image/jpeg", 0.85), w, h, pixels };
}

/** The cleaned detection (exactly what Apply will use) as a coloured overlay image (data URL). */
function detectionPreview(d: { assignment: Uint8Array; classes: MapClass[]; overrides: Uint8Array }, w: number, h: number, metresPerPixel: number): string | null {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const { cls, cleaned } = classMap(d.assignment, w, h, d.classes, cleanOptions(metresPerPixel, d.overrides));
  const img = ctx.createImageData(w, h);
  const byCode: MapClass[] = ["ignore", "road", "walkable", "obstacle"];
  for (let i = 0; i < w * h; i++) img.data.set(cleaned[i] ? CLEANED_RGBA : CLASS_RGBA[byCode[cls[i] as number] ?? "ignore"], i * 4);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/** A notice that survives the remount after saving (saving selects the venue, which remounts the editor). */
let carriedNotice: { venueId: string; text: string } | null = null;

interface Target {
  kind: "local" | "server";
  venue: Venue;
}

type Drag =
  | { kind: "handle"; handle: Handle }
  | { kind: "move"; id: string; last: Point }
  | { kind: "pan"; startClient: { x: number; y: number }; startView: View }
  | { kind: "shape"; a: Point; b: Point }
  | { kind: "gate"; a: Point; b: Point }
  | { kind: "stroke"; path: Point[] };

const KIND_FILL: Record<AreaKind, string> = { walkable: "fill-[#faf9f6] dark:fill-[#1b1f27]", obstacle: "fill-[#d3d7de] dark:fill-[#2c323c]", destination: "fill-[#dcf3e8] dark:fill-[#123a2c]" };

export function VenueEditor({ venueId, server, onSaved }: { venueId: string; server: Server; onSaved: (venueId: string) => void }) {
  const known = knownVenues();
  const current = known.find((v) => v.id === venueId);
  const shared = server.shared.status === "ready" && server.shared.venue.id === venueId ? server.shared.venue : null;
  const readOnly = shared !== null && server.access?.kind !== "edit";

  const startTarget = (): Target => {
    if (shared) return { kind: "server", venue: shared.venue };
    if (current?.user) return { kind: "local", venue: current.venue };
    return { kind: "local", venue: blankVenue(newVenueId(), E.newName) };
  };
  const [target, setTarget] = useState<Target>(startTarget);
  const [history, setHistory] = useState<History<Venue>>(() => createHistory(target.venue));
  const venue = history.present;
  const [tool, setTool] = useState<Tool>("select");
  const [kind, setKind] = useState<AreaKind>("walkable");
  const [style, setStyle] = useState<Style>("paint");
  const [brush, setBrush] = useState(4);
  const [roadLanes, setRoadLanes] = useState(1);
  const [draft, setDraft] = useState<Point[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [view, setView] = useState<View>(() => bounds(target.venue));
  const [image, setImage] = useState<MapImage | null>(null);
  const [imageAlpha, setImageAlpha] = useState(0.8);
  const [tolerance, setTolerance] = useState(DEFAULT_TRACE.tolerance);
  const [detection, setDetection] = useState<Detection | null>(null);
  const [showDetection, setShowDetection] = useState(true);
  const [fixClass, setFixClass] = useState<MapClass>("ignore");
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ image: true, detection: true, walkable: true, obstacles: true, destinations: true, roads: true, parking: true, names: false, problems: true });
  const show = (l: Layer) => layers[l];
  const [calPoints, setCalPoints] = useState<Point[]>([]);
  const [calDistance, setCalDistance] = useState("100");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(() => {
    const n = carriedNotice;
    return n && n.venueId === target.venue.id ? { ok: true, text: n.text } : null;
  });
  const [validator, setValidator] = useState<SchemaValidator | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    carriedNotice = null; // shown once (cleared here, not in the initialiser, which StrictMode runs twice)
  }, []);
  useEffect(() => {
    let live = true;
    void loadVenueValidator().then((v) => live && setValidator(() => v));
    return () => {
      live = false;
    };
  }, []);
  // A map image kept for this venue in this browser.
  useEffect(() => {
    const id = target.venue.id;
    const url = id ? loadVenueImage(browserStore(), id) : null;
    if (!url) return;
    let live = true;
    void decodeImage(url, true).then(
      (img) => {
        if (live) setImage(img);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [target.venue.id]);

  const problems: VenueProblem[] | null = useMemo(() => (validator ? checkVenue(venue, validator) : null), [venue, validator]);

  const open = (t: Target) => {
    setTarget(t);
    setHistory(createHistory(t.venue));
    setView(bounds(t.venue));
    setDraft([]);
    setSelected(null);
    setMessage(null);
    setImage(null);
    setDetection(null);
  };

  const edit = (next: Venue, coalesce: string | null = null) => {
    if (readOnly) return;
    setHistory((h) => commit(h, next, coalesce));
    setMessage(null);
  };

  const toVenue = (e: { clientX: number; clientY: number }): Point => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const metresPerScreenPx = () => {
    const svg = svgRef.current;
    return svg ? Math.max(view.w / svg.clientWidth, view.h / svg.clientHeight) : 1;
  };

  const chooseTool = (t: Tool) => {
    setTool(t);
    setDraft([]);
    setCalPoints([]);
    setDrag(null);
  };

  /** Adds an area, joined with the shapes of the same kind it touches. */
  const addArea = (k: AreaKind, ring: readonly Point[]) => {
    const r = mergePolygon(venue, k, { outer: [...ring] }, Math.max(0.1, Math.min(0.5, metresPerScreenPx())));
    edit(r.venue);
    setSelected(r.id);
  };

  const finishPoints = () => {
    if (tool === "area" && draft.length >= 3) addArea(kind, draft);
    else if (tool === "road" && draft.length >= 2) {
      const r = addRoad(venue, draft, roadLanes);
      if (r) {
        edit(r.venue);
        setSelected(r.id);
      }
    } else return;
    setDraft([]);
  };

  // Calibration of the map image (venue = origin + pixel × metres per pixel).
  const cal = venue.background ? { metresPerPixel: venue.background.metresPerPixel, origin: venue.background.origin } : { metresPerPixel: 0.25, origin: { x: 0, y: 0 } };

  const pickImage = async (file: File | undefined) => {
    if (!file || !/^image\/(png|jpeg)$/.test(file.type)) return;
    const raw = URL.createObjectURL(file);
    try {
      const img = await decodeImage(raw, false);
      setImage(img);
      setDetection(null);
      // A first guess: the image about 300 m wide, top-left at the origin (calibrate next).
      const metresPerPixel = venue.background?.metresPerPixel ?? 300 / img.w;
      const next = { ...venue, background: { image: file.name.slice(0, 300), widthPx: img.w, heightPx: img.h, metresPerPixel, origin: venue.background?.origin ?? { x: 0, y: 0 } } };
      edit(next);
      setView(bounds(next));
      const kept = venue.id ? saveVenueImage(browserStore(), venue.id, img.url) : false;
      setMessage({ ok: kept, text: kept ? E.imageSaved : E.imageTooBig });
      chooseTool("calibrate");
    } catch {
      setMessage({ ok: false, text: E.importHint });
    } finally {
      URL.revokeObjectURL(raw);
    }
  };
  /** Replaces the drawing with an OpenStreetMap export (undo brings the old one back). */
  const pickOsm = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = osmToVenue(parseOsm(await file.text()), { id: venue.id as string, name: venue.name !== E.newName ? venue.name : undefined });
      edit(r.venue);
      setImage(null);
      setDetection(null);
      setSelected(null);
      setView(bounds(r.venue));
      chooseTool("select");
      setMessage({ ok: true, text: E.osmDone(r.report) });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof OsmError ? err.message : E.osmFailed });
    }
  };

  const removeImage = () => {
    setImage(null);
    setDetection(null);
    if (venue.id) removeVenueImage(browserStore(), venue.id);
    const rest: Venue = { ...venue };
    delete rest.background;
    edit(rest);
  };
  const applyCalibration = () => {
    if (calPoints.length !== 2 || !venue.background) return;
    const [a, b] = calPoints.map((p) => venueToPixel(cal, p)) as [ReturnType<typeof venueToPixel>, ReturnType<typeof venueToPixel>];
    const r = calibrate(a, b, Number(calDistance));
    if (!r.ok) {
      setMessage({ ok: false, text: E.calibrationError[r.reason] ?? r.reason });
      return;
    }
    // Shapes already drawn stay on the same spot of the image.
    const scaled = scaleVenue(venue, r.metresPerPixel / cal.metresPerPixel, cal.origin);
    const next = { ...scaled, background: { ...venue.background, metresPerPixel: r.metresPerPixel, origin: cal.origin } };
    edit(next);
    setView(bounds(next));
    setCalPoints([]);
    setMessage({ ok: true, text: E.calibrated(r.metresPerPixel) });
    chooseTool("select");
  };

  const trace = (p: Point) => {
    if (!image || !venue.background) {
      setMessage({ ok: false, text: E.hint.noImage as string });
      return;
    }
    const r = traceRegion(image.pixels, image.w, image.h, venueToPixel(cal, p), { ...DEFAULT_TRACE, tolerance });
    if (!r.ok) {
      setMessage({ ok: false, text: E.traceError[r.reason] ?? r.reason });
      return;
    }
    addArea(
      kind,
      r.ring.map((q) => pixelToVenue(cal, q)),
    );
    setMessage({ ok: true, text: E.traced(r.ring.length) });
  };

  const runDetection = () => {
    if (!image || !venue.background) {
      setMessage({ ok: false, text: E.hint.noImage as string });
      return;
    }
    const { clusters, assignment } = clusterColours(image.pixels, image.w, image.h);
    const classes = clusters.map((c) => c.guess);
    const overrides = new Uint8Array(image.w * image.h).fill(NO_OVERRIDE);
    setDetection({ clusters, assignment, classes, overrides, preview: detectionPreview({ assignment, classes, overrides }, image.w, image.h, cal.metresPerPixel) });
    setShowDetection(true);
  };
  const setClass = (index: number, c: MapClass) => {
    if (!detection || !image) return;
    const classes = detection.classes.map((x, k) => (k === index ? c : x));
    setDetection({ ...detection, classes, preview: detectionPreview({ assignment: detection.assignment, classes, overrides: detection.overrides }, image.w, image.h, cal.metresPerPixel) });
  };
  const applyDetected = () => {
    if (!detection || !image) return;
    const r = applyDetection(venue, detection.assignment, image.w, image.h, detection.classes, cal.origin, cal.metresPerPixel, detection.overrides);
    edit(r.venue);
    setDetection(null);
    if (tool === "fix") chooseTool("select");
    setMessage({ ok: true, text: E.applied(r.walkable, r.obstacles, r.roads) });
  };

  /** Paints a correction stroke (venue path, brush metres) into the detection's overrides, in image pixels. */
  const paintCorrection = (path: readonly Point[]) => {
    if (!detection || !image) return;
    const overrides = detection.overrides.slice();
    const r = brush / 2 / cal.metresPerPixel;
    const code = CLASS_CODE[fixClass];
    const disc = (cx: number, cy: number) => {
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(image.h - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(image.w - 1, Math.ceil(cx + r)); x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) overrides[y * image.w + x] = code;
    };
    const px = path.map((q) => venueToPixel(cal, q));
    px.forEach((q, k) => {
      const prev = px[k - 1] ?? q;
      const n = Math.max(1, Math.ceil(Math.hypot(q.px - prev.px, q.py - prev.py) / Math.max(1, r / 2)));
      for (let t = 1; t <= n; t++) disc(prev.px + ((q.px - prev.px) * t) / n, prev.py + ((q.py - prev.py) * t) / n);
    });
    setDetection({ ...detection, overrides, preview: detectionPreview({ assignment: detection.assignment, classes: detection.classes, overrides }, image.w, image.h, cal.metresPerPixel) });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const p = toVenue(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (readOnly || tool === "select" || e.button === 1) {
      if (!readOnly && e.button === 0) {
        // A handle within 8 screen pixels, else the element under the pointer.
        let best: Handle | null = null;
        let bestD = 8 * metresPerScreenPx();
        for (const h of handles(venue)) {
          const d = Math.hypot(h.point.x - p.x, h.point.y - p.y);
          if (d < bestD) {
            bestD = d;
            best = h.handle;
          }
        }
        if (best && (selected === best.id || (best.kind !== "vertex" && best.kind !== "roadPoint"))) {
          setSelected(best.id);
          setDrag({ kind: "handle", handle: best });
          return;
        }
        const id = nearLineElement(venue, p, 10 * metresPerScreenPx()) ?? elementAt(venue, p);
        if (id) {
          setSelected(id);
          setDrag({ kind: "move", id, last: p });
          return;
        }
        setSelected(null);
      }
      setDrag({ kind: "pan", startClient: { x: e.clientX, y: e.clientY }, startView: view });
      return;
    }
    if (isShape(tool)) setDrag({ kind: "shape", a: p, b: p });
    else if (tool === "fix" || tool === "eraser" || (tool === "area" && style === "paint") || (tool === "road" && style === "paint")) setDrag({ kind: "stroke", path: [p] });
    else if (tool === "area" || tool === "road") setDraft((d) => [...d, p]);
    else if (tool === "source") {
      const r = addSource(venue, p);
      edit(r.venue);
      setSelected(r.id);
    } else if (tool === "gate") {
      if (draft.length === 1) {
        const r = addGate(venue, draft[0] as Point, p);
        edit(r.venue);
        setSelected(r.id);
        setDraft([]);
      } else setDrag({ kind: "gate", a: p, b: p });
    } else if (tool === "calibrate") {
      if (image) setCalPoints((c) => (c.length >= 2 ? [p] : [...c, p]));
      else setMessage({ ok: false, text: E.hint.noImage as string });
    } else if (tool === "trace") trace(p);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toVenue(e);
    setHover(p);
    if (!drag) return;
    if (drag.kind === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const k = Math.max(drag.startView.w / svg.clientWidth, drag.startView.h / svg.clientHeight);
      setView({ ...drag.startView, x: drag.startView.x - (e.clientX - drag.startClient.x) * k, y: drag.startView.y - (e.clientY - drag.startClient.y) * k });
      return;
    }
    if (drag.kind === "handle") edit(moveHandle(venue, drag.handle, p), `drag:${JSON.stringify(drag.handle)}`);
    else if (drag.kind === "move") {
      edit(moveElement(venue, drag.id, p.x - drag.last.x, p.y - drag.last.y), `move:${drag.id}`);
      setDrag({ ...drag, last: p });
    } else if (drag.kind === "stroke") {
      const last = drag.path[drag.path.length - 1] as Point;
      if (Math.hypot(p.x - last.x, p.y - last.y) > metresPerScreenPx() * 2) setDrag({ kind: "stroke", path: [...drag.path, p] });
    } else setDrag({ ...drag, b: p });
  };

  const onPointerUp = () => {
    if (drag?.kind === "shape" && isShape(tool)) {
      const a = drag.a;
      const b = drag.b;
      if (Math.abs(a.x - b.x) >= 0.5 && Math.abs(a.y - b.y) >= 0.5) addArea(kind, shapePoints(tool, a, b));
    } else if (drag?.kind === "gate") {
      if (Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y) > 1) {
        const r = addGate(venue, drag.a, drag.b);
        edit(r.venue);
        setSelected(r.id);
      } else setDraft([drag.a]);
    } else if (drag?.kind === "stroke") {
      if (tool === "fix") paintCorrection(drag.path);
      else if (tool === "road") {
        // A freehand road: the stroke simplified to a centreline.
        const line = simplifyPath(
          drag.path.map((q) => ({ px: q.x, py: q.y })),
          Math.max(0.5, metresPerScreenPx() * 3),
        ).map((q) => ({ x: q.px, y: q.py }));
        const r = addRoad(venue, line, roadLanes);
        if (r) {
          edit(r.venue);
          setSelected(r.id);
        }
      } else {
        const r = paintPath(venue, kind, drag.path, brush / 2, tool === "eraser");
        edit(r.venue);
        setSelected(tool === "eraser" ? null : r.id);
      }
    }
    setDrag(null);
  };

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const p = toVenue(e);
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setView((v) => ({ x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f }));
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    } else if (mod && key === "y") {
      e.preventDefault();
      setHistory(redo);
    } else if (e.key === "Enter" && !typing) finishPoints();
    else if (e.key === "Escape") {
      setDraft([]);
      setCalPoints([]);
      setDrag(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
      edit(deleteElement(venue, selected));
      setSelected(null);
    } else if (!typing && !mod && !readOnly && KEY_TO_TOOL[key]) chooseTool(KEY_TO_TOOL[key] as Tool);
  };

  const save = async () => {
    if (!problems || hasErrors(problems)) {
      setMessage({ ok: false, text: E.blocked });
      return;
    }
    if (target.kind === "server" && shared && server.access) {
      try {
        await server.client.updateVenue(shared.id, venue, shared.etag, server.access);
        await server.reload();
        setMessage({ ok: true, text: E.savedServer });
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const ok = storeUserVenue(venue);
    setMessage(ok ? { ok: true, text: E.saved(venue.name) } : { ok: false, text: E.storageFailed });
    if (ok) {
      carriedNotice = { venueId: venue.id as string, text: E.saved(venue.name) };
      onSaved(venue.id as string);
    }
  };

  const problemList = problems ?? [];
  const anchors = new Map<string, Point>();
  for (const p of problemList) if (p.elementId && !anchors.has(p.elementId)) {
    const a = anchorOf(venue, p.elementId);
    if (a) anchors.set(p.elementId, a);
  }
  const focus = (id: string) => {
    if (!id) return;
    setSelected(id);
    const a = anchors.get(id) ?? anchorOf(venue, id);
    const poly = polygonOf(venue, id);
    if (!a) return;
    const xs = poly ? poly.ring.map((q) => q.x) : [a.x];
    const ys = poly ? poly.ring.map((q) => q.y) : [a.y];
    const w = Math.max(30, (Math.max(...xs) - Math.min(...xs)) * 2.2);
    const h = Math.max(20, (Math.max(...ys) - Math.min(...ys)) * 2.2);
    setView({ x: a.x - w / 2, y: a.y - h / 2, w, h });
  };
  const fixCount = (f: NonNullable<VenueProblem["fix"]>) => problemList.filter((p) => p.fix === f).length;

  const zoom = (f: number) => setView((v) => ({ x: v.x + (v.w * (1 - f)) / 2, y: v.y + (v.h * (1 - f)) / 2, w: v.w * f, h: v.h * f }));
  const stroke = view.w / 500;
  const paintsArea = tool === "fix" || tool === "eraser" || (tool === "area" && style === "paint");
  const hint =
    tool === "select"
      ? E.hint.select
      : isShape(tool)
        ? E.hint.shape
        : tool === "area"
          ? style === "paint"
            ? E.hint.areaPaint
            : E.hint.areaPoints
          : tool === "road"
            ? style === "paint"
              ? E.hint.roadPaint
              : E.hint.roadPoints
            : tool === "fix"
              ? E.fixHint
              : (E.hint[tool] ?? "");
  const others = known.filter((v) => !v.remote && v.id !== target.venue.id);
  const polySel = selected ? polygonOf(venue, selected) : null;
  const gateSel = selected ? venue.gateGroups.find((g) => g.id === selected) : undefined;
  const roadSel = selected ? (venue.roads ?? []).find((r) => r.id === selected) : undefined;
  const elementRows: { list: string; id: string; name: string }[] = [
    ...venue.walkableAreas.map((e) => ({ list: "walkableAreas", id: e.id, name: e.name ?? e.id })),
    ...venue.obstacles.map((e) => ({ list: "obstacles", id: e.id, name: e.name ?? e.id })),
    ...venue.sources.map((e) => ({ list: "sources", id: e.id, name: e.name })),
    ...venue.screeningStages.map((e) => ({ list: "screeningStages", id: e.id, name: e.name })),
    ...venue.gateGroups.map((e) => ({ list: "gateGroups", id: e.id, name: e.name })),
    ...venue.destinations.map((e) => ({ list: "destinations", id: e.id, name: e.name })),
    ...(venue.roads ?? []).map((e) => ({ list: "roads", id: e.id, name: e.name ?? e.id })),
    ...(venue.parkingLots ?? []).map((e) => ({ list: "parkingLots", id: e.id, name: e.name })),
  ];
  const selRow = elementRows.find((r) => r.id === selected);
  const rename = (list: string, id: string, name: string) => {
    const l = (venue as unknown as Record<string, { id: string; name?: string }[]>)[list];
    if (l) edit({ ...venue, [list]: l.map((e) => (e.id === id ? { ...e, name } : e)) } as Venue, `rename:${id}`);
  };
  const setLanes = (id: string, value: string) => {
    const n = Math.max(1, Math.min(64, Math.round(Number(value) || 1)));
    edit({ ...venue, gateGroups: venue.gateGroups.map((g) => (g.id === id ? { ...g, laneCount: n } : g)) });
  };
  const updateRoad = (id: string, patch: Partial<NonNullable<Venue["roads"]>[number]>) => edit({ ...venue, roads: (venue.roads ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const preview = drag?.kind === "shape" && isShape(tool) ? shapePoints(tool, drag.a, drag.b) : null;
  const usesStyle = tool === "area" || tool === "road";

  const toolButton = (t: Tool) => (
    <button
      key={t}
      type="button"
      className={`flex h-8 w-full items-center justify-between rounded-md px-2.5 text-sm font-medium transition-colors ${tool === t ? "bg-accent text-accent-fg" : "text-fg hover:bg-sunken"} disabled:opacity-45`}
      aria-pressed={tool === t}
      aria-keyshortcuts={E.shortcut[t]}
      disabled={readOnly && t !== "select"}
      onClick={() => chooseTool(t)}
    >
      {E.tool[t]}
      <kbd aria-hidden="true" className={`font-mono text-[10px] ${tool === t ? "text-accent-fg/70" : "text-subtle"}`}>
        {E.shortcut[t]}
      </kbd>
    </button>
  );
  const group = (title: string, children: ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <p className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">{title}</p>
      {children}
    </div>
  );
  const segmented = <T extends string>(label: string, options: readonly T[], value: T, set: (v: T) => void, text: Record<string, string>) => (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <p className="px-0.5 text-[11px] font-medium tracking-wide text-subtle uppercase">{label}</p>
      <div className="grid gap-0.5 rounded-md bg-sunken p-0.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} disabled={readOnly} onClick={() => set(o)} className={`h-7 rounded text-xs font-medium ${value === o ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}>
            {text[o]}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col lg:flex-row" onKeyDown={onKeyDown}>
      {/* Left: venue and tools. */}
      <aside className="flex shrink-0 flex-col gap-4 overflow-y-auto border-line bg-surface p-3 scroll-thin lg:w-56 lg:border-r">
        <h2 className="sr-only">{E.heading}</h2>
        <div className="flex flex-col gap-2">
          <label className={labelText}>
            {E.name}
            <input aria-label={E.name} className={input} value={venue.name} disabled={readOnly} onChange={(e) => edit({ ...venue, name: e.target.value }, "rename:venue")} />
          </label>
          {!shared && (
            <select
              aria-label={E.startFrom}
              className={`${select} text-xs`}
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id === "__blank") open({ kind: "local", venue: blankVenue(newVenueId(), E.newName) });
                const k = known.find((v) => v.id === id);
                if (k) open({ kind: "local", venue: k.user ? k.venue : { ...k.venue, id: newVenueId(), name: `${k.venue.name}${E.copySuffix}` } });
              }}
            >
              <option value="">{E.editing(venue.name)}</option>
              <option value="__blank">{E.blank}</option>
              {others.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.user ? v.title : E.copyOf(v.title)}
                </option>
              ))}
            </select>
          )}
          {readOnly && <p className="text-xs text-bad">{E.readOnly}</p>}
        </div>

        {segmented(E.drawAs, AREA_KINDS, kind, setKind, E.kinds3)}
        {segmented(E.style, ["points", "paint"] as const, style, setStyle, E.styles)}
        {paintsArea && (
          <label className={`${labelText} -mt-2 px-0.5`}>
            {E.brush}: {brush} m
            <input type="range" min={1} max={30} step={0.5} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          </label>
        )}
        {tool === "road" && (
          <label className={`${labelText} -mt-2 px-0.5`}>
            {E.roadLanes}: {roadLanes}
            <input type="range" min={1} max={4} value={roadLanes} onChange={(e) => setRoadLanes(Number(e.target.value))} />
          </label>
        )}

        <div role="toolbar" aria-label={E.groups.shapes} className="flex flex-col gap-3">
          {toolButton("select")}
          {group(E.groups.draw, (["area", "eraser"] as const).map(toolButton))}
          {group(E.groups.shapes, SHAPE_TOOLS.map(toolButton))}
          {group(E.groups.points, (["source", "gate"] as const).map(toolButton))}
          {group(E.groups.cars, toolButton("road"))}
          {group(
            E.groups.map,
            <>
              <label className={`${btnPrimary} w-full cursor-pointer ${readOnly ? "pointer-events-none opacity-45" : ""}`} title={E.osmHint}>
                {E.osmImport}
                <input type="file" accept=".osm,.xml,application/xml,text/xml" className="sr-only" aria-label={E.osmImport} disabled={readOnly} onChange={(e) => void pickOsm(e.target.files?.[0])} />
              </label>
              <label className={`${btn} w-full cursor-pointer ${readOnly ? "pointer-events-none opacity-45" : ""}`} title={E.importHint}>
                {E.importImage}
                <input type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={E.importImage} disabled={readOnly} onChange={(e) => void pickImage(e.target.files?.[0])} />
              </label>
              {toolButton("calibrate")}
              <button type="button" className={`${btn} w-full`} disabled={readOnly || !image} onClick={runDetection} title={E.detectHint}>
                {E.detect}
              </button>
              {toolButton("trace")}
              {tool === "trace" && (
                <label className={`${labelText} px-2.5 pt-1`}>
                  {E.tolerance}
                  <input type="range" min={4} max={90} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
                </label>
              )}
              {image && (
                <div className="flex items-end gap-2 px-2.5 pt-1">
                  <label className={`${labelText} flex-1`}>
                    {E.imageOpacity}
                    <input type="range" min={0.1} max={1} step={0.05} value={imageAlpha} onChange={(e) => setImageAlpha(Number(e.target.value))} />
                  </label>
                  <button type="button" className={btnSmall} onClick={removeImage} disabled={readOnly}>
                    {E.removeImage}
                  </button>
                </div>
              )}
            </>,
          )}
        </div>
      </aside>

      {/* Centre: the drawing. */}
      <section className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden bg-map lg:min-h-0">
        <svg
          ref={svgRef}
          role="img"
          aria-label={E.canvas}
          data-testid="venue-canvas"
          className={`absolute inset-0 h-full w-full touch-none select-none ${tool === "select" ? (drag?.kind === "pan" ? "cursor-grabbing" : "cursor-default") : paintsArea ? "cursor-none" : "cursor-crosshair"}`}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onPointerCancel={() => setDrag(null)}
          onWheel={onWheel}
          onDoubleClick={finishPoints}
        >
          <defs>
            <pattern id="obstacle-hatch" patternUnits="userSpaceOnUse" width={stroke * 8} height={stroke * 8} patternTransform="rotate(45)">
              <rect width={stroke * 8} height={stroke * 8} className="fill-[#e2e8f0] dark:fill-[#334155]" />
              <line x1="0" y1="0" x2="0" y2={stroke * 8} className="stroke-[#64748b] dark:stroke-[#94a3b8]" strokeWidth={stroke * 2.2} />
            </pattern>
          </defs>
          {show("image") && image && venue.background && <image href={image.url} x={venue.background.origin.x} y={venue.background.origin.y} width={image.w * venue.background.metresPerPixel} height={image.h * venue.background.metresPerPixel} opacity={imageAlpha} preserveAspectRatio="none" />}
          {detection?.preview && showDetection && show("detection") && venue.background && image && <image href={detection.preview} x={venue.background.origin.x} y={venue.background.origin.y} width={image.w * venue.background.metresPerPixel} height={image.h * venue.background.metresPerPixel} preserveAspectRatio="none" style={{ imageRendering: "pixelated" }} />}
          {/* Roads under everything people use. */}
          {show("roads") && (venue.roads ?? []).map((r) => (
            <g key={r.id}>
              <path d={linePath(r.points)} fill="none" stroke="#111827" strokeWidth={r.laneCount * LANE_WIDTH * (r.direction === "twoWay" ? 2 : 1) + stroke * 3} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
              <path d={linePath(r.points)} fill="none" stroke="#4b5563" strokeWidth={r.laneCount * LANE_WIDTH * (r.direction === "twoWay" ? 2 : 1)} strokeLinecap="round" strokeLinejoin="round" />
              {r.direction === "twoWay" && <path d={linePath(r.points)} fill="none" stroke="#f8fafc" strokeWidth={stroke * 1.2} strokeDasharray={`${stroke * 8} ${stroke * 6}`} opacity={0.9} />}
              {selected === r.id && <path d={linePath(r.points)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2.5} />}
            </g>
          ))}
          {/* Walkable: teal; destinations: green; obstacles: grey hatching. Strong outlines, so each shape stands out over a map image. */}
          {show("walkable") &&
            venue.walkableAreas.map((w) => (
              <path key={w.id} d={polyPath(w.polygon)} fillRule="evenodd" className="fill-[#99f6e4] stroke-[#0d9488] dark:fill-[#115e59]" fillOpacity={image && show("image") ? 0.45 : 0.85} strokeWidth={stroke * 2} strokeLinejoin="round" />
            ))}
          {show("destinations") &&
            venue.destinations.map((d) => (
              <path key={d.id} d={polyPath(d.area)} fillRule="evenodd" className="fill-[#86efac] stroke-[#15803d] dark:fill-[#14532d]" fillOpacity={image && show("image") ? 0.6 : 0.9} strokeWidth={stroke * 2} />
            ))}
          {show("obstacles") &&
            venue.obstacles.map((o) => (
              <path key={o.id} d={polyPath(o.polygon)} fillRule="evenodd" fill="url(#obstacle-hatch)" className="stroke-[#334155] dark:stroke-[#cbd5e1]" fillOpacity={image && show("image") ? 0.8 : 1} strokeWidth={stroke * 1.6} />
            ))}
          {/* Car parks: outline, aisles, stalls, barriers (green entry, red exit), car sources. */}
          {show("parking") &&
            (venue.parkingLots ?? []).map((l) => (
              <g key={l.id}>
                <path d={polyPath(l.outline)} fill="#fde68a" fillOpacity={0.55} stroke="#b45309" strokeWidth={stroke * 1.8} strokeDasharray={`${stroke * 6} ${stroke * 3}`} />
                {l.aisles.map((a, k) => (
                  <path key={k} d={linePath(a.points)} fill="none" stroke="#9ca3af" strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
                ))}
                {(l.stallRows ?? []).flatMap((r, k) => stallRects(r).map((q, j) => <polygon key={`${k}-${j}`} points={pts(q)} fill="#fffbeb" stroke="#92400e" strokeWidth={stroke * 0.6} />))}
                <circle cx={l.walkingExit.x} cy={l.walkingExit.y} r={stroke * 5} fill="#0d9488" stroke="#fff" strokeWidth={stroke} />
              </g>
            ))}
          {show("parking") &&
            (venue.vehicleBarriers ?? []).map((b) => (
              <rect key={b.id} x={b.position.x - 2} y={b.position.y - 2} width={4} height={4} rx={0.8} fill={b.kind === "entry" ? "#16a34a" : "#dc2626"} stroke="#fff" strokeWidth={stroke}>
                <title>{b.name}</title>
              </rect>
            ))}
          {show("parking") &&
            (venue.vehicleSources ?? []).map((v) => (
              <g key={v.id}>
                <circle cx={v.position.x} cy={v.position.y} r={stroke * 9} fill="#f59e0b" opacity={0.25} />
                <circle cx={v.position.x} cy={v.position.y} r={stroke * 4} fill="#d97706">
                  <title>{v.name}</title>
                </circle>
              </g>
            ))}
          {show("names") &&
            [...venue.walkableAreas.map((e) => ({ id: e.id, name: e.name ?? e.id, ring: e.polygon.outer })), ...venue.obstacles.map((e) => ({ id: e.id, name: e.name ?? e.id, ring: e.polygon.outer })), ...venue.destinations.map((e) => ({ id: e.id, name: e.name, ring: e.area.outer }))].map((e) => {
              const c = centroidOf(e.ring);
              return (
                <text key={`name-${e.id}`} x={c.x} y={c.y} fontSize={stroke * 11} textAnchor="middle" dominantBaseline="middle" className="fill-[#0f172a] stroke-white dark:fill-white dark:stroke-black" strokeWidth={stroke * 2.5} paintOrder="stroke" pointerEvents="none">
                  {e.name}
                </text>
              );
            })}
          {[...venue.screeningStages, ...venue.gateGroups].map((g) => (
            <g key={g.id}>
              <line x1={g.line.a.x} y1={g.line.a.y} x2={g.line.b.x} y2={g.line.b.y} className="stroke-[#2b2f36] dark:stroke-[#cbd5e1]" strokeWidth={stroke * 2.5} strokeLinecap="round" />
              {Array.from({ length: g.laneCount }, (_, k) => {
                const t = (k + 0.5) / g.laneCount;
                return <circle key={k} cx={g.line.a.x + (g.line.b.x - g.line.a.x) * t} cy={g.line.a.y + (g.line.b.y - g.line.a.y) * t} r={stroke * 2.2} fill="#15803d" />;
              })}
            </g>
          ))}
          {venue.sources.map((s) => (
            <g key={s.id}>
              <circle cx={s.position.x} cy={s.position.y} r={stroke * 9} fill="#2563eb" opacity={0.15} />
              <circle cx={s.position.x} cy={s.position.y} r={stroke * 3.5} fill="#2563eb" />
            </g>
          ))}
          {/* Problems: the shape outlined (red for errors, amber for warnings) and a numbered marker, like the list. */}
          {show("problems") &&
            problemList.map((p, k) => {
              if (!p.elementId) return null;
              const a = anchors.get(p.elementId);
              const poly = polygonOf(venue, p.elementId);
              const color = p.severity === "error" ? "#dc2626" : "#d97706";
              return (
                <g key={`problem-${k}`} className="cursor-pointer" onPointerDown={(ev) => {
                  ev.stopPropagation();
                  focus(p.elementId);
                }}>
                  {poly && <polygon points={pts(poly.ring)} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={stroke * 2.5} strokeDasharray={`${stroke * 6} ${stroke * 3}`} />}
                  {a && (
                    <>
                      <circle cx={a.x} cy={a.y} r={stroke * 7} fill={color} stroke="#fff" strokeWidth={stroke * 1.5} />
                      <text x={a.x} y={a.y} fontSize={stroke * 8} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill="#fff" pointerEvents="none">
                        {k + 1}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          {polySel && <polygon points={pts(polySel.ring)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2.5} />}
          {gateSel && <line x1={gateSel.line.a.x} y1={gateSel.line.a.y} x2={gateSel.line.b.x} y2={gateSel.line.b.y} stroke="#f59e0b" strokeWidth={stroke * 5} strokeLinecap="round" opacity={0.6} />}
          {preview && <polygon points={pts(preview)} className={KIND_FILL[kind]} stroke="#f59e0b" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 5} ${stroke * 3}`} opacity={0.85} />}
          {drag?.kind === "gate" && <line x1={drag.a.x} y1={drag.a.y} x2={drag.b.x} y2={drag.b.y} stroke="#f59e0b" strokeWidth={stroke * 2.5} strokeDasharray={`${stroke * 5} ${stroke * 3}`} />}
          {drag?.kind === "stroke" &&
            (tool === "road" ? (
              <path d={linePath(drag.path)} fill="none" stroke="#6b7280" strokeWidth={roadLanes * LANE_WIDTH * 2} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
            ) : (
              <path d={linePath(drag.path)} fill="none" stroke={tool === "eraser" ? "#ef4444" : "#f59e0b"} strokeWidth={brush} strokeLinecap="round" strokeLinejoin="round" opacity={0.45} />
            ))}
          {draft.length > 0 &&
            (tool === "road" ? (
              <path d={linePath(hover ? [...draft, hover] : draft)} fill="none" stroke="#6b7280" strokeWidth={roadLanes * LANE_WIDTH * 2} strokeLinecap="round" strokeLinejoin="round" opacity={0.6} />
            ) : (
              <polyline points={pts(hover ? [...draft, hover] : draft)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 5} ${stroke * 3}`} />
            ))}
          {draft.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 3} fill="#f59e0b" />
          ))}
          {calPoints.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 4} fill="none" stroke="#dc2626" strokeWidth={stroke * 2} />
          ))}
          {calPoints.length === 2 && <line x1={calPoints[0]?.x} y1={calPoints[0]?.y} x2={calPoints[1]?.x} y2={calPoints[1]?.y} stroke="#dc2626" strokeWidth={stroke * 1.5} />}
          {paintsArea && hover && <circle cx={hover.x} cy={hover.y} r={brush / 2} fill="none" stroke={tool === "eraser" ? "#ef4444" : "#f59e0b"} strokeWidth={stroke * 1.5} />}
          {tool === "select" &&
            !readOnly &&
            handles(venue)
              .filter((h) => (h.handle.kind !== "vertex" && h.handle.kind !== "roadPoint") || h.handle.id === selected)
              .map((h, k) => <rect key={k} x={h.point.x - stroke * 3} y={h.point.y - stroke * 3} width={stroke * 6} height={stroke * 6} fill="#fff" stroke="#334155" strokeWidth={stroke} />)}
        </svg>

        {/* Top: history, view and the tool's hint. */}
        <div className={`${overlay} absolute top-3 left-3 flex items-center gap-0.5 p-1`}>
          <button type="button" className={btnGhost} disabled={!canUndo(history) || readOnly} onClick={() => setHistory(undo)} aria-keyshortcuts="Control+Z">
            {E.undo}
          </button>
          <button type="button" className={btnGhost} disabled={!canRedo(history) || readOnly} onClick={() => setHistory(redo)} aria-keyshortcuts="Control+Y">
            {E.redo}
          </button>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <button type="button" className={btnGhost} onClick={() => zoom(0.8)} aria-label={E.zoomIn}>
            +
          </button>
          <button type="button" className={btnGhost} onClick={() => zoom(1.25)} aria-label={E.zoomOut}>
            −
          </button>
          <button type="button" className={btnGhost} onClick={() => setView(bounds(venue))}>
            {E.fit}
          </button>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <details className="relative">
            <summary className={`${btnGhost} cursor-pointer list-none`}>{E.layers}</summary>
            <div className={`${overlay} absolute top-10 left-0 z-10 flex w-56 flex-col gap-1 p-3 text-xs`}>
              {LAYERS.map((l) => (
                <label key={l} className="flex items-center gap-2">
                  <input type="checkbox" checked={layers[l]} onChange={(e) => setLayers((cur) => ({ ...cur, [l]: e.target.checked }))} />
                  <span className={`inline-block size-3 shrink-0 rounded-sm border ${LAYER_SWATCH[l]}`} aria-hidden="true" />
                  {E.layerNames[l]}
                </label>
              ))}
            </div>
          </details>
        </div>
        <p className={`${overlay} pointer-events-none absolute top-3 right-3 max-w-[22rem] px-3 py-1.5 text-xs text-muted`} aria-live="polite">
          {hint}
          {usesStyle && style === "points" && draft.length > 0 && ` (${draft.length})`}
        </p>
        {usesStyle && style === "points" && draft.length > 0 && (
          <div className={`${overlay} absolute bottom-3 left-3 flex gap-2 p-2`}>
            <button type="button" className={btnSmall} disabled={draft.length < (tool === "road" ? 2 : 3)} onClick={finishPoints}>
              {E.finish}
            </button>
            <button type="button" className={btnSmall} onClick={() => setDraft([])}>
              {E.cancel}
            </button>
          </div>
        )}
        {tool === "calibrate" && image && (
          <div className={`${overlay} absolute bottom-3 left-3 flex items-end gap-2 p-2`}>
            <label className={labelText}>
              {E.distance}
              <input aria-label={E.distance} className={`${input} w-24`} type="number" min={0} step="any" value={calDistance} onChange={(e) => setCalDistance(e.target.value)} />
            </label>
            <button type="button" className={btnPrimary} disabled={calPoints.length !== 2} onClick={applyCalibration}>
              {E.applyCalibration}
            </button>
          </div>
        )}
        {message && (
          <p className={`${overlay} absolute right-3 bottom-3 max-w-sm px-3 py-2 text-sm ${message.ok ? "text-ok" : "text-bad"}`} role={message.ok ? "status" : "alert"}>
            {message.text}
          </p>
        )}
      </section>

      {/* Right: detection, the selected element, checks and saving, all elements. */}
      <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-line bg-canvas p-3 scroll-thin lg:w-80 lg:border-l [&>*]:shrink-0">
        {detection && (
          <section className={`${card} p-3.5`} aria-labelledby="editor-detect">
            <div className="flex items-center gap-1.5">
              <h3 id="editor-detect" className={cardTitle}>
                {E.detectHeading}
              </h3>
              <InfoTip text={E.detectIntro} />
            </div>
            <ul className="mt-2 flex flex-col gap-1.5" data-testid="detected-colours">
              {detection.clusters.map((c) => (
                <li key={c.index} className="flex items-center gap-2 text-xs">
                  <span className="size-5 shrink-0 rounded border border-line" style={{ background: `rgb(${c.rgb.join(",")})` }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={`${c.label} · ${Math.round(c.share * 100)}%`}>
                    {c.label} <span className="text-subtle tabular">{Math.round(c.share * 100)}%</span>
                  </span>
                  <select aria-label={`${c.label} ${c.index + 1}`} className={`${select} h-7 px-1 text-xs`} value={detection.classes[c.index]} onChange={(e) => setClass(c.index, e.target.value as MapClass)}>
                    {CLASSES.map((k) => (
                      <option key={k} value={k}>
                        {E.classes[k]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showDetection} onChange={(e) => setShowDetection(e.target.checked)} />
              {E.showDetection}
            </label>
            <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-medium text-fg">{E.fixHeading}</p>
                <InfoTip text={E.fixIntro} />
              </div>
              <div role="group" aria-label={E.fixHeading} className="grid grid-cols-4 gap-0.5 rounded-md bg-sunken p-0.5">
                {CLASSES.map((c) => (
                  <button key={c} type="button" aria-pressed={fixClass === c} onClick={() => setFixClass(c)} className={`h-7 rounded text-[11px] font-medium ${fixClass === c ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}>
                    {E.classes[c]}
                  </button>
                ))}
              </div>
              <button type="button" className={tool === "fix" ? btnPrimary : btn} aria-pressed={tool === "fix"} onClick={() => chooseTool(tool === "fix" ? "select" : "fix")}>
                {E.fixPaint}
              </button>
              {tool === "fix" && (
                <label className={labelText}>
                  {E.brush}: {brush} m
                  <input type="range" min={1} max={30} step={0.5} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
                </label>
              )}
              <p className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className="inline-block size-3 rounded-sm" style={{ background: "rgb(217 70 239)" }} aria-hidden="true" />
                {E.cleanedKey}
              </p>
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" className={btnPrimary} onClick={applyDetected}>
                {E.applyDetection}
              </button>
              <button type="button" className={btn} onClick={() => setDetection(null)}>
                {E.cancel}
              </button>
            </div>
          </section>
        )}

        <section className={`${card} p-3.5`} aria-labelledby="editor-selected">
          <h3 id="editor-selected" className={cardTitle}>
            {E.selected}
          </h3>
          {!selRow ? (
            <p className="mt-1 text-xs text-muted">{E.nothingSelected}</p>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <label className={labelText}>
                {E.kinds[selRow.list]}
                <input className={input} value={selRow.name} disabled={readOnly} onChange={(e) => rename(selRow.list, selRow.id, e.target.value)} />
              </label>
              {polySel && (
                <div className={labelText}>
                  {E.kindLabel}
                  <div className="grid grid-cols-3 gap-0.5 rounded-md bg-sunken p-0.5">
                    {AREA_KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={polySel.kind === k}
                        disabled={readOnly}
                        onClick={() => {
                          const r = changeKind(venue, selRow.id, k);
                          edit(r.venue);
                          setSelected(r.id);
                        }}
                        className={`h-7 rounded text-xs font-medium ${polySel.kind === k ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
                      >
                        {E.kinds3[k]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {gateSel && (
                <label className={labelText}>
                  {E.lanes}
                  <input className={`${input} w-20`} type="number" min={1} max={64} disabled={readOnly} value={gateSel.laneCount} onChange={(e) => setLanes(gateSel.id, e.target.value)} />
                </label>
              )}
              {roadSel && (
                <div className="flex flex-wrap items-end gap-3">
                  <label className={labelText}>
                    {E.roadLanes}
                    <input className={`${input} w-16`} type="number" min={1} max={4} disabled={readOnly} value={roadSel.laneCount} onChange={(e) => updateRoad(roadSel.id, { laneCount: Math.max(1, Math.min(4, Math.round(Number(e.target.value) || 1))) })} />
                  </label>
                  <label className="flex h-8 items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={roadSel.publicRoad ?? false} disabled={readOnly} onChange={(e) => updateRoad(roadSel.id, { publicRoad: e.target.checked })} />
                    {E.publicRoad}
                  </label>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnSmall}
                  disabled={readOnly || !!roadSel}
                  onClick={() => {
                    const r = duplicateElement(venue, selRow.id);
                    if (r) {
                      edit(r.venue);
                      setSelected(r.id);
                    }
                  }}
                >
                  {E.duplicate}
                </button>
                <button
                  type="button"
                  className={btnSmall}
                  disabled={readOnly}
                  onClick={() => {
                    edit(deleteElement(venue, selRow.id));
                    setSelected(null);
                  }}
                >
                  {E.delete}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className={`${card} p-3.5`} aria-labelledby="editor-problems">
          <h3 id="editor-problems" className={cardTitle}>
            {E.problems}
          </h3>
          {problems === null ? (
            <p className="mt-1 text-xs text-subtle">{E.checking}</p>
          ) : problems.length === 0 ? (
            <p className="mt-1 text-sm text-ok">✓ {E.noProblems}</p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1 text-xs" data-testid="venue-problems">
              {problems.map((p, k) => (
                <li key={k} className={p.severity === "error" ? "text-bad" : "text-warn"}>
                  <button type="button" className="flex gap-1.5 text-left hover:underline disabled:no-underline" disabled={!p.elementId} onClick={() => focus(p.elementId)}>
                    <span className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${p.severity === "error" ? "bg-[#dc2626]" : "bg-[#d97706]"}`}>{k + 1}</span>
                    <span>{p.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(fixCount("removeTiny") > 0 || fixCount("removeIsolated") > 0) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {fixCount("removeTiny") > 0 && (
                <button type="button" className={btnSmall} disabled={readOnly} onClick={() => edit(applyFix(venue, problemList, "removeTiny"))}>
                  {E.fixTiny(fixCount("removeTiny"))}
                </button>
              )}
              {fixCount("removeIsolated") > 0 && (
                <button type="button" className={btnSmall} disabled={readOnly} onClick={() => edit(applyFix(venue, problemList, "removeIsolated"))}>
                  {E.fixIsolated(fixCount("removeIsolated"))}
                </button>
              )}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={readOnly || problems === null} onClick={() => void save()}>
              {target.kind === "server" ? E.saveServer : E.save}
            </button>
            {target.kind === "local" && known.some((v) => v.user && v.id === venue.id) && (
              <button
                type="button"
                className={btn}
                onClick={() => {
                  deleteUserVenue(venue.id as string);
                  if (venue.id) removeVenueImage(browserStore(), venue.id);
                  open({ kind: "local", venue: blankVenue(newVenueId(), E.newName) });
                }}
              >
                {E.deleteVenue}
              </button>
            )}
          </div>
        </section>

        <details className={card} open>
          <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-3">
            <span className={cardTitle}>{E.elements}</span>
            <InfoTip text={E.intro} />
            <span className="ml-auto text-xs text-subtle tabular">{elementRows.length}</span>
          </summary>
          <div className="px-3.5 pb-3.5">
            {elementRows.length === 0 ? (
              <p className="text-xs text-muted">{E.noElements}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {elementRows.map((r) => (
                  <li key={r.id} className={`flex items-center gap-1.5 rounded px-1 ${selected === r.id ? "bg-accent-soft" : ""}`}>
                    <input aria-label={`${E.kinds[r.list] ?? r.list} ${r.id}`} className={`${input} h-7 min-w-0 flex-1 text-xs`} value={r.name} disabled={readOnly} onFocus={() => setSelected(r.id)} onChange={(e) => rename(r.list, r.id, e.target.value)} />
                    {r.list === "gateGroups" && (
                      <input
                        aria-label={`${E.lanes} ${r.id}`}
                        className={`${input} h-7 w-14 text-xs`}
                        type="number"
                        min={1}
                        max={64}
                        disabled={readOnly}
                        value={venue.gateGroups.find((g) => g.id === r.id)?.laneCount ?? 1}
                        onChange={(e) => setLanes(r.id, e.target.value)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </aside>
    </div>
  );
}

/** A source, lane line or road within `radius` metres of p (they have no area to click inside). */
function nearLineElement(v: Venue, p: Point, radius: number): string | null {
  for (const s of v.sources) if (Math.hypot(s.position.x - p.x, s.position.y - p.y) < radius) return s.id;
  const nearSegment = (a: Point, b: Point, r: number) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) < r;
  };
  for (const g of [...v.gateGroups, ...v.screeningStages]) if (nearSegment(g.line.a, g.line.b, radius)) return g.id;
  for (const r of v.roads ?? []) {
    const half = (r.laneCount * LANE_WIDTH * (r.direction === "twoWay" ? 2 : 1)) / 2;
    for (let k = 1; k < r.points.length; k++) if (nearSegment(r.points[k - 1] as Point, r.points[k] as Point, Math.max(radius, half))) return r.id;
  }
  return null;
}

/** Swatches for the layers menu: the same colours as on the canvas. */
const LAYER_SWATCH: Record<Layer, string> = {
  image: "border-line bg-[linear-gradient(135deg,#cbd5e1,#94a3b8)]",
  detection: "border-line bg-[linear-gradient(90deg,#14b8a6_33%,#dc2626_33%_66%,#d946ef_66%)]",
  walkable: "border-[#0d9488] bg-[#99f6e4]",
  obstacles: "border-[#334155] bg-[repeating-linear-gradient(45deg,#e2e8f0_0_2px,#64748b_2px_3px)]",
  destinations: "border-[#15803d] bg-[#86efac]",
  roads: "border-[#111827] bg-[#4b5563]",
  parking: "border-[#b45309] bg-[#fde68a]",
  names: "border-line bg-surface",
  problems: "border-[#dc2626] bg-[#fecaca]",
};

/** Where to put an element's problem marker: a polygon's centre, a source, a gate's middle, a road's middle point. */
function anchorOf(v: Venue, id: string): Point | null {
  const p = polygonOf(v, id);
  if (p) return centroidOf(p.ring);
  const s = v.sources.find((e) => e.id === id);
  if (s) return s.position;
  const g = [...v.gateGroups, ...v.screeningStages].find((e) => e.id === id);
  if (g) return { x: (g.line.a.x + g.line.b.x) / 2, y: (g.line.a.y + g.line.b.y) / 2 };
  const r = (v.roads ?? []).find((e) => e.id === id);
  if (r) return r.points[Math.floor(r.points.length / 2)] ?? null;
  return null;
}

/** The stalls of a row as quadrilaterals (the engine's geometry: centres along a→b, depth to the given side). */
function stallRects(row: { a: Point; b: Point; count: number; side: "left" | "right" | "both"; depth?: number }): Point[][] {
  const dx = row.b.x - row.a.x;
  const dy = row.b.y - row.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const depth = row.depth ?? 5;
  const w = len / Math.max(1, row.count);
  const sides = row.side === "both" ? [1, -1] : row.side === "right" ? [1] : [-1];
  const out: Point[][] = [];
  for (const s of sides)
    for (let k = 0; k < row.count; k++) {
      const x0 = row.a.x + ux * w * k;
      const y0 = row.a.y + uy * w * k;
      const nx = -uy * s * depth;
      const ny = ux * s * depth;
      out.push([
        { x: x0, y: y0 },
        { x: x0 + ux * w, y: y0 + uy * w },
        { x: x0 + ux * w + nx, y: y0 + uy * w + ny },
        { x: x0 + nx, y: y0 + ny },
      ]);
    }
  return out;
}
