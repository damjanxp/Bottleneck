/**
 * Test hook for the Playwright determinism check. Only installed when the URL has `?determinism=1`;
 * it is a no-op for normal visitors. It exposes `window.__bottleneckDeterminismHash()`, which starts
 * a fresh engine Web Worker, asks it to run the tiny pinned scenario to completion
 * (`determinismCheck` request) and resolves with the metrics hash. No inline scripts are involved,
 * so the production CSP is unaffected.
 */

import type { WorkerRequest, WorkerResponse } from "../workerProtocol.ts";

declare global {
  interface Window {
    __bottleneckDeterminismHash?: () => Promise<string>;
  }
}

export function installDeterminismHook(): void {
  if (new URLSearchParams(window.location.search).get("determinism") !== "1") return;
  window.__bottleneckDeterminismHash = () =>
    new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL("../engine.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (data.type === "determinismResult") resolve(data.hash);
        else if (data.type === "error") reject(new Error(data.message));
        else return;
        worker.terminate();
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || "Worker error"));
        worker.terminate();
      };
      const request: WorkerRequest = { type: "determinismCheck" };
      worker.postMessage(request);
    });
}
