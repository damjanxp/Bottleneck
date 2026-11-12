import { Suspense, lazy, useRef, useState } from "react";
import { fitScanLog, parseScanLogCsv, type ScanLogFit } from "@bottleneck/analysis";
import type { Scenario } from "@bottleneck/schema";
import { allChoices, venueById } from "../library/catalog.ts";
import { newScenarioId } from "../library/scenarios.ts";
import type { LibraryEntry } from "../library/storage.ts";
import { applyFit } from "../scanlog/applyFit.ts";
import { formatCount, formatDuration } from "../sim/format.ts";
import { elementName } from "../sim/parameters.ts";
import { strings } from "../strings.ts";
import { readPickedFile } from "./browserFiles.ts";
import { btn, btnPrimary, card, input, labelText } from "./styles.ts";

const OverlayChart = lazy(() => import("./CompareCharts.tsx").then((m) => ({ default: m.OverlayChart })));

const S = strings.scanLog;

interface Imported {
  fileName: string;
  rows: number;
  errors: string[];
  fit: ScanLogFit | null;
}

/** Scan-log import: parse, fit service times and the arrival curve, apply to a new scenario (spec 6.3). */
export function ScanLogView({ venueId, entries, onApply }: { venueId: string; entries: readonly LibraryEntry[]; onApply: (s: Scenario) => void }) {
  const [imported, setImported] = useState<Imported | null>(null);
  const [baseKey, setBaseKey] = useState<string>("");
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const venue = venueById(venueId);
  const choices = allChoices(entries, venueId);
  const base = choices.find((c) => c.key === baseKey) ?? choices[0];

  const onFile = async () => {
    const input = fileRef.current;
    if (!input) return;
    const picked = await readPickedFile(input);
    if (!picked) return;
    const parsed = parseScanLogCsv(picked.text);
    setNote(null);
    setImported({ fileName: picked.name, rows: parsed.rows.length, errors: parsed.errors, fit: parsed.rows.length > 0 ? fitScanLog(parsed.rows) : null });
  };

  const apply = () => {
    if (!imported?.fit || !venue || !base) return;
    const r = applyFit(imported.fit, base.scenario, venue, newScenarioId(), `${base.label}, fitted from ${imported.fileName}`);
    setNote(r.unmatched.length > 0 ? S.unmatched(r.unmatched) : null);
    onApply(r.scenario);
  };

  const fit = imported?.fit ?? null;
  const tl = base?.scenario.timeline;
  const name = (group: string) => (venue ? elementName(venue, group.replace(/#manual$/, "")) + (group.endsWith("#manual") ? ` (${strings.lanes.manual})` : "") : group);

  return (
    <div className="flex flex-col gap-4">
      <section className={card} aria-labelledby="scanlog-heading">
        <h2 id="scanlog-heading" className="text-lg font-semibold">
          {S.heading}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{S.intro}</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{S.exportIntro}</p>
        <p className="mt-1 text-xs text-slate-500">{S.format}</p>
        <div className="mt-3">
          <button type="button" className={btn} onClick={() => fileRef.current?.click()}>
            {S.import}
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" aria-label={S.import} onChange={() => void onFile()} />
        </div>
        {imported && (
          <div className="mt-3 text-sm" role="status">
            <p>
              {imported.fileName}: {S.rows(imported.rows)}
            </p>
            {imported.errors.length > 0 && (
              <>
                <p className="mt-1 text-orange-800 dark:text-orange-300">{S.errors(imported.errors.length)}</p>
                <ul className="ml-5 list-disc text-xs">
                  {imported.errors.slice(0, 10).map((e, k) => (
                    <li key={k}>{e}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>

      {fit && (
        <>
          <section className={card} aria-labelledby="scanlog-groups-heading">
            <h2 id="scanlog-groups-heading" className="text-sm font-semibold text-slate-500">
              {S.groups}
            </h2>
            <table className="mt-2 w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-2 font-normal">{S.group}</th>
                  <th className="py-1 pr-2 text-right font-normal">{S.meanService}</th>
                  <th className="py-1 text-right font-normal">{S.intervals}</th>
                </tr>
              </thead>
              <tbody>
                {fit.groups.map((g) => (
                  <tr key={g.group} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-2">{name(g.group)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{g.meanServiceTime === null ? S.noEstimate : `${g.meanServiceTime.toFixed(2)} s`}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{formatCount(g.busyIntervals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{S.lanes}</summary>
              <table className="mt-1 w-full text-left font-mono tabular-nums">
                <thead className="font-sans text-slate-500">
                  <tr>
                    <th className="font-normal">{strings.charts2.lane}</th>
                    <th className="text-right font-normal">{S.passes}</th>
                    <th className="text-right font-normal">{S.meanService}</th>
                  </tr>
                </thead>
                <tbody>
                  {fit.lanes.map((l) => (
                    <tr key={l.lane}>
                      <td>{l.lane}</td>
                      <td className="text-right">{formatCount(l.passes)}</td>
                      <td className="text-right">{l.meanServiceTime === null ? "–" : `${l.meanServiceTime.toFixed(2)} s`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          {fit.arrivals.length >= 2 && tl && (
            <section className={card} aria-labelledby="scanlog-arrivals-heading">
              <h2 id="scanlog-arrivals-heading" className="text-sm font-semibold text-slate-500">
                {S.arrivals}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {formatDuration(fit.lastTime - fit.firstTime)} · {fit.arrivals.length} points
              </p>
              <Suspense fallback={<p className="text-xs text-slate-500">{strings.charts2.loading}</p>}>
                <OverlayChart data={{ x: fit.arrivals.map((p) => p.t), ys: [fit.arrivals.map((p) => p.weight)] }} labels={[S.arrivals]} anchor={tl.eventStart ?? tl.gatesOpen} fixedStart={tl.eventStart !== null} unit="" height={180} />
              </Suspense>
            </section>
          )}

          <section className={card} aria-labelledby="scanlog-apply-heading">
            <h2 id="scanlog-apply-heading" className="text-sm font-semibold text-slate-500">
              {S.apply}
            </h2>
            <p className="mt-1 text-xs text-slate-500">{S.applyHint}</p>
            <p className="mt-1 text-xs text-slate-500">{S.applyNote}</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className={labelText}>
                {S.applyBase}
                <select className={input} value={base?.key ?? ""} onChange={(e) => setBaseKey(e.target.value)}>
                  {choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className={btnPrimary} onClick={apply} disabled={!base}>
                {S.apply}
              </button>
            </div>
            {note && <p className="mt-2 text-xs text-orange-800 dark:text-orange-300">{note}</p>}
          </section>
        </>
      )}
    </div>
  );
}
