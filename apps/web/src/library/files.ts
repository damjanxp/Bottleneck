/**
 * JSON export and import of single scenarios. The file is the scenario document itself (valid
 * against /schema/scenario.schema.json), so it can be read by any other tool that uses the schema.
 */

import type { Scenario, Venue } from "@bottleneck/schema";
import type { Problem } from "./form.ts";
import { ID_PATTERN } from "./scenarios.ts";
import { checkScenario, type SchemaValidator } from "./validate.ts";

/** "Concert, 3 lanes!" → "concert-3-lanes.scenario.json". */
export function exportFileName(s: Scenario): string {
  const slug = s.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "scenario"}.scenario.json`;
}

export function scenarioToJson(s: Scenario): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

export interface ImportResult {
  scenario: Scenario | null;
  venue: Venue | null;
  problems: Problem[];
  /** True if the file's id was missing or already used, so a new one was given. */
  renamedId: boolean;
}

/** Reads a scenario file: JSON, schema, a known venue, venue checks; gives it a fresh id if needed. */
export function parseScenarioFile(text: string, venues: readonly Venue[], validate: SchemaValidator, usedIds: ReadonlySet<string>, newId: () => string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { scenario: null, venue: null, problems: [{ field: "", message: `The file is not valid JSON (${e instanceof Error ? e.message : String(e)}).` }], renamedId: false };
  }
  const schemaProblems = checkScenario(data, null, validate);
  if (schemaProblems.length > 0) return { scenario: null, venue: null, problems: schemaProblems, renamedId: false };
  const s = data as Scenario;
  const venue = venues.find((v) => v.id === s.venueId) ?? null;
  if (!venue) return { scenario: null, venue: null, problems: [{ field: "", message: `The scenario is for venue “${s.venueId}”, which this site does not have.` }], renamedId: false };
  const problems = checkScenario(s, venue, validate);
  if (problems.length > 0) return { scenario: null, venue, problems, renamedId: false };
  const renamedId = s.id === undefined || usedIds.has(s.id) || !ID_PATTERN.test(s.id);
  return { scenario: renamedId ? { ...s, id: newId() } : s, venue, problems: [], renamedId };
}
