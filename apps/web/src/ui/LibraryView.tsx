import { useRef, useState } from "react";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import type { EditorRequest } from "../App.tsx";
import type { CompareEntry } from "../compare/plan.ts";
import { builtInChoices, usedScenarioIds, userChoices, venueById, type ScenarioChoice } from "../library/catalog.ts";
import { exportFileName, parseScenarioFile, scenarioToJson } from "../library/files.ts";
import { blankScenario, copyName, duplicateScenario, newScenarioId } from "../library/scenarios.ts";
import { strings } from "../strings.ts";
import { loadScenarioValidator } from "../validation/loadValidator.ts";
import { downloadText, readPickedFile } from "./browserFiles.ts";
import { ScenarioEditor } from "./ScenarioEditor.tsx";
import { btn, btnSmall, card } from "./styles.ts";
import type { Library } from "./useLibrary.ts";

const L = strings.library;

interface Editing {
  scenario: Scenario;
  isNew: boolean;
  /** Changes when a new editing session starts, so the editor's form is rebuilt. */
  key: number;
}

/** Scenario library for one venue (spec 6.3): built-ins read-only, the user's own editable. */
export function LibraryView({ venueId, library, request, onOpen, onCompare }: { venueId: string; library: Library; request: EditorRequest | null; onOpen: (key: string, venueId: string) => void; onCompare: (entries: CompareEntry[], seeds: number) => void }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [lastRequest, setLastRequest] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const venue = venueById(venueId);

  // A draft handed over by another section (a fitted scan log, a comparison entry): open it in the editor.
  if (request && request.nonce !== lastRequest) {
    setLastRequest(request.nonce);
    setEditing({ scenario: request.scenario, isNew: request.isNew, key: request.nonce });
  }

  if (!venue) return null;
  const builtIns = builtInChoices(venueId);
  const mine = userChoices(library.entries, venueId);
  const venueTitle = exampleVenues.find((v) => v.id === venueId)?.title ?? venueId;

  const startEdit = (scenario: Scenario, isNew: boolean) => {
    setMessage(null);
    setEditing((prev) => ({ scenario, isNew, key: (prev?.key ?? 0) + 1 }));
  };

  const onImport = async () => {
    const input = fileRef.current;
    if (!input) return;
    const picked = await readPickedFile(input);
    if (!picked) return;
    const validate = await loadScenarioValidator();
    const r = parseScenarioFile(
      picked.text,
      exampleVenues.map((v) => v.venue),
      validate,
      usedScenarioIds(library.entries),
      () => newScenarioId(),
    );
    if (!r.scenario) {
      setMessage({ ok: false, lines: [`${L.importFailed} ${picked.name}`, ...r.problems.map((p) => p.message)] });
      return;
    }
    library.save(r.scenario);
    setMessage({ ok: true, lines: [L.imported(r.scenario.name), ...(r.renamedId ? [L.importedNewId] : []), ...(r.scenario.venueId !== venueId ? [`(${r.venue?.name ?? r.scenario.venueId})`] : [])] });
  };

  const row = (c: ScenarioChoice) => {
    const s = c.scenario;
    const lanes = Object.entries(s.overrides ?? {})
      .filter(([, o]) => o?.laneCount !== undefined)
      .map(([id, o]) => `${id} ${o?.laneCount}`)
      .join(", ");
    const entry = library.entries.find((e) => e.id === s.id);
    return (
      <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2 dark:border-slate-800">
        <div className="min-w-0">
          <p className="font-medium">{c.label}</p>
          <p className="text-xs text-slate-500">
            {s.attendance.toLocaleString("en-GB")} people · seed {s.seed}
            {lanes && ` · ${L.lanes}: ${lanes}`}
            {(s.timedEvents?.length ?? 0) > 0 && ` · ${s.timedEvents?.length} ${L.events}`}
            {entry?.savedAt && ` · ${L.savedAt} ${entry.savedAt.slice(0, 16).replace("T", " ")}`}
          </p>
          {c.description && <p className="text-xs text-slate-500">{c.description}</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btnSmall} onClick={() => onOpen(c.key, c.venueId)} aria-label={`${L.open} ${c.label}`}>
            {L.open}
          </button>
          {!c.builtIn && (
            <button type="button" className={btnSmall} onClick={() => startEdit(s, false)} aria-label={`${L.edit} ${c.label}`}>
              {L.edit}
            </button>
          )}
          <button type="button" className={btnSmall} onClick={() => startEdit(duplicateScenario(s, newScenarioId(), copyName(s.name)), true)} aria-label={`${L.duplicate} ${c.label}`}>
            {L.duplicate}
          </button>
          {!c.builtIn && (
            <>
              <button
                type="button"
                className={btnSmall}
                onClick={() => {
                  const name = window.prompt(L.renamePrompt, s.name)?.trim();
                  if (name) library.save({ ...s, name: name.slice(0, 120) });
                }}
              >
                {L.rename}
              </button>
              <button
                type="button"
                className={btnSmall}
                onClick={() => {
                  if (window.confirm(L.confirmDelete(s.name))) library.remove(s.id as string);
                }}
              >
                {L.delete}
              </button>
            </>
          )}
          <button type="button" className={btnSmall} onClick={() => downloadText(exportFileName(s), scenarioToJson(s), "application/json")}>
            {L.exportJson}
          </button>
          <button type="button" className={btnSmall} onClick={() => onCompare([{ key: c.key, label: c.label, scenario: s }], 1)}>
            {L.compare}
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <section className={card} aria-labelledby="library-heading">
        <h2 id="library-heading" className="text-lg font-semibold">
          {L.heading}: {venueTitle}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{L.intro}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => startEdit(blankScenario(venue, newScenarioId(), builtIns[0]?.scenario.timeline.eventStart === null), true)}>
            {L.newFromDefaults}
          </button>
          <button type="button" className={btn} onClick={() => fileRef.current?.click()}>
            {L.importJson}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-label={L.importJson} onChange={() => void onImport()} />
        </div>
        {message && (
          <div className={`mt-3 rounded-lg border p-2 text-sm ${message.ok ? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10" : "border-orange-300 bg-orange-50 dark:border-orange-500/40 dark:bg-orange-500/10"}`} role="status">
            {message.lines.map((l, k) => (
              <p key={k}>{l}</p>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <ScenarioEditor
          key={editing.key}
          venue={venueById(editing.scenario.venueId) ?? venue}
          base={editing.scenario}
          isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onSave={(s) => {
            library.save(s);
            setEditing(null);
            setMessage({ ok: true, lines: [`${strings.working.saved} “${s.name}”`] });
          }}
        />
      )}

      <section className={card} aria-labelledby="mine-heading">
        <h3 id="mine-heading" className="text-sm font-semibold text-slate-500">
          {L.mine}
        </h3>
        {mine.length === 0 ? <p className="mt-2 text-sm text-slate-500">{L.none}</p> : <ul className="mt-1">{mine.map(row)}</ul>}
      </section>
      <section className={card} aria-labelledby="builtin-heading">
        <h3 id="builtin-heading" className="text-sm font-semibold text-slate-500">
          {L.builtIn}
        </h3>
        <ul className="mt-1">{builtIns.map(row)}</ul>
      </section>
    </div>
  );
}
