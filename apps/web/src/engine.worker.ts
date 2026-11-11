/**
 * Engine Web Worker. In Phase 0 it only runs the self-check; Phase 1 runs the simulation here,
 * so the main thread (and the UI) never blocks.
 */

import { ENGINE_VERSION, EXPECTED_SELF_CHECK_HASH, runSelfCheck } from "@bottleneck/engine";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.ts";

// The web app compiles with the DOM library, which types `self` as a Window. Inside a worker it is
// a DedicatedWorkerGlobalScope; only the two members used here are declared.
const scope = self as unknown as {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

scope.onmessage = (event) => {
  if (event.data.type !== "selfCheck") return;
  try {
    const started = performance.now();
    const result = runSelfCheck();
    scope.postMessage({
      type: "selfCheckResult",
      hash: result.hash,
      expected: EXPECTED_SELF_CHECK_HASH,
      matches: result.matches,
      numbers: result.numbers,
      durationMs: performance.now() - started,
      engineVersion: ENGINE_VERSION,
    });
  } catch (error) {
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
