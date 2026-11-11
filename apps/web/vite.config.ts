import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite preview` serves the production build with the same security headers as Vercel, so a
// Content-Security-Policy problem shows up locally before it ships.
const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const securityHeaders = Object.fromEntries((vercel.headers.find((h) => h.source === "/(.*)")?.headers ?? []).map((h) => [h.key, h.value]));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: { target: "es2023", sourcemap: true },
  preview: { headers: securityHeaders, port: 4173, strictPort: true },
});
