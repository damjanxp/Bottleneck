/** Worker thread: runs one simulation to completion and posts the result (or the engine's error). */
import { parentPort, workerData } from "node:worker_threads";
import { createRun, hashMetrics } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";

export interface WorkerInput {
  venue: Venue;
  scenario: Scenario;
}

try {
  const { venue, scenario } = workerData as WorkerInput;
  const run = createRun(venue, scenario);
  while (!run.done) run.step();
  const full = run.metrics();
  const { parameters, ...metrics } = full;
  parentPort?.postMessage({ ok: true, result: { metricsHash: hashMetrics(full), metrics, parameters, drained: run.drained, deadlock: run.deadlock, simulatedSeconds: run.time } });
} catch (e) {
  parentPort?.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) });
}
