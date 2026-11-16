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

/** Same-origin routes of the API (Caddy proxies the same paths, deploy/Caddyfile). */
function apiProxy(target: string) {
  return { "/api": { target }, "/health": { target } };
}
const previewProxy = process.env.API_PROXY ? apiProxy(process.env.API_PROXY) : {};

/**
 * `virtual:scenario-validator`: the JSON Schema validators for scenarios and venues, compiled by Ajv at build
 * time (standalone mode), because the CSP forbids the `new Function` Ajv uses at run time (D-033).
 */
function scenarioValidatorPlugin(): Plugin {
  const id = "virtual:scenario-validator";
  const resolved = `\0${id}`;
  const schemaFiles = ["common.schema.json", "scenario.schema.json", "venue.schema.json"];
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
  // `vite preview` behaves like static hosting (no backend), unless API_PROXY names a running API
  // (e.g. API_PROXY=http://localhost:5080 npx vite preview --port 4174): then it proxies like Caddy.
  preview: { headers: securityHeaders, port: 4173, strictPort: true, proxy: previewProxy },
  // `npm run dev` talks to a locally running API (apps/api, `dotnet run --launch-profile http`) on the
  // same origin, like Caddy does in production. Without it the app works as on static hosting.
  server: { proxy: apiProxy("http://localhost:5080") },
});
