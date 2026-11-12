import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import type { ComparePreset } from "../App.tsx";
import type { RunResult } from "../batchProtocol.ts";
import { MAX_ENTRIES, MAX_SEEDS, planJobs, venueIds, type CompareEntry, type Job } from "../compare/plan.ts";
import { RunPool, poolSize } from "../compare/runPool.ts";
import { capacityRows, endNotes, measureRows } from "../compare/table.ts";
import { measureValue, formatValue, VERDICT_WORDS } from "../compare/measures.ts";
import { builtInChoices, userChoices, venueById } from "../library/catalog.ts";
import type { LibraryEntry } from "../library/storage.ts";
import { formatCount, formatPercent } from "../sim/format.ts";
import { elementName } from "../sim/parameters.ts";
import { strings } from "../strings.ts";
import { btn, btnPrimary, btnSmall, card, input, labelText, verdictClass, verdictSymbol } from "./styles.ts";

const CompareCharts = lazy(() => import("./CompareCharts.tsx").then((m) => ({ default: m.CompareCharts })));

const C = strings.compare;

interface RunState {
  status: "running" | "done" | "cancelled";
  entries: CompareEntry[];
  jobs: Job[];
  paired: boolean;
  results: Record<number, RunResult>;
  progress: Record<number, number>;
  errors: string[];
  startedAt: number;
  finishedAt: number | null;
  workers: number;
}

/** Comparison of up to four scenarios, and multi-seed batches (spec 6.3). */
export function CompareView({ venueId, entries: libraryEntries, preset, onSave }: { venueId: string; entries: readonly LibraryEntry[]; preset: ComparePreset | null; onSave: (s: Scenario) => void }) {
  const [adhoc, setAdhoc] = useState<CompareEntry[]>([]);
  const [slots, setSlots] = useState<string[]>(() => builtInChoices(venueId).slice(0, 2).map((c) => c.key));
  const [seeds, setSeeds] = useState(1);
  const [sameSeeds, setSameSeeds] = useState(true);
  const [run, setRun] = useState<RunState | null>(null);
  const [lastPreset, setLastPreset] = useState<number | null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const poolRef = useRef<RunPool | null>(null);

  // A request from another section ("+1 lane", "Batch: 5 seeds", "Compare"): set it up and run it.
  if (preset && preset.nonce !== lastPreset) {
    setLastPreset(preset.nonce);
    const extra = preset.entries.filter((e) => e.key.startsWith("adhoc:"));
    setAdhoc((cur) => [...cur.filter((a) => !extra.some((x) => x.key === a.key)), ...extra]);
    setSlots(preset.entries.slice(0, MAX_ENTRIES).map((e) => e.key));
    setSeeds(Math.min(MAX_SEEDS, Math.max(1, preset.seeds)));
    setAutoRun(true);
  }

  const options: (CompareEntry & { venueId: string })[] = useMemo(() => {
    const fromChoices = [...builtInChoices(), ...userChoices(libraryEntries)].map((c) => ({ key: c.key, label: c.label, scenario: c.scenario, venueId: c.venueId }));
    return [...adhoc.map((a) => ({ ...a, venueId: a.scenario.venueId })), ...fromChoices];
  }, [adhoc, libraryEntries]);
  const chosen = slots.map((k) => options.find((o) => o.key === k)).filter((o): o is (typeof options)[number] => o !== undefined);
  const venuesDiffer = venueIds(chosen).length > 1;
  const unknownVenues = venueIds(chosen).filter((id) => !venueById(id));

  const start = () => {
    poolRef.current?.dispose();
    if (chosen.length === 0 || unknownVenues.length > 0) return;
    const ents: CompareEntry[] = chosen.map((o) => ({ key: o.key, label: o.label, scenario: o.scenario }));
    const jobs = planJobs(ents, seeds, sameSeeds);
    const state: RunState = { status: "running", entries: ents, jobs, paired: sameSeeds, results: {}, progress: {}, errors: [], startedAt: performance.now(), finishedAt: null, workers: poolSize(jobs.length) };
    setRun(state);
    poolRef.current = new RunPool(jobs, (job) => venueById(job.scenario.venueId) as NonNullable<ReturnType<typeof venueById>>, {
      onProgress: (jobId, fraction) => setRun((r) => (r && r.jobs === jobs ? { ...r, progress: { ...r.progress, [jobId]: fraction } } : r)),
      onResult: (result) => setRun((r) => (r && r.jobs === jobs ? { ...r, results: { ...r.results, [result.jobId]: result }, progress: { ...r.progress, [result.jobId]: 1 } } : r)),
      onError: (jobId, message) => setRun((r) => (r && r.jobs === jobs ? { ...r, errors: [...r.errors, `${ents[jobs[jobId]?.entryIndex ?? 0]?.label ?? ""} (seed ${jobs[jobId]?.seed}): ${message}`] } : r)),
      onDone: (cancelled) => setRun((r) => (r && r.jobs === jobs ? { ...r, status: cancelled ? "cancelled" : "done", finishedAt: performance.now() } : r)),
    });
  };

  useEffect(() => {
    if (!autoRun) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot start requested by another section
    setAutoRun(false);
    start();
    // `start` reads the state this render set up; it is not a dependency on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  useEffect(() => () => poolRef.current?.dispose(), []);

  const done = run ? Object.keys(run.results).length : 0;
  const total = run?.jobs.length ?? 0;
  const fraction = run && total > 0 ? run.jobs.reduce((s, j) => s + (run.progress[j.jobId] ?? 0), 0) / total : 0;

  const setSlot = (k: number, key: string) => setSlots((s) => s.map((x, i) => (i === k ? key : x)));
  const optionGroups: { label: string; items: typeof options }[] = [
    { label: C.fromSimulation, items: options.filter((o) => o.key.startsWith("adhoc:")) },
    ...exampleVenues.map((v) => ({ label: `${v.title}: ${strings.library.builtIn}`, items: options.filter((o) => o.key.startsWith("builtin:") && o.venueId === v.id) })),
    ...exampleVenues.map((v) => ({ label: `${v.title}: ${strings.library.mine}`, items: options.filter((o) => o.key.startsWith("user:") && o.venueId === v.id) })),
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-4">
      <section className={card} aria-labelledby="compare-heading">
        <h2 id="compare-heading" className="text-lg font-semibold">
          {C.heading}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{C.intro}</p>
        <div className="mt-3 flex flex-col gap-2">
          {slots.map((key, k) => (
            <div key={k} className="flex flex-wrap items-end gap-2">
              <label className={labelText}>
                {C.slot(k + 1)}
                {k === 0 ? ` (${C.baseline})` : ""}
                <select className={`${input} min-w-[18rem]`} value={key} onChange={(e) => setSlot(k, e.target.value)} aria-label={C.slot(k + 1)}>
                  {optionGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {slots.length > 1 && (
                <button type="button" className={btnSmall} onClick={() => setSlots((s) => s.filter((_, i) => i !== k))}>
                  {C.remove}
                </button>
              )}
              {key.startsWith("adhoc:") && (
                <button type="button" className={btnSmall} onClick={() => { const o = options.find((x) => x.key === key); if (o) onSave(o.scenario); }}>
                  {strings.working.saveNew}
                </button>
              )}
            </div>
          ))}
          {slots.length < MAX_ENTRIES && (
            <div>
              <button type="button" className={btnSmall} onClick={() => setSlots((s) => [...s, builtInChoices(venueId)[0]?.key ?? options[0]?.key ?? ""])}>
                {C.add}
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <label className={labelText}>
            {C.seeds}
            <select className={input} value={seeds} onChange={(e) => setSeeds(Number(e.target.value))}>
              {Array.from({ length: MAX_SEEDS }, (_, k) => k + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm" title={C.sameSeedsHint}>
            <input type="checkbox" checked={sameSeeds} onChange={(e) => setSameSeeds(e.target.checked)} />
            {C.sameSeeds}
          </label>
          <button type="button" className={btnPrimary} onClick={start} disabled={run?.status === "running" || chosen.length === 0 || unknownVenues.length > 0}>
            {chosen.length === 1 && seeds > 1 ? C.runBatch : C.run}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {C.seedsHint} {C.sameSeedsHint}
        </p>
        {venuesDiffer && (
          <p className="mt-3 rounded-lg border border-orange-300 bg-orange-50 p-2 text-sm font-medium dark:border-orange-500/40 dark:bg-orange-500/10" role="alert">
            ⚠ {C.venuesDiffer}
          </p>
        )}
        {unknownVenues.map((id) => (
          <p key={id} className="mt-2 text-sm text-orange-700" role="alert">
            {C.unknownVenue(id)}
          </p>
        ))}
        {run && (
          <div className="mt-3 flex items-center gap-2 text-sm" role="status">
            {run.status === "running" && (
              <>
                <progress className="h-2 flex-1 accent-amber-500" max={1} value={fraction} />
                <span>{C.running(done, total)}</span>
                <button type="button" className={btn} onClick={() => poolRef.current?.cancel()}>
                  {C.cancel}
                </button>
              </>
            )}
            {run.status === "cancelled" && <span>{C.cancelled}</span>}
            {run.status === "done" && run.finishedAt !== null && <span>{C.finished(done, ((run.finishedAt - run.startedAt) / 1000).toFixed(1), run.workers)}</span>}
          </div>
        )}
      </section>

      {run?.status === "done" && <Results run={run} />}
    </div>
  );
}

function Results({ run }: { run: RunState }) {
  const runs = run.entries.map((_, i) =>
    run.jobs
      .filter((j) => j.entryIndex === i)
      .sort((a, b) => a.seedIndex - b.seedIndex)
      .map((j) => run.results[j.jobId])
      .filter((r): r is RunResult => r !== undefined),
  );
  const labels = run.entries.map((e) => e.label);
  const base = run.entries[0]?.scenario;
  const venue = base ? venueById(base.venueId) : undefined;
  const names = (id: string) => (venue ? elementName(venue, id) : id);
  const fixedStart = base?.timeline.eventStart !== null;
  const rows = measureRows(runs, fixedStart, run.paired);
  const seedsPerEntry = Math.max(...runs.map((r) => r.length));
  const firstRuns = runs.map((r) => r[0] ?? null);
  const capacity = capacityRows(firstRuns);
  const notes = endNotes(runs, labels);
  const clock = base ? { anchor: base.timeline.eventStart ?? base.timeline.gatesOpen, fixedStart, referenceClock: base.timeline.referenceClock } : null;

  return (
    <>
      {run.errors.length > 0 && (
        <section className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm dark:border-orange-500/40 dark:bg-orange-500/10" role="alert">
          <p className="font-medium">{C.errors}</p>
          <ul className="ml-5 list-disc">
            {run.errors.map((e, k) => (
              <li key={k}>{e}</li>
            ))}
          </ul>
        </section>
      )}

      <section className={card} aria-labelledby="compare-headline-heading">
        <h2 id="compare-headline-heading" className="text-sm font-semibold text-slate-500">
          {C.headline}
        </h2>
        {seedsPerEntry > 1 && (
          <p className="mt-1 text-xs text-slate-500">
            {C.batchNote(seedsPerEntry)} {run.paired && labels.length > 1 && C.pairedNote}
          </p>
        )}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-normal">{C.measure}</th>
                {labels.map((l, i) => (
                  <th key={i} className="py-1 pr-3 text-right font-normal">
                    {l}
                    {i === 0 && labels.length > 1 ? ` (${C.baseline})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.measure.key} className="border-t border-slate-100 align-top dark:border-slate-800" data-measure={r.measure.key}>
                  <th scope="row" className={`py-1 pr-3 font-normal ${r.measure.sub ? "pl-4 text-xs text-slate-600 dark:text-slate-400" : ""}`}>
                    {r.measure.label}
                  </th>
                  {r.cells.map((cell, i) => {
                    const d = r.differences[i];
                    return (
                      <td key={i} className="py-1 pr-3 text-right tabular-nums">
                        <div className="font-mono">{cell}</div>
                        {d && (
                          <div className={`text-xs font-semibold ${verdictClass[d.verdict]}`} data-verdict={d.verdict}>
                            <span aria-hidden="true">{verdictSymbol[d.verdict]} </span>
                            {d.delta}, {C[d.verdict]}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {notes.map((n, k) => (
          <p key={k} className="mt-2 text-xs text-orange-800 dark:text-orange-300">
            {n}
          </p>
        ))}
      </section>

      {labels.length > 1 && (
        <section className={card} aria-labelledby="compare-words-heading">
          <h2 id="compare-words-heading" className="text-sm font-semibold text-slate-500">
            {C.differences}
          </h2>
          {labels.slice(1).map((l, k) => (
            <div key={k} className="mt-2">
              <h3 className="text-sm font-medium">
                {l} {C.against} {labels[0]}
              </h3>
              <ul className="mt-1 flex flex-col gap-1 text-sm" aria-label={`${l} ${C.against} ${labels[0]}`}>
                {rows
                  .filter((r) => !r.measure.sub)
                  .map((r) => {
                    const d = r.differences[k + 1];
                    if (!d) return null;
                    return (
                      <li key={r.measure.key} className={`rounded px-2 py-1 ${d.verdict === "better" ? "bg-emerald-50 dark:bg-emerald-500/10" : d.verdict === "worse" ? "bg-orange-50 dark:bg-orange-500/10" : ""}`} data-measure={r.measure.key} data-verdict={d.verdict}>
                        <span className={`font-semibold ${verdictClass[d.verdict]}`}>
                          <span aria-hidden="true">{verdictSymbol[d.verdict]}</span> {VERDICT_WORDS[d.verdict]}:
                        </span>{" "}
                        {d.sentence}
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </section>
      )}

      {seedsPerEntry > 1 && (
        <details className={card}>
          <summary className="cursor-pointer text-sm font-semibold text-slate-500">{C.perSeed}</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left font-mono text-xs tabular-nums">
              <thead className="font-sans text-slate-500">
                <tr>
                  <th className="pr-2 font-normal">{C.scenarioColumn}</th>
                  <th className="pr-2 font-normal">{C.seed}</th>
                  {rows.map((r) => (
                    <th key={r.measure.key} className="pr-2 text-right font-normal">
                      {r.measure.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.flatMap((rs, i) =>
                  rs.map((res) => (
                    <tr key={`${i}-${res.seed}`} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="pr-2 font-sans">{labels[i]}</td>
                      <td className="pr-2">{res.seed}</td>
                      {rows.map((r) => {
                        const v = measureValue(res.metrics, r.measure.key);
                        return (
                          <td key={r.measure.key} className="pr-2 text-right">
                            {v === null ? "–" : formatValue(r.measure.unit, v)}
                          </td>
                        );
                      })}
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {capacity.length > 0 && (
        <section className={card} aria-labelledby="compare-capacity-heading">
          <h2 id="compare-capacity-heading" className="text-sm font-semibold text-slate-500">
            {C.capacity}
          </h2>
          <p className="mt-1 text-xs text-slate-500">{C.capacityIntro}</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">{strings.capacity.element}</th>
                  {labels.map((l, i) => (
                    <th key={i} className="py-1 pr-2 text-right font-normal">
                      {l}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {capacity.map((row) => (
                  <tr key={row.elementId} className="border-t border-slate-100 align-top dark:border-slate-800">
                    <td className="py-1 pr-2">{names(row.elementId)}</td>
                    {row.cells.map((c, i) => (
                      <td key={i} className="py-1 pr-2 text-right font-mono tabular-nums">
                        {c ? (
                          <>
                            <div>
                              {c.laneCount} {strings.library.lanes}
                            </div>
                            <div>
                              {formatCount(c.capacityPerHour)} {strings.capacity.capacity.toLowerCase()}/h
                            </div>
                            <div className={c.overloaded ? "font-semibold text-orange-700 dark:text-orange-400" : ""}>
                              {formatCount(c.peakDemandPerHour)} {strings.capacity.peakDemand.toLowerCase()}/h{c.overloaded ? ` ▲ ${C.overloaded}` : ""}
                            </div>
                            <div>
                              {formatPercent(c.peakUtilisation)} {strings.capacity.peakUtilisation.toLowerCase()}
                            </div>
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {clock && (
        <section className={card} aria-labelledby="compare-charts-heading">
          <h2 id="compare-charts-heading" className="text-sm font-semibold text-slate-500">
            {C.charts}
          </h2>
          {seedsPerEntry > 1 && <p className="mt-1 text-xs text-slate-500">{C.chartsFirstSeed}</p>}
          <Suspense fallback={<p className="text-xs text-slate-500">{strings.charts2.loading}</p>}>
            <CompareCharts results={firstRuns} labels={labels} names={names} anchor={clock.anchor} fixedStart={clock.fixedStart} />
          </Suspense>
        </section>
      )}
    </>
  );
}
