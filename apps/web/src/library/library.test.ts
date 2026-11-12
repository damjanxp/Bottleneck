import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { distributionMoments } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario, Venue } from "@bottleneck/schema";
import commonSchema from "../../../../schema/common.schema.json";
import scenarioSchema from "../../../../schema/scenario.schema.json";
import { buildScenarioValidatorSource } from "../validation/buildValidator.ts";
import { exportFileName, parseScenarioFile, scenarioToJson } from "./files.ts";
import { editTime, formToScenario, newEventForm, parseTime, scenarioToForm, timeField, type ScenarioForm } from "./form.ts";
import { ID_PATTERN, blankScenario, copyName, duplicateScenario, newScenarioId, readSimpleServiceTime, serviceTimeWithMean, withLaneCount, withTimedEvent } from "./scenarios.ts";
import { DROPPED_KEY, LIBRARY_KEY, dropInvalid, loadLibrary, removeEntry, saveLibrary, upsertEntry, type KeyValueStore } from "./storage.ts";
import { checkScenario, pathLabel, schemaMessages, venueProblems, type SchemaValidator } from "./validate.ts";

// The reference validator: Ajv at run time (fine in Node; the browser uses the build-time one).
const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
ajv.addSchema(commonSchema as object, "common.schema.json");
ajv.addSchema(scenarioSchema as object, "scenario.schema.json");
const ajvValidate = ajv.getSchema("scenario.schema.json");
if (!ajvValidate) throw new Error("scenario schema missing");
const validate: SchemaValidator = (data) => {
  const ok = ajvValidate(data) as boolean;
  return { ok, errors: ok ? [] : [...(ajvValidate.errors ?? [])] };
};

const concert = exampleVenues.find((v) => v.id === "belgrade-fair-concert") as (typeof exampleVenues)[number];
const fair = exampleVenues.find((v) => v.id === "belgrade-fair-fair-day") as (typeof exampleVenues)[number];
const venues: Venue[] = exampleVenues.map((v) => v.venue);
const allBuiltIns = exampleVenues.flatMap((v) => v.scenarios.map((s) => ({ venue: v.venue, scenario: s })));

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe("build-time (standalone) scenario validator", () => {
  // The browser cannot use Ajv's run-time compiler under the CSP, so it uses this generated code.
  const source = buildScenarioValidatorSource({ "common.schema.json": commonSchema as object, "scenario.schema.json": scenarioSchema as object });
  // Evaluating the generated module in Node only (the browser imports it as a module).
  const standalone = new Function(`${source.replace(/export const validateScenario/, "const validateScenario")}\nreturn validateScenario;`)() as (d: unknown) => boolean;

  it("contains no run-time code generation and no imports", () => {
    expect(source).not.toMatch(/new Function|\beval\(|require\(|^import /m);
  });

  it("accepts and rejects the same documents as Ajv", () => {
    const docs: unknown[] = [
      ...allBuiltIns.map((x) => x.scenario),
      blankScenario(concert.venue, "user-a"),
      { ...blankScenario(concert.venue, "user-b"), attendance: 0 },
      { ...blankScenario(concert.venue, "user-c"), name: "" },
      { ...blankScenario(concert.venue, "user-d"), name: "x".repeat(121) },
      { ...blankScenario(concert.venue, "user-e"), extra: 1 },
      { ...blankScenario(concert.venue, "user-f"), overrides: { "gate-main": {} } },
      { ...blankScenario(concert.venue, "user-g"), overrides: { "gate-main": { serviceTime: { kind: "mixture", components: [{ weight: 1, distribution: { kind: "fixed", value: 3 } }] } } } },
      { ...blankScenario(concert.venue, "user-h"), timedEvents: [{ kind: "laneFail", at: 0, groupId: "gate-main", laneIndex: 64 }] },
      { ...blankScenario(concert.venue, "user-i"), timeline: { referenceClock: "24:00", gatesOpen: 0, eventStart: null, eventEnd: 1, horizon: 2 } },
    ];
    for (const d of docs) expect(standalone(d)).toBe(validate(d).ok);
    expect(docs.filter((d) => standalone(d)).length).toBe(allBuiltIns.length + 2);
  });
});

describe("scenario helpers", () => {
  it("makes ids that the schema accepts", () => {
    const id = newScenarioId(1_700_000_000_000, () => 0.5);
    expect(id).toMatch(ID_PATTERN);
    expect(id.startsWith("user-")).toBe(true);
    expect(newScenarioId(0, () => 0)).toMatch(ID_PATTERN);
  });

  it("creates valid blank scenarios for both kinds of event", () => {
    expect(checkScenario(blankScenario(concert.venue, "user-x"), concert.venue, validate)).toEqual([]);
    expect(checkScenario(blankScenario(fair.venue, "user-y", true), fair.venue, validate)).toEqual([]);
  });

  it("duplicates deeply and names copies", () => {
    const s = concert.scenarios[0] as Scenario;
    const d = duplicateScenario(s, "user-copy", copyName(s.name));
    expect(d.name).toBe("Concert, 3 lanes (copy)");
    expect(d.id).toBe("user-copy");
    d.overrides!["gate-main"]!.laneCount = 9;
    expect(s.overrides!["gate-main"]!.laneCount).toBe(3);
    expect(copyName("x".repeat(120)).length).toBe(120);
  });

  it("inserts timed events in time order, keeping equal times in insertion order", () => {
    let s = blankScenario(concert.venue, "user-t");
    s = withTimedEvent(s, { kind: "laneFail", at: 100, groupId: "gate-main", laneIndex: 0 });
    s = withTimedEvent(s, { kind: "laneFail", at: 50, groupId: "gate-main", laneIndex: 1 });
    s = withTimedEvent(s, { kind: "laneReopen", at: 100, groupId: "gate-main", laneIndex: 0 });
    expect(s.timedEvents?.map((e) => `${e.kind}@${e.at}`)).toEqual(["laneFail@50", "laneFail@100", "laneReopen@100"]);
  });

  it("sets lane counts within the schema's limits", () => {
    const s = withLaneCount(concert.scenarios[0] as Scenario, "gate-main", 4);
    expect(s.overrides?.["gate-main"]).toEqual({ laneCount: 4 });
    expect(withLaneCount(s, "gate-main", 99).overrides?.["gate-main"]?.laneCount).toBe(64);
  });

  it("builds a service time with a fitted mean but the existing shape", () => {
    const shape = concert.venue.gateGroups[0]!.serviceTime; // shifted lognormal, minimum 2.5 s
    const d = serviceTimeWithMean(shape, 5);
    expect(readSimpleServiceTime(d)?.min).toBe(2.5);
    expect(distributionMoments(d).mean).toBeCloseTo(5, 9);
    // A mean below the old minimum gets a minimum of 60% of the mean.
    const low = serviceTimeWithMean(shape, 2);
    expect(readSimpleServiceTime(low)?.min).toBeCloseTo(1.2, 9);
    expect(distributionMoments(low).mean).toBeCloseTo(2, 9);
    // Other kinds (a mixture) become a shifted lognormal with the same mean.
    const mix = serviceTimeWithMean({ kind: "mixture", components: [{ weight: 1, distribution: { kind: "fixed", value: 3 } }] }, 4);
    expect(distributionMoments(mix).mean).toBeCloseTo(4, 9);
  });
});

describe("editor form", () => {
  it("round-trips every built-in scenario exactly", () => {
    for (const { venue, scenario } of allBuiltIns) {
      const r = formToScenario(scenarioToForm(scenario, venue), scenario, venue);
      expect(r.problems, scenario.name).toEqual([]);
      expect(r.scenario, scenario.name).toEqual(scenario);
    }
  });

  it("keeps exact seconds for untouched time fields and rounds edited ones to 1 ms", () => {
    const f = timeField(-2731.25);
    expect(parseTime(f)).toBe(-2731.25);
    expect(parseTime(editTime(f, "-45.5"))).toBe(-2730);
    expect(parseTime(editTime(f, "1/3"))).toBeNaN();
    expect(parseTime(editTime(f, "0,5"))).toBe(30);
  });

  /** Fills every field the editor has, in the ways a person might. */
  function fullyEdited(venue: Venue, s: Scenario): ScenarioForm {
    const f = scenarioToForm(s, venue);
    f.name = `${s.name} edited`;
    f.attendance = "5000";
    f.seed = "42";
    f.carSharePercent = "35";
    f.walking = { mean: "1.2", sd: "0.3" };
    f.nearestLaneSharePercent = "25";
    f.groupSizes = "0.5, 0.3, 0.2";
    f.bagPolicy = "fullSearch";
    f.decisionDistance = "25";
    f.logitScale = "10";
    f.jockeyThreshold = "4";
    f.elements = f.elements.map((el, k) =>
      k % 2 === 0
        ? { ...el, laneCount: "6", serviceMode: "simple", serviceMin: "2", serviceMean: "4.5", serviceSigma: "0.6", scanFailurePercent: el.kind === "gate" ? "5" : "" }
        : { ...el, laneCount: "2", serviceMode: "json", serviceJson: '{"kind":"mixture","components":[{"weight":1,"distribution":{"kind":"uniform","min":2,"max":5}}]}' },
    );
    f.events = [newEventForm("laneFail", venue, f.gatesOpen.seconds ?? 0), newEventForm("laneReopen", venue, (f.gatesOpen.seconds ?? 0) + 600), newEventForm("busBurst", venue, 120)];
    return f;
  }

  it("produces schema-valid scenarios from every kind of edit (the editor never saves an invalid document)", () => {
    const bases = [...allBuiltIns, { venue: concert.venue, scenario: blankScenario(concert.venue, "user-blank") }, { venue: fair.venue, scenario: blankScenario(fair.venue, "user-fair", true) }];
    for (const { venue, scenario } of bases) {
      const variants: ScenarioForm[] = [scenarioToForm(scenario, venue), fullyEdited(venue, scenario)];
      const cleared = fullyEdited(venue, scenario);
      cleared.walking = { mean: "", sd: "" };
      cleared.groupSizes = "";
      cleared.elements = cleared.elements.map((el) => ({ ...el, laneCount: "", serviceMode: "default", scanFailurePercent: "" }));
      cleared.fixedStart = false;
      cleared.eventType = "fair";
      cleared.arrivalPreset = "fair";
      cleared.keepCustomPoints = false;
      variants.push(cleared);
      for (const form of variants) {
        const r = formToScenario(form, scenario, venue);
        expect(r.problems, `${scenario.name}: ${JSON.stringify(r.problems)}`).toEqual([]);
        const result = validate(r.scenario);
        expect(result.ok, `${scenario.name}: ${JSON.stringify(result.errors)}`).toBe(true);
        expect(venueProblems(r.scenario as Scenario, venue)).toEqual([]);
      }
    }
  });

  it("reads the simple service-time helper as an exact shifted lognormal", () => {
    const f = fullyEdited(concert.venue, concert.scenarios[0] as Scenario);
    const s = formToScenario(f, concert.scenarios[0] as Scenario, concert.venue).scenario as Scenario;
    const st = s.overrides?.[f.elements[0]!.id]?.serviceTime;
    expect(st?.kind).toBe("shiftedLognormal");
    expect(distributionMoments(st!).mean).toBeCloseTo(4.5, 9);
    expect(s.parameters?.groupSizes).toEqual([0.5, 0.3, 0.2]);
    // Sorted by time: fail at the opening (−90 min), reopen 10 min later, the bus 2 min after the start.
    expect(s.timedEvents?.map((e) => `${e.kind}@${e.at}`)).toEqual(["laneFail@-5400", "laneReopen@-4800", "busBurst@120"]);
  });

  it("explains bad input in plain words instead of producing a scenario", () => {
    const base = concert.scenarios[0] as Scenario;
    const f = scenarioToForm(base, concert.venue);
    f.name = " ";
    f.attendance = "12.5";
    f.groupSizes = "0, 0";
    f.elements[0] = { ...f.elements[0]!, serviceMode: "simple", serviceMin: "5", serviceMean: "4" };
    f.elements[1] = { ...f.elements[1]!, serviceMode: "json", serviceJson: "{oops" };
    f.arrivalPreset = "custom";
    f.keepCustomPoints = false;
    f.referenceClock = "8pm";
    const r = formToScenario(f, base, concert.venue);
    expect(r.scenario).toBeNull();
    const text = r.problems.map((p) => p.message).join("\n");
    expect(text).toContain("Give the scenario a name");
    expect(text).toContain("Attendance must be a whole number from 1 to 200,000");
    expect(text).toContain("Group sizes");
    expect(text).toContain("mean service time must be above the minimum");
    expect(text).toContain("not valid JSON");
    expect(text).toContain("custom");
    expect(text).toContain("20:00");
  });

  it("finds problems against the venue that the schema cannot see", () => {
    const s: Scenario = {
      ...blankScenario(concert.venue, "user-v"),
      overrides: { "gate-main": { laneCount: 2 }, "no-such-gate": { laneCount: 3 } },
      timedEvents: [
        { kind: "laneFail", at: -100, groupId: "gate-main", laneIndex: 2 },
        { kind: "busBurst", at: 0, sourceId: "nowhere", count: 10 },
      ],
    };
    const msgs = venueProblems(s, concert.venue).map((p) => p.message);
    expect(msgs).toEqual([
      "There is a change for “no-such-gate”, but the venue has no gate group or screening stage with that id.",
      "Timed event 1: Main turnstiles has 2 lanes in this scenario, so there is no lane 3.",
      "Timed event 2: the venue has no source “nowhere”.",
    ]);
  });

  it("turns schema errors into short sentences", () => {
    expect(pathLabel("/timedEvents/2/at")).toBe("timed event 3 › at");
    expect(pathLabel("/overrides/gate-main/laneCount")).toBe("override for “gate-main” › laneCount");
    const bad = { ...blankScenario(concert.venue, "user-s"), attendance: -1, color: "red" };
    const msgs = schemaMessages(validate(bad).errors);
    expect(msgs).toContain("Attendance must be >= 1.");
    expect(msgs).toContain("Scenario has an unknown field “color”.");
  });
});

describe("localStorage library", () => {
  const s1 = { ...(concert.scenarios[0] as Scenario), id: "user-one", name: "Mine" };
  const s2 = { ...(fair.scenarios[0] as Scenario), id: "user-two", name: "Fair mine" };

  it("saves under one versioned key and loads the same entries back", () => {
    const store = memoryStore();
    let entries = upsertEntry([], s1, new Date("2026-11-12T10:00:00Z"));
    entries = upsertEntry(entries, s2, new Date("2026-11-12T10:01:00Z"));
    entries = upsertEntry(entries, { ...s1, name: "Mine, renamed" }, new Date("2026-11-12T10:02:00Z"));
    expect(saveLibrary(store, entries)).toBeNull();
    expect([...store.data.keys()]).toEqual([LIBRARY_KEY]);
    const stored = JSON.parse(store.data.get(LIBRARY_KEY) as string) as { format: string; version: number; entries: { schemaVersion: number }[] };
    expect(stored.format).toBe("bottleneck-scenario-library");
    expect(stored.version).toBe(1);
    expect(stored.entries.every((e) => e.schemaVersion === 1)).toBe(true);
    const loaded = loadLibrary(store);
    expect(loaded.error).toBeNull();
    expect(loaded.dropped).toEqual([]);
    expect(loaded.entries.map((e) => e.scenario.name)).toEqual(["Mine, renamed", "Fair mine"]);
    expect(loaded.entries[0]?.savedAt).toBe("2026-11-12T10:02:00.000Z");
    expect(removeEntry(loaded.entries, "user-one").map((e) => e.id)).toEqual(["user-two"]);
  });

  it("drops incompatible entries with a reason, backs them up, and keeps the rest", () => {
    const store = memoryStore();
    const good = { id: "user-one", schemaVersion: 1, savedAt: "x", scenario: s1 };
    store.setItem(LIBRARY_KEY, JSON.stringify({ format: "bottleneck-scenario-library", version: 1, entries: [good, { id: "old", schemaVersion: 0, scenario: { ...s2, schemaVersion: 0, name: "Old one" } }, "junk", good] }));
    const r = loadLibrary(store);
    expect(r.entries.map((e) => e.id)).toEqual(["user-one"]);
    expect(r.dropped.map((d) => d.name)).toEqual(["Old one", "entry 3", "Mine"]);
    expect(r.dropped[0]?.reason).toContain("schemaVersion 0");
    expect(r.dropped[2]?.reason).toBe("duplicate id");
    expect(JSON.parse(store.data.get(DROPPED_KEY) as string)).toHaveLength(3);
    // The cleaned library was written back.
    expect(loadLibrary(store).dropped).toEqual([]);
  });

  it("drops entries that fail the schema once the validator is loaded", () => {
    const store = memoryStore();
    const entries = upsertEntry(upsertEntry([], s1, new Date(0)), { ...s2, attendance: -5 }, new Date(0));
    saveLibrary(store, entries);
    const r = dropInvalid(store, loadLibrary(store).entries, (s) => (validate(s).ok ? null : "does not match the schema"));
    expect(r.entries.map((e) => e.id)).toEqual(["user-one"]);
    expect(r.dropped).toEqual([{ name: "Fair mine", reason: "does not match the schema" }]);
    expect(loadLibrary(store).entries).toHaveLength(1);
  });

  it("survives unreadable data, other formats and a library version from the future", () => {
    const store = memoryStore();
    store.setItem(LIBRARY_KEY, "{not json");
    expect(loadLibrary(store).dropped[0]?.reason).toContain("not valid JSON");
    store.setItem(LIBRARY_KEY, JSON.stringify({ format: "bottleneck-scenario-library", version: 2, entries: [] }));
    expect(loadLibrary(store).dropped[0]?.reason).toContain("library format 2");
    store.setItem(LIBRARY_KEY, JSON.stringify([1, 2]));
    expect(loadLibrary(store).dropped[0]?.reason).toContain("unknown format");
  });

  it("never throws when storage is missing or refuses access", () => {
    expect(loadLibrary(null).error).toContain("storage is disabled");
    expect(saveLibrary(null, [])).toContain("does not allow saving");
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(loadLibrary(throwing).error).toContain("refused");
    expect(saveLibrary(throwing, [])).toContain("QuotaExceededError");
  });
});

describe("JSON export and import", () => {
  const used = new Set(allBuiltIns.map((x) => x.scenario.id as string));
  let n = 0;
  const newId = () => `user-import-${++n}`;

  it("exports the scenario document itself under a readable file name", () => {
    const s = concert.scenarios[0] as Scenario;
    expect(exportFileName(s)).toBe("concert-3-lanes.scenario.json");
    expect(exportFileName({ ...s, name: "Ćevapi & Šljivovica!" })).toBe("cevapi-sljivovica.scenario.json");
    expect(JSON.parse(scenarioToJson(s))).toEqual(s);
  });

  it("imports an exported scenario, giving it a new id when the id is taken", () => {
    const s = concert.scenarios[0] as Scenario;
    const r = parseScenarioFile(scenarioToJson(s), venues, validate, used, newId);
    expect(r.problems).toEqual([]);
    expect(r.renamedId).toBe(true);
    expect(r.scenario?.id).toBe("user-import-1");
    expect({ ...r.scenario, id: s.id }).toEqual(s);
    expect(r.venue?.id).toBe("belgrade-fair-concert");
    const fresh = parseScenarioFile(scenarioToJson({ ...s, id: "user-zzz" }), venues, validate, used, newId);
    expect(fresh.renamedId).toBe(false);
  });

  it("rejects broken files with a clear message", () => {
    const s = concert.scenarios[0] as Scenario;
    const msg = (text: string) => parseScenarioFile(text, venues, validate, used, newId).problems.map((p) => p.message);
    expect(msg("{")[0]).toContain("not valid JSON");
    expect(msg(JSON.stringify({ ...s, schemaVersion: 2 }))[0]).toContain("schemaVersion 2");
    expect(msg(JSON.stringify({ ...s, venueId: "somewhere-else" }))[0]).toContain("“somewhere-else”, which this site does not have");
    expect(msg(JSON.stringify({ ...s, attendance: "many" }))[0]).toBe("Attendance must be integer.");
    expect(msg(JSON.stringify({ ...s, timedEvents: [{ kind: "laneFail", at: 0, groupId: "gate-main", laneIndex: 7 }] }))[0]).toContain("no lane 8");
  });
});
