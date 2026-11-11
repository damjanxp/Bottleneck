/**
 * @bottleneck/examples: built-in example venues (pedestrian parts only, Phase 1) with their scenarios.
 * The JSON files are valid against /schema; the test in ../test checks that.
 */
import type { Scenario, Venue } from "@bottleneck/schema";
import concertVenue from "../venues/belgrade-fair-concert.json" with { type: "json" };
import fairDayVenue from "../venues/belgrade-fair-fair-day.json" with { type: "json" };
import concert3Lanes from "../scenarios/concert-3-lanes.json" with { type: "json" };
import concert5Lanes from "../scenarios/concert-5-lanes.json" with { type: "json" };
import concertLaneFails from "../scenarios/concert-lane-fails.json" with { type: "json" };
import fairDayBaseline from "../scenarios/fair-day-baseline.json" with { type: "json" };
import fairDayBusBurst from "../scenarios/fair-day-bus-burst.json" with { type: "json" };
import fairDayGateAReduced from "../scenarios/fair-day-gate-a-reduced.json" with { type: "json" };

export interface ExampleScenario {
  id: string;
  title: string;
  description: string;
  scenario: Scenario;
}

export interface ExampleVenue {
  id: string;
  title: string;
  description: string;
  venue: Venue;
  /** Plain scenario documents, in display order. */
  scenarios: Scenario[];
  /** The same scenarios with a title and a short description for pickers. */
  scenarioInfo: ExampleScenario[];
}

// The JSON imports are widened (e.g. `kind: string`), so they are cast to the schema types here;
// the Ajv test in ../test guarantees that they really conform.
const asVenue = (json: unknown): Venue => json as Venue;
const asScenario = (json: unknown): Scenario => json as Scenario;

function build(
  id: string,
  description: string,
  venueJson: unknown,
  scenarios: { json: unknown; description: string }[],
): ExampleVenue {
  const venue = asVenue(venueJson);
  const scenarioInfo = scenarios.map((s) => {
    const scenario = asScenario(s.json);
    return { id: scenario.id ?? scenario.name, title: scenario.name, description: s.description, scenario };
  });
  return { id, title: venue.name, description, venue, scenarios: scenarioInfo.map((s) => s.scenario), scenarioInfo };
}

export const exampleVenues: ExampleVenue[] = [
  build(
    "belgrade-fair-fair-day",
    "Open-door fair day: three gate groups, arrivals from the tram and bus stops and the street entrance, no screening.",
    fairDayVenue,
    [
      { json: fairDayBaseline, description: "12,000 visitors over the day, all 22 gate lanes open." },
      { json: fairDayBusBurst, description: "Baseline plus a full tram (1,500) and a full bus load (1,000) arriving 30 minutes after opening." },
      { json: fairDayGateAReduced, description: "Gate A staffed with only 3 of its 8 lanes." },
    ],
  ),
  build(
    "belgrade-fair-concert",
    "Concert in one hall: a bag-check stage in front of one turnstile gate group, fixed start, about 6,000 people.",
    concertVenue,
    [
      { json: concert3Lanes, description: "3 turnstile lanes (about 2,700 people/h): expected to jam." },
      { json: concert5Lanes, description: "5 turnstile lanes (about 4,500 people/h): expected to mostly cope." },
      { json: concertLaneFails, description: "5 lanes, one turnstile lane fails 30 minutes before the start." },
    ],
  ),
];
