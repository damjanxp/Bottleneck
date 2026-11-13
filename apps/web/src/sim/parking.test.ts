import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { AgentState, createRun } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { DepartureMetrics, ParkingMetrics, Scenario } from "@bottleneck/schema";
import commonSchema from "../../../../schema/common.schema.json";
import scenarioSchema from "../../../../schema/scenario.schema.json";
import type { RunResult } from "../batchProtocol.ts";
import { compareValues, parkingMeasures } from "../compare/measures.ts";
import { measureRows } from "../compare/table.ts";
import { formToScenario, newEventForm, scenarioToForm } from "../library/form.ts";
import { checkScenario, type SchemaValidator } from "../library/validate.ts";
import { CAR_STYLES, carStyleIndex } from "../render/palette.ts";
import { barrierArm, dashSegments, pointsAlong, publicRoadBoundaries, roadWidth, stallCorners, zebraStripes } from "../render/vehicleGeometry.ts";
import { summariseMetrics, type MetricsSummary } from "../workerProtocol.ts";
import { describeParameters, elementName } from "./parameters.ts";
import { barrierQueueSeries, barrierRows, carsOnSite, eventPhase, lotOccupancySeries, lotRows, parkingHeadlines, timeToEmpty, withLotClosed } from "./parking.ts";

const carPark = exampleVenues.find((v) => v.id === "standalone-car-park") as (typeof exampleVenues)[number];
const payStation = carPark.scenarios[0] as Scenario;

const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
ajv.addSchema(commonSchema as object, "common.schema.json");
ajv.addSchema(scenarioSchema as object, "scenario.schema.json");
const ajvValidate = ajv.getSchema("scenario.schema.json");
if (!ajvValidate) throw new Error("scenario schema missing");
const validate: SchemaValidator = (data) => {
  const ok = ajvValidate(data) as boolean;
  return { ok, errors: ok ? [] : [...(ajvValidate.errors ?? [])] };
};

/** The stand-alone car park run to the end (about 0.3 s), with a mid-run look at the live state. */
function finishedRun(scenario: Scenario = payStation) {
  const r = createRun(carPark.venue, scenario);
  let mid: { lots: ReturnType<typeof r.lotStates>; barriers: ReturnType<typeof r.barrierStates>; counts: number[] } | null = null;
  while (!r.done) {
    r.step();
    if (mid === null && r.toScenarioTime(r.time) >= -1700) mid = { lots: r.lotStates(), barriers: r.barrierStates(), counts: r.carCountsByState() };
  }
  return { run: r, metrics: summariseMetrics(r.metrics()), mid: mid as NonNullable<typeof mid> };
}

const finished = finishedRun();

describe("parking headline numbers", () => {
  it("reads time to empty, the exit and entry queues and turned-away cars from a real run", () => {
    const m = finished.metrics;
    const p = m.parking as ParkingMetrics;
    const h = parkingHeadlines(p, m.departures, true);
    expect(h.timeToEmpty.status).toBe("empty");
    expect(h.timeToEmpty.seconds).toBe(p.lots[0]?.timeToEmpty);
    expect(h.timeToEmpty.seconds as number).toBeGreaterThan(0);
    expect(h.longestExitQueue?.barrierId).toBe("exit-barrier");
    expect(h.longestEntryQueue?.metres).toBe(Math.max(...p.barriers.filter((b) => b.kind === "entry").map((b) => b.maxQueueMetres)));
    expect(h.turnedAwayCars).toBe(p.turnedAwayCars);
    expect(h.divertedCars).toBe(0);
    // The entry queues of this example spill onto the main road; the earliest time is reported.
    const reached = p.barriers.filter((b) => b.kind === "entry" && b.reachedPublicRoadAt !== null).map((b) => b.reachedPublicRoadAt as number);
    expect(h.entryReachedPublicRoad?.at ?? null).toBe(reached.length > 0 ? Math.min(...reached) : null);
  });

  it("says why there is no time to empty", () => {
    const lot = { lotId: "a", stalls: 10, parked: 5, maxOccupancy: 5, occupancy: [], meanSearchTime: 0, turnedAway: 0, divertedAway: 0, divertedIn: 0, closedAt: null, emptyAt: null, timeToEmpty: null };
    const p = { lots: [lot], barriers: [] } as unknown as ParkingMetrics;
    const dep = { departedPeople: 0, departedCars: 0, firstDepartureAt: null, lastDepartureAt: null } as DepartureMetrics;
    expect(timeToEmpty(p, null, true).status).toBe("noDepartures");
    expect(timeToEmpty(p, dep, false)).toEqual({ seconds: null, lotId: "a", status: "notYet" });
    expect(timeToEmpty(p, dep, true).status).toBe("notEmpty");
    // The slowest of the used lots counts; an unused lot does not.
    const p2 = { lots: [{ ...lot, timeToEmpty: 600, emptyAt: 1 }, { ...lot, lotId: "b", timeToEmpty: 900, emptyAt: 1 }, { ...lot, lotId: "c", parked: 0 }], barriers: [] } as unknown as ParkingMetrics;
    expect(timeToEmpty(p2, dep, true)).toEqual({ seconds: 900, lotId: "b", status: "empty" });
  });
});

describe("live parking rows", () => {
  it("joins the layout, the live states and the metrics per lot and per barrier", () => {
    const layout = finished.run.vehicleLayout;
    if (!layout) throw new Error("no layout");
    const lots = lotRows(layout, finished.mid.lots, finished.metrics.parking?.lots);
    expect(lots).toHaveLength(1);
    expect(lots[0]?.stalls).toBe(320);
    expect(lots[0]?.occupied).toBe(finished.mid.lots[0]?.occupied);
    expect(lots[0]?.share).toBeCloseTo((lots[0]?.occupied ?? 0) / 320, 12);
    const rows = barrierRows(layout, finished.mid.barriers, finished.metrics.parking?.barriers);
    expect(rows.map((r) => r.barrierId)).toEqual(["entry-north-barrier", "entry-south-barrier", "exit-barrier"]);
    const waiting = finished.mid.barriers.filter((b) => b.barrierId === "entry-north-barrier").reduce((s, b) => s + b.queueLength, 0);
    expect(rows[0]?.waiting).toBe(waiting);
    expect(rows[2]?.laneCount).toBe(2);
    expect(rows[2]?.reachedPublicRoadAt).toBeNull();
    // Without metrics yet, the metric columns are empty, not zero.
    expect(barrierRows(layout, [], undefined)[0]?.maxQueueMetres).toBeNull();
    expect(carsOnSite(finished.mid.counts)).toBe((finished.mid.counts[AgentState.Driving] ?? 0) + (finished.mid.counts[AgentState.Parked] ?? 0) + (finished.mid.counts[AgentState.Diverted] ?? 0));
    expect(carsOnSite(finished.mid.counts)).toBeGreaterThan(0);
  });

  it("builds occupancy and barrier queue series in scenario time", () => {
    const p = finished.metrics.parking as ParkingMetrics;
    const start = finished.run.toScenarioTime(0);
    const bin = finished.run.parameters.throughputBin;
    const occ = lotOccupancySeries(p.lots[0] as ParkingMetrics["lots"][number], start, bin);
    expect(occ.x[0]).toBe(start + bin);
    expect(Math.max(...occ.y)).toBe(p.lots[0]?.maxOccupancy);
    const q = barrierQueueSeries(p.barrierLanes, "exit-barrier", start, finished.run.parameters.queueSampleInterval);
    const lanes = p.barrierLanes.filter((l) => l.barrierId === "exit-barrier");
    expect(q.y[5]).toBe(lanes.reduce((s, l) => s + (l.queueLength[5] ?? 0), 0));
    expect(barrierQueueSeries(p.barrierLanes, "nope", start, 10)).toEqual({ x: [], y: [] });
  });
});

describe("event phase and lot closing", () => {
  const tl = payStation.timeline;
  const curve = finished.run.parameters.departureCurve;
  it("names the phase of the event for the clock", () => {
    expect(eventPhase(tl.gatesOpen - 1, tl, curve)).toBe("beforeOpening");
    expect(eventPhase(-60, tl, curve)).toBe("arrivals");
    expect(eventPhase(60, tl, curve)).toBe("event");
    expect(eventPhase(tl.eventEnd + 60, tl, curve)).toBe("departures");
    expect(eventPhase(tl.eventEnd + 60, tl, null)).toBe("event");
    expect(eventPhase(100, { ...tl, eventStart: null, gatesOpen: 0 }, null)).toBe("open");
  });

  it("records 'close lot now' as a lotClose event, and the run then turns new cars away", () => {
    const s = withLotClosed(payStation, "car-park", -1800);
    expect(s.timedEvents).toEqual([{ kind: "lotClose", at: -1800, lotId: "car-park" }]);
    expect(checkScenario(s, carPark.venue, validate)).toEqual([]);
    const closed = finishedRun(s);
    expect(closed.metrics.parking?.lots[0]?.closedAt).toBe(-1800);
    expect(closed.metrics.parking?.turnedAwayCars as number).toBeGreaterThan(finished.metrics.parking?.turnedAwayCars as number);
  });
});

describe("car markers", () => {
  it("styles cars by state and speed, and hides cars that are not on the map", () => {
    expect(CAR_STYLES[carStyleIndex(AgentState.Driving, 5, 0)]?.key).toBe("CarDriving");
    expect(CAR_STYLES[carStyleIndex(AgentState.Driving, 0.1, 0.1)]?.key).toBe("CarStopped");
    expect(CAR_STYLES[carStyleIndex(AgentState.Parked, 0, 0)]?.key).toBe("CarParked");
    expect(CAR_STYLES[carStyleIndex(AgentState.Diverted, 3, 0)]?.key).toBe("CarDiverted");
    for (const s of [AgentState.Pending, AgentState.Departed, AgentState.TurnedAway]) expect(carStyleIndex(s, 0, 0)).toBe(-1);
    // Colour is never the only cue: every style has its own shape.
    expect(new Set(CAR_STYLES.map((s) => s.shape)).size).toBe(CAR_STYLES.length);
  });
});

describe("road and stall geometry", () => {
  it("draws a stall as a rectangle along the parked car", () => {
    const c = stallCorners({ x: 10, y: 20, hx: 0, hy: 1 }, 2.5, 5);
    const xs = c.filter((_, k) => k % 2 === 0);
    const ys = c.filter((_, k) => k % 2 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2.5, 12);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(5, 12);
  });

  it("measures roads and spaces markings along them", () => {
    expect(roadWidth({ direction: "twoWay", laneCount: 1 }, 3)).toBe(6);
    expect(roadWidth({ direction: "oneWay", laneCount: 2 }, 3)).toBe(6);
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(pointsAlong(pts, 5).map((p) => [p.x, p.y, p.dx, p.dy])).toEqual([
      [2.5, 0, 1, 0],
      [7.5, 0, 1, 0],
      [10, 2.5, 0, 1],
      [10, 7.5, 0, 1],
    ]);
    const dashes = dashSegments(pts, 3, 2);
    const drawn = dashes.reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0);
    expect(drawn).toBeCloseTo(12, 9); // 20 m of road: 3 on, 2 off, four times
    expect(zebraStripes({ x: 0, y: 0 }, { x: 0, y: 4 }, 4, 0.5)).toHaveLength(4);
    const [x1, y1, x2, y2] = barrierArm({ x: 5, y: 5 }, { x: 1, y: 0 }, 3);
    expect(x1).toBe(5);
    expect(x2).toBe(5);
    expect(Math.abs(y2 - y1)).toBeCloseTo(2.7, 12);
  });

  it("marks where the site roads leave the public road", () => {
    const layout = finished.run.vehicleLayout;
    if (!layout) throw new Error("no layout");
    const marks = publicRoadBoundaries(layout);
    // Both entry roads start on the main road and the exit road ends on it.
    expect(marks.map((m) => m.roadId).sort()).toEqual(["entry-north", "entry-south", "exit-road"]);
    for (const m of marks) expect(Math.abs(m.x - -30)).toBeLessThan(6);
  });
});

describe("names and assumptions with cars", () => {
  it("names barriers, lots and pay stations, and lists the car assumptions", () => {
    expect(elementName(carPark.venue, "exit-barrier")).toBe(carPark.venue.vehicleBarriers?.find((b) => b.id === "exit-barrier")?.name);
    expect(elementName(carPark.venue, "car-park")).toBe(carPark.venue.parkingLots?.[0]?.name);
    expect(elementName(carPark.venue, "pay-machines")).toBe(carPark.venue.parkingLots?.[0]?.payStation?.name);
    const rows = describeParameters(finished.run.parameters, carPark.venue, payStation);
    const keys = rows.map((r) => r.key);
    for (const k of ["departureCurve", "carShare", "occupancy", "cardShare", "exit-barrier.lanes", "exit-barrier.type", "car-park.payment", "car-park.overflow"]) expect(keys).toContain(k);
    expect(rows.find((r) => r.key === "occupancy")?.assumed).toBe(true);
    expect(rows.find((r) => r.key === "carShare")?.assumed).toBe(false);
  });
});

describe("editor: cars, barriers, lots and lot closing", () => {
  it("round-trips the car park scenarios and writes every vehicle field as valid scenario JSON", () => {
    for (const s of carPark.scenarios) {
      const r = formToScenario(scenarioToForm(s, carPark.venue), s, carPark.venue);
      expect(r.problems, s.name).toEqual([]);
      expect(r.scenario, s.name).toEqual(s);
    }
    const f = scenarioToForm(payStation, carPark.venue);
    f.departurePreset = "stadium";
    f.occupancy = "1, 1";
    f.cardSharePercent = "90";
    f.carExitDelay = "30";
    f.carBoardDelay = "15";
    f.carLength = "4.8";
    f.carGap = "2";
    f.aisleSpeed = "10";
    f.parkManoeuvre = "8";
    f.barriers = f.barriers.map((b) => (b.id === "exit-barrier" ? { ...b, laneCount: "3", serviceType: "plate", misreadPercent: "2" } : b));
    f.lots = f.lots.map((l) => ({ ...l, paymentMode: "payAtBarrier", stallChoice: "nearestWalkingExit", overflowRule: "queue" }));
    f.events = [...f.events, newEventForm("lotClose", carPark.venue, -600)];
    const r = formToScenario(f, payStation, carPark.venue);
    expect(r.problems).toEqual([]);
    const s = r.scenario as Scenario;
    expect(s.departures).toEqual({ preset: "stadium" });
    expect(s.parameters).toMatchObject({ occupancy: [1, 1], cardShare: 0.9, carExitDelay: 30, carBoardDelay: 15, carLength: 4.8, carGap: 2, aisleSpeed: 10, parkManoeuvre: 8 });
    expect(s.overrides?.["exit-barrier"]).toEqual({ laneCount: 3, serviceType: "plate", scanFailureRate: 0.02 });
    expect(s.overrides?.["car-park"]).toEqual({ paymentMode: "payAtBarrier", stallChoice: "nearestWalkingExit", overflow: { rule: "queue" } });
    expect(s.timedEvents).toEqual([{ kind: "lotClose", at: -600, lotId: "car-park" }]);
    expect(checkScenario(s, carPark.venue, validate)).toEqual([]);
    // No departures, and a divert rule without a second lot is refused in words.
    f.departurePreset = "";
    f.lots = f.lots.map((l) => ({ ...l, overflowRule: "divert", divertTo: "" }));
    const bad = formToScenario(f, payStation, carPark.venue);
    expect(bad.problems.map((p) => p.field)).toContain("lots.car-park.divertTo");
    f.lots = f.lots.map((l) => ({ ...l, overflowRule: "" }));
    expect(formToScenario(f, payStation, carPark.venue).scenario?.departures).toBeUndefined();
  });
});

describe("comparison with cars", () => {
  const result = (metrics: MetricsSummary, jobId: number): RunResult => ({ jobId, seed: 1, metrics, startTime: -3600, queueSampleInterval: 10, throughputBin: 60, hash: "x", durationMs: 1 });
  it("adds parking headline rows and per-lot and per-barrier rows with verdicts", () => {
    const atBarrier = finishedRun(carPark.scenarios[1] as Scenario).metrics;
    const name = (id: string) => elementName(carPark.venue, id);
    const keys = parkingMeasures(finished.metrics, name).map((m) => m.key);
    expect(keys.slice(0, 6)).toEqual(["parking.timeToEmpty", "parking.exitQueue", "parking.entryQueue", "parking.publicRoad", "parking.turnedAway", "parking.diverted"]);
    expect(keys).toContain("lot.car-park.timeToEmpty");
    expect(keys).toContain("barrier.exit-barrier.maxQueue");
    expect(keys).toContain("barrier.entry-north-barrier.publicRoad");
    expect(keys).not.toContain("barrier.exit-barrier.publicRoad");
    expect(parkingMeasures(null, name)).toEqual([]);

    const rows = measureRows([[result(finished.metrics, 0)], [result(atBarrier, 1)]], true, false, name);
    const tte = rows.find((r) => r.measure.key === "parking.timeToEmpty");
    expect(tte?.cells[0]).not.toBe("–");
    // Paying at the barrier empties the car park later (example description): worse.
    const d = tte?.differences[1];
    expect(d?.verdict).toBe((atBarrier.parking?.lots[0]?.timeToEmpty as number) > (finished.metrics.parking?.lots[0]?.timeToEmpty as number) ? "worse" : "better");
    const lotRow = rows.find((r) => r.measure.key === "lot.car-park.timeToEmpty");
    expect(lotRow?.measure.sub).toBe(true);
    expect(lotRow?.measure.label).toBe(`${name("car-park")}: time until empty`);
  });

  it("formats car units in words", () => {
    const m = parkingMeasures(finished.metrics, (id) => id);
    const q = m.find((x) => x.key === "parking.exitQueue");
    const flag = m.find((x) => x.key === "parking.publicRoad");
    const cars = m.find((x) => x.key === "parking.turnedAway");
    if (!q || !flag || !cars) throw new Error("missing measures");
    expect(compareValues(q, 40, 12)?.sentence).toBe("Longest exit queue: 40 m → 12 m (−28 m, better)");
    expect(compareValues(flag, 1, 0)?.sentence).toBe("Entry queue reached the public road: yes → no (−100 points, better)");
    expect(compareValues(cars, 3, 9)?.verdict).toBe("worse");
  });
});
