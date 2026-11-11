/**
 * @bottleneck/schema — the document formats shared by the engine, the web app and (from Phase 4)
 * the .NET backend.
 *
 * The JSON Schemas in /schema are the source of truth. The types in ./generated are produced from
 * them by `npm run schema:gen`, and CI fails if they are out of date.
 */

export type * from "./generated/types.ts";

/** Current version of every document format. Bump it only together with a migration (Phase 4). */
export const SCHEMA_VERSION = 1;

/** File names of the schemas in /schema, in dependency order. */
export const SCHEMA_FILES = ["common.schema.json", "venue.schema.json", "scenario.schema.json", "run.schema.json"] as const;
