/**
 * @bottleneck/examples: built-in example venues with their scenarios: the Belgrade Fair venues
 * (pedestrians in Phase 1; with car parks, cars and departures since Phase 3) and a stand-alone car park (cars, barriers, pay machines and the
 * exit rush, Phase 3). The JSON files are valid against /schema; the tests in ../test check that.
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
import fairDayWithCars from "../scenarios/fair-day-with-cars.json" with { type: "json" };
import fairDayNorthCloses from "../scenarios/fair-day-north-car-park-closes.json" with { type: "json" };
import concertCarsPayStation from "../scenarios/concert-cars-pay-station.json" with { type: "json" };
import concertCarsPayAtBarrier from "../scenarios/concert-cars-pay-at-barrier.json" with { type: "json" };
import carParkVenue from "../venues/standalone-car-park.json" with { type: "json" };
import carParkPayStation from "../scenarios/car-park-pay-station.json" with { type: "json" };
import carParkPayAtBarrier from "../scenarios/car-park-pay-at-barrier.json" with { type: "json" };
import carParkPayAtBarrier3Lanes from "../scenarios/car-park-pay-at-barrier-3-lanes.json" with { type: "json" };

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
    "Open-door fair day: three gate groups, arrivals from the tram and bus stops and the street entrance, no screening. Two car parks (about 960 stalls) are used by the scenarios with a car share.",
    fairDayVenue,
    [
      { json: fairDayBaseline, description: "4,000 visitors over a two-hour session, all 15 gate lanes open." },
      { json: fairDayBusBurst, description: "Baseline plus a full tram (1,800) and a full bus load (1,200) arriving 30 minutes after opening." },
      { json: fairDayGateAReduced, description: "Gate A staffed with only 1 of its 4 lanes." },
      { json: fairDayWithCars, description: "55% of the visitors come by car to two car parks on Bulevar vojvode Misica (north: pay at the exit barrier, south: pay machines) and leave over the afternoon." },
      { json: fairDayNorthCloses, description: "The same day, but the north car park closes after 30 minutes: its cars divert to the south car park, and the rest are turned away." },
    ],
  ),
  build(
    "belgrade-fair-concert",
    "Concert in one hall: a bag-check stage in front of one turnstile gate group, fixed start, about 4,500 people. A 640-stall car park is used by the scenarios with a car share.",
    concertVenue,
    [
      { json: concert3Lanes, description: "3 turnstile lanes (about 2,700 people/h): expected to jam." },
      { json: concert5Lanes, description: "5 turnstile lanes (about 4,500 people/h): expected to mostly cope." },
      { json: concertLaneFails, description: "5 lanes, one turnstile lane fails 50 minutes before the start." },
      { json: concertCarsPayStation, description: "5 lanes; 35% of the audience comes by car to a 640-stall car park and everyone leaves after the show: the exit rush, paying at the machines." },
      { json: concertCarsPayAtBarrier, description: "The same evening, but drivers pay at the exit barrier: a longer exit queue and a later empty car park." },
    ],
  ),
  build(
    "standalone-car-park",
    "A 320-stall car park next to an event hall: two entries from the main road, pay machines on foot, one exit road with a two-lane exit barrier and a zebra crossing. Everyone comes by car (about 2.1 per car); the lot fills before the start and empties after the show (the exit rush).",
    carParkVenue,
    [
      { json: carParkPayStation, description: "About 310 cars for 320 stalls (a few are turned away when it is full). Drivers pay at 4 machines on the way back to the car; 2 exit lanes." },
      { json: carParkPayAtBarrier, description: "The same evening, but drivers pay at the exit barrier (card or cash): no machine queue, a longer exit queue and a later empty car park." },
      { json: carParkPayAtBarrier3Lanes, description: "Paying at the exit barrier with a third exit lane: does it win back the time the payment costs?" },
    ],
  ),
];
