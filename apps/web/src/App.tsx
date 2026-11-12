import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import type { CompareEntry } from "./compare/plan.ts";
import { allChoices, userKey } from "./library/catalog.ts";
import { copyName, newScenarioId } from "./library/scenarios.ts";
import { strings } from "./strings.ts";
import { SimulationView } from "./ui/SimulationView.tsx";
import { useLibrary } from "./ui/useLibrary.ts";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.ts";

// Sections other than the simulation load on first use (their own chunks).
const LibraryView = lazy(() => import("./ui/LibraryView.tsx").then((m) => ({ default: m.LibraryView })));
const CompareView = lazy(() => import("./ui/CompareView.tsx").then((m) => ({ default: m.CompareView })));
const ScanLogView = lazy(() => import("./ui/ScanLogView.tsx").then((m) => ({ default: m.ScanLogView })));

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

type Tab = "simulate" | "scenarios" | "compare" | "scanLogs";
const TABS: Tab[] = ["simulate", "scenarios", "compare", "scanLogs"];

const DEFAULT_VENUE = exampleVenues.find((v) => v.id === "belgrade-fair-concert")?.id ?? exampleVenues[0]?.id ?? "";

/** A request from one section to another (open the comparison with these entries, edit this draft). */
export interface ComparePreset {
  entries: CompareEntry[];
  seeds: number;
  nonce: number;
}
export interface EditorRequest {
  scenario: Scenario;
  isNew: boolean;
  nonce: number;
}

const select = "mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

export function App() {
  const library = useLibrary();
  const [tab, setTab] = useState<Tab>("simulate");
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["simulate"]));
  const [venueId, setVenueId] = useState(DEFAULT_VENUE);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [comparePreset, setComparePreset] = useState<ComparePreset | null>(null);
  const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const example = exampleVenues.find((v) => v.id === venueId) ?? exampleVenues[0];
  const venue = example?.venue;
  const choices = useMemo(() => allChoices(library.entries, example?.id), [library.entries, example?.id]);
  const choice = choices.find((c) => c.key === selected[venueId]) ?? choices[0];

  const goTo = useCallback((t: Tab) => {
    setTab(t);
    setVisited((v) => (v.has(t) ? v : new Set([...v, t])));
  }, []);

  const openComparison = useCallback(
    (entries: CompareEntry[], seeds: number) => {
      setComparePreset({ entries, seeds, nonce: Date.now() });
      goTo("compare");
    },
    [goTo],
  );

  const openScenario = useCallback(
    (key: string, scenarioVenueId: string) => {
      setVenueId(scenarioVenueId);
      setSelected((s) => ({ ...s, [scenarioVenueId]: key }));
      goTo("simulate");
    },
    [goTo],
  );

  const editDraft = useCallback(
    (scenario: Scenario, isNew: boolean) => {
      setVenueId(scenario.venueId);
      setEditorRequest({ scenario, isNew, nonce: Date.now() });
      goTo("scenarios");
    },
    [goTo],
  );

  const saveWorking = (s: Scenario, intoSelected: boolean) => {
    if (!choice) return;
    const toSave = intoSelected && !choice.builtIn ? s : { ...s, id: newScenarioId(), name: copyName(s.name, " (changed)") };
    library.save(toSave);
    setSelected((cur) => ({ ...cur, [toSave.venueId]: userKey(toSave.id as string) }));
    setSavedNote(`${strings.working.saved} “${toSave.name}”`);
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-4 px-4 py-4 sm:py-6">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          <span className="text-amber-500">⟩⟨</span> {strings.appName}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{strings.tagline}</p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-600 dark:text-slate-400">
          {strings.picker.venue}
          <select className={select} value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            {exampleVenues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label={strings.tabs.label} className="flex flex-wrap gap-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"}`}
              onClick={() => goTo(t)}
            >
              {strings.tabs[t]}
            </button>
          ))}
        </nav>
      </div>

      {(library.dropped.length > 0 || library.error) && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm dark:border-orange-500/40 dark:bg-orange-500/10" role="status">
          {library.error && <p>{library.error}</p>}
          {library.dropped.length > 0 && (
            <>
              <p>{strings.library.droppedNotice}</p>
              <ul className="ml-5 list-disc">
                {library.dropped.map((d, k) => (
                  <li key={k}>
                    {d.name}: {d.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="mt-1 text-xs underline" onClick={library.dismissNotices}>
            OK
          </button>
        </div>
      )}

      <main>
        {/* Every visited section stays mounted (hidden when not shown), so its state survives switching. */}
        <div hidden={tab !== "simulate"}>
          {venue && choice && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-xs text-slate-600 dark:text-slate-400">
                  {strings.picker.scenario}
                  <select className={select} value={choice.key} onChange={(e) => setSelected((s) => ({ ...s, [venueId]: e.target.value }))}>
                    <optgroup label={strings.picker.builtIn}>
                      {choices
                        .filter((c) => c.builtIn)
                        .map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                    </optgroup>
                    {choices.some((c) => !c.builtIn) && (
                      <optgroup label={strings.picker.mine}>
                        {choices
                          .filter((c) => !c.builtIn)
                          .map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </label>
                <p className="max-w-md flex-1 text-sm text-slate-600 dark:text-slate-400">
                  {choice.description}
                  {savedNote && <span className="mt-1 block font-medium text-emerald-800 dark:text-emerald-300">{savedNote}</span>}
                </p>
              </div>
              <SimulationView venue={venue} scenario={choice.scenario} label={choice.label} ownScenario={!choice.builtIn} active={tab === "simulate"} onCompare={openComparison} onSaveWorking={saveWorking} />
            </div>
          )}
        </div>
        <Suspense fallback={<p className="text-sm text-slate-500">{strings.controls.loading}</p>}>
          {visited.has("scenarios") && (
            <div hidden={tab !== "scenarios"}>
              <LibraryView venueId={venueId} library={library} request={editorRequest} onOpen={openScenario} onCompare={openComparison} />
            </div>
          )}
          {visited.has("compare") && (
            <div hidden={tab !== "compare"}>
              <CompareView venueId={venueId} entries={library.entries} preset={comparePreset} onSave={(s) => editDraft({ ...s, id: newScenarioId(), name: copyName(s.name, "") }, true)} />
            </div>
          )}
          {visited.has("scanLogs") && (
            <div hidden={tab !== "scanLogs"}>
              <ScanLogView venueId={venueId} entries={library.entries} onApply={(s) => editDraft(s, true)} />
            </div>
          )}
        </Suspense>
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

