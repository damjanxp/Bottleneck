/**
 * Inline venues and scenarios for the run tests. venueMinimal / scenarioMinimal are copies of
 * schema/fixtures/valid/venue-minimal.json and scenario-minimal.json (the engine's test tsconfig has
 * no Node types, so the tests do not read files).
 */

import type { Scenario, Venue } from "@bottleneck/schema";

export const venueMinimal: Venue = {
  schemaVersion: 1,
  id: "fixture-minimal",
  name: "Minimal venue: one source, one gate group, one destination",
  attribution: "Hand-made test fixture",
  walkableAreas: [
    {
      id: "plaza",
      polygon: {
        outer: [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
          { x: 60, y: 40 },
          { x: 0, y: 40 },
        ],
        holes: [
          [
            { x: 25, y: 5 },
            { x: 30, y: 5 },
            { x: 30, y: 8 },
          ],
        ],
      },
    },
  ],
  obstacles: [],
  sources: [{ id: "tram", name: "Tram stop", position: { x: 5, y: 20 }, share: 1 }],
  screeningStages: [],
  gateGroups: [
    {
      id: "gate-a",
      name: "Gate A",
      line: { a: { x: 40, y: 30 }, b: { x: 40, y: 10 } },
      laneCount: 4,
      queueLength: 15,
      serviceTime: { kind: "shiftedLognormal", shift: 2.5, mu: 0.25, sigma: 0.55 },
      scanFailure: { rate: 0.03, retryTime: { kind: "uniform", min: 5, max: 15 } },
    },
  ],
  destinations: [
    {
      id: "hall",
      name: "Hall",
      area: {
        outer: [
          { x: 50, y: 10 },
          { x: 60, y: 10 },
          { x: 60, y: 30 },
          { x: 50, y: 30 },
        ],
      },
    },
  ],
};

export const scenarioMinimal: Scenario = {
  schemaVersion: 1,
  venueId: "fixture-minimal",
  name: "Concert, gate A lane 2 fails 30 min before the start",
  eventType: "concert",
  timeline: { referenceClock: "20:00", gatesOpen: -5400, eventStart: 0, eventEnd: 9000, horizon: 14400 },
  attendance: 3000,
  carShare: 0,
  arrivals: { preset: "concert" },
  seed: 42,
  parameters: {
    freeWalkingSpeed: { kind: "truncatedNormal", mean: 1.3, sd: 0.25, min: 0.5, max: 2.2 },
    nearestLaneShare: 0.3,
  },
  overrides: { "gate-a": { laneCount: 5 } },
  timedEvents: [
    { kind: "laneFail", at: -1800, groupId: "gate-a", laneIndex: 1 },
    { kind: "busBurst", at: -2400, sourceId: "tram", count: 120 },
  ],
};

/** Every coordinate of the venue mapped through f. */
export function mapVenue(venue: Venue, f: (p: { x: number; y: number }) => { x: number; y: number }, lengthScale = 1): Venue {
  const ring = (r: { x: number; y: number }[]) => r.map(f);
  const poly = (p: { outer: { x: number; y: number }[]; holes?: { x: number; y: number }[][] }) => ({ outer: ring(p.outer), ...(p.holes ? { holes: p.holes.map(ring) } : {}) });
  return {
    ...venue,
    walkableAreas: venue.walkableAreas.map((w) => ({ ...w, polygon: poly(w.polygon) })),
    obstacles: venue.obstacles.map((o) => ({ ...o, polygon: poly(o.polygon) })),
    sources: venue.sources.map((s) => ({ ...s, position: f(s.position) })),
    screeningStages: venue.screeningStages.map((s) => ({ ...s, line: { a: f(s.line.a), b: f(s.line.b) }, queueLength: s.queueLength * lengthScale })),
    gateGroups: venue.gateGroups.map((g) => ({ ...g, line: { a: f(g.line.a), b: f(g.line.b) }, queueLength: g.queueLength * lengthScale })),
    destinations: venue.destinations.map((d) => ({ ...d, area: poly(d.area) })),
  };
}

/**
 * Lane-failure setup (review B6): 4 lanes, fixed 4 s service, no scan failures, a flat arrival
 * rate of 0.85 · 4 / 4 s = 0.85 people/s for the hour before the start, so the lanes run at about
 * 85% utilisation before lanes 1 and 2 fail 30 min before the start.
 */
export function laneFailureScenario(withFailure: boolean, seed = 7): { venue: Venue; scenario: Scenario } {
  const venue: Venue = {
    ...venueMinimal,
    gateGroups: [
      {
        ...(venueMinimal.gateGroups[0] as Venue["gateGroups"][number]),
        laneCount: 4,
        serviceTime: { kind: "fixed", value: 4 },
        scanFailure: { rate: 0, retryTime: { kind: "fixed", value: 0 } },
      },
    ],
  };
  const scenario: Scenario = {
    ...scenarioMinimal,
    attendance: 3060,
    seed,
    timeline: { referenceClock: "20:00", gatesOpen: -3600, eventStart: 0, eventEnd: 9000, horizon: 9000 },
    arrivals: {
      preset: "custom",
      points: [
        { t: -3600, weight: 1 },
        { t: 0, weight: 1 },
      ],
    },
    overrides: {},
    timedEvents: withFailure
      ? [
          { kind: "laneFail", at: -1800, groupId: "gate-a", laneIndex: 1 },
          { kind: "laneFail", at: -1800, groupId: "gate-a", laneIndex: 2 },
        ]
      : [],
  };
  return { venue, scenario };
}

/**
 * Reference load for the performance smoke test: 10,000 pedestrians from two sources into a
 * 200 × 120 m plaza with two gate groups of 12 lanes. They arrive during the 20 minutes before the
 * gates open, so all 10,000 are on site at once (most of them spilled back behind the queue areas).
 */
export function largeScenario(): { venue: Venue; scenario: Scenario } {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  const gate = (id: string, ax: number, ay: number, bx: number, by: number) => ({
    id,
    name: id,
    line: { a: { x: ax, y: ay }, b: { x: bx, y: by } },
    laneCount: 12,
    queueLength: 20,
    serviceTime: { kind: "shiftedLognormal" as const, shift: 2.5, mu: 0.25, sigma: 0.55 },
    scanFailure: { rate: 0.03, retryTime: { kind: "uniform" as const, min: 5, max: 15 } },
  });
  const venue: Venue = {
    schemaVersion: 1,
    name: "Large test plaza",
    walkableAreas: [{ id: "plaza", polygon: { outer: rect(0, 0, 200, 120) } }],
    obstacles: [
      { id: "kiosk-1", polygon: { outer: rect(60, 30, 70, 40) } },
      { id: "kiosk-2", polygon: { outer: rect(60, 80, 70, 90) } },
    ],
    sources: [
      { id: "north", name: "North", position: { x: 5, y: 20 }, share: 1 },
      { id: "south", name: "South", position: { x: 5, y: 100 }, share: 1 },
    ],
    screeningStages: [],
    gateGroups: [gate("gate-n", 140, 50, 140, 10), gate("gate-s", 140, 110, 140, 70)],
    destinations: [{ id: "arena", name: "Arena", area: { outer: rect(180, 10, 200, 110) } }],
  };
  const scenario: Scenario = {
    schemaVersion: 1,
    venueId: "large",
    name: "10k reference",
    eventType: "concert",
    timeline: { referenceClock: "20:00", gatesOpen: -2400, eventStart: 0, eventEnd: 9000, horizon: 3600 },
    attendance: 10000,
    carShare: 0,
    arrivals: {
      preset: "custom",
      points: [
        { t: -3600, weight: 1 },
        { t: -2400, weight: 1 },
      ],
    },
    seed: 1,
  };
  return { venue, scenario };
}
