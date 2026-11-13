/**
 * Bottleneck sidecar: a stateless internal HTTP service that runs the simulation engine headless
 * (the same engine code as the browser) for the .NET API's job runner. JSON only.
 *
 *   GET  /health -> 200 { status: "ok", engineVersion }
 *   POST /run    { venue, scenario, seed?, overrides?, timeoutMs? }
 *        -> 200 { engineVersion, seed, metricsHash, metrics, parameters, drained, deadlock, simulatedSeconds, wallMs }
 *   `seed` replaces scenario.seed; `overrides` ({ elementId: ElementOverride }) are merged over
 *   scenario.overrides field by field per element id (for lane sweeps). The merged scenario is
 *   validated against /schema. metricsHash equals createRun(venue, thatScenario).metricsHash().
 *   Errors are RFC 7807 problem JSON (application/problem+json): 400 malformed JSON or
 *   schema-invalid documents, 404 unknown route, 405 wrong method, 413 body too large,
 *   422 the engine threw on a valid document, 503 busy (retry), 504 wall-clock budget exceeded.
 *
 * Environment: PORT (8080), CONCURRENCY (1), MAX_BODY_BYTES (2097152), RUN_TIMEOUT_MS (120000),
 *   WORKER_MEMORY_MB (1024). One JSON log line per request on stdout; bodies are never logged.
 * Closing the connection before the response cancels the run and frees its slot.
 *
 * Build and run (the engine is TypeScript source, so it is bundled with esbuild):
 *   npm run build -w @bottleneck/sidecar && node apps/sidecar/dist/server.mjs   (or: npm run dev -w @bottleneck/sidecar)
 * Docker (build context = repository root):
 *   docker build -f apps/sidecar/Dockerfile -t bottleneck-sidecar .
 *   docker run --rm -p 8080:8080 bottleneck-sidecar
 */
import process, { env } from "node:process";
import { createApp, DEFAULT_CONFIG } from "./app.ts";

const num = (name: string, fallback: number): number => {
  const v = Number(env[name]);
  return env[name] && Number.isFinite(v) && v > 0 ? v : fallback;
};

const app = createApp({
  concurrency: num("CONCURRENCY", DEFAULT_CONFIG.concurrency),
  maxBodyBytes: num("MAX_BODY_BYTES", DEFAULT_CONFIG.maxBodyBytes),
  runTimeoutMs: num("RUN_TIMEOUT_MS", DEFAULT_CONFIG.runTimeoutMs),
  workerMemoryMb: num("WORKER_MEMORY_MB", DEFAULT_CONFIG.workerMemoryMb),
  workerPath: new URL("./worker.mjs", import.meta.url),
});
const port = num("PORT", 8080);
app.server.listen(port, () => DEFAULT_CONFIG.log(JSON.stringify({ time: new Date().toISOString(), msg: "listening", port })));

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => app.server.close(() => process.exit(0)));
