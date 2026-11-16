import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ENGINE_VERSION } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import { gateSweepHeadline, jobResult } from "./api/jobs.ts";
import { buildRunRecord, fitRunRecord, venueHash } from "./api/runRecord.ts";
import type { CompareEntry } from "./compare/plan.ts";
import { allChoices, knownVenues, serverKey, userKey } from "./library/catalog.ts";
import { useRemoteVenues } from "./library/remoteVenues.ts";
import { useUserVenues } from "./library/userVenues.ts";
import { copyName, newScenarioId } from "./library/scenarios.ts";
import type { RunRecordParts } from "./sim/SimController.ts";
import { strings } from "./strings.ts";
import type { CompareLeadLine } from "./ui/CompareView.tsx";
import { SimulationView } from "./ui/SimulationView.tsx";
import { useJobs } from "./ui/useJobs.ts";
import { useLibrary } from "./ui/useLibrary.ts";
import { useServer } from "./ui/useServer.ts";
import type { WorkerRequest, WorkerResponse } from "./workerProtocol.ts";
import { IconCompare, IconList, IconLog, IconLogo, IconMap, IconPencil, IconShare, InfoTip } from "./ui/icons.tsx";
import { noticeInfo, noticeWarn, page, select } from "./ui/styles.ts";

// Sections other than the simulation load on first use (their own chunks).
const LibraryView = lazy(() => import("./ui/LibraryView.tsx").then((m) => ({ default: m.LibraryView })));
const CompareView = lazy(() => import("./ui/CompareView.tsx").then((m) => ({ default: m.CompareView })));
const ScanLogView = lazy(() => import("./ui/ScanLogView.tsx").then((m) => ({ default: m.ScanLogView })));
const ShareView = lazy(() => import("./ui/ShareView.tsx").then((m) => ({ default: m.ShareView })));
const VenueEditor = lazy(() => import("./ui/VenueEditor.tsx").then((m) => ({ default: m.VenueEditor })));

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
    <p className="text-[11px] leading-snug text-subtle" aria-live="polite">
      {s.heading}:{" "}
      {state.status === "running" && s.running}
      {state.status === "error" && (
        <span className="font-medium text-bad">
          ✕ {s.failed}: {state.message}
        </span>
      )}
      {state.status === "done" && (
        <>
          <span className={state.result.matches ? "font-medium text-ok" : "font-medium text-bad"}>{state.result.matches ? `✓ ${s.match}` : `✕ ${s.mismatch}`}</span>{" "}
          <span className="font-mono" title={`${state.result.numbers.toLocaleString("en-GB")} numbers, engine ${state.result.engineVersion}`}>
            {state.result.hash.slice(0, 16)}… · {state.result.durationMs.toFixed(0)} ms
          </span>
        </>
      )}
    </p>
  );
}

type Tab = "simulate" | "scenarios" | "compare" | "scanLogs" | "editor" | "share";
const TABS: Tab[] = ["simulate", "scenarios", "compare", "scanLogs", "editor"];

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

const TAB_ICON: Record<Tab, typeof IconMap> = { simulate: IconMap, scenarios: IconList, compare: IconCompare, scanLogs: IconLog, editor: IconPencil, share: IconShare };

export function App() {
  const library = useLibrary();
  // The optional backend: hidden entirely when the API is not reachable (static hosting).
  const server = useServer();
  const remote = useRemoteVenues();
  const mine = useUserVenues();
  const sharedVenue = server.shared.status === "ready" ? server.shared.venue : null;
  const jobs = useJobs(server.client, sharedVenue?.id ?? null, server.access);

  const [tab, setTab] = useState<Tab>("simulate");
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(["simulate"]));
  const [venueId, setVenueId] = useState(DEFAULT_VENUE);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [comparePreset, setComparePreset] = useState<ComparePreset | null>(null);
  const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // `remote` changes when a shared venue loads or changes: the catalogue reads it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const known = useMemo(() => knownVenues(), [remote, mine]);
  const example = known.find((v) => v.id === venueId) ?? known.find((v) => v.id === DEFAULT_VENUE) ?? known[0];
  const venue = example?.venue;
  const isShared = example?.remote ?? false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const choices = useMemo(() => allChoices(library.entries, example?.id), [library.entries, example?.id, remote]);
  const choice = choices.find((c) => c.key === selected[example?.id ?? venueId]) ?? choices[0];
  const tabs: Tab[] = server.status === "available" || server.route.kind === "venue" ? [...TABS, "share"] : TABS;

  // A shared link opens that venue (on its first server scenario); leaving it returns to the examples.
  const [shownShared, setShownShared] = useState<string | null>(null);
  const sharedId = sharedVenue?.id ?? null;
  if (sharedId !== shownShared) {
    setShownShared(sharedId);
    if (sharedVenue) {
      setVenueId(sharedVenue.id);
      const first = sharedVenue.scenarios[0];
      if (first) setSelected((s) => ({ ...s, [sharedVenue.id]: serverKey(first.id) }));
    } else if (!exampleVenues.some((v) => v.id === venueId)) setVenueId(DEFAULT_VENUE);
  }
  if (server.route.kind === "venue" && !visited.has("share")) setVisited((v) => new Set([...v, "share"]));

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

  // E6: the latest finished gate-opening sweep of the shared venue leads the comparison view.
  const latestGateSweep = jobs.list.find((j) => j.kind === "gateOpeningSweep" && j.status === "succeeded");
  const latestGateDetail = latestGateSweep ? jobs.details[latestGateSweep.id] : undefined;
  const openJob = jobs.open;
  const latestGateId = latestGateSweep?.id;
  const latestGateLoaded = latestGateDetail?.result !== undefined && latestGateDetail?.result !== null;
  useEffect(() => {
    if (latestGateId && !latestGateLoaded) void openJob(latestGateId);
  }, [latestGateId, latestGateLoaded, openJob]);
  const leadLine: CompareLeadLine | null = useMemo(() => {
    const r = latestGateDetail ? jobResult(latestGateDetail) : null;
    const sc = latestGateDetail?.request.scenario as Scenario | undefined;
    if (!r || r.kind !== "gateOpeningSweep" || !sc) return null;
    const h = gateSweepHeadline(r, sc.timeline);
    return { main: h.main, detail: `${strings.share.jobs.leadDetail(sc.name)} ${h.byMean} ${h.byCi}` };
  }, [latestGateDetail]);

  // "Save this run to the server" (a finished browser run, origin clientReported).
  const saveRun = async (parts: RunRecordParts): Promise<string> => {
    const access = server.access;
    if (!sharedVenue || !venue || !access) throw new Error(strings.share.saveRun.noVenue);
    if (!parts.done) throw new Error(strings.share.saveRun.notDone);
    const record = buildRunRecord({
      scenario: { ...parts.scenario, venueId: sharedVenue.id },
      metrics: parts.metrics,
      metricsHash: parts.hash,
      venueHash: await venueHash(venue),
      engineVersion: ENGINE_VERSION,
      createdAt: new Date().toISOString(),
    });
    const fitted = fitRunRecord(record);
    if (!fitted) throw new Error(strings.share.saveRun.tooBig);
    const onServer = sharedVenue.scenarios.some((s) => s.id === parts.scenario.id) ? (parts.scenario.id as string) : undefined;
    await server.client.createRun(sharedVenue.id, fitted.record, access, onServer);
    return fitted.trimmed ? strings.share.saveRun.savedTrimmed(Math.round(fitted.bytes / 1024)) : strings.share.saveRun.saved;
  };

  const scenarioPicker = venue && choice && (
    <select aria-label={strings.picker.scenario} className={`${select} min-w-0 max-w-[22rem] flex-1`} value={choice.key} onChange={(e) => setSelected((s) => ({ ...s, [example?.id ?? venueId]: e.target.value }))}>
      {choices.some((c) => c.key.startsWith("server:")) && (
        <optgroup label={strings.share.serverScenarios}>
          {choices
            .filter((c) => c.key.startsWith("server:"))
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
        </optgroup>
      )}
      {choices.some((c) => c.key.startsWith("builtin:")) && (
        <optgroup label={strings.picker.builtIn}>
          {choices
            .filter((c) => c.key.startsWith("builtin:"))
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
        </optgroup>
      )}
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
  );

  const notices = (
    <>
      {server.route.kind === "venue" && (
        <div className={server.shared.status === "error" ? noticeWarn : noticeInfo} role="status">
          {server.shared.status === "ready" ? (
            <p>
              <span className="font-semibold">{strings.share.banner.shared(server.shared.venue.name)}</span> {server.access?.kind === "edit" ? strings.share.banner.edit : strings.share.banner.read}{" "}
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => goTo("share")}>
                {strings.share.banner.manage}
              </button>
            </p>
          ) : server.shared.status === "error" ? (
            <p>
              {server.shared.message}{" "}
              <button type="button" className="font-medium underline underline-offset-2" onClick={server.leave}>
                {strings.share.venue.backHome}
              </button>
            </p>
          ) : (
            <p>{strings.share.venue.loading}</p>
          )}
        </div>
      )}
      {server.route.kind === "notFound" && (
        <p className={noticeWarn} role="status">
          {strings.share.notFound(server.route.path)}
        </p>
      )}
      {(library.dropped.length > 0 || library.error) && (
        <div className={noticeWarn} role="status">
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
          <button type="button" className="mt-1 text-xs font-medium underline underline-offset-2" onClick={library.dismissNotices}>
            OK
          </button>
        </div>
      )}
    </>
  );
  const hasNotices = server.route.kind !== "home" || library.dropped.length > 0 || !!library.error;

  /** A non-simulation section: scrolls on its own, in a centred page. */
  const pageWrap = (t: Tab, child: ReactNode) => (
    <div hidden={tab !== t} className="h-full overflow-y-auto scroll-thin">
      <div className={page}>{child}</div>
    </div>
  );

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Sidebar: brand, sections, engine status. */}
      <aside className="flex shrink-0 flex-col border-b border-line bg-surface lg:w-56 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5 px-4 py-3 lg:py-4">
          <IconLogo />
          <div className="min-w-0">
            <h1 className="text-[15px] leading-tight font-semibold tracking-tight">{strings.appName}</h1>
            <p className="hidden text-[11px] leading-snug text-subtle lg:block">{strings.taglineShort}</p>
          </div>
        </div>
        <nav aria-label={strings.tabs.label} role="tablist" aria-orientation="vertical" className="flex gap-0.5 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
          {tabs.map((t) => {
            const Icon = TAB_ICON[t];
            const on = tab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={on}
                className={`flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors ${on ? "bg-sunken text-fg" : "text-muted hover:bg-sunken/60 hover:text-fg"}`}
                onClick={() => goTo(t)}
              >
                <Icon className={on ? "text-accent" : ""} />
                {strings.tabs[t]}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto hidden flex-col gap-2 border-t border-line px-4 py-3 lg:flex">
          <SelfCheckLine />
          {server.status === "available" && <p className="text-[11px] text-subtle">{strings.share.footerServer}</p>}
          <a className="text-[11px] text-subtle underline underline-offset-2 hover:text-fg" href={strings.footer.sourceUrl}>
            {strings.footer.source}
          </a>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Top bar: what is open. */}
        <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2">
          <select aria-label={strings.picker.venue} className={`${select} max-w-[20rem] font-medium`} value={example?.id ?? venueId} onChange={(e) => setVenueId(e.target.value)}>
            {known.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
          {tab === "simulate" && scenarioPicker && (
            <>
              <span className="text-subtle" aria-hidden="true">
                /
              </span>
              {scenarioPicker}
              {choice?.description && <InfoTip text={choice.description} />}
            </>
          )}
          {savedNote && tab === "simulate" && <span className="rounded-full bg-ok-soft px-2.5 py-0.5 text-xs font-medium text-ok">{savedNote}</span>}
        </header>
        {hasNotices && <div className="flex flex-col gap-2 border-b border-line px-4 py-2">{notices}</div>}

        <main className="relative min-h-0 flex-1">
          {/* Every visited section stays mounted (hidden when not shown), so its state survives switching. */}
          <div hidden={tab !== "simulate"} className="h-full">
            {venue && choice && (
              <SimulationView
                venue={venue}
                scenario={choice.scenario}
                label={choice.label}
                ownScenario={!choice.builtIn}
                active={tab === "simulate"}
                onCompare={openComparison}
                onSaveWorking={saveWorking}
                onSaveRun={isShared && server.access?.kind === "edit" ? saveRun : undefined}
              />
            )}
            {!choice && venue && (
              <div className={page}>
                <p className="text-sm text-muted">{strings.share.noScenarios}</p>
              </div>
            )}
          </div>
          <Suspense fallback={<p className="p-6 text-sm text-subtle">{strings.controls.loading}</p>}>
            {visited.has("scenarios") && pageWrap("scenarios", <LibraryView venueId={example?.id ?? venueId} library={library} request={editorRequest} onOpen={openScenario} onCompare={openComparison} />)}
            {visited.has("compare") &&
              pageWrap(
                "compare",
                <CompareView
                  venueId={example?.id ?? venueId}
                  entries={library.entries}
                  preset={comparePreset}
                  onSave={(s) => editDraft({ ...s, id: newScenarioId(), name: copyName(s.name, "") }, true)}
                  leadLine={sharedVenue && example?.id === sharedVenue.id ? leadLine : null}
                />,
              )}
            {visited.has("scanLogs") && pageWrap("scanLogs", <ScanLogView venueId={example?.id ?? venueId} entries={library.entries} onApply={(s) => editDraft(s, true)} />)}
            {visited.has("editor") && (
              <div hidden={tab !== "editor"} className="h-full">
                <VenueEditor key={example?.id ?? venueId} venueId={example?.id ?? venueId} server={server} onSaved={(id) => setVenueId(id)} />
              </div>
            )}
            {visited.has("share") && tabs.includes("share") && pageWrap("share", <ShareView server={server} jobs={jobs} venueId={example?.id ?? venueId} library={library} onOpenScenario={openScenario} />)}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
