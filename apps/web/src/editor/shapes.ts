/**
 * Ready-made shapes for the venue editor (redesign 2) and operations on whole elements: move,
 * duplicate, change kind. A shape is dragged out as a box from corner a to corner b and becomes a
 * plain polygon, which can then be edited corner by corner like any other. Pure.
 */

import type { Point, Venue } from "@bottleneck/schema";
import { addPolygon, deleteElement, nextId } from "./edits.ts";

export type ShapeKind = "rectangle" | "circle" | "lshape" | "ushape";
/** What a polygon is in the venue. */
export type AreaKind = "walkable" | "obstacle" | "destination";

export const SHAPES: ShapeKind[] = ["rectangle", "circle", "lshape", "ushape"];
export const AREA_KINDS: AreaKind[] = ["walkable", "obstacle", "destination"];

/** Corners of a shape fitted into the box spanned by a and b (any two opposite corners). */
export function shapePoints(shape: ShapeKind, a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const w = x1 - x0;
  const h = y1 - y0;
  switch (shape) {
    case "rectangle":
      return [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
    case "circle": {
      // An ellipse as a 24-sided polygon (the engine works with polygons).
      const n = 24;
      const cx = x0 + w / 2;
      const cy = y0 + h / 2;
      return Array.from({ length: n }, (_, k) => ({ x: cx + (w / 2) * Math.cos((2 * Math.PI * k) / n), y: cy + (h / 2) * Math.sin((2 * Math.PI * k) / n) }));
    }
    case "lshape": {
      // An L: the full height on the left, the full width along the bottom, arms 40% thick.
      const tx = w * 0.4;
      const ty = h * 0.4;
      return [
        { x: x0, y: y0 },
        { x: x0 + tx, y: y0 },
        { x: x0 + tx, y: y1 - ty },
        { x: x1, y: y1 - ty },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
    }
    case "ushape": {
      // A U open at the top: two side arms and a bottom, each 30% thick.
      const tx = w * 0.3;
      const ty = h * 0.3;
      return [
        { x: x0, y: y0 },
        { x: x0 + tx, y: y0 },
        { x: x0 + tx, y: y1 - ty },
        { x: x1 - tx, y: y1 - ty },
        { x: x1 - tx, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ];
    }
  }
}

/** A box too small to be meant (a click rather than a drag): metres. */
export const MIN_SHAPE_METRES = 0.5;

export function addShape(v: Venue, kind: AreaKind, shape: ShapeKind, a: Point, b: Point): { venue: Venue; id: string } | null {
  if (Math.abs(a.x - b.x) < MIN_SHAPE_METRES || Math.abs(a.y - b.y) < MIN_SHAPE_METRES) return null;
  return addPolygon(v, kind, shapePoints(shape, a, b));
}

const round = (x: number) => Math.round(x * 100) / 100;
const shift = (p: Point, dx: number, dy: number): Point => ({ x: round(p.x + dx), y: round(p.y + dy) });

/** Moves one element (polygon, source or lane line) by (dx, dy); the same venue if no element has that id. */
export function moveElement(v: Venue, id: string, dx: number, dy: number): Venue {
  const ring = (r: readonly Point[]) => r.map((p) => shift(p, dx, dy));
  if (v.walkableAreas.some((e) => e.id === id)) return { ...v, walkableAreas: v.walkableAreas.map((e) => (e.id === id ? { ...e, polygon: { ...e.polygon, outer: ring(e.polygon.outer), holes: e.polygon.holes?.map(ring) } } : e)) };
  if (v.obstacles.some((e) => e.id === id)) return { ...v, obstacles: v.obstacles.map((e) => (e.id === id ? { ...e, polygon: { ...e.polygon, outer: ring(e.polygon.outer), holes: e.polygon.holes?.map(ring) } } : e)) };
  if (v.destinations.some((e) => e.id === id)) return { ...v, destinations: v.destinations.map((e) => (e.id === id ? { ...e, area: { ...e.area, outer: ring(e.area.outer), holes: e.area.holes?.map(ring) } } : e)) };
  if (v.sources.some((e) => e.id === id)) return { ...v, sources: v.sources.map((e) => (e.id === id ? { ...e, position: shift(e.position, dx, dy) } : e)) };
  if (v.gateGroups.some((e) => e.id === id)) return { ...v, gateGroups: v.gateGroups.map((e) => (e.id === id ? { ...e, line: { a: shift(e.line.a, dx, dy), b: shift(e.line.b, dx, dy) } } : e)) };
  if (v.screeningStages.some((e) => e.id === id)) return { ...v, screeningStages: v.screeningStages.map((e) => (e.id === id ? { ...e, line: { a: shift(e.line.a, dx, dy), b: shift(e.line.b, dx, dy) } } : e)) };
  if ((v.roads ?? []).some((e) => e.id === id)) return { ...v, roads: (v.roads ?? []).map((e) => (e.id === id ? { ...e, points: ring(e.points) } : e)) };
  return v;
}

/** The outer ring of a polygon element, or null for anything else. */
export function polygonOf(v: Venue, id: string): { kind: AreaKind; ring: Point[] } | null {
  const w = v.walkableAreas.find((e) => e.id === id);
  if (w) return { kind: "walkable", ring: w.polygon.outer };
  const o = v.obstacles.find((e) => e.id === id);
  if (o) return { kind: "obstacle", ring: o.polygon.outer };
  const d = v.destinations.find((e) => e.id === id);
  if (d) return { kind: "destination", ring: d.area.outer };
  return null;
}

/** Turns a polygon into another kind (a walkable area into an obstacle, …). It gets a new id of the new kind. */
export function changeKind(v: Venue, id: string, kind: AreaKind): { venue: Venue; id: string } {
  const p = polygonOf(v, id);
  if (!p || p.kind === kind) return { venue: v, id };
  return addPolygon(deleteElement(v, id), kind, p.ring);
}

/** A copy of an element, a few metres down and to the right, with a new id. */
export function duplicateElement(v: Venue, id: string, offset = 3): { venue: Venue; id: string } | null {
  const p = polygonOf(v, id);
  if (p) return addPolygon(v, p.kind, p.ring.map((q) => shift(q, offset, offset)));
  const s = v.sources.find((e) => e.id === id);
  if (s) {
    const nid = nextId(v, "source");
    return { venue: { ...v, sources: [...v.sources, { ...s, id: nid, name: `${s.name} (copy)`, position: shift(s.position, offset, offset), share: 0 }] }, id: nid };
  }
  const g = v.gateGroups.find((e) => e.id === id);
  if (g) {
    const nid = nextId(v, "gate");
    return { venue: { ...v, gateGroups: [...v.gateGroups, { ...g, id: nid, name: `${g.name} (copy)`, line: { a: shift(g.line.a, offset, offset), b: shift(g.line.b, offset, offset) } }] }, id: nid };
  }
  return null;
}

/** Ray-casting point-in-polygon. */
export function pointInRing(ring: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** The topmost polygon element under p: obstacles and destinations above walkable areas, later drawn above earlier. */
export function elementAt(v: Venue, p: Point): string | null {
  for (const list of [v.obstacles.map((e) => ({ id: e.id, r: e.polygon.outer })), v.destinations.map((e) => ({ id: e.id, r: e.area.outer })), v.walkableAreas.map((e) => ({ id: e.id, r: e.polygon.outer }))]) {
    for (let k = list.length - 1; k >= 0; k--) {
      const e = list[k] as { id: string; r: Point[] };
      if (pointInRing(e.r, p)) return e.id;
    }
  }
  return null;
}
