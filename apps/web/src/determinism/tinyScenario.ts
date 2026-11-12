/**
 * A tiny pinned venue and scenario for the cross-runtime determinism check (acceptance: the same
 * scenario gives the same metrics hash in Node and in Chrome's Web Worker). Imported by the worker
 * (browser side) and by the Playwright test (Node side), so both run exactly this data.
 *
 * Do not change it casually: any change is fine for the check itself (both sides move together),
 * but keep it small so the e2e test stays fast.
 */

import type { Scenario, Venue } from "@bottleneck/schema";

export const tinyVenue: Venue = {
  schemaVersion: 1,
  id: "determinism-tiny",
  name: "Tiny determinism venue: one source, one gate group (2 lanes), one destination",
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
      laneCount: 2,
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

export const tinyScenario: Scenario = {
  schemaVersion: 1,
  venueId: "determinism-tiny",
  name: "Tiny determinism scenario: 300 people, 10 minutes of arrivals",
  eventType: "concert",
  timeline: { referenceClock: "20:00", gatesOpen: -600, eventStart: 0, eventEnd: 1200, horizon: 1800 },
  attendance: 300,
  carShare: 0,
  arrivals: {
    preset: "custom",
    points: [
      { t: -600, weight: 1 },
      { t: 0, weight: 1 },
    ],
  },
  seed: 12345,
  parameters: {},
  overrides: {},
  timedEvents: [],
};
