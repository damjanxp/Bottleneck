/**
 * Painting and erasing areas of one kind in a venue (redesign 3): the shapes of that kind that the
 * stroke touches are merged with the stroke on a grid and turned back into polygons (raster.ts).
 * Shapes the stroke does not touch stay exactly as they were. Pure.
 */

import type { Point, Polygon, Venue } from "@bottleneck/schema";
import { nextId } from "./edits.ts";
import { boxesOverlap, gridToPolygons, makeGrid, paintStroke, rasterizePolygon, ringBox, type Box, type Grid } from "./raster.ts";
import type { AreaKind } from "./shapes.ts";

interface Area {
  id: string;
  name?: string;
  polygon: Polygon;
}

function areasOf(v: Venue, kind: AreaKind): Area[] {
  if (kind === "walkable") return v.walkableAreas.map((e) => ({ id: e.id, name: e.name, polygon: e.polygon }));
  if (kind === "obstacle") return v.obstacles.map((e) => ({ id: e.id, name: e.name, polygon: e.polygon }));
  return v.destinations.map((e) => ({ id: e.id, name: e.name, polygon: e.area }));
}

function withAreas(v: Venue, kind: AreaKind, keep: (id: string) => boolean, added: { id: string; name: string; polygon: Polygon }[]): Venue {
  if (kind === "walkable") return { ...v, walkableAreas: [...v.walkableAreas.filter((e) => keep(e.id)), ...added.map((a) => ({ id: a.id, name: a.name, polygon: a.polygon }))] };
  if (kind === "obstacle") return { ...v, obstacles: [...v.obstacles.filter((e) => keep(e.id)), ...added.map((a) => ({ id: a.id, name: a.name, polygon: a.polygon }))] };
  return { ...v, destinations: [...v.destinations.filter((e) => keep(e.id)), ...added.map((a) => ({ id: a.id, name: a.name, area: a.polygon }))] };
}

const PREFIX: Record<AreaKind, string> = { walkable: "area", obstacle: "obstacle", destination: "destination" };
const DEFAULT_NAME: Record<AreaKind, string> = { walkable: "Walkable area", obstacle: "Obstacle", destination: "Destination" };

/** Grid cell size for a brush of radius r: fine enough to keep its shape. */
export function cellFor(radius: number): number {
  return Math.max(0.1, Math.min(1, radius / 3));
}

/**
 * Applies `paint` (which sets or clears cells) to the shapes of `kind` within `box`, merges, and
 * returns the venue with the merged shapes. `id` is the largest resulting shape (to select it).
 */
export function applyPaint(v: Venue, kind: AreaKind, box: Box, cell: number, paint: (g: Grid) => void, minArea = Math.max(0.5, cell * cell * 4)): { venue: Venue; id: string | null } {
  const touched = areasOf(v, kind).filter((a) => boxesOverlap(ringBox([a.polygon.outer]), box, cell * 2));
  const all = [box, ...touched.map((a) => ringBox([a.polygon.outer]))];
  const union = { minX: Math.min(...all.map((b) => b.minX)), minY: Math.min(...all.map((b) => b.minY)), maxX: Math.max(...all.map((b) => b.maxX)), maxY: Math.max(...all.map((b) => b.maxY)) };
  const g = makeGrid(union, cell);
  for (const a of touched) rasterizePolygon(g, a.polygon, 1);
  paint(g);
  const polys = gridToPolygons(g, minArea, 1.2).sort((p, q) => ringArea(q.outer) - ringArea(p.outer));
  const gone = new Set(touched.map((a) => a.id));
  // The largest result keeps the first touched shape's id and name; the others get new ids.
  let scratch = withAreas(v, kind, (id) => !gone.has(id), []);
  const added: { id: string; name: string; polygon: Polygon }[] = [];
  polys.forEach((polygon, k) => {
    const reuse = k === 0 ? touched[0] : undefined;
    const id = reuse?.id ?? nextId(scratch, PREFIX[kind]);
    const name = reuse?.name ?? `${DEFAULT_NAME[kind]} ${id.split("-").pop()}`;
    added.push({ id, name, polygon });
    scratch = withAreas(scratch, kind, () => true, [{ id, name, polygon }]);
  });
  return { venue: withAreas(v, kind, (id) => !gone.has(id), added), id: added[0]?.id ?? null };
}

/** A brush stroke of radius r along `path`: paint (erase = false) or erase. */
export function paintPath(v: Venue, kind: AreaKind, path: readonly Point[], radius: number, erase = false): { venue: Venue; id: string | null } {
  const b = ringBox([path]);
  const box = { minX: b.minX - radius, minY: b.minY - radius, maxX: b.maxX + radius, maxY: b.maxY + radius };
  return applyPaint(v, kind, box, cellFor(radius), (g) => paintStroke(g, path, radius, erase ? 0 : 1));
}

/** Adds a polygon of `kind`, merged with the shapes of that kind it overlaps or touches. */
export function mergePolygon(v: Venue, kind: AreaKind, polygon: Polygon, cell = 0.25): { venue: Venue; id: string | null } {
  return applyPaint(v, kind, ringBox([polygon.outer]), cell, (g) => rasterizePolygon(g, polygon, 1));
}

function ringArea(r: readonly Point[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += ((r[j] as Point).x + (r[i] as Point).x) * ((r[j] as Point).y - (r[i] as Point).y);
  return Math.abs(s / 2);
}
