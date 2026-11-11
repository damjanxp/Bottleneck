import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SCHEMA_FILES, SCHEMA_VERSION, type Scenario, type Venue } from "../src/index.ts";

// Shared fixtures in /schema/fixtures are also loaded by the .NET tests from Phase 4.
const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../schema");
const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(schemaDir, file), "utf8"));

function makeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
  addFormats.default(ajv);
  for (const file of SCHEMA_FILES) ajv.addSchema(readJson(file) as object, file);
  return ajv;
}

const ajv = makeAjv();
const validator = (file: string): ValidateFunction => ajv.getSchema(file) as ValidateFunction;

describe("JSON Schemas", () => {
  it("compile in strict mode", () => {
    for (const file of SCHEMA_FILES) expect(validator(file), file).toBeTypeOf("function");
  });

  it("all declare the current schemaVersion", () => {
    for (const file of ["venue.schema.json", "scenario.schema.json", "run.schema.json"]) {
      const schema = readJson(file) as { properties: { schemaVersion: { const: number } } };
      expect(schema.properties.schemaVersion.const, file).toBe(SCHEMA_VERSION);
    }
  });
});

describe("valid fixtures", () => {
  const validDir = path.join(schemaDir, "fixtures", "valid");
  for (const file of readdirSync(validDir)) {
    it(`${file} is valid`, () => {
      const doc = readJson(path.join("fixtures", "valid", file));
      const schemaFile = file.startsWith("venue") ? "venue.schema.json" : file.startsWith("scenario") ? "scenario.schema.json" : "run.schema.json";
      const validate = validator(schemaFile);
      expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
    });
  }

  it("type-check against the generated types", () => {
    // Compile-time check: if the generated types and the fixtures drift apart, `npm run typecheck` fails here.
    const venue = readJson("fixtures/valid/venue-minimal.json") as Venue;
    const scenario = readJson("fixtures/valid/scenario-minimal.json") as Scenario;
    expect(venue.gateGroups[0]?.laneCount).toBe(4);
    expect(scenario.venueId).toBe(venue.id);
  });
});

describe("invalid fixtures", () => {
  const cases = readJson("fixtures/invalid/cases.json") as { why: string; schema: string; patch: Record<string, unknown> }[];
  const bases: Record<string, unknown> = {
    "venue.schema.json": readJson("fixtures/valid/venue-minimal.json"),
    "scenario.schema.json": readJson("fixtures/valid/scenario-minimal.json"),
  };
  for (const c of cases) {
    it(`rejects: ${c.why}`, () => {
      const doc = { ...(bases[c.schema] as object), ...c.patch };
      expect(validator(c.schema)(doc)).toBe(false);
    });
  }
});
