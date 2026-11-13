/**
 * Small hand-made car parks for the Phase 3 tests (spec 4.3, 4.4, 4.5 Parking).
 *
 * Lot A (and optionally lot B further east) along one public road, y = 0, x from −60 to 140:
 *
 *        public road (two-way, public) ─────────────────────────────────────────▶ x
 *   source (−55, 0)    │ entry A (10,0)→(10,30)        ▲ exit A (50,30)→(50,0)
 *                      ▼ entry barrier at (10, 20)     │ exit barrier at (50, 10)
 *                      └──────── aisle (10,30)→(50,30) ┘
 *                 stalls in two rows along the aisle (above and below it)
 *
 * Lot B (if asked for) is the same shape at x = 80..110. Occupants walk from the stall to the
 * walking exit (30, 40) and across a plaza (0..60 × 40..80) to a hall at its far side.
 */

import type { Scenario, Venue } from "@bottleneck/schema";

type P = { x: number; y: number };
const pt = (x: number, y: number): P => ({ x, y });
const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];

export interface LotOptions {
  /** Stalls per row (two rows). */
  perRow?: number;
  /** Stalls per row in lot B; 0 = no lot B. */
  lotBPerRow?: number;
  overflow?: NonNullable<Venue["parkingLots"]>[number]["overflow"];
  entryType?: "ticket" | "plate" | "card" | "payAtBarrier";
  exitLanes?: number;
  paymentMode?: "payStation" | "payAtBarrier" | "prepaid";
}

export function parkingVenue(o: LotOptions = {}): Venue {
  const perRow = o.perRow ?? 12;
  const lot = (id: string, x0: number, rows: number) => {
    const x1 = x0 + 40;
    return {
      id,
      name: id,
      outline: { outer: rect(x0 - 2, 20, x1 + 2, 40) },
      stallRows: [
        { a: pt(x0 + 4, 27), b: pt(x1 - 4, 27), count: rows, side: "left" as const },
        { a: pt(x0 + 4, 33), b: pt(x1 - 4, 33), count: rows, side: "right" as const },
      ],
      aisles: [{ points: [pt(x0, 30), pt(x1, 30)] }],
      entryBarrierIds: [`${id}-entry`],
      exitBarrierIds: [`${id}-exit`],
      walkingExit: pt(x0 + 20, 40),
    };
  };
  const lotA = {
    ...lot("lot-a", 10, perRow),
    ...(o.overflow ? { overflow: o.overflow } : {}),
    ...(o.paymentMode ? { paymentMode: o.paymentMode } : {}),
    ...(o.paymentMode === "payStation" ? { payStation: { id: "pay-a", name: "Pay machines", line: { a: pt(40, 55), b: pt(20, 55) }, laneCount: 2, queueLength: 10 } } : {}),
  };
  const lots: NonNullable<Venue["parkingLots"]> = [lotA];
  const roads: NonNullable<Venue["roads"]> = [
    { id: "public", name: "Public road", points: [pt(-60, 0), pt(140, 0)], direction: "twoWay", laneCount: 1, freeSpeed: 50, publicRoad: true },
    { id: "entry-a-road", points: [pt(10, 0), pt(10, 30)], direction: "oneWay", laneCount: 1 },
    { id: "exit-a-road", points: [pt(50, 30), pt(50, 0)], direction: "oneWay", laneCount: 1 },
  ];
  const barriers: NonNullable<Venue["vehicleBarriers"]> = [
    { id: "lot-a-entry", name: "Entry A", roadId: "entry-a-road", position: pt(10, 20), kind: "entry", laneCount: 1, serviceType: o.entryType ?? "ticket" },
    { id: "lot-a-exit", name: "Exit A", roadId: "exit-a-road", position: pt(50, 10), kind: "exit", laneCount: o.exitLanes ?? 1, serviceType: "ticket" },
  ];
  if ((o.lotBPerRow ?? 0) > 0) {
    lots.push(lot("lot-b", 80, o.lotBPerRow as number));
    roads.push({ id: "entry-b-road", points: [pt(80, 0), pt(80, 30)], direction: "oneWay", laneCount: 1 });
    roads.push({ id: "exit-b-road", points: [pt(120, 30), pt(120, 0)], direction: "oneWay", laneCount: 1 });
    barriers.push({ id: "lot-b-entry", name: "Entry B", roadId: "entry-b-road", position: pt(80, 20), kind: "entry", laneCount: 1, serviceType: "ticket" });
    barriers.push({ id: "lot-b-exit", name: "Exit B", roadId: "exit-b-road", position: pt(120, 10), kind: "exit", laneCount: 1, serviceType: "ticket" });
  }
  return {
    schemaVersion: 1,
    id: "parking-fixture",
    name: "Parking test fixture",
    walkableAreas: [{ id: "plaza", polygon: { outer: rect(0, 40, 60, 80) } }],
    obstacles: [],
    sources: [],
    screeningStages: [],
    gateGroups: [],
    destinations: [{ id: "hall", name: "Hall", area: { outer: rect(0, 74, 60, 80) } }],
    roads,
    vehicleSources: [{ id: "west", name: "From the west", position: pt(-55, 0), share: 1 }],
    vehicleBarriers: barriers,
    parkingLots: lots,
  };
}

export interface ParkingScenarioOptions {
  cars: number;
  /** Arrival window in seconds (flat), starting at −3600. */
  window?: number;
  seed?: number;
  /** One person per car (default) or the default occupancy distribution. */
  singleOccupant?: boolean;
  /** All departures in the second after the event end (default: no departures). */
  departAll?: boolean;
  overrides?: Scenario["overrides"];
  timedEvents?: Scenario["timedEvents"];
  horizon?: number;
  attendance?: number;
  /** Seconds a parking car blocks the aisle (default: the engine's). */
  parkManoeuvre?: number;
}

export function parkingScenario(o: ParkingScenarioOptions): Scenario {
  const window = o.window ?? 1800;
  return {
    schemaVersion: 1,
    venueId: "parking-fixture",
    name: "Parking test",
    eventType: "concert",
    timeline: { referenceClock: "20:00", gatesOpen: -3600, eventStart: 0, eventEnd: 3600, horizon: o.horizon ?? 3600 * 4 },
    attendance: o.attendance ?? o.cars,
    carShare: 1,
    arrivals: {
      preset: "custom",
      points: [
        { t: -3600, weight: 1 },
        { t: -3600 + window, weight: 1 },
      ],
    },
    ...(o.departAll
      ? {
          departures: {
            preset: "custom" as const,
            points: [
              { t: 3600, weight: 1 },
              { t: 3601, weight: 1 },
            ],
          },
        }
      : {}),
    seed: o.seed ?? 1,
    parameters: {
      ...(o.singleOccupant === false ? {} : { occupancy: [1], groupSizes: [1] }),
      ...(o.parkManoeuvre !== undefined ? { parkManoeuvre: o.parkManoeuvre } : {}),
    },
    ...(o.overrides ? { overrides: o.overrides } : {}),
    ...(o.timedEvents ? { timedEvents: o.timedEvents } : {}),
  };
}

/** Every coordinate of a venue (pedestrian and vehicle elements) moved by (dx, dy). */
export function translateVenue(v: Venue, dx: number, dy: number): Venue {
  const f = (p: P): P => ({ x: p.x + dx, y: p.y + dy });
  const ring = (r: P[]) => r.map(f);
  const poly = (p: { outer: P[]; holes?: P[][] }) => ({ outer: ring(p.outer), ...(p.holes ? { holes: p.holes.map(ring) } : {}) });
  return {
    ...v,
    walkableAreas: v.walkableAreas.map((w) => ({ ...w, polygon: poly(w.polygon) })),
    obstacles: v.obstacles.map((o) => ({ ...o, polygon: poly(o.polygon) })),
    sources: v.sources.map((s) => ({ ...s, position: f(s.position) })),
    screeningStages: v.screeningStages.map((s) => ({ ...s, line: { a: f(s.line.a), b: f(s.line.b) } })),
    gateGroups: v.gateGroups.map((g) => ({ ...g, line: { a: f(g.line.a), b: f(g.line.b) } })),
    destinations: v.destinations.map((d) => ({ ...d, area: poly(d.area) })),
    ...(v.roads ? { roads: v.roads.map((r) => ({ ...r, points: ring(r.points) })) } : {}),
    ...(v.vehicleSources ? { vehicleSources: v.vehicleSources.map((s) => ({ ...s, position: f(s.position) })) } : {}),
    ...(v.vehicleBarriers ? { vehicleBarriers: v.vehicleBarriers.map((b) => ({ ...b, position: f(b.position) })) } : {}),
    ...(v.crossings ? { crossings: v.crossings.map((c) => ({ ...c, a: f(c.a), b: f(c.b) })) } : {}),
    ...(v.parkingLots
      ? {
          parkingLots: v.parkingLots.map((l) => ({
            ...l,
            outline: poly(l.outline),
            walkingExit: f(l.walkingExit),
            aisles: l.aisles.map((a) => ({ ...a, points: ring(a.points) })),
            ...(l.stallRows ? { stallRows: l.stallRows.map((r) => ({ ...r, a: f(r.a), b: f(r.b) })) } : {}),
            ...(l.stalls ? { stalls: l.stalls.map((s) => ({ ...s, position: f(s.position) })) } : {}),
            ...(l.payStation ? { payStation: { ...l.payStation, line: { a: f(l.payStation.line.a), b: f(l.payStation.line.b) } } } : {}),
          })),
        }
      : {}),
  };
}

/**
 * Reference load (review A7): the 10,000-pedestrian plaza of runFixtures.largeScenario plus a
 * 2,000-stall car park west of it, 2,000 cars with one occupant each arriving over 40 minutes from
 * two sources, so 2,000 car drivers walk into the plaza as well.
 */
export function referenceVenueWithCars(base: Venue): Venue {
  const aisles: { points: P[] }[] = [];
  const stallRows: NonNullable<NonNullable<Venue["parkingLots"]>[number]["stallRows"]> = [];
  // 10 aisles, 100 stalls per side each: 2,000 stalls. Lot spans x −300..−40, y 0..170.
  for (let k = 0; k < 10; k++) {
    const y = 8 + 16 * k;
    aisles.push({ points: [pt(-290, y), pt(-40, y)] });
    stallRows.push({ a: pt(-285, y - 3), b: pt(-35 - 10, y - 3), count: 100, side: "left" });
    stallRows.push({ a: pt(-285, y + 3), b: pt(-35 - 10, y + 3), count: 100, side: "right" });
  }
  aisles.push({ points: [pt(-290, 8), pt(-290, 152)] });
  aisles.push({ points: [pt(-40, 8), pt(-40, 152)] });
  return {
    ...base,
    roads: [
      { id: "ring", points: [pt(-340, -200), pt(-340, 400)], direction: "twoWay", laneCount: 2, freeSpeed: 50, publicRoad: true },
      { id: "entry-1", points: [pt(-340, 8), pt(-290, 8)], direction: "oneWay", laneCount: 1 },
      { id: "entry-2", points: [pt(-340, 152), pt(-290, 152)], direction: "oneWay", laneCount: 1 },
      { id: "exit-1", points: [pt(-40, 152), pt(-40, 200), pt(-340, 200)], direction: "oneWay", laneCount: 1 },
    ],
    vehicleSources: [
      { id: "north", name: "North", position: pt(-340, -190), share: 1 },
      { id: "south", name: "South", position: pt(-340, 390), share: 1 },
    ],
    vehicleBarriers: [
      { id: "entry-1-barrier", name: "Entry 1", roadId: "entry-1", position: pt(-300, 8), kind: "entry", laneCount: 2, serviceType: "plate" },
      { id: "entry-2-barrier", name: "Entry 2", roadId: "entry-2", position: pt(-300, 152), kind: "entry", laneCount: 2, serviceType: "plate" },
      { id: "exit-1-barrier", name: "Exit", roadId: "exit-1", position: pt(-100, 200), kind: "exit", laneCount: 3, serviceType: "plate" },
    ],
    parkingLots: [
      {
        id: "big-lot",
        name: "Big lot",
        outline: { outer: rect(-300, 0, -30, 170) },
        stallRows,
        aisles,
        entryBarrierIds: ["entry-1-barrier", "entry-2-barrier"],
        exitBarrierIds: ["exit-1-barrier"],
        walkingExit: pt(2, 60),
      },
    ],
  };
}

/**
 * Lot A plus a footpath across its exit road, between the aisle and the exit barrier: pedestrians
 * come from a stop at (40, 22) west of the road and go to a kiosk east of it, crossing the road on a
 * zebra crossing at y = 22, right where the exit queue stands during the departure rush.
 */
export function crossingVenue(): Venue {
  const v = parkingVenue({ perRow: 30 });
  return {
    ...v,
    walkableAreas: [...v.walkableAreas, { id: "footpath", polygon: { outer: rect(38, 18, 62, 26) } }],
    sources: [{ id: "stop", name: "Stop", position: pt(40, 22), share: 1 }],
    destinations: [...v.destinations, { id: "kiosk", name: "Kiosk", area: { outer: rect(58, 18, 62, 26) } }],
    crossings: [{ id: "zebra", a: pt(47, 22), b: pt(53, 22), width: 3 }],
  };
}
