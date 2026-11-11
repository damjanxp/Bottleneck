import { useEffect, useState } from "react";
import { strings } from "./strings.ts";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.ts";

const CURRENT_PHASE = 0;

type SelfCheckState = { status: "running" } | { status: "done"; result: Extract<WorkerResponse, { type: "selfCheckResult" }> } | { status: "error"; message: string };

function useEngineSelfCheck(): SelfCheckState {
  const [state, setState] = useState<SelfCheckState>({ status: "running" });

  useEffect(() => {
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const data = event.data;
      setState(data.type === "selfCheckResult" ? { status: "done", result: data } : { status: "error", message: data.message });
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

function SelfCheckCard() {
  const state = useEngineSelfCheck();
  const s = strings.selfCheck;

  return (
    <section aria-labelledby="self-check-heading" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 id="self-check-heading" className="text-lg font-semibold">
        {s.heading}
      </h2>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{s.explainer}</p>

      <div aria-live="polite" className="mt-4">
        {state.status === "running" && <p className="text-sm text-slate-500">{s.running}</p>}

        {state.status === "error" && (
          <p className="text-sm font-medium text-red-700 dark:text-red-400">
            ✕ {s.failed}: {state.message}
          </p>
        )}

        {state.status === "done" && (
          <>
            <p className={`text-sm font-semibold ${state.result.matches ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
              {state.result.matches ? `✓ ${s.match}` : `✕ ${s.mismatch}`}
            </p>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-slate-500">{s.hash}</dt>
              <dd className="font-mono break-all">{state.result.hash}</dd>
              <dt className="text-slate-500">{s.expected}</dt>
              <dd className="font-mono break-all">{state.result.expected}</dd>
              <dt className="text-slate-500">{s.numbers}</dt>
              <dd className="font-mono">{state.result.numbers.toLocaleString("en-GB")}</dd>
              <dt className="text-slate-500">{s.duration}</dt>
              <dd className="font-mono">{state.result.durationMs.toFixed(1)} ms</dd>
              <dt className="text-slate-500">{s.engineVersion}</dt>
              <dd className="font-mono">{state.result.engineVersion}</dd>
            </dl>
          </>
        )}
      </div>
    </section>
  );
}

function Roadmap() {
  const r = strings.roadmap;
  return (
    <section aria-labelledby="roadmap-heading" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 id="roadmap-heading" className="text-lg font-semibold">
        {r.heading}
      </h2>
      <ol className="mt-3 space-y-2 text-sm">
        {r.phases.map((phase) => {
          const state = phase.id < CURRENT_PHASE ? r.done : phase.id === CURRENT_PHASE ? r.inProgress : r.planned;
          const marker = phase.id < CURRENT_PHASE ? "●" : phase.id === CURRENT_PHASE ? "◐" : "○";
          return (
            <li key={phase.id} className="flex gap-3">
              <span aria-hidden="true" className={phase.id === CURRENT_PHASE ? "text-amber-500" : "text-slate-400"}>
                {marker}
              </span>
              <span className="flex-1">
                <span className="font-mono text-slate-500">{phase.id}</span> {phase.title}
                {"optional" in phase && phase.optional && <span className="text-slate-500"> ({r.optional})</span>}
              </span>
              <span className="text-slate-500">{state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function App() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10 sm:py-16">
      <header>
        <h1 className="text-4xl font-bold tracking-tight">
          <span className="text-amber-500">⟩⟨</span> {strings.appName}
        </h1>
        <p className="mt-3 text-lg text-slate-700 dark:text-slate-300">{strings.tagline}</p>
        <p className="mt-3 text-slate-600 dark:text-slate-400">{strings.intro}</p>
        <p className="mt-4 inline-block rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">
          {strings.status.current}
        </p>
      </header>

      <main className="flex flex-col gap-6">
        <SelfCheckCard />
        <Roadmap />
      </main>

      <footer className="mt-auto flex flex-wrap justify-between gap-2 pt-6 text-sm text-slate-500">
        <a className="underline hover:text-slate-800 dark:hover:text-slate-200" href={strings.footer.sourceUrl}>
          {strings.footer.source}
        </a>
        <span>{strings.footer.note}</span>
      </footer>
    </div>
  );
}
