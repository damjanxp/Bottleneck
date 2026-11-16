import { describe, expect, it } from "vitest";
import { exampleVenues } from "@bottleneck/examples";
import type { Point, Venue } from "@bottleneck/schema";
import commonSchema from "../../../../schema/common.schema.json";
import scenarioSchema from "../../../../schema/scenario.schema.json";
import venueSchema from "../../../../schema/venue.schema.json";
import type { SchemaError, SchemaValidator } from "../library/validate.ts";
import { buildScenarioValidatorSource } from "../validation/buildValidator.ts";
import { calibrate, distance, pixelToVenue, venueToPixel } from "./calibration.ts";
import { area, isDegenerateOrSelfIntersecting, selfIntersections } from "./geometry.ts";
import { HISTORY_LIMIT, canRedo, canUndo, commit, createHistory, redo, undo } from "./history.ts";
import { applyFix, checkVenue, cleanupProblems, hasErrors, structureProblems } from "./venueChecks.ts";
import { addGate, addPolygon, addSource, blankVenue, deleteElement, handles, moveHandle } from "./edits.ts";
import type { KeyValueStore } from "../library/storage.ts";
import { USER_VENUES_KEY, loadUserVenues, removeUserVenue, saveUserVenues, upsertUserVenue } from "../library/userVenues.ts";

// The build-time standalone validator (what the browser uses), evaluated in Node.
const source = buildScenarioValidatorSource({ "common.schema.json": commonSchema as object, "scenario.schema.json": scenarioSchema as object, "venue.schema.json": venueSchema as object });
const standalone = new Function(`${source.replace(/export const (validateScenario|validateVenue)/g, "const $1")}\nreturn validateVenue;`)() as ((d: unknown) => boolean) & { errors?: SchemaError[] | null };
const validateVenue: SchemaValidator = (d) => {
  const ok = standalone(d);
  return { ok, errors: ok ? [] : (standalone.errors ?? []) };
};

const concert = (exampleVenues.find((v) => v.venue.id === "belgrade-fair-concert") ?? exampleVenues[0])!.venue;

const sq = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** A small venue drawn the way the editor builds one. */
const drawn: Venue = {
  schemaVersion: 1,
  id: "drawn-venue",
  name: "Drawn venue",
  walkableAreas: [{ id: "area-1", polygon: { outer: sq(0, 0, 80, 40) } }],
  obstacles: [],
  sources: [{ id: "source-1", name: "Tram", position: { x: 5, y: 20 }, share: 1 }],
  screeningStages: [],
  gateGroups: [
    {
      id: "gate-1",
      name: "Gate 1",
      line: { a: { x: 40, y: 32 }, b: { x: 40, y: 8 } },
      laneCount: 4,
      queueLength: 15,
      serviceTime: { kind: "shiftedLognormal", shift: 2.5, mu: 0.25, sigma: 0.55 },
      scanFailure: { rate: 0.03, retryTime: { kind: "uniform", min: 5, max: 15 } },
    },
  ],
  destinations: [{ id: "destination-1", name: "Hall", area: { outer: sq(65, 10, 78, 30) } }],
};

describe("[test] two-click calibration", () => {
  it("after calibrating on a known 100 m, another 100 m distance measures 100 m ± 1%", () => {
    // A map at 0.2287 m per pixel: a 100 m wall spans 437.3 px, clicked to whole pixels.
    const truth = 0.2287;
    const a = { px: 120, py: 300 };
    const b = { px: 120 + Math.round(100 / truth / Math.SQRT2), py: 300 + Math.round(100 / truth / Math.SQRT2) };
    const c = calibrate(a, b, 100);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const cal = { metresPerPixel: c.metresPerPixel, origin: { x: -50, y: 12 } };
    // A different 100 m stretch elsewhere on the same map (horizontal, also clicked to whole pixels).
    const p = pixelToVenue(cal, { px: 40, py: 900 });
    const q = pixelToVenue(cal, { px: 40 + Math.round(100 / truth), py: 900 });
    expect(Math.abs(distance(p, q) - 100)).toBeLessThan(1);
    // Pixels and venue metres convert both ways.
    const back = venueToPixel(cal, p);
    expect(back.px).toBeCloseTo(40, 9);
    expect(back.py).toBeCloseTo(900, 9);
  });

  it("refuses the same point twice, points too close together and a non-positive distance", () => {
    expect(calibrate({ px: 5, py: 5 }, { px: 5, py: 5 }, 100)).toEqual({ ok: false, reason: "same-point" });
    expect(calibrate({ px: 5, py: 5 }, { px: 9, py: 5 }, 100)).toEqual({ ok: false, reason: "too-close" });
    expect(calibrate({ px: 0, py: 0 }, { px: 100, py: 0 }, 0)).toEqual({ ok: false, reason: "bad-distance" });
    expect(calibrate({ px: 0, py: 0 }, { px: 100, py: 0 }, Number.NaN)).toEqual({ ok: false, reason: "bad-distance" });
  });
});

describe("[test] undo and redo", () => {
  const move = (v: Venue, dx: number): Venue => ({ ...v, sources: v.sources.map((s) => ({ ...s, position: { ...s.position, x: s.position.x + dx } })) });

  it("undo returns exactly the previous document, and redo the next one", () => {
    let h = createHistory(drawn);
    const snapshot = JSON.stringify(drawn);
    h = commit(h, move(h.present, 1));
    h = commit(h, { ...h.present, name: "Renamed" });
    const latest = h.present;
    h = undo(h);
    h = undo(h);
    expect(h.present).toBe(drawn); // the very same object
    expect(JSON.stringify(h.present)).toBe(snapshot); // and untouched by the edits
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(latest);
    expect(canRedo(h)).toBe(false);
  });

  it("a new edit after undo clears redo; an edit that changes nothing adds no step", () => {
    let h = commit(createHistory(drawn), move(drawn, 1));
    h = undo(h);
    h = commit(h, move(h.present, 2));
    expect(canRedo(h)).toBe(false);
    expect(commit(h, h.present)).toBe(h);
  });

  it("a drag (edits with the same key in a row) is one undo step", () => {
    let h = createHistory(drawn);
    for (let i = 1; i <= 30; i++) h = commit(h, move(h.present, 0.5), "drag:source-1");
    expect(h.past).toHaveLength(1);
    expect(h.present.sources[0]?.position.x).toBe(20);
    h = undo(h);
    expect(h.present).toBe(drawn);
  });

  it("keeps at most HISTORY_LIMIT steps", () => {
    let h = createHistory(drawn);
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) h = commit(h, move(h.present, 1));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("[test] polygon checks", () => {
  it("finds a bow tie and accepts a simple polygon, a concave one and a square with a hole", () => {
    const bowTie = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(selfIntersections(bowTie)).toEqual([[0, 2]]);
    expect(isDegenerateOrSelfIntersecting({ outer: bowTie })).toBe(true);
    expect(isDegenerateOrSelfIntersecting({ outer: sq(0, 0, 10, 10) })).toBe(false);
    const l = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isDegenerateOrSelfIntersecting({ outer: l })).toBe(false);
    expect(area(l)).toBe(64);
    expect(isDegenerateOrSelfIntersecting({ outer: sq(0, 0, 10, 10), holes: [sq(2, 2, 4, 4)] })).toBe(false);
  });

  it("finds a corner that touches another edge, a spike that folds back, and a polygon with no area", () => {
    const touching = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 0 }, // lies on the first edge
    ];
    expect(selfIntersections(touching).length).toBeGreaterThan(0);
    const spike = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 }, // folds back along the previous edge
      { x: 5, y: 8 },
    ];
    expect(selfIntersections(spike).length).toBeGreaterThan(0);
    expect(isDegenerateOrSelfIntersecting({ outer: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] })).toBe(true);
  });
});

describe("[test] venue validation flags an unreachable source and a self-intersecting polygon", () => {
  it("accepts every built-in example and a freshly drawn venue", () => {
    for (const e of exampleVenues) expect(checkVenue(e.venue, validateVenue).filter((p) => p.severity === "error")).toEqual([]);
    expect(checkVenue(drawn, validateVenue)).toEqual([]);
  });

  it("a blank venue is refused with plain reasons, not an exception", () => {
    const blank: Venue = { schemaVersion: 1, id: "blank", name: "Blank", walkableAreas: [], obstacles: [], sources: [], screeningStages: [], gateGroups: [], destinations: [] };
    const problems = checkVenue(blank, validateVenue);
    expect(problems.filter((p) => p.severity === "error").map((p) => p.message)).toEqual([
      "Draw at least one walkable area: people can only walk there.",
      "Add at least one source: where people arrive.",
      "Add at least one destination: where people are going.",
    ]);
  });

  it("flags a source on an island that cannot reach the gates", () => {
    const v: Venue = {
      ...drawn,
      walkableAreas: [...drawn.walkableAreas, { id: "area-2", polygon: { outer: sq(200, 0, 220, 20) } }],
      sources: [...drawn.sources.map((s) => ({ ...s, share: 0.5 })), { id: "source-2", name: "Car park stop", position: { x: 210, y: 10 }, share: 0.5 }],
    };
    const problems = checkVenue(v, validateVenue);
    expect(hasErrors(problems)).toBe(true);
    expect(problems).toContainEqual(expect.objectContaining({ severity: "error", elementId: "source-2", message: expect.stringContaining("cannot reach any entry lane") }));
  });

  it("flags a walkable area that crosses itself", () => {
    const v: Venue = {
      ...drawn,
      walkableAreas: [
        {
          id: "area-1",
          polygon: {
            outer: [
              { x: 0, y: 0 },
              { x: 80, y: 40 },
              { x: 80, y: 0 },
              { x: 0, y: 40 },
            ],
          },
        },
      ],
    };
    const problems = checkVenue(v, validateVenue);
    expect(problems).toContainEqual(expect.objectContaining({ severity: "error", elementId: "area-1", message: expect.stringContaining("crosses itself") }));
  });

  it("reports schema errors as sentences, and duplicate ids and broken references", () => {
    const bad = checkVenue({ ...drawn, gateGroups: [{ ...drawn.gateGroups[0], laneCount: 0 }] }, validateVenue);
    expect(bad[0]?.message).toMatch(/gate group 1 › lane count|laneCount/i);
    const dup = structureProblems({ ...drawn, destinations: [{ ...drawn.destinations[0]!, id: "gate-1" }] });
    expect(dup).toContainEqual(expect.objectContaining({ severity: "error", message: expect.stringContaining("used twice") }));
    const ref = structureProblems({ ...drawn, gateGroups: [{ ...drawn.gateGroups[0]!, screeningStageId: "nowhere" }] });
    expect(ref).toContainEqual(expect.objectContaining({ severity: "error", elementId: "gate-1" }));
  });

  it("warns (without blocking) about a source drawn off the walkable area and shares that do not add up to 1", () => {
    const v: Venue = { ...drawn, sources: [{ ...drawn.sources[0]!, position: { x: -3, y: 20 }, share: 0.8 }] };
    const problems = checkVenue(v, validateVenue);
    expect(hasErrors(problems)).toBe(false);
    expect(problems.map((p) => p.severity)).toEqual(["warning", "warning"]);
    expect(concert.id).toBe("belgrade-fair-concert");
  });
});

describe("editing operations keep the document immutable", () => {
  it("adds elements with fresh ids, moves handles, deletes, and never mutates the input", () => {
    const frozen = JSON.stringify(drawn);
    const a = addSource(drawn, { x: 12.345, y: 20 });
    expect(a.id).toBe("source-2");
    expect(a.venue.sources.map((s) => s.share)).toEqual([0.5, 0.5]);
    expect(a.venue.sources[1]?.position).toEqual({ x: 12.35, y: 20 }); // rounded to centimetres
    expect(a.venue.walkableAreas).toBe(drawn.walkableAreas); // untouched parts are shared
    const three = addSource(a.venue, { x: 1, y: 1 }).venue.sources.map((s) => s.share);
    expect(three.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
    const g = addGate(drawn, { x: 30, y: 30 }, { x: 30, y: 10 });
    expect(g.id).toBe("gate-2");
    expect(g.venue.gateGroups[1]?.laneCount).toBe(4);
    const p = addPolygon(drawn, "obstacle", sq(20, 20, 22, 22));
    expect(p.venue.obstacles[0]?.id).toBe("obstacle-1");
    const h = handles(drawn).find((x) => x.handle.kind === "lineEnd" && x.handle.end === "a");
    expect(h).toBeDefined();
    const moved = moveHandle(drawn, h!.handle, { x: 41, y: 33 });
    expect(moved.gateGroups[0]?.line.a).toEqual({ x: 41, y: 33 });
    expect(deleteElement(drawn, "gate-1").gateGroups).toEqual([]);
    expect(deleteElement(drawn, "nothing")).toBe(drawn);
    expect(JSON.stringify(drawn)).toBe(frozen);
    expect(blankVenue("v-1", "New").walkableAreas).toEqual([]);
  });
});

describe("venues saved in this browser", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };

  it("round-trip exactly, sorted by id, with replace and remove", () => {
    const store = memory();
    let list = upsertUserVenue([], drawn, "2026-11-16T00:00:00.000Z");
    list = upsertUserVenue(list, { ...drawn, id: "a-venue", name: "A" }, "t");
    expect(list.map((v) => v.id)).toEqual(["a-venue", "drawn-venue"]);
    expect(saveUserVenues(store, list)).toBe(true);
    expect(loadUserVenues(store)).toEqual(list);
    expect(removeUserVenue(list, "a-venue").map((v) => v.id)).toEqual(["drawn-venue"]);
  });

  it("skips entries that are not venues and ignores an unknown format", () => {
    const store = memory();
    store.setItem(USER_VENUES_KEY, JSON.stringify({ format: 1, venues: [{ venue: drawn, savedAt: "t" }, { venue: { id: 3 } }, null] }));
    expect(loadUserVenues(store).map((v) => v.id)).toEqual(["drawn-venue"]);
    store.setItem(USER_VENUES_KEY, JSON.stringify({ format: 2, venues: [] }));
    expect(loadUserVenues(store)).toEqual([]);
    store.setItem(USER_VENUES_KEY, "{not json");
    expect(loadUserVenues(store)).toEqual([]);
  });
});

describe("clean-up checks for imported venues", () => {
  it("flags tiny shapes and walkable islands, and the one-click fixes remove them", () => {
    const v: Venue = {
      ...drawn,
      walkableAreas: [...drawn.walkableAreas, { id: "island", polygon: { outer: sq(200, 0, 220, 20) } }, { id: "speck", polygon: { outer: sq(5, 5, 6, 6) } }],
      obstacles: [{ id: "dot", polygon: { outer: sq(30, 30, 31, 31) } }],
    };
    const problems = cleanupProblems(v);
    expect(problems.filter((p) => p.fix === "removeTiny").map((p) => p.elementId).sort()).toEqual(["dot", "speck"]);
    expect(problems.filter((p) => p.fix === "removeIsolated").map((p) => p.elementId)).toEqual(["island"]);
    const fixed = applyFix(applyFix(v, problems, "removeTiny"), problems, "removeIsolated");
    expect(fixed.walkableAreas.map((w) => w.id)).toEqual(["area-1"]);
    expect(fixed.obstacles).toEqual([]);
    expect(cleanupProblems(fixed)).toEqual([]);
  });
});
