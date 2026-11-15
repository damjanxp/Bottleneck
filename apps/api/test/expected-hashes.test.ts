/**
 * Cross-language determinism fixture for the .NET job runner (Phase 4: "a job run and a browser run
 * with the same seed produce the same metrics hash").
 *
 * The "browser" side: this test runs the engine in-process in Node, exactly as the browser's worker
 * does (createRun + step + metricsHash). Node and Chrome give bit-identical hashes (Playwright,
 * apps/web/e2e/determinism.spec.ts), so these are the hashes a browser computes for the same venue,
 * scenario, seed and overrides. The batch seeds come from the web app's own deriveSeeds.
 *
 * The result is checked into apps/api/tests/Bottleneck.Api.Tests/Jobs/expected-hashes.json, which the
 * .NET integration tests compare with the hashes of runs computed by a job through the real sidecar.
 * If the engine changes on purpose, this test fails until the file is regenerated:
 *   npm run api:hashes:gen        (vitest -u; CI never writes the file, so a stale file fails CI)
 */
import { createRun } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";
import { expect, test } from "vitest";
import { deriveSeeds } from "../../web/src/compare/plan.ts";
import concertVenue from "../../../packages/examples/venues/belgrade-fair-concert.json" with { type: "json" };
import carParkVenue from "../../../packages/examples/venues/standalone-car-park.json" with { type: "json" };
import concert3Lanes from "../../../packages/examples/scenarios/concert-3-lanes.json" with { type: "json" };
import carParkPayStation from "../../../packages/examples/scenarios/car-park-pay-station.json" with { type: "json" };

type Overrides = Record<string, Record<string, unknown>>;

interface Case {
  venue: string;
  scenario: string;
  seed: number;
  overrides: Overrides | null;
}

const venues: Record<string, unknown> = { "belgrade-fair-concert": concertVenue, "standalone-car-park": carParkVenue };
const scenarios: Record<string, unknown> = { "concert-3-lanes": concert3Lanes, "car-park-pay-station": carParkPayStation };

/** The sidecar's rule (apps/sidecar/src/app.ts): seed replaces scenario.seed; overrides merge per element id and field. */
function apply(scenario: Scenario, seed: number, overrides: Overrides | null): Scenario {
  const merged: Overrides = { ...((scenario.overrides as Overrides | undefined) ?? {}) };
  for (const [id, o] of Object.entries(overrides ?? {})) merged[id] = { ...(merged[id] ?? {}), ...o };
  return { ...scenario, seed, ...(overrides ? { overrides: merged as Scenario["overrides"] } : {}) };
}

function hash(c: Case): string {
  const run = createRun(venues[c.venue] as Venue, apply(scenarios[c.scenario] as Scenario, c.seed, c.overrides));
  while (!run.done) run.step();
  return run.metricsHash();
}

test("expected job hashes match the engine (regenerate with npm run api:hashes:gen)", async () => {
  const batchSeeds = deriveSeeds(1, 3);
  const cases: Case[] = [
    // BatchJobTests: a 3-seed batch of the car park example, base seed 1.
    ...batchSeeds.map((seed) => ({ venue: "standalone-car-park", scenario: "car-park-pay-station", seed, overrides: null })),
    // LaneSweepTests: the concert example's gate group with 4 lanes, first seed.
    { venue: "belgrade-fair-concert", scenario: "concert-3-lanes", seed: 1, overrides: { "gate-main": { laneCount: 4 } } },
  ];
  const fixture = {
    generatedBy: "apps/api/test/expected-hashes.test.ts (npm run api:hashes:gen)",
    derivedSeeds: { base: 1, count: 20, seeds: deriveSeeds(1, 20) },
    runs: cases.map((c) => ({ ...c, metricsHash: hash(c) })),
  };
  await expect(JSON.stringify(fixture, null, 2) + "\n").toMatchFileSnapshot("../tests/Bottleneck.Api.Tests/Jobs/expected-hashes.json");
}, 60_000);
