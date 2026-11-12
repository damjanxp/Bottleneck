import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_SPEED, MIN_SPEED, TICK_SECONDS } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";
import type { CompareEntry } from "../compare/plan.ts";
import { exportFileName } from "../library/files.ts";
import { withTimedEvent } from "../library/scenarios.ts";
// Type-only: PixiJS and uPlot are loaded on demand, so they stay out of the main chunk.
import type { FrameStats, VenueRenderer } from "../render/VenueRenderer.ts";
import { formatBytesPerSecond, formatCount, formatDuration, formatRelativeClock } from "../sim/format.ts";
import { MAX_LANES, headlines, laneLabel, withExtraLane, worstLane } from "../sim/headline.ts";
import { describeParameters, elementName } from "../sim/parameters.ts";
import { SimController, type SeekState } from "../sim/SimController.ts";
import { strings } from "../strings.ts";
import type { LoadedInfo, MetricsSummary, StatsMessage } from "../workerProtocol.ts";
import { downloadText } from "./browserFiles.ts";
import { Legend } from "./Legend.tsx";
import { CapacityTable, ClockDisplay, Headlines, LaneTable, ParametersList, StateCounts, WorstLane, type ClockInfo } from "./Panels.tsx";
import { btn, btnPrimary, btnSmall } from "./styles.ts";

const LaneCharts = lazy(() => import("./LaneCharts.tsx").then((m) => ({ default: m.LaneCharts })));

const SPEEDS = [1, 2, 5, 10, 30, 60].filter((s) => s >= MIN_SPEED && s <= MAX_SPEED);
const DEFAULT_SPEED = 30;
/** "Step" advances one tick; "+1 min" one simulated minute. */
const STEP_TICKS = 1;
const MINUTE_TICKS = Math.round(60 / TICK_SECONDS);
const NARROW_PX = 768;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function perfEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf") === "1";
}

export interface SimulationViewProps {
  venue: Venue;
  /** The selected scenario as saved (built-in or the user's). */
  scenario: Scenario;
  label: string;
  /** The selected scenario is the user's own, so changes may be saved into it. */
  ownScenario: boolean;
  /** False while another section is shown: playback pauses. */
  active: boolean;
  onCompare(entries: CompareEntry[], seeds: number): void;
  /** Save the working copy (lane events recorded during playback), into the selected scenario or as a new one. */
  onSaveWorking(scenario: Scenario, intoSelected: boolean): void;
}

/**
 * Lane events recorded during playback (review B8) live in a working copy of the scenario, tied to
 * the scenario object they were made on: selecting another scenario forgets them.
 */
interface WorkingCopy {
  base: Scenario;
  scenario: Scenario;
  added: number;
}

export function SimulationView({ venue, scenario, label, ownScenario, active, onCompare, onSaveWorking }: SimulationViewProps) {
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [loaded, setLoaded] = useState<LoadedInfo | null>(null);
  const [stats, setStats] = useState<StatsMessage | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [seek, setSeek] = useState<SeekState | null>(null);
  const [heatmap, setHeatmap] = useState(false);
  const [selectedLane, setSelectedLane] = useState<number | null>(null);
  const [showMap, setShowMap] = useState(() => typeof window === "undefined" || window.innerWidth >= NARROW_PX);
  const [error, setError] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [workingState, setWorkingState] = useState<WorkingCopy | null>(null);
  const [applyingSeek, setApplyingSeek] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [perf] = useState(perfEnabled);

  const working = workingState?.base === scenario ? workingState : null;
  const effective = working?.scenario ?? scenario;

  const controllerRef = useRef<SimController | null>(null);
  const rendererRef = useRef<VenueRenderer | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<LoadedInfo | null>(null);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Crossing the narrow-screen breakpoint shows or hides the map (review C6); the button overrides.
  useEffect(() => {
    const mq = window.matchMedia?.(`(min-width: ${NARROW_PX}px)`);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setShowMap(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Worker controller: one per mounted view.
  useEffect(() => {
    const c = new SimController();
    controllerRef.current = c;
    const unsubscribe = c.subscribe({
      onLoaded: (info) => {
        loadedRef.current = info;
        setLoaded(info);
        setMetrics(null);
        setStats(null);
        setSelectedLane(null);
        setError(null);
        if (!prefersReducedMotion()) c.play();
      },
      onSnapshot: (s) => rendererRef.current?.setSnapshot(s),
      onStats: (s) => {
        setStats(s);
        const r = rendererRef.current;
        if (r) {
          r.setLaneStates(s.lanes);
          r.setPlayback(s.playing, s.speed);
          const info = loadedRef.current;
          if (s.density && info) r.setDensity({ data: s.density, ...info.density });
        }
      },
      onMetrics: (m) => setMetrics(m),
      onSeek: (s) => setSeek(s),
      onSeekDone: (d) => setApplyingSeek((cur) => (cur === d.seekId ? null : cur)),
      onError: (m) => setError(m),
    });
    return () => {
      unsubscribe();
      c.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Load the selected scenario (lane events recorded here go through replaceScenario instead).
  useEffect(() => {
    loadedRef.current = null;
    controllerRef.current?.load(venue, scenario, DEFAULT_SPEED);
    // Speed resets to the examples' default on every load (review A9).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpeed(DEFAULT_SPEED);
  }, [venue, scenario]);

  // Leaving the section pauses playback.
  const playingNow = stats?.playing ?? false;
  useEffect(() => {
    if (!active && playingNow) controllerRef.current?.pause();
  }, [active, playingNow]);

  // Renderer: created while the map is shown.
  useEffect(() => {
    const host = hostRef.current;
    if (!showMap || !host) return;
    let cancelled = false;
    let renderer: VenueRenderer | null = null;
    import("../render/VenueRenderer.ts")
      .then(({ VenueRenderer: Renderer }) => Renderer.create(host))
      .then((r) => {
        if (cancelled) {
          r.destroy();
          return;
        }
        renderer = r;
        rendererRef.current = r;
        r.onLaneClick = (id) => setSelectedLane(id);
        const info = loadedRef.current;
        const c = controllerRef.current;
        if (info) r.setVenue(venue, info.lanes);
        if (c?.latest) r.setSnapshot(c.latest);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      renderer?.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
    // The renderer is rebuilt only when the map is shown or hidden; venue changes go through setVenue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMap]);

  // New venue geometry for the renderer.
  useEffect(() => {
    const r = rendererRef.current;
    if (r && loaded) r.setVenue(venue, loaded.lanes);
  }, [loaded, venue]);

  useEffect(() => {
    rendererRef.current?.setSelectedLane(selectedLane);
  }, [selectedLane]);

  useEffect(() => {
    controllerRef.current?.setDensity(heatmap);
    if (!heatmap) rendererRef.current?.setDensity(null);
  }, [heatmap, loaded]);

  const playing = playingNow;
  const time = stats?.time ?? loaded?.startTime ?? 0;
  const done = stats?.done ?? false;

  const clock: ClockInfo = useMemo(() => {
    const tl = scenario.timeline;
    return { anchor: tl.eventStart ?? tl.gatesOpen, fixedStart: tl.eventStart !== null, referenceClock: tl.referenceClock };
  }, [scenario]);

  const laneNames = useMemo(() => {
    const m = new Map<number, string>();
    if (!loaded) return m;
    for (const l of loaded.lanes) m.set(l.laneId, laneLabel(l, elementName(venue, l.elementId), strings.lanes.lane, strings.lanes.manual));
    return m;
  }, [loaded, venue]);

  const paramRows = useMemo(() => (loaded ? describeParameters(loaded.parameters, venue, effective) : []), [loaded, venue, effective]);

  const onPlayPause = useCallback(() => {
    const c = controllerRef.current;
    if (!c) return;
    if (playing) c.pause();
    else c.play();
  }, [playing]);

  const onSpeed = (s: number) => {
    setSpeed(s);
    controllerRef.current?.setSpeed(s);
  };

  const effectiveLabel = working ? `${label} (${strings.working.heading.toLowerCase()})` : label;

  /** "+1 lane" (review A9): opens the comparison of this scenario against the same with one more lane. */
  const onAddLane = (elementId: string) => {
    if (!loaded) return;
    const el = loaded.parameters.elements.find((e) => e.id === elementId);
    if (!el || el.laneCount >= MAX_LANES) return;
    const name = elementName(venue, elementId);
    onCompare(
      [
        { key: "adhoc:current", label: `${effectiveLabel}: ${name} ${el.laneCount} ${strings.library.lanes}`, scenario: effective },
        { key: `adhoc:plus-${elementId}-${el.laneCount + 1}`, label: `${effectiveLabel}: ${name} ${el.laneCount + 1} ${strings.library.lanes}`, scenario: withExtraLane(effective, elementId, el.laneCount) },
      ],
      1,
    );
  };

  /** Interactive lane failure / reopening (review B8): a timed event at the current time in the working copy. */
  const onLaneEvent = (kind: "laneFail" | "laneReopen", laneId: number) => {
    const c = controllerRef.current;
    const layout = loaded?.lanes.find((l) => l.laneId === laneId);
    if (!c || !layout || layout.manual || seek) return;
    const at = time;
    const next = withTimedEvent(effective, { kind, at, groupId: layout.elementId, laneIndex: layout.laneIndex });
    setWorkingState({ base: scenario, scenario: next, added: (working?.added ?? 0) + 1 });
    setApplyingSeek(c.replaceScenario(next, at));
  };

  const discardWorking = () => {
    const c = controllerRef.current;
    setWorkingState(null);
    if (c) setApplyingSeek(c.replaceScenario(scenario, time));
  };

  const onExportScanLog = async () => {
    const c = controllerRef.current;
    if (!c) return;
    setExporting(true);
    try {
      const { csv } = await c.scanLog();
      downloadText(exportFileName(effective).replace(/\.scenario\.json$/, ".scan-log.csv"), csv, "text/csv");
    } finally {
      setExporting(false);
    }
  };

  const onScrub = (value: number) => {
    setScrub(value);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => {
      controllerRef.current?.seek(value);
      setScrub(null);
    }, 300);
  };

  const worst = stats ? worstLane(stats.lanes) : null;
  const worstElement = worst && loaded ? loaded.lanes.find((l) => l.laneId === worst.laneId)?.elementId : undefined;
  const heads = metrics ? headlines(metrics, scenario.timeline.eventStart, done ? Infinity : time) : [];
  const busy = !loaded || seek !== null;
  const names = (id: string) => elementName(venue, id);
  const selectedReport = selectedLane !== null ? metrics?.lanes.find((l) => l.laneId === selectedLane) : undefined;
  const selectedLayout = selectedLane !== null ? loaded?.lanes.find((l) => l.laneId === selectedLane) : undefined;
  const selectedLive = selectedLane !== null ? stats?.lanes[selectedLane] : undefined;

  const statusNote = stats?.done ? (stats.deadlock ? strings.controls.deadlock : stats.drained ? strings.controls.drained : strings.controls.horizon) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="flex min-w-0 flex-col gap-3">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnPrimary} onClick={onPlayPause} disabled={!loaded || done || seek !== null}>
              {playing ? strings.controls.pause : strings.controls.play}
            </button>
            <button type="button" className={btn} onClick={() => controllerRef.current?.step(STEP_TICKS)} disabled={!loaded || playing || done || seek !== null} title={strings.controls.stepHint}>
              {strings.controls.step}
            </button>
            <button type="button" className={btn} onClick={() => controllerRef.current?.step(MINUTE_TICKS)} disabled={!loaded || playing || done || seek !== null} title={strings.controls.plusMinuteHint}>
              {strings.controls.plusMinute}
            </button>
            <button type="button" className={btn} onClick={() => controllerRef.current?.restart()} disabled={!loaded}>
              {strings.controls.restart}
            </button>
            <button type="button" className={btn} onClick={() => loaded && controllerRef.current?.seek(loaded.peakStart)} disabled={!loaded || seek !== null} title={strings.controls.jumpToPeakHint}>
              {strings.controls.jumpToPeak}
            </button>
            <label className="flex items-center gap-1 text-sm">
              {strings.controls.speed}
              <select className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900" value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} />
              {strings.controls.heatmap}
            </label>
            {showMap && (
              <button type="button" className={btn} onClick={() => rendererRef.current?.fit()}>
                {strings.controls.fit}
              </button>
            )}
            <button type="button" className={btn} onClick={() => setShowMap((v) => !v)}>
              {showMap ? strings.controls.hideMap : strings.controls.showMap}
            </button>
          </div>

          {/* Run-level actions: batch over seeds, scan-log export */}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btn} onClick={() => onCompare([{ key: "adhoc:current", label: effectiveLabel, scenario: effective }], 5)} title={strings.runActions.batchHint}>
              {strings.runActions.batch}
            </button>
            <button type="button" className={btn} onClick={() => void onExportScanLog()} disabled={!done || exporting || seek !== null} title={strings.runActions.exportScanLogHint}>
              {strings.runActions.exportScanLog}
            </button>
            {!done && loaded && (
              <span className="text-xs text-slate-500">
                {strings.runActions.runToEndFirst}{" "}
                <button type="button" className="underline" onClick={() => controllerRef.current?.seek(loaded.endTime)} disabled={seek !== null}>
                  {strings.runActions.runToEnd}
                </button>
              </span>
            )}
          </div>

          <ClockDisplay time={scrub ?? time} clock={clock} />

          {/* Scrubber */}
          {loaded && (
            <div className="flex flex-col gap-1">
              <input
                type="range"
                aria-label={strings.controls.scrubber}
                aria-valuetext={formatRelativeClock(scrub ?? time, clock.anchor, clock.fixedStart)}
                min={loaded.startTime}
                max={loaded.endTime}
                step={30}
                value={scrub ?? seek?.target ?? time}
                onChange={(e) => onScrub(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              {seek && (
                <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400" role="status">
                  <progress className="h-2 flex-1 accent-amber-500" max={1} value={seek.fraction} />
                  <span>{applyingSeek === seek.seekId ? strings.laneActions.applying : strings.controls.seeking}</span>
                  <button type="button" className="underline" onClick={() => controllerRef.current?.cancelSeek()}>
                    {strings.controls.cancel}
                  </button>
                </div>
              )}
            </div>
          )}

          {working && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 p-2 text-sm dark:border-sky-500/40 dark:bg-sky-500/10" role="status">
              <span className="font-medium text-sky-900 dark:text-sky-200">
                {strings.working.heading}: {strings.working.events(working.added)}
              </span>
              {ownScenario && (
                <button type="button" className={btnSmall} onClick={() => onSaveWorking(working.scenario, true)}>
                  {strings.working.saveOver}
                </button>
              )}
              <button type="button" className={btnSmall} onClick={() => onSaveWorking(working.scenario, false)}>
                {strings.working.saveNew}
              </button>
              <button
                type="button"
                className={btnSmall}
                onClick={() =>
                  onCompare(
                    [
                      { key: "adhoc:original", label, scenario },
                      { key: "adhoc:current", label: effectiveLabel, scenario: working.scenario },
                    ],
                    1,
                  )
                }
              >
                {strings.working.compare}
              </button>
              <button type="button" className={btnSmall} onClick={discardWorking} disabled={seek !== null}>
                {strings.working.discard}
              </button>
            </div>
          )}

          {reducedMotion && !playing && time === loaded?.startTime && <p className="text-sm text-slate-600 dark:text-slate-400">{strings.controls.reducedMotion}</p>}
          {statusNote && (
            <p className="text-sm font-medium" role="status">
              {strings.controls.finished}: {statusNote}
            </p>
          )}
          {error && (
            <p className="text-sm font-medium text-red-700 dark:text-red-400" role="alert">
              {strings.errors.worker}: {error}
            </p>
          )}

          {/* Map */}
          {showMap ? (
            <div ref={hostRef} className="relative h-[62vh] min-h-[360px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800">
              {!loaded && <p className="absolute inset-0 grid place-items-center text-sm text-slate-500">{strings.controls.loading}</p>}
              {perf && <PerfOverlay controller={controllerRef} renderer={rendererRef} stats={stats} agentCount={loaded?.agentCount ?? 0} />}
            </div>
          ) : (
            <p className="text-sm text-slate-500">{strings.controls.mapHiddenNote}</p>
          )}
          <Legend heatmap={heatmap} />
          {venue.attribution && <p className="text-xs text-slate-500">{venue.attribution}</p>}
        </section>

        <aside className="flex min-w-0 flex-col gap-3">
          {heads.length > 0 && <Headlines items={heads} clock={clock} />}
          <WorstLane name={worst ? (laneNames.get(worst.laneId) ?? null) : null} queue={worst?.queueLength ?? 0} onAddLane={worstElement ? () => onAddLane(worstElement) : undefined} addDisabled={busy} />
          {selectedLayout && (
            <section className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm dark:border-sky-500/40 dark:bg-sky-500/10" aria-labelledby="lane-actions-heading">
              <h2 id="lane-actions-heading" className="text-xs font-semibold text-sky-900 dark:text-sky-200">
                {strings.laneActions.heading}: {laneNames.get(selectedLayout.laneId)}
              </h2>
              {selectedLayout.manual ? (
                <p className="mt-1 text-xs">{strings.laneActions.manual}</p>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedLive?.failed ? (
                      <button type="button" className={btnSmall} onClick={() => onLaneEvent("laneReopen", selectedLayout.laneId)} disabled={busy || done}>
                        {strings.laneActions.reopen}
                      </button>
                    ) : (
                      <button type="button" className={btnSmall} onClick={() => onLaneEvent("laneFail", selectedLayout.laneId)} disabled={busy || done}>
                        {strings.laneActions.fail}
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">{strings.laneActions.intro}</p>
                </>
              )}
            </section>
          )}
          {selectedReport && loaded && (
            <Suspense fallback={<p className="text-xs text-slate-500">{strings.charts.loading}</p>}>
              <LaneCharts
                name={laneNames.get(selectedReport.laneId) ?? ""}
                report={selectedReport}
                startTime={loaded.startTime}
                queueInterval={loaded.parameters.queueSampleInterval}
                binSeconds={loaded.parameters.throughputBin}
                anchor={clock.anchor}
                fixedStart={clock.fixedStart}
                onClose={() => setSelectedLane(null)}
              />
            </Suspense>
          )}
          {metrics && metrics.elements.length > 0 && <CapacityTable elements={metrics.elements} names={names} clock={clock} onAddLane={onAddLane} addDisabled={busy} />}
          {loaded && stats && <LaneTable lanes={loaded.lanes} states={stats.lanes} names={laneNames} selected={selectedLane} onSelect={(id) => setSelectedLane((cur) => (cur === id ? null : id))} />}
          {stats && <StateCounts counts={stats.countsByState} time={stats.time} />}
          {paramRows.length > 0 && <ParametersList rows={paramRows} />}
          {!showMap && perf && <PerfOverlay controller={controllerRef} renderer={rendererRef} stats={stats} agentCount={loaded?.agentCount ?? 0} />}
        </aside>
      </div>
    </div>
  );
}

function PerfOverlay({ controller, renderer, stats, agentCount }: { controller: React.RefObject<SimController | null>; renderer: React.RefObject<VenueRenderer | null>; stats: StatsMessage | null; agentCount: number }) {
  const [sample, setSample] = useState<{ f: FrameStats | undefined; bytes: number; seekMs: number | null }>({ f: undefined, bytes: 0, seekMs: null });
  useEffect(() => {
    const id = setInterval(() => setSample({ f: renderer.current?.frameStats(), bytes: controller.current?.snapshotBytesPerSecond() ?? 0, seekMs: controller.current?.lastSeekMs ?? null }), 500);
    return () => clearInterval(id);
  }, [controller, renderer]);
  const { f, bytes, seekMs } = sample;
  const P = strings.perf;
  const ms = (v: number | undefined) => (v === undefined ? "–" : v.toFixed(1));
  return (
    <div className="pointer-events-none absolute top-2 right-2 rounded-md bg-slate-950/80 px-3 py-2 font-mono text-xs text-slate-100" aria-label={P.heading}>
      <div>
        {P.agents}: {formatCount(agentCount)}
      </div>
      <div>
        {P.frame}: {ms(f?.frameIntervalP50)} / {ms(f?.frameIntervalP95)} ms
      </div>
      <div>
        {P.render}: {ms(f?.renderP50)} / {ms(f?.renderP95)} ms
      </div>
      <div>
        {P.tick}: {ms(stats?.tick.p50)} / {ms(stats?.tick.p95)} ms
      </div>
      <div>
        {P.bytes}: {formatBytesPerSecond(bytes)}
      </div>
      {stats && (
        <div>
          {P.checkpoints}: {stats.checkpoints.count} · {(stats.checkpoints.bytes / 1048576).toFixed(1)} MB · {P.every} {formatDuration(stats.checkpoints.interval)}
        </div>
      )}
      <div>
        {P.lastSeek}: {seekMs === null ? "–" : `${seekMs.toFixed(0)} ms`}
      </div>
    </div>
  );
}
