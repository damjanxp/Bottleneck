/**
 * Builds the scenario validator as plain JavaScript source with Ajv's "standalone" mode.
 *
 * Why: Ajv normally compiles a schema into a function with `new Function(...)`, which the strict
 * Content-Security-Policy (no 'unsafe-eval', D-009) forbids in the browser. Standalone mode runs
 * that compilation at build time instead and emits ordinary code. The Vite plugin in
 * vite.config.ts calls this function during the build and serves the result as the virtual module
 * `virtual:scenario-validator`, which the app loads lazily (its own chunk). The Vitest suite calls it
 * too and checks that the generated code accepts and rejects the same documents as Ajv itself.
 *
 * Runs in Node (vite.config.ts) and in Vitest only; never imported by app code.
 */

import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";

/** Counts Unicode code points like Ajv's runtime helper (minLength/maxLength count characters, not UTF-16 units). */
const UCS2_LENGTH = `function ucs2length(str) {
  let length = 0;
  for (const _ of str) length++;
  return length;
}
`;

/**
 * ES module source exporting `validateScenario(data): boolean` (with `.errors` after a failure),
 * from the given schemas (file name → parsed JSON; must include common and scenario).
 */
export function buildScenarioValidatorSource(schemas: Record<string, object>): string {
  const ajv = new Ajv({ code: { source: true, esm: true }, allErrors: true, strict: true, strictTuples: false });
  for (const [file, schema] of Object.entries(schemas)) ajv.addSchema(schema, file);
  let code = standaloneCode(ajv, { validateScenario: "scenario.schema.json" });
  // The only runtime helper the scenario schema needs; inlined so the chunk has no dependencies.
  code = code.replace(/require\("ajv\/dist\/runtime\/ucs2length"\)\.default/g, "ucs2length");
  if (/require\(/.test(code)) throw new Error("The standalone scenario validator still needs an Ajv runtime helper; inline it in buildValidator.ts");
  if (/new Function|\beval\(/.test(code)) throw new Error("The standalone scenario validator uses run-time code generation, which the CSP forbids");
  return `/* eslint-disable */\n// Generated at build time from /schema by apps/web/src/validation/buildValidator.ts.\n${UCS2_LENGTH}${code}`;
}
