import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import type { Point, Venue } from "@bottleneck/schema";
import { calibrate, pixelToVenue, venueToPixel } from "../editor/calibration.ts";
import { addGate, addPolygon, addSource, blankVenue, deleteElement, handles, moveHandle, newVenueId, scaleVenue, type Handle } from "../editor/edits.ts";
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "../editor/history.ts";
import { AREA_KINDS, addShape, changeKind, duplicateElement, elementAt, moveElement, polygonOf, shapePoints, type AreaKind, type ShapeKind } from "../editor/shapes.ts";
import { DEFAULT_TRACE, traceRegion } from "../editor/trace.ts";
import { checkVenue, hasErrors, type VenueProblem } from "../editor/venueChecks.ts";
import { knownVenues } from "../library/catalog.ts";
import { deleteUserVenue, storeUserVenue } from "../library/userVenues.ts";
import type { SchemaValidator } from "../library/validate.ts";
import { browserStore, downscaledSize, loadVenueImage, removeVenueImage, saveVenueImage } from "../library/venueImages.ts";
import { strings } from "../strings.ts";
import { loadVenueValidator } from "../validation/loadValidator.ts";
import { InfoTip } from "./icons.tsx";
import { btn, btnGhost, btnPrimary, btnSmall, card, cardTitle, input, labelText, overlay, select } from "./styles.ts";
import type { Server } from "./useServer.ts";

const E = strings.venueEditor;
type Tool = "select" | ShapeKind | "freeform" | "source" | "gate" | "calibrate" | "trace";
const SHAPE_TOOLS: ShapeKind[] = ["rectangle", "circle", "lshape", "ushape"];
const KEY_TO_TOOL: Record<string, Tool> = { v: "select", r: "rectangle", c: "circle", l: "lshape", u: "ushape", p: "freeform", s: "source", g: "gate", k: "calibrate", t: "trace" };
const isShape = (t: Tool): t is ShapeKind => (SHAPE_TOOLS as string[]).includes(t);

/** The map image in this page view: its data URL and pixels (for tracing). */
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

function bounds(v: Venue): View {
  const pts: Point[] = [];
  const grow = (p: Point) => pts.push(p);
  v.walkableAreas.forEach((e) => e.polygon.outer.forEach(grow));
  v.obstacles.forEach((e) => e.polygon.outer.forEach(grow));
  v.destinations.forEach((e) => e.area.outer.forEach(grow));
  v.sources.forEach((e) => grow(e.position));
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
  | { kind: "gate"; a: Point; b: Point };

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
  const [draft, setDraft] = useState<Point[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [view, setView] = useState<View>(() => bounds(target.venue));
  const [image, setImage] = useState<MapImage | null>(null);
  const [imageAlpha, setImageAlpha] = useState(0.8);
  const [tolerance, setTolerance] = useState(DEFAULT_TRACE.tolerance);
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
  const flagged = new Set((problems ?? []).filter((p) => p.severity === "error").map((p) => p.elementId));

  const open = (t: Target) => {
    setTarget(t);
    setHistory(createHistory(t.venue));
    setView(bounds(t.venue));
    setDraft([]);
    setSelected(null);
    setMessage(null);
    setImage(null);
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

  const finishFreeform = () => {
    if (tool !== "freeform" || draft.length < 3) return;
    const r = addPolygon(venue, kind, draft);
    edit(r.venue);
    setSelected(r.id);
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
  const removeImage = () => {
    setImage(null);
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
    chooseTool("trace");
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
    const added = addPolygon(
      venue,
      kind,
      r.ring.map((q) => pixelToVenue(cal, q)),
    );
    edit(added.venue);
    setSelected(added.id);
    setMessage({ ok: true, text: E.traced(r.ring.length) });
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
        if (best && (selected === best.id || best.kind !== "vertex")) {
          setSelected(best.id);
          setDrag({ kind: "handle", handle: best });
          return;
        }
        const id = nearPointElement(venue, p, 10 * metresPerScreenPx()) ?? elementAt(venue, p);
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
    else if (tool === "freeform") setDraft((d) => [...d, p]);
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
    if (!drag) return;
    if (drag.kind === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const k = Math.max(drag.startView.w / svg.clientWidth, drag.startView.h / svg.clientHeight);
      setView({ ...drag.startView, x: drag.startView.x - (e.clientX - drag.startClient.x) * k, y: drag.startView.y - (e.clientY - drag.startClient.y) * k });
      return;
    }
    const p = toVenue(e);
    if (drag.kind === "handle") edit(moveHandle(venue, drag.handle, p), `drag:${JSON.stringify(drag.handle)}`);
    else if (drag.kind === "move") {
      edit(moveElement(venue, drag.id, p.x - drag.last.x, p.y - drag.last.y), `move:${drag.id}`);
      setDrag({ ...drag, last: p });
    } else setDrag({ ...drag, b: p });
  };

  const onPointerUp = () => {
    if (drag?.kind === "shape" && isShape(tool)) {
      const r = addShape(venue, kind, tool, drag.a, drag.b);
      if (r) {
        edit(r.venue);
        setSelected(r.id);
      }
    } else if (drag?.kind === "gate") {
      if (Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y) > 1) {
        const r = addGate(venue, drag.a, drag.b);
        edit(r.venue);
        setSelected(r.id);
      } else setDraft([drag.a]);
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
    } else if (e.key === "Enter" && !typing) finishFreeform();
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

  const zoom = (f: number) => setView((v) => ({ x: v.x + (v.w * (1 - f)) / 2, y: v.y + (v.h * (1 - f)) / 2, w: v.w * f, h: v.h * f }));
  const stroke = view.w / 500;
  const hint = tool === "select" ? E.hint.select : isShape(tool) ? E.hint.shape : (E.hint[tool] ?? "");
  const others = known.filter((v) => !v.remote && v.id !== target.venue.id);
  const polySel = selected ? polygonOf(venue, selected) : null;
  const gateSel = selected ? venue.gateGroups.find((g) => g.id === selected) : undefined;
  const elementRows: { list: string; id: string; name: string }[] = [
    ...venue.walkableAreas.map((e) => ({ list: "walkableAreas", id: e.id, name: e.name ?? e.id })),
    ...venue.obstacles.map((e) => ({ list: "obstacles", id: e.id, name: e.name ?? e.id })),
    ...venue.sources.map((e) => ({ list: "sources", id: e.id, name: e.name })),
    ...venue.screeningStages.map((e) => ({ list: "screeningStages", id: e.id, name: e.name })),
    ...venue.gateGroups.map((e) => ({ list: "gateGroups", id: e.id, name: e.name })),
    ...venue.destinations.map((e) => ({ list: "destinations", id: e.id, name: e.name })),
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
  const preview = drag?.kind === "shape" && isShape(tool) ? shapePoints(tool, drag.a, drag.b) : null;

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

        <div role="group" aria-label={E.drawAs} className="flex flex-col gap-1">
          <p className="px-0.5 text-[11px] font-medium tracking-wide text-subtle uppercase">{E.drawAs}</p>
          <div className="grid grid-cols-3 gap-0.5 rounded-md bg-sunken p-0.5">
            {AREA_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} disabled={readOnly} onClick={() => setKind(k)} className={`h-7 rounded text-xs font-medium ${kind === k ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}>
                {E.kinds3[k]}
              </button>
            ))}
          </div>
        </div>

        <div role="toolbar" aria-label={E.groups.shapes} className="flex flex-col gap-3">
          {toolButton("select")}
          {group(E.groups.shapes, [...SHAPE_TOOLS, "freeform" as const].map(toolButton))}
          {group(E.groups.points, (["source", "gate"] as const).map(toolButton))}
          {group(
            E.groups.map,
            <>
              <label className={`${btn} w-full cursor-pointer ${readOnly ? "pointer-events-none opacity-45" : ""}`} title={E.importHint}>
                {E.importImage}
                <input type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={E.importImage} disabled={readOnly} onChange={(e) => void pickImage(e.target.files?.[0])} />
              </label>
              {toolButton("calibrate")}
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
          className={`absolute inset-0 h-full w-full touch-none select-none ${tool === "select" ? (drag?.kind === "pan" ? "cursor-grabbing" : "cursor-default") : "cursor-crosshair"}`}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
          onWheel={onWheel}
          onDoubleClick={finishFreeform}
        >
          {image && venue.background && <image href={image.url} x={venue.background.origin.x} y={venue.background.origin.y} width={image.w * venue.background.metresPerPixel} height={image.h * venue.background.metresPerPixel} opacity={imageAlpha} preserveAspectRatio="none" />}
          {venue.walkableAreas.map((w) => (
            <polygon key={`wall-${w.id}`} points={pts(w.polygon.outer)} fill="none" className="stroke-[#3a3f47] dark:stroke-[#4a5261]" strokeWidth={stroke * 4} strokeLinejoin="miter" opacity={image ? 0.7 : 1} />
          ))}
          {venue.walkableAreas.map((w) => (
            <polygon key={w.id} points={pts(w.polygon.outer)} className={KIND_FILL.walkable} opacity={image ? 0.55 : 1} />
          ))}
          {venue.destinations.map((d) => (
            <polygon key={d.id} points={pts(d.area.outer)} className={KIND_FILL.destination} stroke="#2f9e6e" strokeWidth={stroke * 1.5} opacity={image ? 0.75 : 1} />
          ))}
          {venue.obstacles.map((o) => (
            <polygon key={o.id} points={pts(o.polygon.outer)} className={KIND_FILL.obstacle} stroke="#8b929c" strokeWidth={stroke} opacity={image ? 0.8 : 1} />
          ))}
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
          {/* Problems and selection on top. */}
          {[...flagged].map((id) => {
            const p = polygonOf(venue, id);
            return p ? <polygon key={`bad-${id}`} points={pts(p.ring)} fill="none" stroke="#ea580c" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 6} ${stroke * 4}`} /> : null;
          })}
          {polySel && <polygon points={pts(polySel.ring)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2.5} />}
          {gateSel && <line x1={gateSel.line.a.x} y1={gateSel.line.a.y} x2={gateSel.line.b.x} y2={gateSel.line.b.y} stroke="#f59e0b" strokeWidth={stroke * 5} strokeLinecap="round" opacity={0.6} />}
          {preview && <polygon points={pts(preview)} className={KIND_FILL[kind]} stroke="#f59e0b" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 5} ${stroke * 3}`} opacity={0.85} />}
          {drag?.kind === "gate" && <line x1={drag.a.x} y1={drag.a.y} x2={drag.b.x} y2={drag.b.y} stroke="#f59e0b" strokeWidth={stroke * 2.5} strokeDasharray={`${stroke * 5} ${stroke * 3}`} />}
          {draft.length > 0 && <polyline points={pts(draft)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 5} ${stroke * 3}`} />}
          {draft.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 3} fill="#f59e0b" />
          ))}
          {calPoints.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 4} fill="none" stroke="#dc2626" strokeWidth={stroke * 2} />
          ))}
          {calPoints.length === 2 && <line x1={calPoints[0]?.x} y1={calPoints[0]?.y} x2={calPoints[1]?.x} y2={calPoints[1]?.y} stroke="#dc2626" strokeWidth={stroke * 1.5} />}
          {tool === "select" &&
            !readOnly &&
            handles(venue)
              .filter((h) => h.handle.kind !== "vertex" || h.handle.id === selected)
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
        </div>
        <p className={`${overlay} pointer-events-none absolute top-3 right-3 max-w-[22rem] px-3 py-1.5 text-xs text-muted`} aria-live="polite">
          {hint}
        </p>
        {tool === "freeform" && draft.length > 0 && (
          <div className={`${overlay} absolute bottom-3 left-3 flex gap-2 p-2`}>
            <button type="button" className={btnSmall} disabled={draft.length < 3} onClick={finishFreeform}>
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

      {/* Right: the selected element, checks and saving, all elements. */}
      <aside className="flex shrink-0 flex-col gap-3 overflow-y-auto border-line bg-canvas p-3 scroll-thin lg:w-80 lg:border-l [&>*]:shrink-0">
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
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnSmall}
                  disabled={readOnly}
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
                <li key={k} className={p.severity === "error" ? "text-bad" : "text-muted"}>
                  <button type="button" className="text-left" onClick={() => p.elementId && setSelected(p.elementId)}>
                    {p.severity === "error" ? "✗ " : "! "}
                    {p.message}
                  </button>
                </li>
              ))}
            </ul>
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
                    <input aria-label={`${E.kinds[r.list]} ${r.id}`} className={`${input} h-7 min-w-0 flex-1 text-xs`} value={r.name} disabled={readOnly} onFocus={() => setSelected(r.id)} onChange={(e) => rename(r.list, r.id, e.target.value)} />
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

/** A source or lane line within `radius` metres of p (they have no area to click inside). */
function nearPointElement(v: Venue, p: Point, radius: number): string | null {
  for (const s of v.sources) if (Math.hypot(s.position.x - p.x, s.position.y - p.y) < radius) return s.id;
  for (const g of [...v.gateGroups, ...v.screeningStages]) {
    const dx = g.line.b.x - g.line.a.x;
    const dy = g.line.b.y - g.line.a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - g.line.a.x) * dx + (p.y - g.line.a.y) * dy) / len2));
    if (Math.hypot(g.line.a.x + t * dx - p.x, g.line.a.y + t * dy - p.y) < radius) return g.id;
  }
  return null;
}
