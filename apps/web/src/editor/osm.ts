/**
 * Importing an OpenStreetMap export (.osm XML, from "Export" on openstreetmap.org) as a venue
 * (redesign 5, D-073). OpenStreetMap says what every line and area *is* (road, footway, sidewalk,
 * crossing, building, car park, fence, water, rail), so nothing is guessed from colours:
 *
 * - roads for cars become venue roads (lanes, one-way and speed from the tags; streets public,
 *   service roads and car-park aisles not);
 * - buildings, water and rail lines become obstacles;
 * - walkable ground is worked out on a grid: the site (exhibition grounds, squares, parks, car
 *   parks; the whole box if the export has no site), minus buildings, public streets, rail, water
 *   and fences (service roads and car-park aisles are shared with people), plus every footway, sidewalk, path, step and crossing (so crossings join the blocks
 *   that roads separate);
 * - where a footway or a driveway crosses a fence (or at a mapped gate or entrance), a gate group
 *   is suggested, with the fence left open there;
 * - public-transport stops become sources.
 *
 * Everything is clipped to the export's bounding box. Venue coordinates: metres, x east, y south,
 * the box's north-west corner at (0, 0). Pure: XML text in, venue out (a small regex reader; OSM
 * XML is simple and regular).
 */

import type { Point, Polygon, Road, Venue } from "@bottleneck/schema";
import { SERVICE_TIME_PRESETS } from "@bottleneck/engine";
import { gridToPolygons, makeGrid, paintStroke, rasterizePolygon, type Grid } from "./raster.ts";
import { simplifyPath } from "./trace.ts";

export interface OsmData {
  bounds: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  nodes: Map<string, { lat: number; lon: number; tags: Record<string, string> }>;
  ways: { id: string; refs: string[]; tags: Record<string, string> }[];
  relations: { id: string; members: { type: string; ref: string; role: string }[]; tags: Record<string, string> }[];
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const attr = (s: string, k: string) => {
  const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s);
  return m ? unescape(m[1] as string) : undefined;
};
function tagsOf(body: string): Record<string, string> {
  const t: Record<string, string> = {};
  for (const m of body.matchAll(/<tag\s+([^>]*?)\/>/g)) {
    const k = attr(m[1] as string, "k");
    const v = attr(m[1] as string, "v");
    if (k !== undefined && v !== undefined) t[k] = v;
  }
  return t;
}

export class OsmError extends Error {}

/** Reads OSM XML. Throws OsmError if it is not an OSM file or has no bounding box. */
export function parseOsm(xml: string): OsmData {
  if (!/<osm[\s>]/.test(xml)) throw new OsmError("This is not an OpenStreetMap (.osm) file.");
  const b = /<bounds\s+([^>]*?)\/>/.exec(xml);
  if (!b) throw new OsmError("The file has no bounding box (<bounds>). Export it with “Export” on openstreetmap.org.");
  const bounds = { minlat: Number(attr(b[1] as string, "minlat")), minlon: Number(attr(b[1] as string, "minlon")), maxlat: Number(attr(b[1] as string, "maxlat")), maxlon: Number(attr(b[1] as string, "maxlon")) };
  if (![bounds.minlat, bounds.minlon, bounds.maxlat, bounds.maxlon].every(Number.isFinite) || bounds.maxlat <= bounds.minlat || bounds.maxlon <= bounds.minlon) throw new OsmError("The file's bounding box is not valid.");
  const nodes: OsmData["nodes"] = new Map();
  for (const m of xml.matchAll(/<node\s+([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const a = m[1] as string;
    const id = attr(a, "id");
    const lat = Number(attr(a, "lat"));
    const lon = Number(attr(a, "lon"));
    if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lat, lon, tags: m[3] ? tagsOf(m[3]) : {} });
  }
  const ways: OsmData["ways"] = [];
  for (const m of xml.matchAll(/<way\s+([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const id = attr(m[1] as string, "id");
    if (!id) continue;
    ways.push({ id, refs: [...(m[2] as string).matchAll(/<nd\s+ref="(\d+)"/g)].map((r) => r[1] as string), tags: tagsOf(m[2] as string) });
  }
  const relations: OsmData["relations"] = [];
  for (const m of xml.matchAll(/<relation\s+([^>]*?)>([\s\S]*?)<\/relation>/g)) {
    const id = attr(m[1] as string, "id");
    if (!id) continue;
    const members = [...(m[2] as string).matchAll(/<member\s+([^>]*?)\/>/g)].map((x) => ({ type: attr(x[1] as string, "type") ?? "", ref: attr(x[1] as string, "ref") ?? "", role: attr(x[1] as string, "role") ?? "" }));
    relations.push({ id, members, tags: tagsOf(m[2] as string) });
  }
  return { bounds, nodes, ways, relations };
}

// ---- What a feature is, for a venue

export type OsmKind = "road" | "path" | "crossing" | "walkArea" | "site" | "building" | "water" | "rail" | "fence" | "parking" | "green" | "none";

const CAR_ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "road", "busway"]);
const PUBLIC_ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "road", "busway"]);
const FOOT = new Set(["footway", "pedestrian", "path", "steps", "corridor", "cycleway", "bridleway", "track"]);

export function osmKind(t: Record<string, string>, closed: boolean): OsmKind {
  const h = t.highway;
  if (t["area:highway"] === "pedestrian" || t.place === "square" || (h === "pedestrian" && (t.area === "yes" || closed))) return "walkArea";
  if (h === "footway" && (t.footway === "crossing" || t.crossing !== undefined)) return "crossing";
  if (h && FOOT.has(h)) return "path";
  if (h && CAR_ROADS.has(h)) return t.area === "yes" ? "walkArea" : "road";
  if (t.building || t["building:part"]) return "building";
  if (t.natural === "water" || t.waterway === "riverbank" || t.landuse === "basin" || t.landuse === "reservoir") return "water";
  if (t.railway && !["platform", "abandoned", "razed", "disused"].includes(t.railway)) return t.railway === "platform" ? "walkArea" : "rail";
  if (t.railway === "platform" || t.public_transport === "platform") return closed ? "walkArea" : "path";
  if (t.barrier && ["fence", "wall", "retaining_wall", "city_wall", "hedge"].includes(t.barrier)) return "fence";
  if (t.amenity === "parking" || (t.parking && closed)) return "parking";
  if (["park", "garden", "playground", "dog_park"].includes(t.leisure ?? "") || ["grass", "recreation_ground", "village_green", "meadow"].includes(t.landuse ?? "")) return "green";
  if (closed && (["exhibition_centre", "events_venue", "conference_centre", "university", "school", "hospital", "marketplace"].includes(t.amenity ?? "") || ["stadium", "sports_centre"].includes(t.leisure ?? "") || ["commercial", "retail"].includes(t.landuse ?? "") || t.tourism === "theme_park" || t.tourism === "zoo")) return "site";
  return "none";
}

// ---- Geometry: projection and clipping

export interface Box {
  w: number;
  h: number;
}

/** Projects lat/lon to metres from the box's north-west corner (x east, y south). */
export function projector(b: OsmData["bounds"]): { box: Box; at: (lat: number, lon: number) => Point } {
  const lat0 = (b.minlat + b.maxlat) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
  const ky = 110_574;
  const at = (lat: number, lon: number): Point => ({ x: (lon - b.minlon) * kx, y: (b.maxlat - lat) * ky });
  return { box: { w: (b.maxlon - b.minlon) * kx, h: (b.maxlat - b.minlat) * ky }, at };
}

/** Clips a polyline to the box; returns the pieces inside (Liang–Barsky per segment). */
export function clipPolyline(line: readonly Point[], box: Box): Point[][] {
  const pieces: Point[][] = [];
  let cur: Point[] = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1] as Point;
    const b = line[k] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let inside = true;
    for (const [p, q] of [
      [-dx, a.x],
      [dx, box.w - a.x],
      [-dy, a.y],
      [dy, box.h - a.y],
    ] as const) {
      if (p === 0) {
        if (q < 0) inside = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!inside || t0 > t1) {
      flush();
      continue;
    }
    const s = { x: a.x + t0 * dx, y: a.y + t0 * dy };
    const e = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    const last = cur[cur.length - 1];
    if (!last || Math.hypot(last.x - s.x, last.y - s.y) > 1e-6) {
      flush();
      cur.push(s);
    }
    cur.push(e);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/** Clips a polygon ring to the box (Sutherland–Hodgman); [] if nothing is left. */
export function clipRing(ring: readonly Point[], box: Box): Point[] {
  let out = [...ring];
  const edges: [(p: Point) => boolean, (a: Point, b: Point) => Point][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= box.w, (a, b) => ({ x: box.w, y: a.y + ((b.y - a.y) * (box.w - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= box.h, (a, b) => ({ x: a.x + ((b.x - a.x) * (box.h - a.y)) / (b.y - a.y), y: box.h })],
  ];
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i] as Point;
      const b = input[(i + 1) % input.length] as Point;
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (out.length === 0) return [];
  }
  return out.length >= 3 ? out : [];
}

const r2 = (p: Point): Point => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
const pathLength = (p: readonly Point[]) => p.slice(1).reduce((s, q, k) => s + Math.hypot(q.x - (p[k] as Point).x, q.y - (p[k] as Point).y), 0);
const simplify = (p: readonly Point[], eps: number) => simplifyPath(p.map((q) => ({ px: q.x, py: q.y })), eps).map((q) => ({ x: q.px, y: q.py }));
const name120 = (s: string) => s.slice(0, 120);

// ---- The venue

export interface OsmImport {
  venue: Venue;
  report: { roads: number; walkable: number; obstacles: number; gates: number; sources: number; footways: number; buildings: number; carParks: number; width: number; height: number };
}

export interface OsmOptions {
  id: string;
  name?: string;
  /** Lane width of car roads, metres. */
  laneWidth?: number;
  /** Width of footways without a width tag, metres. */
  footwayWidth?: number;
}

interface Feature {
  kind: OsmKind;
  tags: Record<string, string>;
  /** Closed areas: the outer rings, clipped. */
  rings: Point[][];
  /** Open lines: the pieces inside the box. */
  lines: Point[][];
  osmId: string;
}

/** Builds a venue from an OSM export. */
export function osmToVenue(osm: OsmData, options: OsmOptions): OsmImport {
  const { box, at } = projector(osm.bounds);
  const laneWidth = options.laneWidth ?? 3.25;
  const footwayWidth = options.footwayWidth ?? 2.5;
  const pos = (ref: string) => {
    const n = osm.nodes.get(ref);
    return n ? at(n.lat, n.lon) : null;
  };
  const wayPts = (refs: readonly string[]) => refs.map(pos).filter((p): p is Point => p !== null);

  // Ways, and the outer ways of multipolygon relations (joined into rings).
  const features: Feature[] = [];
  const inRelation = new Set<string>();
  const wayById = new Map(osm.ways.map((w) => [w.id, w]));
  for (const r of osm.relations) {
    if (r.tags.type !== "multipolygon") continue;
    const kind = osmKind(r.tags, true);
    if (kind === "none") continue;
    const outers = r.members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => wayById.get(m.ref)).filter((w): w is OsmData["ways"][number] => !!w);
    outers.forEach((w) => inRelation.add(w.id));
    for (const ring of joinRings(outers.map((w) => w.refs))) {
      const clipped = clipRing(wayPts(ring), box);
      if (clipped.length) features.push({ kind, tags: r.tags, rings: [clipped], lines: [], osmId: `relation/${r.id}` });
    }
  }
  for (const w of osm.ways) {
    const closed = w.refs.length > 3 && w.refs[0] === w.refs[w.refs.length - 1];
    const kind = osmKind(w.tags, closed);
    if (kind === "none") continue;
    if (inRelation.has(w.id) && Object.keys(w.tags).length === 0) continue;
    const pts = wayPts(w.refs);
    const isArea = closed && ["walkArea", "site", "building", "water", "parking", "green"].includes(kind);
    if (isArea) {
      const ring = clipRing(pts.slice(0, -1), box);
      if (ring.length) features.push({ kind, tags: w.tags, rings: [ring], lines: [], osmId: `way/${w.id}` });
    } else features.push({ kind, tags: w.tags, rings: [], lines: clipPolyline(pts, box), osmId: `way/${w.id}` });
  }
  const of = (k: OsmKind) => features.filter((f) => f.kind === k);

  // Roads.
  const roads: Road[] = [];
  for (const f of of("road")) {
    const t = f.tags;
    const lanesTag = Number.parseInt(t.lanes ?? "", 10);
    const oneWay = t.oneway === "yes" || t.oneway === "1" || t.oneway === "-1" || t.junction === "roundabout";
    const perDirection = Number.isFinite(lanesTag) && lanesTag > 0 ? (oneWay ? lanesTag : Math.max(1, Math.round(lanesTag / 2))) : t.highway === "primary" || t.highway === "trunk" ? 2 : 1;
    const speed = Number.parseFloat(t.maxspeed ?? "");
    for (const piece of f.lines) {
      const line = simplify(t.oneway === "-1" ? [...piece].reverse() : piece, 0.4).map(r2);
      if (line.length < 2 || pathLength(line) < 5) continue;
      const id = `road-${roads.length + 1}`;
      roads.push({
        id,
        name: name120(t.name ?? (t.service === "parking_aisle" ? "Car park aisle" : t.service === "driveway" ? "Driveway" : `Road ${roads.length + 1}`)),
        points: line.slice(0, 500),
        direction: oneWay ? "oneWay" : "twoWay",
        laneCount: Math.max(1, Math.min(4, perDirection)),
        ...(Number.isFinite(speed) && speed > 0 && speed <= 130 ? { freeSpeed: speed } : {}),
        ...(PUBLIC_ROADS.has(t.highway ?? "") ? { publicRoad: true } : {}),
      });
    }
  }
  const roadWidth = (r: Road) => r.laneCount * laneWidth * (r.direction === "twoWay" ? 2 : 1);

  // Gates: where a footway, path or driveway crosses a fence, and at mapped gate or entrance nodes on a fence.
  const fences = of("fence").flatMap((f) => f.lines);
  const crossers = [...of("path"), ...of("crossing"), ...of("road").filter((f) => f.tags.service === "driveway" || f.tags.highway === "service")].flatMap((f) => f.lines.map((l) => ({ line: l, foot: f.kind !== "road" })));
  const gatePoints: { p: Point; dir: Point; foot: boolean }[] = [];
  for (const fence of fences)
    for (let k = 1; k < fence.length; k++) {
      const a = fence[k - 1] as Point;
      const b = fence[k] as Point;
      for (const c of crossers)
        for (let j = 1; j < c.line.length; j++) {
          const x = intersect(a, b, c.line[j - 1] as Point, c.line[j] as Point);
          if (x) gatePoints.push({ p: x, dir: unit(a, b), foot: c.foot });
        }
    }
  for (const [, n] of osm.nodes) {
    if (n.tags.barrier !== "gate" && n.tags.entrance === undefined) continue;
    const p = at(n.lat, n.lon);
    if (p.x < 0 || p.y < 0 || p.x > box.w || p.y > box.h) continue;
    // Along the nearest fence, if there is one within 3 m.
    let best: { d: number; dir: Point } | null = null;
    for (const fence of fences)
      for (let k = 1; k < fence.length; k++) {
        const d = distToSegment(p, fence[k - 1] as Point, fence[k] as Point);
        if (d < 3 && (!best || d < best.d)) best = { d, dir: unit(fence[k - 1] as Point, fence[k] as Point) };
      }
    if (best && !gatePoints.some((g) => Math.hypot(g.p.x - p.x, g.p.y - p.y) < 8)) gatePoints.push({ p, dir: best.dir, foot: true });
  }
  // One gate per spot (crossings closer than 8 m are the same gate).
  const gates: { p: Point; dir: Point; foot: boolean }[] = [];
  for (const g of gatePoints) if (!gates.some((h) => Math.hypot(h.p.x - g.p.x, h.p.y - g.p.y) < 8)) gates.push(g);
  const GATE_HALF = 4;

  // Walkable ground on a grid.
  const cell = Math.max(0.5, Math.min(2, Math.max(box.w, box.h) / 800));
  const g = makeGrid({ minX: 0, minY: 0, maxX: box.w, maxY: box.h }, cell, 0);
  const sites = [...of("site"), ...of("walkArea"), ...of("green"), ...of("parking")];
  const hasSite = of("site").length > 0 || of("walkArea").length > 0;
  if (hasSite) for (const f of sites) for (const ring of f.rings) rasterizePolygon(g, { outer: ring }, 1);
  else g.data.fill(1);
  const paintLines = (lines: Point[][], width: number, value: 0 | 1) => {
    for (const l of lines) paintStroke(g, l, width / 2, value);
  };
  // Public streets are not walkable; service roads, driveways and car-park aisles are shared with people.
  for (const r of roads) if (r.publicRoad) paintLines([r.points], roadWidth(r), 0);
  for (const f of of("rail")) paintLines(f.lines, 3, 0);
  for (const f of of("fence")) paintLines(f.lines, Math.max(0.6, cell * 1.2), 0);
  for (const f of [...of("water"), ...of("building")]) for (const ring of f.rings) rasterizePolygon(g, { outer: ring }, 0);
  // Footways, sidewalks, paths, steps and crossings are walkable, over roads and fences too.
  for (const f of [...of("path"), ...of("crossing")]) {
    const w = Number.parseFloat(f.tags.width ?? "");
    paintLines(f.lines, Number.isFinite(w) && w > 0 ? Math.max(1.5, w) : footwayWidth, 1);
  }
  // Open the fence at every gate (gates on footways only: driveways stay for cars).
  for (const gt of gates) paintStroke(g, [{ x: gt.p.x - gt.dir.x * GATE_HALF, y: gt.p.y - gt.dir.y * GATE_HALF }, { x: gt.p.x + gt.dir.x * GATE_HALF, y: gt.p.y + gt.dir.y * GATE_HALF }], 2, 1);
  // Buildings and water stay solid even where a footway was painted over them.
  for (const f of [...of("water"), ...of("building")]) for (const ring of f.rings) rasterizePolygon(g, { outer: ring }, 0);
  const walkPolys = gridToPolygons(g as Grid, 10, 1.2);

  // Obstacles: buildings (named), water.
  const obstacles = [
    ...of("building").flatMap((f, k) => f.rings.map((ring) => ({ id: "", name: name120(f.tags.name ?? f.tags["addr:housename"] ?? `Building ${k + 1}`), polygon: { outer: simplify(ring, 0.2).map(r2) } as Polygon }))),
    ...of("water").flatMap((f) => f.rings.map((ring) => ({ id: "", name: name120(f.tags.name ?? "Water"), polygon: { outer: simplify(ring, 0.5).map(r2) } as Polygon }))),
  ]
    .filter((o) => o.polygon.outer.length >= 3)
    .map((o, k) => ({ ...o, id: `obstacle-${k + 1}` }));

  // Sources: public-transport stops in the box.
  const stops = [...osm.nodes.values()].filter((n) => n.tags.highway === "bus_stop" || n.tags.railway === "tram_stop" || n.tags.public_transport === "platform" || n.tags.public_transport === "stop_position");
  const stopPts: { p: Point; name: string }[] = [];
  for (const n of stops) {
    const p = at(n.lat, n.lon);
    if (p.x < 0 || p.y < 0 || p.x > box.w || p.y > box.h) continue;
    if (stopPts.some((s) => Math.hypot(s.p.x - p.x, s.p.y - p.y) < 25)) continue;
    stopPts.push({ p, name: name120(n.tags.name ?? "Public transport stop") });
  }
  const share = stopPts.length ? Math.floor(10000 / stopPts.length) / 10000 : 0;

  const site = of("site")[0];
  const venue: Venue = {
    schemaVersion: 1,
    id: options.id,
    name: name120(options.name ?? site?.tags.name ?? "OpenStreetMap import"),
    attribution: "Map data © OpenStreetMap contributors (ODbL)",
    walkableAreas: walkPolys.map((polygon, k) => ({ id: `area-${k + 1}`, name: `Walkable area ${k + 1}`, polygon: { outer: polygon.outer, ...(polygon.holes?.length ? { holes: polygon.holes } : {}) } })),
    obstacles,
    sources: stopPts.map((s, k) => ({ id: `source-${k + 1}`, name: s.name, position: r2(s.p), share: k === stopPts.length - 1 ? Math.round((1 - share * (stopPts.length - 1)) * 10000) / 10000 : share })),
    screeningStages: [],
    gateGroups: gates.map((gt, k) => ({
      id: `gate-${k + 1}`,
      name: `Gate ${k + 1}`,
      line: { a: r2({ x: gt.p.x - gt.dir.x * GATE_HALF, y: gt.p.y - gt.dir.y * GATE_HALF }), b: r2({ x: gt.p.x + gt.dir.x * GATE_HALF, y: gt.p.y + gt.dir.y * GATE_HALF }) },
      laneCount: 3,
      queueLength: 15,
      serviceTime: SERVICE_TIME_PRESETS.turnstile,
      scanFailure: { rate: 0.03, retryTime: { kind: "uniform", min: 5, max: 15 } },
    })),
    destinations: [],
    ...(roads.length ? { roads } : {}),
  };
  return {
    venue,
    report: {
      roads: roads.length,
      walkable: venue.walkableAreas.length,
      obstacles: obstacles.length,
      gates: venue.gateGroups.length,
      sources: venue.sources.length,
      footways: of("path").length + of("crossing").length,
      buildings: of("building").length,
      carParks: of("parking").length,
      width: Math.round(box.w),
      height: Math.round(box.h),
    },
  };
}

/** Joins way node lists end to end into closed rings (multipolygon outers). */
function joinRings(parts: string[][]): string[][] {
  const rings: string[][] = [];
  const left = parts.map((p) => [...p]);
  while (left.length) {
    let ring = left.shift() as string[];
    let grew = true;
    while (ring[0] !== ring[ring.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i] as string[];
        const end = ring[ring.length - 1];
        if (p[0] === end) ring = [...ring, ...p.slice(1)];
        else if (p[p.length - 1] === end) ring = [...ring, ...[...p].reverse().slice(1)];
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length > 3 && ring[0] === ring[ring.length - 1]) rings.push(ring.slice(0, -1));
  }
  return rings;
}

function unit(a: Point, b: Point): Point {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
}

function intersect(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * r.x, y: a.y + t * r.y } : null;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
