/**
 * All user-facing text, kept out of components (spec 7.2, "Language").
 * English only for now; this file is where a translation layer would plug in.
 */

export const strings = {
  appName: "Bottleneck",
  tagline: "See where a venue's entrances and car parks will jam before the event happens.",
  intro:
    "Draw the site, set the expected crowd, press Play and watch queues form at gates, security lanes and parking barriers. Then add a lane, break a gate or swap a barrier type, and compare the numbers side by side.",
  status: {
    heading: "Status",
    current: "Phase 0: foundation. The simulator is being built in the open.",
  },
  roadmap: {
    heading: "Roadmap",
    done: "done",
    inProgress: "in progress",
    planned: "planned",
    optional: "optional",
    phases: [
      { id: 0, title: "Foundation: engine core, schema, CI, deployment" },
      { id: 1, title: "Pedestrian simulation on the Belgrade Fair examples" },
      { id: 2, title: "Scenarios and side-by-side comparison" },
      { id: 3, title: "Vehicles and parking" },
      { id: 4, title: ".NET backend with batch runs and lane sweeps" },
      { id: 5, title: "Venue editor" },
      { id: 6, title: "Showcase and polish" },
      { id: 7, title: "Parking layout generator", optional: true },
      { id: 8, title: "AI auto-draft from a screenshot", optional: true },
    ],
  },
  selfCheck: {
    heading: "Engine self-check",
    explainer:
      "The simulation engine is deterministic: the same scenario and seed must give bit-identical results in your browser and on the server. This page runs a fixed workload in a Web Worker and compares its hash with the one pinned by the tests in Node.",
    running: "Running in a Web Worker…",
    hash: "Hash in this browser",
    expected: "Expected (pinned in Node)",
    match: "Match: bit-identical to Node",
    mismatch: "Mismatch: this browser computed a different result",
    failed: "The self-check could not run",
    numbers: "Numbers hashed",
    duration: "Time in worker",
    engineVersion: "Engine version",
  },
  footer: {
    source: "Source on GitHub",
    sourceUrl: "https://github.com/damjanxp/Bottleneck",
    note: "Default parameters are assumptions, not measurements.",
  },
} as const;
