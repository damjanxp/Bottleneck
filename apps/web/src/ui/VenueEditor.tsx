import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { Point, Venue } from "@bottleneck/schema";
import { calibrate, venueToPixel } from "../editor/calibration.ts";
import { addGate, addPolygon, addSource, blankVenue, deleteElement, handles, moveHandle, newVenueId, scaleVenue, type DrawTool, type Handle } from "../editor/edits.ts";
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from "../editor/history.ts";
import { checkVenue, hasErrors, type VenueProblem } from "../editor/venueChecks.ts";
import { knownVenues } from "../library/catalog.ts";
import { deleteUserVenue, storeUserVenue } from "../library/userVenues.ts";
import type { SchemaValidator } from "../library/validate.ts";
import { strings } from "../strings.ts";
import { loadVenueValidator } from "../validation/loadValidator.ts";
import { btn, btnPrimary, btnSmall, card, input, labelText } from "./styles.ts";
import type { Server } from "./useServer.ts";

const E = strings.venueEditor;
type Tool = "select" | DrawTool | "calibrate";
const TOOLS: Tool[] = ["select", "walkable", "obstacle", "destination", "source", "gate", "calibrate"];
const POLYGON_TOOLS = new Set<Tool>(["walkable", "obstacle", "destination"]);

/** A background image for this page view only (an object URL), with its calibration. */
interface Background {
  url: string;
  name: string;
  widthPx: number;
  heightPx: number;
}

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

function bounds(v: Venue): View {
  const pts: Point[] = [];
  JSON.stringify(v, (_k, val: unknown) => {
    if (typeof val === "object" && val !== null && typeof (val as Point).x === "number" && typeof (val as Point).y === "number" && Object.keys(val).length === 2) pts.push(val as Point);
    return val;
  });
  if (v.background) {
    const b = v.background;
    pts.push(b.origin, { x: b.origin.x + b.widthPx * b.metresPerPixel, y: b.origin.y + b.heightPx * b.metresPerPixel });
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

/** A notice that survives the remount after saving (saving selects the venue, which remounts the editor). */
let carriedNotice: { venueId: string; text: string } | null = null;

/** What the editor works on: a new venue, a copy of another, a venue saved in this browser, or a shared venue on the server. */
interface Target {
  kind: "local" | "server";
  venue: Venue;
}

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
  const [draft, setDraft] = useState<Point[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Handle | null>(null);
  const [view, setView] = useState<View>(() => bounds(target.venue));
  const [background, setBackground] = useState<Background | null>(null);
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
  useEffect(() => () => {
    if (background) URL.revokeObjectURL(background.url);
  }, [background]);

  const problems: VenueProblem[] | null = useMemo(() => (validator ? checkVenue(venue, validator) : null), [venue, validator]);
  const flagged = new Set((problems ?? []).filter((p) => p.severity === "error").map((p) => p.elementId));

  const open = (t: Target) => {
    setTarget(t);
    setHistory(createHistory(t.venue));
    setView(bounds(t.venue));
    setDraft([]);
    setSelected(null);
    setMessage(null);
  };

  const edit = (next: Venue, coalesce: string | null = null) => {
    if (readOnly) return;
    setHistory((h) => commit(h, next, coalesce));
    setMessage(null);
  };

  const toVenue = (e: { clientX: number; clientY: number }): Point => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const finishPolygon = () => {
    if (!POLYGON_TOOLS.has(tool) || draft.length < 3) return;
    const r = addPolygon(venue, tool as "walkable" | "obstacle" | "destination", draft);
    edit(r.venue);
    setSelected(r.id);
    setDraft([]);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (readOnly || e.button !== 0) return;
    const p = toVenue(e);
    if (tool === "select") {
      // The nearest handle within 8 screen pixels.
      const svg = svgRef.current;
      const scale = svg ? view.w / svg.clientWidth : 1;
      let best: Handle | null = null;
      let bestD = 8 * scale;
      for (const h of handles(venue)) {
        const d = Math.hypot(h.point.x - p.x, h.point.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = h.handle;
        }
      }
      if (best) {
        setDrag(best);
        setSelected(best.id);
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }
      return;
    }
    if (POLYGON_TOOLS.has(tool)) setDraft((d) => [...d, p]);
    else if (tool === "source") {
      const r = addSource(venue, p);
      edit(r.venue);
      setSelected(r.id);
    } else if (tool === "gate") {
      if (draft.length === 0) setDraft([p]);
      else {
        const r = addGate(venue, draft[0] as Point, p);
        edit(r.venue);
        setSelected(r.id);
        setDraft([]);
      }
    } else if (tool === "calibrate" && background) setCalPoints((c) => (c.length >= 2 ? [p] : [...c, p]));
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    edit(moveHandle(venue, drag, toVenue(e)), `drag:${drag.id}:${JSON.stringify(drag)}`);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      setHistory(redo);
    } else if (e.key === "Enter") finishPolygon();
    else if (e.key === "Escape") {
      setDraft([]);
      setCalPoints([]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !(e.target instanceof HTMLInputElement)) {
      edit(deleteElement(venue, selected));
      setSelected(null);
    }
  };

  // Background calibration: current scale (or 0.1 m per pixel for a new image) at the venue's background origin.
  const cal = venue.background ? { metresPerPixel: venue.background.metresPerPixel, origin: venue.background.origin } : { metresPerPixel: 0.1, origin: { x: 0, y: 0 } };
  const pickImage = (file: File | undefined) => {
    if (!file || !/^image\/(png|jpeg)$/.test(file.type)) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const widthPx = Math.min(4096, img.naturalWidth);
      const heightPx = Math.min(4096, img.naturalHeight);
      setBackground({ url, name: file.name, widthPx, heightPx });
      edit({ ...venue, background: { image: file.name.slice(0, 300), widthPx, heightPx, metresPerPixel: cal.metresPerPixel, origin: cal.origin } });
      setTool("calibrate");
    };
    img.src = url;
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
      } catch (e) {
        setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
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
  const stroke = view.w / 400;
  const hint = tool === "select" ? E.hint.select : POLYGON_TOOLS.has(tool) ? E.hint.polygon : tool === "source" ? E.hint.source : tool === "gate" ? E.hint.gate : E.hint.calibrate;
  const others = known.filter((v) => !v.remote && v.id !== target.venue.id);

  const elementRows: { list: string; id: string; name: string }[] = [
    ...venue.walkableAreas.map((e) => ({ list: "walkableAreas", id: e.id, name: e.name ?? e.id })),
    ...venue.obstacles.map((e) => ({ list: "obstacles", id: e.id, name: e.name ?? e.id })),
    ...venue.sources.map((e) => ({ list: "sources", id: e.id, name: e.name })),
    ...venue.screeningStages.map((e) => ({ list: "screeningStages", id: e.id, name: e.name })),
    ...venue.gateGroups.map((e) => ({ list: "gateGroups", id: e.id, name: e.name })),
    ...venue.destinations.map((e) => ({ list: "destinations", id: e.id, name: e.name })),
  ];
  const rename = (list: string, id: string, name: string) => {
    const l = (venue as unknown as Record<string, { id: string; name?: string }[]>)[list];
    if (!l) return;
    edit({ ...venue, [list]: l.map((e) => (e.id === id ? { ...e, name } : e)) } as Venue, `rename:${id}`);
  };

  return (
    <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
      <section className={card} aria-labelledby="editor-heading">
        <h2 id="editor-heading" className="text-lg font-semibold">
          {E.heading}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{E.intro}</p>
        {readOnly && <p className="mt-2 text-sm text-orange-700 dark:text-orange-400">{E.readOnly}</p>}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {!shared && (
            <label className={labelText}>
              {E.startFrom}
              <select
                aria-label={E.startFrom}
                className={input}
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
            </label>
          )}
          <label className={labelText}>
            {E.name}
            <input aria-label={E.name} className={`${input} min-w-[16rem]`} value={venue.name} disabled={readOnly} onChange={(e) => edit({ ...venue, name: e.target.value }, "rename:venue")} />
          </label>
        </div>
      </section>

      <section className={card} aria-label={E.tools}>
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={E.tools}>
          {TOOLS.map((t) => (
            <button
              key={t}
              type="button"
              className={tool === t ? btnPrimary : btn}
              aria-pressed={tool === t}
              disabled={readOnly && t !== "select"}
              onClick={() => {
                setTool(t);
                setDraft([]);
                setCalPoints([]);
              }}
            >
              {E.tool[t]}
            </button>
          ))}
          <span className="mx-2 h-6 w-px bg-slate-300 dark:bg-slate-700" />
          <button type="button" className={btn} disabled={!canUndo(history) || readOnly} onClick={() => setHistory(undo)} aria-keyshortcuts="Control+Z">
            {E.undo}
          </button>
          <button type="button" className={btn} disabled={!canRedo(history) || readOnly} onClick={() => setHistory(redo)} aria-keyshortcuts="Control+Y">
            {E.redo}
          </button>
          <button type="button" className={btnSmall} onClick={() => zoom(0.8)}>
            {E.zoomIn}
          </button>
          <button type="button" className={btnSmall} onClick={() => zoom(1.25)}>
            {E.zoomOut}
          </button>
          <button type="button" className={btnSmall} onClick={() => setView(bounds(venue))}>
            {E.fit}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
          {hint}
        </p>
        {POLYGON_TOOLS.has(tool) && draft.length > 0 && (
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnSmall} disabled={draft.length < 3} onClick={finishPolygon}>
              {E.finish}
            </button>
            <button type="button" className={btnSmall} onClick={() => setDraft([])}>
              {E.cancel}
            </button>
          </div>
        )}
        {tool === "calibrate" && (
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className={labelText}>
              {E.background}
              <input aria-label={E.background} type="file" accept="image/png,image/jpeg" className="text-xs" onChange={(e) => pickImage(e.target.files?.[0])} />
            </label>
            <label className={labelText}>
              {E.distance}
              <input aria-label={E.distance} className={`${input} w-28`} type="number" min={0} step="any" value={calDistance} onChange={(e) => setCalDistance(e.target.value)} />
            </label>
            <button type="button" className={btnSmall} disabled={calPoints.length !== 2} onClick={applyCalibration}>
              {E.applyCalibration}
            </button>
            <span className="text-xs text-slate-500">{E.backgroundNote}</span>
          </div>
        )}

        <svg
          ref={svgRef}
          role="img"
          aria-label={E.canvas}
          data-testid="venue-canvas"
          className="mt-3 h-[28rem] w-full touch-none select-none rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          preserveAspectRatio="xMidYMid meet"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDrag(null)}
          onDoubleClick={finishPolygon}
        >
          {background && venue.background && (
            <image href={background.url} x={venue.background.origin.x} y={venue.background.origin.y} width={background.widthPx * venue.background.metresPerPixel} height={background.heightPx * venue.background.metresPerPixel} opacity={0.6} />
          )}
          {venue.walkableAreas.map((w) => (
            <polygon key={w.id} points={pts(w.polygon.outer)} className="fill-slate-200 dark:fill-slate-800" stroke={flagged.has(w.id) ? "#ea580c" : selected === w.id ? "#f59e0b" : "#94a3b8"} strokeWidth={stroke} onPointerDown={() => tool === "select" && setSelected(w.id)} />
          ))}
          {venue.obstacles.map((o) => (
            <polygon key={o.id} points={pts(o.polygon.outer)} className="fill-slate-500" stroke={flagged.has(o.id) ? "#ea580c" : selected === o.id ? "#f59e0b" : "#475569"} strokeWidth={stroke} onPointerDown={() => tool === "select" && setSelected(o.id)} />
          ))}
          {venue.destinations.map((d) => (
            <polygon key={d.id} points={pts(d.area.outer)} fill="#10b98155" stroke={flagged.has(d.id) ? "#ea580c" : selected === d.id ? "#f59e0b" : "#059669"} strokeWidth={stroke} onPointerDown={() => tool === "select" && setSelected(d.id)} />
          ))}
          {[...venue.screeningStages, ...venue.gateGroups].map((g) => (
            <g key={g.id} onPointerDown={() => tool === "select" && setSelected(g.id)}>
              <line x1={g.line.a.x} y1={g.line.a.y} x2={g.line.b.x} y2={g.line.b.y} stroke={flagged.has(g.id) ? "#ea580c" : selected === g.id ? "#f59e0b" : "#1d4ed8"} strokeWidth={stroke * 3} strokeLinecap="round" />
              {Array.from({ length: g.laneCount }, (_, k) => {
                const t = (k + 0.5) / g.laneCount;
                return <circle key={k} cx={g.line.a.x + (g.line.b.x - g.line.a.x) * t} cy={g.line.a.y + (g.line.b.y - g.line.a.y) * t} r={stroke * 2} fill="#fff" />;
              })}
            </g>
          ))}
          {venue.sources.map((s) => (
            <circle key={s.id} cx={s.position.x} cy={s.position.y} r={stroke * 5} fill={flagged.has(s.id) ? "#ea580c" : "#7c3aed"} stroke={selected === s.id ? "#f59e0b" : "none"} strokeWidth={stroke * 2} onPointerDown={() => tool === "select" && setSelected(s.id)} />
          ))}
          {draft.length > 0 && <polyline points={pts(draft)} fill="none" stroke="#f59e0b" strokeWidth={stroke * 2} strokeDasharray={`${stroke * 4} ${stroke * 3}`} />}
          {draft.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 3} fill="#f59e0b" />
          ))}
          {calPoints.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={stroke * 4} fill="none" stroke="#dc2626" strokeWidth={stroke * 2} />
          ))}
          {calPoints.length === 2 && <line x1={calPoints[0]?.x} y1={calPoints[0]?.y} x2={calPoints[1]?.x} y2={calPoints[1]?.y} stroke="#dc2626" strokeWidth={stroke} />}
          {tool === "select" && !readOnly && handles(venue).map((h, k) => <rect key={k} x={h.point.x - stroke * 2.5} y={h.point.y - stroke * 2.5} width={stroke * 5} height={stroke * 5} fill="#fff" stroke="#334155" strokeWidth={stroke * 0.8} />)}
        </svg>
        {venue.background && !background && <p className="mt-1 text-xs text-slate-500">{E.calibrated(venue.background.metresPerPixel)}</p>}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={card} aria-labelledby="editor-elements">
          <h3 id="editor-elements" className="font-semibold">
            {E.elements}
          </h3>
          {elementRows.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">{E.noElements}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {elementRows.map((r) => (
                <li key={r.id} className={`flex flex-wrap items-center gap-2 rounded px-1 ${selected === r.id ? "bg-amber-100 dark:bg-amber-500/20" : ""}`}>
                  <span className="w-28 text-xs text-slate-500">{E.kinds[r.list]}</span>
                  <input aria-label={`${E.kinds[r.list]} ${r.id}`} className={`${input} min-w-0 flex-1`} value={r.name} disabled={readOnly} onFocus={() => setSelected(r.id)} onChange={(e) => rename(r.list, r.id, e.target.value)} />
                  {r.list === "gateGroups" && (
                    <input
                      aria-label={`${E.lanes} ${r.id}`}
                      className={`${input} w-16`}
                      type="number"
                      min={1}
                      max={64}
                      disabled={readOnly}
                      value={venue.gateGroups.find((g) => g.id === r.id)?.laneCount ?? 1}
                      onChange={(e) => {
                        const n = Math.max(1, Math.min(64, Math.round(Number(e.target.value) || 1)));
                        edit({ ...venue, gateGroups: venue.gateGroups.map((g) => (g.id === r.id ? { ...g, laneCount: n } : g)) });
                      }}
                    />
                  )}
                  <button type="button" className={btnSmall} disabled={readOnly} onClick={() => edit(deleteElement(venue, r.id))}>
                    {E.delete}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card} aria-labelledby="editor-problems">
          <h3 id="editor-problems" className="font-semibold">
            {E.problems}
          </h3>
          {problems === null ? (
            <p className="mt-1 text-sm text-slate-500">{E.checking}</p>
          ) : problems.length === 0 ? (
            <p className="mt-1 text-sm text-emerald-700 dark:text-emerald-400">✓ {E.noProblems}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="venue-problems">
              {problems.map((p, k) => (
                <li key={k} className={p.severity === "error" ? "text-orange-700 dark:text-orange-400" : "text-slate-600 dark:text-slate-400"}>
                  {p.severity === "error" ? "✗ " : "! "}
                  {p.message}
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
                  open({ kind: "local", venue: blankVenue(newVenueId(), E.newName) });
                }}
              >
                {E.deleteVenue}
              </button>
            )}
          </div>
          {message && (
            <p className={`mt-2 text-sm ${message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-orange-700 dark:text-orange-400"}`} role={message.ok ? "status" : "alert"}>
              {message.text}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

