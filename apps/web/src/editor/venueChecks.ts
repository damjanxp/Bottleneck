/**
 * Checks a venue before the editor saves it (D-066), in plain sentences:
 * 1. the JSON Schema (the same /schema the server validates against), compiled at build time;
 * 2. what the schema cannot say: unique ids, references between elements (a gate's screening
 *    stage, a barrier's road, a lot's barriers), polygons that cross themselves, sources and lines
 *    outside every walkable area;
 * 3. walking reachability, computed by the engine on the same grid a run uses
 *    (`checkWalkingReachability`), so "unreachable" means what it means in a simulation.
 *
 * Errors block saving; warnings do not (a run copes, but the result is probably not what was meant).
 * Pure: the schema validator is passed in.
 */

import { checkWalkingReachability } from "@bottleneck/engine";
import type { Point, Polygon, Venue } from "@bottleneck/schema";
import { schemaMessages, type SchemaValidator } from "../library/validate.ts";
import { area, isDegenerateOrSelfIntersecting } from "./geometry.ts";
import { components, makeGrid, rasterizePolygon, ringBox } from "./raster.ts";

export interface VenueProblem {
  severity: "error" | "warning";
  /** The element the problem is about (for highlighting), or "" for the whole venue. */
  elementId: string;
  message: string;
  /** A one-click repair that applies to every problem of this kind. */
  fix?: "removeTiny" | "removeIsolated";
}

/** Shapes smaller than this (m²) are almost always map noise. */
export const TINY_AREA = 4;

interface Named {
  id?: string;
  name?: string;
}

const label = (e: Named, what: string) => `${what} “${e.name ?? e.id ?? "?"}”`;

function insideRing(ring: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function insidePolygon(poly: Polygon, p: Point): boolean {
  return insideRing(poly.outer, p) && !(poly.holes ?? []).some((h) => insideRing(h, p));
}

function onWalkableArea(v: Venue, p: Point): boolean {
  return v.walkableAreas.some((w) => insidePolygon(w.polygon, p));
}

/** Schema problems only (fast; run on every edit). */
export function schemaProblems(v: unknown, validate: SchemaValidator): VenueProblem[] {
  const r = validate(v);
  return r.ok ? [] : schemaMessages(r.errors).map((message) => ({ severity: "error", elementId: "", message }));
}

/** Checks the schema cannot express. Assumes a schema-valid venue. */
export function structureProblems(v: Venue): VenueProblem[] {
  const out: VenueProblem[] = [];
  const err = (elementId: string, message: string) => out.push({ severity: "error", elementId, message });
  const warn = (elementId: string, message: string) => out.push({ severity: "warning", elementId, message });

  // The basics a simulation needs.
  if (!v.walkableAreas.some((w) => area(w.polygon.outer) > 0)) err("", "Draw at least one walkable area: people can only walk there.");
  if (v.sources.length === 0 && (v.vehicleSources ?? []).length === 0) err("", "Add at least one source: where people arrive.");
  if (v.destinations.length === 0) err("", "Add at least one destination: where people are going.");

  // Unique ids across the whole venue (scenario overrides and events refer to elements by id).
  const groups: [string, readonly Named[]][] = [
    ["walkable area", v.walkableAreas],
    ["obstacle", v.obstacles],
    ["source", v.sources],
    ["screening stage", v.screeningStages],
    ["gate group", v.gateGroups],
    ["destination", v.destinations],
    ["road", v.roads ?? []],
    ["vehicle source", v.vehicleSources ?? []],
    ["barrier", v.vehicleBarriers ?? []],
    ["car park", v.parkingLots ?? []],
    ["crossing", v.crossings ?? []],
  ];
  const seen = new Map<string, string>();
  for (const [what, list] of groups) {
    for (const e of list) {
      if (e.id === undefined) continue;
      const before = seen.get(e.id);
      if (before !== undefined) err(e.id, `The id “${e.id}” is used twice (${before} and ${what}); every element needs its own id.`);
      else seen.set(e.id, what);
    }
  }

  // References.
  const screeningIds = new Set(v.screeningStages.map((s) => s.id));
  for (const g of v.gateGroups) {
    if (g.screeningStageId !== undefined && !screeningIds.has(g.screeningStageId)) err(g.id, `${label(g, "Gate group")} refers to a screening stage “${g.screeningStageId}” that does not exist.`);
  }
  const roadIds = new Set((v.roads ?? []).map((r) => r.id));
  for (const b of v.vehicleBarriers ?? []) {
    if (!roadIds.has(b.roadId)) err(b.id, `${label(b, "Barrier")} stands on a road “${b.roadId}” that does not exist.`);
  }
  const barrierIds = new Set((v.vehicleBarriers ?? []).map((b) => b.id));
  for (const lot of v.parkingLots ?? []) {
    for (const id of [...lot.entryBarrierIds, ...lot.exitBarrierIds]) {
      if (!barrierIds.has(id)) err(lot.id, `${label(lot, "Car park")} uses a barrier “${id}” that does not exist.`);
    }
  }
  const lotIds = new Set((v.parkingLots ?? []).map((l) => l.id));
  for (const s of v.vehicleSources ?? []) {
    if (s.lotId !== undefined && !lotIds.has(s.lotId)) err(s.id, `${label(s, "Vehicle source")} sends cars to a car park “${s.lotId}” that does not exist.`);
  }

  // Polygons.
  const polys: [string, Named, Polygon][] = [
    ...v.walkableAreas.map((w): [string, Named, Polygon] => ["Walkable area", w, w.polygon]),
    ...v.obstacles.map((o): [string, Named, Polygon] => ["Obstacle", o, o.polygon]),
    ...v.destinations.map((d): [string, Named, Polygon] => ["Destination", d, d.area]),
    ...(v.parkingLots ?? []).map((l): [string, Named, Polygon] => ["Car park", l, l.outline]),
  ];
  for (const [what, e, poly] of polys) {
    if (isDegenerateOrSelfIntersecting(poly)) err(e.id ?? "", `${label(e, what)} crosses itself or has no area. Move a corner so that its edges do not cross.`);
  }

  // Positions.
  for (const s of v.sources) {
    if (!onWalkableArea(v, s.position)) warn(s.id, `${label(s, "Source")} is outside every walkable area; people will start at the nearest walkable spot.`);
  }
  for (const g of [...v.screeningStages, ...v.gateGroups]) {
    if (!onWalkableArea(v, g.line.a) || !onWalkableArea(v, g.line.b)) warn(g.id, `${label(g, "Lane line")} has an end outside the walkable areas; some lanes may be unusable.`);
  }
  if (v.gateGroups.length === 0 && v.screeningStages.length === 0 && (v.parkingLots ?? []).length === 0) {
    warn("", "The venue has no gates: people walk straight to a destination and nothing queues.");
  }
  const shareSum = v.sources.reduce((s, x) => s + x.share, 0);
  if (v.sources.length > 0 && Math.abs(shareSum - 1) > 1e-6) warn("", `The sources' shares add up to ${shareSum.toFixed(2)}, not 1; the simulation scales them to 1.`);
  return out;
}

/** Walking reachability from the engine. Assumes a schema-valid venue without structure errors. */
export function reachabilityProblems(v: Venue): VenueProblem[] {
  const byId = new Map<string, Named>([...v.sources, ...v.screeningStages, ...v.gateGroups].map((e) => [e.id, e]));
  let issues: ReturnType<typeof checkWalkingReachability>;
  try {
    issues = checkWalkingReachability(v);
  } catch (e) {
    // The engine refuses a venue it cannot model; say why instead of failing the page.
    return [{ severity: "error", elementId: "", message: `The simulation cannot use this venue: ${e instanceof Error ? e.message : String(e)}.` }];
  }
  return issues.map((i): VenueProblem => {
    switch (i.kind) {
      case "sourceUnreachable":
        return { severity: "error", elementId: i.sourceId, message: `${label(byId.get(i.sourceId) ?? { id: i.sourceId }, "Source")} cannot reach any entry lane on foot: connect its walkable area to the gates.` };
      case "exitUnreachable":
        return { severity: "error", elementId: i.elementId, message: `People leaving ${label(byId.get(i.elementId) ?? { id: i.elementId }, "lane line")} cannot walk on to the next stage or a destination.` };
      case "noDestination":
        return { severity: "error", elementId: "", message: "No destination can be reached: draw a destination area on a walkable area." };
    }
  });
}

/**
 * Clean-up warnings for imported or painted venues: tiny shapes (noise) and walkable areas no
 * source can reach on foot (islands). Each comes with a one-click repair.
 */
export function cleanupProblems(v: Venue): VenueProblem[] {
  const out: VenueProblem[] = [];
  const shapes: { what: string; e: Named & { id: string }; poly: Polygon }[] = [
    ...v.walkableAreas.map((e) => ({ what: "Walkable area", e, poly: e.polygon })),
    ...v.obstacles.map((e) => ({ what: "Obstacle", e, poly: e.polygon })),
    ...v.destinations.map((e) => ({ what: "Destination", e, poly: e.area })),
  ];
  const tiny = new Set<string>();
  for (const { what, e, poly } of shapes) {
    const a = area(poly.outer);
    if (a < TINY_AREA) {
      tiny.add(e.id);
      out.push({ severity: "warning", elementId: e.id, message: `${label(e, what)} is tiny (${a.toFixed(1)} m²): probably map noise.`, fix: "removeTiny" });
    }
  }
  for (const id of isolatedWalkable(v)) {
    if (tiny.has(id)) continue;
    const e = v.walkableAreas.find((w) => w.id === id);
    if (e) out.push({ severity: "warning", elementId: id, message: `${label(e, "Walkable area")} cannot be reached from any source: an island nobody walks to.`, fix: "removeIsolated" });
  }
  return out;
}

/** Ids of walkable areas that no source can reach on foot (through walkable areas, around obstacles). */
export function isolatedWalkable(v: Venue): string[] {
  if (v.sources.length === 0 || v.walkableAreas.length < 2) return [];
  const box = ringBox(v.walkableAreas.map((w) => w.polygon.outer));
  const extent = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  const g = makeGrid(box, Math.min(2, Math.max(0.5, extent / 500)));
  for (const w of v.walkableAreas) rasterizePolygon(g, w.polygon, 1);
  for (const o of v.obstacles) rasterizePolygon(g, o.polygon, 0);
  const { labels } = components(g.data, g.w, g.h);
  const reached = new Set<number>();
  for (const s of v.sources) {
    const i = Math.floor((s.position.x - g.x0) / g.cell);
    const j = Math.floor((s.position.y - g.y0) / g.cell);
    // The source's own cell, or the nearest walkable cell within a few metres.
    let found = 0;
    for (let r = 0; r <= 6 && !found; r++)
      for (let dj = -r; dj <= r && !found; dj++)
        for (let di = -r; di <= r && !found; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii < g.w && jj < g.h) found = labels[jj * g.w + ii] as number;
        }
    if (found) reached.add(found);
  }
  const out: string[] = [];
  for (const w of v.walkableAreas) {
    const one = { ...g, data: new Uint8Array(g.w * g.h) };
    rasterizePolygon(one, w.polygon, 1);
    let ok = false;
    let any = false;
    for (let k = 0; k < one.data.length && !ok; k++)
      if (one.data[k]) {
        any = true;
        if (reached.has(labels[k] as number)) ok = true;
      }
    if (any && !ok) out.push(w.id);
  }
  return out;
}

/** All checks in order; later stages run only if the earlier ones found no errors. */
export function checkVenue(data: unknown, validate: SchemaValidator): VenueProblem[] {
  const schema = schemaProblems(data, validate);
  if (schema.length > 0) return schema;
  const v = data as Venue;
  const structure = structureProblems(v);
  const cleanup = cleanupProblems(v);
  if (structure.some((p) => p.severity === "error")) return [...structure, ...cleanup];
  return [...structure, ...cleanup, ...reachabilityProblems(v)];
}

/** Applies a one-click repair: removes the tiny shapes, or the walkable islands. */
export function applyFix(v: Venue, problems: readonly VenueProblem[], fix: NonNullable<VenueProblem["fix"]>): Venue {
  const ids = new Set(problems.filter((p) => p.fix === fix).map((p) => p.elementId));
  return {
    ...v,
    walkableAreas: v.walkableAreas.filter((e) => !ids.has(e.id)),
    obstacles: v.obstacles.filter((e) => !ids.has(e.id)),
    destinations: v.destinations.filter((e) => !ids.has(e.id)),
  };
}

export function hasErrors(problems: readonly VenueProblem[]): boolean {
  return problems.some((p) => p.severity === "error");
}
