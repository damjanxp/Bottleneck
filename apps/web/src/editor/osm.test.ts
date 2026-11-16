import { describe, expect, it } from "vitest";
import type { Venue } from "@bottleneck/schema";
import commonSchema from "../../../../schema/common.schema.json";
import scenarioSchema from "../../../../schema/scenario.schema.json";
import venueSchema from "../../../../schema/venue.schema.json";
import type { SchemaError, SchemaValidator } from "../library/validate.ts";
import { buildScenarioValidatorSource } from "../validation/buildValidator.ts";
import { OsmError, clipPolyline, clipRing, osmToVenue, parseOsm } from "./osm.ts";
import { checkVenue } from "./venueChecks.ts";
import { createRun, type Run } from "@bottleneck/engine";
import type { Scenario } from "@bottleneck/schema";
import { layoutCarPark } from "./osmParking.ts";

const source = buildScenarioValidatorSource({ "common.schema.json": commonSchema as object, "scenario.schema.json": scenarioSchema as object, "venue.schema.json": venueSchema as object });
const standalone = new Function(`${source.replace(/export const (validateScenario|validateVenue)/g, "const $1")}\nreturn validateVenue;`)() as ((d: unknown) => boolean) & { errors?: SchemaError[] | null };
const validateVenue: SchemaValidator = (d) => {
  const ok = standalone(d);
  return { ok, errors: ok ? [] : (standalone.errors ?? []) };
};

/**
 * A small fair, about 200 × 130 m: a two-way boulevard along the south edge, a fenced site north
 * of it with a hall, a footway from the boulevard's sidewalk through the fence to the hall, a
 * zebra crossing over the boulevard, a tram stop south of the road, and a car park.
 * Degrees: 0.001° lat ≈ 110.6 m, 0.001° lon ≈ 78.7 m at 45° N.
 */
const lat = (m: number) => 45 + m / 110574;
const lon = (m: number) => 20 + m / (Math.cos((45 * Math.PI) / 180) * 111320);
let nid = 0;
const nodes: string[] = [];
const node = (x: number, y: number, tags: Record<string, string> = {}) => {
  const id = ++nid;
  const t = Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join("");
  nodes.push(t ? `<node id="${id}" lat="${lat(y).toFixed(8)}" lon="${lon(x).toFixed(8)}">${t}</node>` : `<node id="${id}" lat="${lat(y).toFixed(8)}" lon="${lon(x).toFixed(8)}"/>`);
  return id;
};
const way = (id: number, refs: number[], tags: Record<string, string>) => `<way id="${id}">${refs.map((r) => `<nd ref="${r}"/>`).join("")}${Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join("")}</way>`;

// y grows north here (latitude); the venue's y grows south.
const road = [node(-50, 20), node(250, 20)]; // runs out of the box on both sides
const site = [node(10, 40), node(190, 40), node(190, 120), node(10, 120)];
const fence = [node(10, 40), node(190, 40)];
const hall = [node(80, 80), node(130, 80), node(130, 110), node(80, 110)];
const foot = [node(100, 28), node(100, 80)]; // from the sidewalk through the fence to the hall
const sidewalk = [node(0, 28), node(200, 28)];
const crossing = [node(100, 12), node(100, 28)];
const lot = [node(140, 50), node(180, 50), node(180, 70), node(140, 70)];
node(100, 8, { railway: "tram_stop", name: "Sajam" });
const ways = [
  way(1, road, { highway: "primary", name: "Bulevar", lanes: "4", maxspeed: "50" }),
  way(2, [...site, site[0] as number], { landuse: "commercial", amenity: "exhibition_centre", name: "Fair" }),
  way(3, fence, { barrier: "fence" }),
  way(4, [...hall, hall[0] as number], { building: "yes", name: "Hall 1" }),
  way(5, foot, { highway: "footway" }),
  way(6, sidewalk, { highway: "footway", footway: "sidewalk" }),
  way(7, crossing, { highway: "footway", footway: "crossing", crossing: "zebra" }),
  way(8, [...lot, lot[0] as number], { amenity: "parking" }),
];
const OSM = `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6"><bounds minlat="${lat(0)}" minlon="${lon(0)}" maxlat="${lat(130)}" maxlon="${lon(200)}"/>${nodes.join("")}${ways.join("")}</osm>`;

describe("OpenStreetMap import", () => {
  const osm = parseOsm(OSM);
  const { venue, report } = osmToVenue(osm, { id: "osm-test" });

  it("reads the file and keeps the box's size in metres", () => {
    expect(osm.ways).toHaveLength(8);
    expect(report.width).toBe(200);
    expect(report.height).toBe(130);
    expect(venue.name).toBe("Fair");
    expect(venue.attribution).toContain("OpenStreetMap");
  });

  it("the boulevard becomes a public two-way road, clipped to the box, with lanes and speed from the tags", () => {
    expect(venue.roads?.filter((x) => x.publicRoad)).toHaveLength(1);
    const r = venue.roads?.[0];
    expect(r?.direction).toBe("twoWay");
    expect(r?.laneCount).toBe(2);
    expect(r?.freeSpeed).toBe(50);
    expect(r?.publicRoad).toBe(true);
    expect(r?.points[0]?.x).toBeCloseTo(0, 1);
    expect(r?.points[1]?.x).toBeCloseTo(200, 1);
    expect(r?.points[0]?.y).toBeCloseTo(110, 1); // 20 m north of the south edge
  });

  it("the hall is a named obstacle, a gate is suggested where the footway crosses the fence, the tram stop is a source", () => {
    expect(venue.obstacles.map((o) => o.name)).toEqual(["Hall 1"]);
    expect(venue.gateGroups).toHaveLength(1);
    const gl = venue.gateGroups[0]?.line;
    expect(((gl?.a.x ?? 0) + (gl?.b.x ?? 0)) / 2).toBeCloseTo(100, 0);
    expect(((gl?.a.y ?? 0) + (gl?.b.y ?? 0)) / 2).toBeCloseTo(90, 0); // the fence, 40 m north of the south edge
    expect(venue.sources.map((s) => s.name)).toEqual(["Sajam"]);
  });

  it("walkable ground: the fenced site and the sidewalk, joined through the gate and over the road by the crossing", () => {
    // One connected area: tram stop → crossing → sidewalk → gate → site.
    expect(venue.walkableAreas).toHaveLength(1);
    const problems = checkVenue({ ...venue, destinations: [{ id: "hall", name: "Hall entrance", area: { outer: [ { x: 85, y: 18 }, { x: 125, y: 18 }, { x: 125, y: 48 }, { x: 85, y: 48 } ] } }] } satisfies Venue, validateVenue);
    expect(problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("refuses a file that is not an OSM export", () => {
    expect(() => parseOsm("<html></html>")).toThrow(OsmError);
    expect(() => parseOsm('<osm version="0.6"></osm>')).toThrow(/bounding box/);
  });
});

describe("clipping to the export box", () => {
  const box = { w: 100, h: 50 };
  it("a line through the box keeps only the inside piece; a line leaving and re-entering gives two pieces", () => {
    expect(clipPolyline([{ x: -10, y: 25 }, { x: 110, y: 25 }], box)).toEqual([[{ x: 0, y: 25 }, { x: 100, y: 25 }]]);
    const pieces = clipPolyline([{ x: 10, y: 10 }, { x: 10, y: 80 }, { x: 50, y: 80 }, { x: 50, y: 10 }], box);
    expect(pieces).toHaveLength(2);
  });
  it("a polygon sticking out of the box is cut at the edge", () => {
    const ring = clipRing([{ x: 50, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 40 }, { x: 50, y: 40 }], box);
    expect(Math.max(...ring.map((p) => p.x))).toBe(100);
    expect(clipRing([{ x: 200, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 10 }], box)).toEqual([]);
  });
});

describe("car parks from OpenStreetMap", () => {
  const { venue, report } = osmToVenue(parseOsm(OSM), { id: "osm-test" });
  const lot = venue.parkingLots?.[0];

  it("the 40 × 20 m car park becomes a lot with an aisle, stall rows both sides and entry/exit barriers", () => {
    expect(report.carParks).toBe(1);
    expect(lot?.aisles).toHaveLength(1);
    expect(lot?.stallRows?.map((r) => r.count)).toEqual([13, 13]);
    expect(report.stalls).toBe(26);
    expect(venue.vehicleBarriers?.map((b) => b.kind)).toEqual(["entry", "exit"]);
    // Entry and exit are one-way connector roads from the boulevard; cars come in where the boulevard leaves the map.
    const connectors = venue.roads?.filter((r) => r.id.startsWith("car-park-1-")) ?? [];
    expect(connectors.map((r) => r.direction)).toEqual(["oneWay", "oneWay"]);
    expect(venue.vehicleSources?.map((s) => s.position.x).sort((a, b) => a - b)).toEqual([0, 200]);
  });

  it("is schema-valid, and in a run cars drive in through the barrier, park and leave", () => {
    const withHall: Venue = { ...venue, destinations: [{ id: "hall", name: "Hall entrance", area: { outer: [ { x: 85, y: 18 }, { x: 125, y: 18 }, { x: 125, y: 48 }, { x: 85, y: 48 } ] } }] };
    expect(validateVenue(withHall).errors).toEqual([]);
    const scenario: Scenario = {
      schemaVersion: 1,
      venueId: "osm-test",
      name: "Small fair with cars",
      eventType: "concert",
      timeline: { referenceClock: "20:00", gatesOpen: -3600, eventStart: 0, eventEnd: 3600, horizon: 10800 },
      attendance: 60,
      carShare: 1,
      arrivals: { preset: "concert" },
      departures: { preset: "concert" },
      seed: 1,
    };
    const run: Run = createRun(withHall, scenario);
    while (!run.done) run.step();
    const m = run.metrics();
    const lotReport = m.parking?.lots[0];
    expect(m.deadlock).toBe(false);
    // 29 cars for 26 stalls: the lot fills up, 3 are turned away, and after the event it empties.
    expect(lotReport?.parked).toBe(26);
    expect(lotReport?.maxOccupancy).toBe(26);
    expect(m.parking?.turnedAwayCars).toBe(3);
    expect(lotReport?.emptyAt).not.toBeNull();
  });

  it("a long, slanted car park gets several aisles joined by a spine", () => {
    const outline = [ { x: 0, y: 0 }, { x: 80, y: 40 }, { x: 60, y: 80 }, { x: -20, y: 40 } ];
    const l = layoutCarPark(outline);
    expect(l).not.toBeNull();
    expect(l?.aisles.length).toBeGreaterThanOrEqual(3); // at least two aisles and the spine
    expect(l?.rows.length).toBeGreaterThanOrEqual(4);
  });
});
