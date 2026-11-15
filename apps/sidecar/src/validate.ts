import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import commonSchema from "../../../schema/common.schema.json" with { type: "json" };
import venueSchema from "../../../schema/venue.schema.json" with { type: "json" };
import scenarioSchema from "../../../schema/scenario.schema.json" with { type: "json" };
import runSchema from "../../../schema/run.schema.json" with { type: "json" };

// ajv-formats is CommonJS: the default export is the function or an object holding it, depending on the loader.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => void;

const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false });
addFormats(ajv);
// Dependency order (the schemas reference each other by file name).
for (const [schema, name] of [[commonSchema, "common.schema.json"], [venueSchema, "venue.schema.json"], [scenarioSchema, "scenario.schema.json"], [runSchema, "run.schema.json"]] as const) ajv.addSchema(schema as object, name);

const venueValidator = ajv.getSchema("venue.schema.json") as ValidateFunction;
const scenarioValidator = ajv.getSchema("scenario.schema.json") as ValidateFunction;

function describeErrors(label: string, v: ValidateFunction): string[] {
  return (v.errors ?? []).slice(0, 5).map((e) => `${label}${e.instancePath} ${e.message ?? "is invalid"}`);
}

/** Returns the first few schema errors of the two documents (empty if both are valid). */
export function validateDocuments(venue: unknown, scenario: unknown): string[] {
  const errors: string[] = [];
  if (!venueValidator(venue)) errors.push(...describeErrors("venue", venueValidator));
  if (!scenarioValidator(scenario)) errors.push(...describeErrors("scenario", scenarioValidator));
  return errors.slice(0, 5);
}
