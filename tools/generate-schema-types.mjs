// Generates TypeScript types from the JSON Schemas in /schema.
//
//   node tools/generate-schema-types.mjs          write packages/schema/src/generated/types.ts
//   node tools/generate-schema-types.mjs --check  fail if that file is out of date (used in CI)
//
// The schemas are the single source of truth (spec section 8, "Shared schema"). C# classes are
// generated from the same files by apps/api/tools/Bottleneck.SchemaGen (npm run api:schema:gen / api:schema:check).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = path.join(root, "schema");
const outFile = path.join(root, "packages", "schema", "src", "generated", "types.ts");
const check = process.argv.includes("--check");

// One synthetic root that references every document type, so shared definitions are emitted once.
const bundle = {
  title: "SchemaBundle",
  description: "Every document type in /schema. Generated only to emit all types into one file.",
  type: "object",
  additionalProperties: false,
  properties: {
    venue: { $ref: "./venue.schema.json" },
    scenario: { $ref: "./scenario.schema.json" },
    run: { $ref: "./run.schema.json" },
  },
};

const banner = `/* eslint-disable */
// GENERATED FILE - do not edit by hand.
// Source: /schema/*.schema.json. Regenerate with: npm run schema:gen
`;

let output = await compile(bundle, "SchemaBundle", {
  cwd: schemaDir,
  bannerComment: banner,
  additionalProperties: false,
  unreachableDefinitions: false,
  ignoreMinAndMaxItems: true,
  strictIndexSignatures: true,
  format: true,
  style: { printWidth: 120, singleQuote: false, trailingComma: "all" },
});
output = output.replace(/\r\n/g, "\n");

if (check) {
  let current = "";
  try {
    current = (await readFile(outFile, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    // missing file counts as out of date
  }
  if (current !== output) {
    console.error("packages/schema/src/generated/types.ts is out of date. Run: npm run schema:gen");
    process.exit(1);
  }
  console.log("Schema types are up to date.");
} else {
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, output, "utf8");
  console.log(`Wrote ${path.relative(root, outFile)}`);
}
