/**
 * Edits of a venue document for the editor (D-066). Every function returns a new venue that shares
 * all unchanged parts with the old one (never mutates), so the history can keep references
 * (history.ts) and React sees changes by reference. Pure.
 *
 * The editor draws the pedestrian part of a venue: walkable areas, obstacles, sources, gate groups
 * and destinations. Roads, car parks and screening stages of an existing venue are kept as they are
 * (the editor can move their points, but not create them yet).
 */

import { SERVICE_TIME_PRESETS } from "@bottleneck/engine";
import type { GateGroup, Point, Venue } from "@bottleneck/schema";

export type DrawTool = "walkable" | "obstacle" | "destination" | "source" | "gate";

/** A road along `points` (two-way, `lanes` per direction, not public unless marked). Points are rounded to centimetres. */
export function addRoad(v: Venue, points: readonly Point[], lanes = 1): { venue: Venue; id: string } | null {
  if (points.length < 2) return null;
  const id = nextId(v, "road");
  const road = { id, name: `Road ${id.split("-")[1]}`, points: points.slice(0, 500).map(roundPoint), direction: "twoWay" as const, laneCount: Math.max(1, Math.min(4, lanes)) };
  return { venue: { ...v, roads: [...(v.roads ?? []), road] }, id };
}

export function blankVenue(id: string, name: string): Venue {
  return { schemaVersion: 1, id, name, walkableAreas: [], obstacles: [], sources: [], screeningStages: [], gateGroups: [], destinations: [] };
}

/** A new id for a venue drawn in this browser, e.g. "venue-mhx3k2a1-4f9q". */
export function newVenueId(now: number = Date.now(), random: () => number = Math.random): string {
  const r = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `venue-${now.toString(36)}-${r}`;
}

/** Every element id in the venue. */
export function elementIds(v: Venue): Set<string> {
  const lists: readonly { id?: string }[][] = [v.walkableAreas, v.obstacles, v.sources, v.screeningStages, v.gateGroups, v.destinations, v.roads ?? [], v.vehicleSources ?? [], v.vehicleBarriers ?? [], v.parkingLots ?? [], v.crossings ?? []];
  return new Set(lists.flatMap((l) => l.map((e) => e.id ?? "")));
}

/** The smallest unused "<prefix>-<n>". */
export function nextId(v: Venue, prefix: string): string {
  const used = elementIds(v);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

const round = (x: number) => Math.round(x * 100) / 100; // centimetres: enough for a venue, and stable JSON
const roundPoint = (p: Point): Point => ({ x: round(p.x), y: round(p.y) });

/** Adds a polygon (walkable area, obstacle or destination) or a point/line element; returns the venue and the new id. */
export function addPolygon(v: Venue, tool: "walkable" | "obstacle" | "destination", points: readonly Point[]): { venue: Venue; id: string } {
  const outer = points.map(roundPoint);
  if (tool === "walkable") {
    const id = nextId(v, "area");
    return { venue: { ...v, walkableAreas: [...v.walkableAreas, { id, polygon: { outer } }] }, id };
  }
  if (tool === "obstacle") {
    const id = nextId(v, "obstacle");
    return { venue: { ...v, obstacles: [...v.obstacles, { id, polygon: { outer } }] }, id };
  }
  const id = nextId(v, "destination");
  return { venue: { ...v, destinations: [...v.destinations, { id, name: `Destination ${id.split("-")[1]}`, area: { outer } }] }, id };
}

/** Adds a source; all sources then get equal shares that add up to exactly 1 (edit them in the element list). */
export function addSource(v: Venue, p: Point): { venue: Venue; id: string } {
  const id = nextId(v, "source");
  const all = [...v.sources, { id, name: `Source ${id.split("-")[1]}`, position: roundPoint(p), share: 0 }];
  const each = Math.floor(10000 / all.length) / 10000;
  const sources = all.map((s, k) => ({ ...s, share: k === all.length - 1 ? round4(1 - each * (all.length - 1)) : each }));
  return { venue: { ...v, sources }, id };
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** A gate group along the line a→b, with the default turnstile (card/QR mix, D-024) and 4 lanes. */
export function addGate(v: Venue, a: Point, b: Point): { venue: Venue; id: string } {
  const id = nextId(v, "gate");
  const gate: GateGroup = {
    id,
    name: `Gate ${id.split("-")[1]}`,
    line: { a: roundPoint(a), b: roundPoint(b) },
    laneCount: 4,
    queueLength: 15,
    serviceTime: SERVICE_TIME_PRESETS.turnstile,
    scanFailure: { rate: 0.03, retryTime: { kind: "uniform", min: 5, max: 15 } },
  };
  return { venue: { ...v, gateGroups: [...v.gateGroups, gate] }, id };
}

export function deleteElement(v: Venue, id: string): Venue {
  const has = <T extends { id?: string }>(l: readonly T[]) => l.some((e) => e.id === id);
  const drop = <T extends { id?: string }>(l: readonly T[]) => l.filter((e) => e.id !== id);
  if (has(v.walkableAreas)) return { ...v, walkableAreas: drop(v.walkableAreas) };
  if (has(v.obstacles)) return { ...v, obstacles: drop(v.obstacles) };
  if (has(v.sources)) return { ...v, sources: drop(v.sources) };
  if (has(v.gateGroups)) return { ...v, gateGroups: drop(v.gateGroups) };
  if (has(v.screeningStages)) return { ...v, screeningStages: drop(v.screeningStages), gateGroups: v.gateGroups.map((g) => (g.screeningStageId === id ? (({ screeningStageId: _drop, ...rest }) => rest)(g) : g)) };
  if (has(v.destinations)) return { ...v, destinations: drop(v.destinations) };
  if (has(v.roads ?? [])) return { ...v, roads: drop(v.roads ?? []) };
  return v;
}

// ---- Handles: the points the select tool can drag

export type Handle =
  | { kind: "vertex"; list: "walkableAreas" | "obstacles" | "destinations"; id: string; index: number }
  | { kind: "source"; id: string }
  | { kind: "lineEnd"; list: "gateGroups" | "screeningStages"; id: string; end: "a" | "b" }
  | { kind: "roadPoint"; id: string; index: number };

export interface HandlePoint {
  handle: Handle;
  point: Point;
}

export function handles(v: Venue): HandlePoint[] {
  const out: HandlePoint[] = [];
  for (const w of v.walkableAreas) w.polygon.outer.forEach((point, index) => out.push({ handle: { kind: "vertex", list: "walkableAreas", id: w.id, index }, point }));
  for (const o of v.obstacles) o.polygon.outer.forEach((point, index) => out.push({ handle: { kind: "vertex", list: "obstacles", id: o.id, index }, point }));
  for (const d of v.destinations) d.area.outer.forEach((point, index) => out.push({ handle: { kind: "vertex", list: "destinations", id: d.id, index }, point }));
  for (const s of v.sources) out.push({ handle: { kind: "source", id: s.id }, point: s.position });
  for (const g of v.gateGroups) for (const end of ["a", "b"] as const) out.push({ handle: { kind: "lineEnd", list: "gateGroups", id: g.id, end }, point: g.line[end] });
  for (const g of v.screeningStages) for (const end of ["a", "b"] as const) out.push({ handle: { kind: "lineEnd", list: "screeningStages", id: g.id, end }, point: g.line[end] });
  for (const r of v.roads ?? []) r.points.forEach((point, index) => out.push({ handle: { kind: "roadPoint", id: r.id, index }, point }));
  return out;
}

const replaceAt = <T>(l: readonly T[], i: number, x: T): T[] => l.map((y, k) => (k === i ? x : y));

/** Moves one handle to p. Returns the same venue if the handle no longer exists. */
export function moveHandle(v: Venue, h: Handle, to: Point): Venue {
  const p = roundPoint(to);
  if (h.kind === "source") {
    const i = v.sources.findIndex((s) => s.id === h.id);
    return i < 0 ? v : { ...v, sources: replaceAt(v.sources, i, { ...(v.sources[i] as Venue["sources"][number]), position: p }) };
  }
  if (h.kind === "roadPoint") {
    const roads = v.roads ?? [];
    const i = roads.findIndex((r) => r.id === h.id);
    const r = roads[i];
    if (!r || h.index >= r.points.length) return v;
    return { ...v, roads: replaceAt(roads, i, { ...r, points: replaceAt(r.points, h.index, p) }) };
  }
  if (h.kind === "lineEnd") {
    if (h.list === "gateGroups") {
      const i = v.gateGroups.findIndex((g) => g.id === h.id);
      if (i < 0) return v;
      const g = v.gateGroups[i] as GateGroup;
      return { ...v, gateGroups: replaceAt(v.gateGroups, i, { ...g, line: { ...g.line, [h.end]: p } }) };
    }
    const i = v.screeningStages.findIndex((g) => g.id === h.id);
    if (i < 0) return v;
    const g = v.screeningStages[i] as Venue["screeningStages"][number];
    return { ...v, screeningStages: replaceAt(v.screeningStages, i, { ...g, line: { ...g.line, [h.end]: p } }) };
  }
  const movePoly = <T extends { id: string }>(list: readonly T[], get: (e: T) => readonly Point[], set: (e: T, outer: Point[]) => T): T[] | null => {
    const i = list.findIndex((e) => e.id === h.id);
    if (i < 0) return null;
    const e = list[i] as T;
    const outer = get(e);
    if (h.index >= outer.length) return null;
    return replaceAt(list, i, set(e, replaceAt(outer, h.index, p)));
  };
  if (h.list === "walkableAreas") {
    const l = movePoly(v.walkableAreas, (e) => e.polygon.outer, (e, outer) => ({ ...e, polygon: { ...e.polygon, outer } }));
    return l ? { ...v, walkableAreas: l } : v;
  }
  if (h.list === "obstacles") {
    const l = movePoly(v.obstacles, (e) => e.polygon.outer, (e, outer) => ({ ...e, polygon: { ...e.polygon, outer } }));
    return l ? { ...v, obstacles: l } : v;
  }
  const l = movePoly(v.destinations, (e) => e.area.outer, (e, outer) => ({ ...e, area: { ...e.area, outer } }));
  return l ? { ...v, destinations: l } : v;
}

/** Scales every coordinate about `centre` (after re-calibrating a background image). */
export function scaleVenue(v: Venue, factor: number, centre: Point): Venue {
  const f = (p: Point): Point => roundPoint({ x: centre.x + (p.x - centre.x) * factor, y: centre.y + (p.y - centre.y) * factor });
  return JSON.parse(JSON.stringify(v), function (this: unknown, _k: string, val: unknown) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 2 && typeof o.x === "number" && typeof o.y === "number") return f(o as unknown as Point);
    }
    return val;
  }) as Venue;
}
