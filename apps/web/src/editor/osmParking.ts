/**
 * Car parks from an OpenStreetMap import (D-074). OpenStreetMap maps a car park as an outline
 * (amenity=parking), sometimes with aisles and a capacity, but not with barriers, stall rows or
 * how it joins the road network in the engine's terms (D-041 to D-044). So each car park gets:
 *
 * - **aisles:** a regular layout inside the outline: aisles along its longest side, 16 m apart
 *   (5 m stalls, 6 m aisle, 5 m stalls), joined by a spine along their starts;
 * - **stall rows** on both sides of every aisle, 2.5 m per stall (scaled down to the `capacity` tag
 *   when there is one);
 * - **an entry and an exit road** (one-way each, overlapping) from the nearest road to the start of
 *   the spine, with a ticket barrier on each: the only way in and out, so no car bypasses them;
 * - **a walking exit** on the outline, on the side facing the rest of the venue.
 *
 * OpenStreetMap's own aisles and service roads inside the car park are dropped (they would let
 * cars bypass the barriers). Pure.
 */

import type { ParkingLot, Point, Road, VehicleBarrier, VehicleSource } from "@bottleneck/schema";

const MODULE = 16; // metres between aisle centre lines
const STALL_WIDTH = 2.5;
const ROW_OFFSET = 3; // aisle centre to the stall row line (half the 6 m aisle)
const INSET = 3; // aisle ends kept away from the outline

export interface CarParkInput {
  name: string;
  outline: Point[];
  capacity: number | null;
}

export interface CarParkResult {
  lots: ParkingLot[];
  barriers: VehicleBarrier[];
  /** Entry and exit connector roads to add. */
  connectors: Road[];
  /** Ids of imported roads to drop (aisles and service roads inside a car park). */
  dropRoads: Set<string>;
  stalls: number;
}

const r2 = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

export function pointInRing(ring: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function nearestOnPolyline(line: readonly Point[], p: Point): { point: Point; d: number } {
  let best = { point: line[0] as Point, d: Infinity };
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1] as Point;
    const b = line[k] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { point: q, d };
  }
  return best;
}

/** The x-ranges where a horizontal line at y crosses inside a ring (pairs, sorted). */
function rowSpans(ring: readonly Point[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Point;
    const b = ring[j] as Point;
    if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k] as number, xs[k + 1] as number]);
  return out;
}

/** Aisles and stall rows for one outline, in venue coordinates; null if it is too small. */
export function layoutCarPark(outline: readonly Point[]): { aisles: Point[][]; rows: { a: Point; b: Point; side: "left" | "right"; count: number }[]; spineStart: Point } | null {
  // Local frame along the outline's longest edge.
  let ex = 1;
  let ey = 0;
  let longest = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] as Point;
    const b = outline[(i + 1) % outline.length] as Point;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > longest) {
      longest = l;
      ex = (b.x - a.x) / l;
      ey = (b.y - a.y) / l;
    }
  }
  const toLocal = (p: Point): Point => ({ x: p.x * ex + p.y * ey, y: -p.x * ey + p.y * ex });
  const toVenue = (p: Point): Point => ({ x: p.x * ex - p.y * ey, y: p.x * ey + p.y * ex });
  const local = outline.map(toLocal);
  const minV = Math.min(...local.map((p) => p.y));
  const maxV = Math.max(...local.map((p) => p.y));
  const aislesLocal: [Point, Point][] = [];
  for (let v = minV + MODULE / 2; v <= maxV - 5; v += MODULE) {
    const spans = rowSpans(local, v);
    const best = spans.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (!best || best[1] - best[0] - 2 * INSET < 10) continue;
    aislesLocal.push([
      { x: best[0] + INSET, y: v },
      { x: best[1] - INSET, y: v },
    ]);
  }
  if (aislesLocal.length === 0) {
    // A narrow car park: one aisle along its middle.
    const v = (minV + maxV) / 2;
    const best = rowSpans(local, v).sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (!best || best[1] - best[0] - 2 * INSET < 10) return null;
    aislesLocal.push([
      { x: best[0] + INSET, y: v },
      { x: best[1] - INSET, y: v },
    ]);
  }
  const aisles = aislesLocal.map(([a, b]) => [r2(toVenue(a)), r2(toVenue(b))]);
  // A spine through the aisles' starts, so every aisle is reachable from the first.
  if (aisles.length > 1) aisles.push(aisles.map((a) => a[0] as Point));
  const rows: { a: Point; b: Point; side: "left" | "right"; count: number }[] = [];
  for (const [a, b] of aislesLocal) {
    const count = Math.floor((b.x - a.x) / STALL_WIDTH);
    if (count < 1) continue;
    // Row lines 3 m either side of the aisle; stalls on the far side of each line (y down: +v is "right" of a→b).
    rows.push({ a: r2(toVenue({ x: a.x, y: a.y - ROW_OFFSET })), b: r2(toVenue({ x: b.x, y: b.y - ROW_OFFSET })), side: "left", count });
    rows.push({ a: r2(toVenue({ x: a.x, y: a.y + ROW_OFFSET })), b: r2(toVenue({ x: b.x, y: b.y + ROW_OFFSET })), side: "right", count });
  }
  return { aisles, rows, spineStart: aisles[0]?.[0] as Point };
}

/**
 * Which roads connect (the engine's rule, D-041): an end point within 1 m of another road's end
 * point or line joins the two. Returns a component number per road.
 */
export function roadComponents(roads: readonly Road[]): number[] {
  const parent = roads.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] as number)));
  const join = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  roads.forEach((r, i) => {
    const ends = [r.points[0] as Point, r.points[r.points.length - 1] as Point];
    roads.forEach((q, j) => {
      if (i === j) return;
      if (ends.some((e) => nearestOnPolyline(q.points, e).d <= 1)) join(i, j);
    });
  });
  return roads.map((_, i) => find(i));
}

/**
 * Builds the car parks. `roads` are the imported roads (with `service` per road id, to recognise
 * aisles); `focus` is where people are going (the walking exit faces it).
 */
export function buildCarParks(parks: readonly CarParkInput[], roads: readonly Road[], serviceOf: (roadId: string) => string | undefined, focus: Point, box: { w: number; h: number }): CarParkResult {
  const lots: ParkingLot[] = [];
  const barriers: VehicleBarrier[] = [];
  const connectors: Road[] = [];
  const dropRoads = new Set<string>();
  let stalls = 0;
  // Roads inside a car park (or aisles crossing it) are dropped: the generated aisles replace them.
  for (const r of roads) {
    const inside = r.points.filter((p) => parks.some((pk) => pointInRing(pk.outline, p))).length;
    const aisle = serviceOf(r.id) === "parking_aisle";
    if ((aisle && inside > 0) || (!r.publicRoad && inside === r.points.length)) dropRoads.add(r.id);
  }
  const kept = roads.filter((r) => !dropRoads.has(r.id));
  // Cars come in where public roads leave the map: car parks join the roads connected to those.
  const comp = roadComponents(kept);
  const onEdge = (p: Point) => p.x < 1 || p.y < 1 || p.x > box.w - 1 || p.y > box.h - 1;
  const fed = new Set(kept.flatMap((r, i) => (r.publicRoad && (onEdge(r.points[0] as Point) || onEdge(r.points[r.points.length - 1] as Point)) ? [comp[i]] : [])));
  const reachable = kept.filter((_, i) => fed.has(comp[i] as number));
  const candidates = reachable.length > 0 ? reachable : kept;
  parks.forEach((pk, k) => {
    const layout = layoutCarPark(pk.outline);
    if (!layout || kept.length === 0) return;
    // Scale the rows to the mapped capacity, if any.
    let total = layout.rows.reduce((s, r) => s + r.count, 0);
    if (pk.capacity && pk.capacity > 0 && pk.capacity < total) {
      const f = pk.capacity / total;
      for (const r of layout.rows) r.count = Math.max(1, Math.floor(r.count * f));
      total = layout.rows.reduce((s, r) => s + r.count, 0);
    }
    stalls += total;
    // The access: the nearest point on a kept road to the spine's start.
    let access: { point: Point; d: number } | null = null;
    for (const r of candidates) {
      const near = nearestOnPolyline(r.points, layout.spineStart);
      if (!access || near.d < access.d) access = near;
    }
    if (!access) return;
    const n = k + 1;
    const lotId = `car-park-${n}`;
    const entryRoad = `car-park-${n}-in`;
    const exitRoad = `car-park-${n}-out`;
    const a = r2(access.point);
    const s = layout.spineStart;
    const along = (from: Point, to: Point, t: number) => r2({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    connectors.push({ id: entryRoad, name: `${pk.name}: way in`, points: [a, s], direction: "oneWay", laneCount: 1 });
    connectors.push({ id: exitRoad, name: `${pk.name}: way out`, points: [s, a], direction: "oneWay", laneCount: 1 });
    barriers.push({ id: `${lotId}-entry`, name: `${pk.name}: entry barrier`, roadId: entryRoad, position: along(a, s, 0.7), kind: "entry", laneCount: 1, serviceType: "ticket" });
    barriers.push({ id: `${lotId}-exit`, name: `${pk.name}: exit barrier`, roadId: exitRoad, position: along(s, a, 0.3), kind: "exit", laneCount: 1, serviceType: "ticket" });
    // Walking exit: the outline point nearest to where people are going.
    const walkingExit = r2(nearestOnPolyline([...pk.outline, pk.outline[0] as Point], focus).point);
    lots.push({
      id: lotId,
      name: pk.name,
      outline: { outer: pk.outline.map(r2) },
      stallRows: layout.rows,
      aisles: layout.aisles.map((points, i) => ({ id: `${lotId}-aisle-${i + 1}`, points })),
      entryBarrierIds: [`${lotId}-entry`],
      exitBarrierIds: [`${lotId}-exit`],
      walkingExit,
      stallChoice: "nearestWalkingExit",
      overflow: { rule: "leave" },
    });
  });
  // A full car park sends cars on to the largest other one (once; a second full one turns them away).
  const bySize = [...lots].sort((a, b) => stallCount(b) - stallCount(a));
  for (const l of lots) {
    const to = bySize.find((o) => o.id !== l.id);
    if (to) l.overflow = { rule: "divert", divertTo: to.id };
  }
  return { lots, barriers, connectors, dropRoads, stalls };
}

const stallCount = (l: ParkingLot) => (l.stallRows ?? []).reduce((n, r) => n + r.count * (r.side === "both" ? 2 : 1), 0) + (l.stalls?.length ?? 0);

/**
 * Car sources where public roads leave the map (at most 6 places), on roads connected to the car
 * parks. Each place gets one source per car park it can reach, with a share in proportion to that
 * car park's stalls, so cars spread over the car parks as drivers would (a source without a lot
 * would send every car to the single quickest one).
 */
export function edgeSources(roads: readonly Road[], lots: readonly ParkingLot[], barriers: readonly VehicleBarrier[], box: { w: number; h: number }): VehicleSource[] {
  const onEdge = (p: Point) => p.x < 1 || p.y < 1 || p.x > box.w - 1 || p.y > box.h - 1;
  const comp = roadComponents(roads);
  const compOf = new Map(roads.map((r, i) => [r.id, comp[i] as number]));
  const lotComp = new Map(lots.map((l) => [l.id, compOf.get(barriers.find((b) => b.id === l.entryBarrierIds[0])?.roadId ?? "") ?? -1]));
  const ends: { p: Point; name: string; comp: number }[] = [];
  roads.forEach((r, i) => {
    if (!r.publicRoad) return;
    for (const p of [r.points[0] as Point, r.points[r.points.length - 1] as Point]) {
      if (!onEdge(p) || ends.some((e) => Math.hypot(e.p.x - p.x, e.p.y - p.y) < 30)) continue;
      // A one-way road only brings cars in at its start.
      if (r.direction === "oneWay" && p !== r.points[0]) continue;
      ends.push({ p, name: `${r.name ?? r.id} (edge of the map)`, comp: comp[i] as number });
    }
  });
  const out: VehicleSource[] = [];
  ends
    .filter((e) => lots.some((l) => lotComp.get(l.id) === e.comp))
    .slice(0, 6)
    .forEach((e, k) => {
      const mine = lots.filter((l) => lotComp.get(l.id) === e.comp);
      const total = mine.reduce((n, l) => n + stallCount(l), 0) || 1;
      for (const l of mine)
        out.push({ id: `cars-${k + 1}-${l.id}`, name: `${e.name} → ${l.name}`.slice(0, 120), position: r2(e.p), share: Math.max(0.0001, Math.round((stallCount(l) / total) * 10000) / 10000), lotId: l.id });
    });
  return out;
}
