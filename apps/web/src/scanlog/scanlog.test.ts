import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { fitScanLog, parseScanLogCsv, scanLogFromRun, toScanLogCsv, type ScanLogFit } from "@bottleneck/analysis";
import { createRun, distributionMoments } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import commonSchema from "../../../../schema/common.schema.json";
import scenarioSchema from "../../../../schema/scenario.schema.json";
import { tinyScenario, tinyVenue } from "../determinism/tinyScenario.ts";
import { venueProblems } from "../library/validate.ts";
import { applyFit, arrivalPoints, peopleInLog } from "./applyFit.ts";

const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
ajv.addSchema(commonSchema as object, "common.schema.json");
ajv.addSchema(scenarioSchema as object, "scenario.schema.json");

describe("applying a fitted scan log", () => {
  it("export → import → fit → new scenario: valid, same people, fitted gate time", () => {
    // What the page does: the worker exports the finished run's log, the user imports the CSV.
    const run = createRun(tinyVenue, tinyScenario);
    while (!run.done) run.step();
    const csv = toScanLogCsv(scanLogFromRun(run.serviceLog(), run.lanes, run.timeOffset, tinyScenario.timeline.referenceClock));
    const parsed = parseScanLogCsv(csv);
    expect(parsed.errors).toEqual([]);
    const fit = fitScanLog(parsed.rows);
    const { scenario, unmatched } = applyFit(fit, tinyScenario, tinyVenue, "user-fit", "From scan log");
    expect(unmatched).toEqual([]);
    expect(ajv.validate("scenario.schema.json", scenario), JSON.stringify(ajv.errors)).toBe(true);
    expect(venueProblems(scenario, tinyVenue)).toEqual([]);
    expect(scenario.arrivals.preset).toBe("custom");
    expect(scenario.attendance).toBe(peopleInLog(fit));
    const gate = fit.groups.find((g) => g.group === "gate-a");
    const st = scenario.overrides?.["gate-a"]?.serviceTime;
    expect(st && gate?.meanServiceTime).toBeTruthy();
    expect(distributionMoments(st!).mean).toBeCloseTo(gate!.meanServiceTime!, 9);
    // Re-running the new scenario works.
    const again = createRun(tinyVenue, scenario);
    while (!again.done) again.step();
    expect(again.metrics().agentCount).toBe(scenario.attendance);
  });

  it("reports groups the venue does not have and thins long curves to the schema's 200 points", () => {
    const fit: ScanLogFit = {
      lanes: [
        { lane: "gate-a#1", group: "gate-a", passes: 10, busyIntervals: 5, meanServiceTime: 4 },
        { lane: "gate-a#manual", group: "gate-a#manual", passes: 2, busyIntervals: 0, meanServiceTime: null },
        { lane: "gate-z#1", group: "gate-z", passes: 3, busyIntervals: 2, meanServiceTime: 5 },
      ],
      groups: [
        { group: "gate-a", meanServiceTime: 4, busyIntervals: 5 },
        { group: "gate-a#manual", meanServiceTime: null, busyIntervals: 0 },
        { group: "gate-z", meanServiceTime: 5, busyIntervals: 2 },
      ],
      arrivals: Array.from({ length: 450 }, (_, k) => ({ t: k * 60, weight: k % 7 })),
      firstTime: 0,
      lastTime: 27000,
    };
    expect(peopleInLog(fit)).toBe(13);
    expect(arrivalPoints(fit).length).toBeLessThanOrEqual(200);
    const r = applyFit(fit, tinyScenario as Scenario, tinyVenue, "user-x", "x");
    expect(r.unmatched).toEqual(["gate-z"]);
    expect(ajv.validate("scenario.schema.json", r.scenario)).toBe(true);
  });

  it("works on the concert venue's elements", () => {
    const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert")!;
    const fit: ScanLogFit = { lanes: [], groups: [{ group: "gate-main", meanServiceTime: 3.2, busyIntervals: 100 }], arrivals: [], firstTime: 0, lastTime: 0 };
    const r = applyFit(fit, concert.scenarios[0] as Scenario, concert.venue, "user-c", "c");
    expect(distributionMoments(r.scenario.overrides!["gate-main"]!.serviceTime!).mean).toBeCloseTo(3.2, 9);
    expect(r.scenario.overrides!["gate-main"]!.laneCount).toBe(3); // the base's lane count stays
    expect(r.scenario.arrivals).toEqual((concert.scenarios[0] as Scenario).arrivals); // no curve in the fit: keep the base's
  });
});
