import { useEffect, useState } from "react";
import { strings } from "./strings.ts";
import { SimulationView } from "./ui/SimulationView.tsx";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.ts";

type SelfCheckResult = Extract<WorkerResponse, { type: "selfCheckResult" }>;
type SelfCheckState = { status: "running" } | { status: "done"; result: SelfCheckResult } | { status: "error"; message: string };

/** Runs the engine self-check in its own short-lived worker, so it never delays the simulation. */
function useEngineSelfCheck(): SelfCheckState {
  const [state, setState] = useState<SelfCheckState>({ status: "running" });

  useEffect(() => {
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      if (data.type === "selfCheckResult") setState({ status: "done", result: data });
      else if (data.type === "error") setState({ status: "error", message: data.message });
      else return;
      worker.terminate();
    };
    worker.onerror = (event) => {
      setState({ status: "error", message: event.message || strings.selfCheck.failed });
      worker.terminate();
    };
    const request: WorkerRequest = { type: "selfCheck" };
    worker.postMessage(request);
    return () => worker.terminate();
  }, []);

  return state;
}

function SelfCheckLine() {
  const state = useEngineSelfCheck();
  const s = strings.selfCheck;
  return (
    <p className="text-xs text-slate-500" aria-live="polite">
      {s.heading}:{" "}
      {state.status === "running" && s.running}
      {state.status === "error" && (
        <span className="font-medium text-red-700 dark:text-red-400">
          ✕ {s.failed}: {state.message}
        </span>
      )}
      {state.status === "done" && (
        <>
          <span className={state.result.matches ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-red-700 dark:text-red-400"}>
            {state.result.matches ? `✓ ${s.match}` : `✕ ${s.mismatch}`}
          </span>{" "}
          <span className="font-mono" title={`${state.result.numbers.toLocaleString("en-GB")} numbers, engine ${state.result.engineVersion}`}>
            {state.result.hash.slice(0, 16)}… · {state.result.durationMs.toFixed(0)} ms
          </span>
        </>
      )}
    </p>
  );
}

export function App() {
  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-4 px-4 py-4 sm:py-6">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-amber-500">⟩⟨</span> {strings.appName}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{strings.tagline}</p>
      </header>

      <main>
        <SimulationView />
      </main>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-800">
        <SelfCheckLine />
        <span>{strings.footer.note}</span>
        <a className="underline hover:text-slate-800 dark:hover:text-slate-200" href={strings.footer.sourceUrl}>
          {strings.footer.source}
        </a>
      </footer>
    </div>
  );
}
