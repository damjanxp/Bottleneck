import { describe, expect, it } from "vitest";
import type { Venue } from "@bottleneck/schema";
import { checkWalkingReachability, createRun, type Run } from "../src/index.ts";
import { scenarioMinimal, venueMinimal } from "./runFixtures.ts";

function runToEnd(run: Run): Run {
  while (!run.done) run.step();
  return run;
}

const square = (x0: number, y0: number, x1: number, y1: number) => ({
  outer: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
});

/** A second walkable island far away, with a source on it: nobody there can reach the gates. */
const withIsland: Venue = {
  ...venueMinimal,
  walkableAreas: [...venueMinimal.walkableAreas, { id: "island", polygon: square(100, 0, 110, 10) }],
  sources: [
    { id: "tram", name: "Tram stop", position: { x: 5, y: 20 }, share: 0.5 },
    { id: "island-stop", name: "Island stop", position: { x: 105, y: 5 }, share: 0.5 },
  ],
};

describe("[test] walking reachability for the venue editor", () => {
  it("finds nothing wrong with a well-formed venue", () => {
    expect(checkWalkingReachability(venueMinimal)).toEqual([]);
  });

  it("flags a source that cannot reach any entry lane, as a run would turn its people away", () => {
    expect(checkWalkingReachability(withIsland)).toEqual([{ kind: "sourceUnreachable", sourceId: "island-stop" }]);
    // The same venue in a run: people from the island are counted as unreachable, the others are not.
    const m = runToEnd(createRun(withIsland, { ...scenarioMinimal, attendance: 200, timedEvents: [] })).metrics();
    expect(m.unreachable).toBeGreaterThan(0);
    expect(m.unreachable).toBeLessThan(200);
  });

  it("flags gates whose exits cannot reach the destination", () => {
    // The hall sits on its own walkable island: people get through gate A and can go no further.
    const v: Venue = {
      ...venueMinimal,
      walkableAreas: [...venueMinimal.walkableAreas, { id: "island", polygon: square(100, 0, 110, 10) }],
      destinations: [{ id: "hall", name: "Hall", area: square(102, 2, 108, 8) }],
    };
    expect(checkWalkingReachability(v)).toEqual([{ kind: "exitUnreachable", elementId: "gate-a" }]);
  });

  it("does not flag a destination drawn just outside the walkable area: a run walks people to its nearest walkable cell", () => {
    const v: Venue = { ...venueMinimal, destinations: [{ id: "hall", name: "Hall", area: square(61, 10, 70, 30) }] };
    expect(checkWalkingReachability(v)).toEqual([]);
  });

  it("is unchanged when the venue is translated", () => {
    const shift = <T>(v: T): T => JSON.parse(JSON.stringify(v), (k, val) => (k === "x" && typeof val === "number" ? val + 1000 : k === "y" && typeof val === "number" ? val - 500 : val)) as T;
    expect(checkWalkingReachability(shift(withIsland))).toEqual(checkWalkingReachability(withIsland));
  });
});
