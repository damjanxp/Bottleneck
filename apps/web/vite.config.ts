import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildScenarioValidatorSource } from "./src/validation/buildValidator.ts";

// `vite preview` serves the production build with the same security headers as Vercel, so a
// Content-Security-Policy problem shows up locally before it ships.
const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const securityHeaders = Object.fromEntries((vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? []).map((h) => [h.key, h.value]));

/**
 * `virtual:scenario-validator`: the JSON Schema validator for scenarios, compiled by Ajv at build
 * time (standalone mode), because the CSP forbids the `new Function` Ajv uses at run time (D-033).
 */
function scenarioValidatorPlugin(): Plugin {
  const id = "virtual:scenario-validator";
  const resolved = `\0${id}`;
  const schemaFiles = ["common.schema.json", "scenario.schema.json"];
  return {
    name: "bottleneck-scenario-validator",
    resolveId: (source) => (source === id ? resolved : null),
    load(loadId) {
      if (loadId !== resolved) return null;
      const schemas: Record<string, object> = {};
      for (const file of schemaFiles) {
        const url = new URL(`../../schema/${file}`, import.meta.url);
        this.addWatchFile(url.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
        schemas[file] = JSON.parse(readFileSync(url, "utf8")) as object;
      }
      return buildScenarioValidatorSource(schemas);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), scenarioValidatorPlugin()],
  worker: { format: "es" },
  build: { target: "es2023", sourcemap: true },
  preview: { headers: securityHeaders, port: 4173, strictPort: true },
});
