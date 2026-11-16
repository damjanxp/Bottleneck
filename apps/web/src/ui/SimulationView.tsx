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
import { barrierRows, eventPhase, lotRows, parkingHeadlines, withLotClosed } from "../sim/parking.ts";
import { SimController, type RunRecordParts, type SeekState } from "../sim/SimController.ts";
import { strings } from "../strings.ts";
import type { LoadedInfo, MetricsSummary, StatsMessage } from "../workerProtocol.ts";
import { browserStore, loadVenueImage } from "../library/venueImages.ts";
import { downloadText } from "./browserFiles.ts";
import { Legend } from "./Legend.tsx";
import { CapacityTable, ClockDisplay, Headlines, LaneTable, ParametersList, Section, StateCounts, WorstLane, type ClockInfo } from "./Panels.tsx";
import { BarrierTable, CarCounts, LotTable, ParkingHeadlineCard } from "./ParkingPanels.tsx";
import { IconEyeOff, IconExit, IconFit, IconLayers, IconPause, IconPeak, IconPlay, IconRestart, IconStep } from "./icons.tsx";
import { btn, btnGhost, btnIcon, btnPrimary, btnSmall, card, cardHint, cardTitle, overlay, select } from "./styles.ts";

const LaneCharts = lazy(() => import("./LaneCharts.tsx").then((m) => ({ default: m.LaneCharts })));
const LotChart = lazy(() => import("./ParkingCharts.tsx").then((m) => ({ default: m.LotChart })));
const BarrierChart = lazy(() => import("./ParkingCharts.tsx").then((m) => ({ default: m.BarrierChart })));

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
  /** Present only for a shared venue opened with its edit link: saves the finished run to the server; resolves with a message. */
  onSaveRun?: (parts: RunRecordParts) => Promise<string>;
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

export function SimulationView({ venue, scenario, label, ownScenario, active, onCompare, onSaveWorking, onSaveRun }: SimulationViewProps) {
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [loaded, setLoaded] = useState<LoadedInfo | null>(null);
  const [stats, setStats] = useState<StatsMessage | null>(null);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [seek, setSeek] = useState<SeekState | null>(null);
  const [heatmap, setHeatmap] = useState(false);
  const [selectedLane, setSelectedLane] = useState<number | null>(null);
  const [lotChart, setLotChart] = useState<string | null>(null);
  const [barrierChart, setBarrierChart] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(() => typeof window === "undefined" || window.innerWidth >= NARROW_PX);
  const [error, setError] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [workingState, setWorkingState] = useState<WorkingCopy | null>(null);
  const [applyingSeek, setApplyingSeek] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [savingRun, setSavingRun] = useState(false);
  const [runSaved, setRunSaved] = useState<{ ok: boolean; text: string } | null>(null);
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
        setLotChart(null);
        setBarrierChart(null);
        setError(null);
        if (!prefersReducedMotion()) c.play();
      },
      onSnapshot: (s) => rendererRef.current?.setSnapshot(s),
      onStats: (s) => {
        setStats(s);
        const r = rendererRef.current;
        if (r) {
          r.setLaneStates(s.lanes);
          r.setBarrierStates(s.barriers);
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
        if (info) {
          r.setVenue(venue, info.lanes, info.vehicleLayout);
          void r.setBackgroundImage(venue.id ? loadVenueImage(browserStore(), venue.id) : null, venue.background ?? null);
        }
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
    if (r && loaded) {
      r.setVenue(venue, loaded.lanes, loaded.vehicleLayout);
      void r.setBackgroundImage(venue.id ? loadVenueImage(browserStore(), venue.id) : null, venue.background ?? null);
    }
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

  /** Interactive "close lot now": a lotClose timed event at the current time in the working copy, like a lane failure. */
  const onLotClose = (lotId: string) => {
    const c = controllerRef.current;
    if (!c || seek) return;
    const at = time;
    const next = withLotClosed(effective, lotId, at);
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

  const onSaveRunClick = async () => {
    const c = controllerRef.current;
    if (!c || !onSaveRun) return;
    setSavingRun(true);
    setRunSaved(null);
    try {
      const parts = await c.runRecord();
      setRunSaved({ ok: true, text: await onSaveRun(parts) });
    } catch (e) {
      setRunSaved({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingRun(false);
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
  // The pedestrian headlines are about gates; a venue without gates or screening (a car park on its own) skips them.
  const hasGates = venue.gateGroups.length + venue.screeningStages.length > 0;
  const heads = metrics && hasGates ? headlines(metrics, scenario.timeline.eventStart, done ? Infinity : time) : [];
  const busy = !loaded || seek !== null;
  const names = (id: string) => elementName(venue, id);
  const selectedReport = selectedLane !== null ? metrics?.lanes.find((l) => l.laneId === selectedLane) : undefined;
  const selectedLayout = selectedLane !== null ? loaded?.lanes.find((l) => l.laneId === selectedLane) : undefined;
  const selectedLive = selectedLane !== null ? stats?.lanes[selectedLane] : undefined;

  const layout = loaded?.vehicleLayout ?? null;
  const parkingHeads = metrics?.parking ? parkingHeadlines(metrics.parking, metrics.departures, done) : null;
  const lots = layout && stats ? lotRows(layout, stats.lots, metrics?.parking?.lots) : [];
  const barriers = layout && stats ? barrierRows(layout, stats.barriers, metrics?.parking?.barriers) : [];
  const phase = loaded ? eventPhase(scrub ?? time, scenario.timeline, loaded.parameters.departureCurve) : undefined;
  const lotChartReport = lotChart ? metrics?.parking?.lots.find((l) => l.lotId === lotChart) : undefined;
  const statusNote = stats?.done ? (stats.deadlock ? strings.controls.deadlock : stats.drained ? strings.controls.drained : strings.controls.horizon) : null;

  const playDisabled = !loaded || done || seek !== null;
  const stepDisabled = !loaded || playing || done || seek !== null;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* The map fills the stage; controls float over it (map-first, like kepler.gl or a video player). */}
      <section className="relative min-h-[460px] min-w-0 flex-1 overflow-hidden bg-map lg:min-h-0" aria-label={strings.controls.stage}>
        {showMap ? (
          <div ref={hostRef} className="absolute inset-0">
            {!loaded && <p className="absolute inset-0 grid place-items-center text-sm text-subtle">{strings.controls.loading}</p>}
            {perf && <PerfOverlay controller={controllerRef} renderer={rendererRef} stats={stats} agentCount={loaded?.agentCount ?? 0} />}
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="text-sm text-muted">{strings.controls.mapHiddenNote}</p>
              <button type="button" className={btn} onClick={() => setShowMap(true)}>
                {strings.controls.showMap}
              </button>
            </div>
          </div>
        )}

        {/* Top left: the event clock. */}
        <div className={`${overlay} absolute top-3 left-3 px-3.5 py-2`}>
          <ClockDisplay time={scrub ?? time} clock={clock} phase={phase} />
        </div>

        {/* Top right: map tools. */}
        <div className={`${overlay} absolute top-3 right-3 flex items-center gap-0.5 p-1`}>
          <button type="button" className={`${btnGhost} ${heatmap ? "bg-accent-soft text-fg" : ""}`} aria-pressed={heatmap} onClick={() => setHeatmap((v) => !v)} title={strings.controls.heatmap}>
            <IconLayers />
            <span className="hidden sm:inline">{strings.controls.heatmapShort}</span>
          </button>
          {showMap && (
            <button type="button" className={btnIcon} onClick={() => rendererRef.current?.fit()} aria-label={strings.controls.fit} title={strings.controls.fit}>
              <IconFit />
            </button>
          )}
          {showMap && (
            <button type="button" className={btnIcon} onClick={() => setShowMap(false)} aria-label={strings.controls.hideMap} title={strings.controls.hideMap}>
              <IconEyeOff />
            </button>
          )}
        </div>

        {/* Messages about the run, under the clock. */}
        <div className="pointer-events-none absolute top-[4.25rem] right-3 left-3 flex flex-col items-start gap-2">
          {working && (
            <div className={`${overlay} pointer-events-auto flex flex-wrap items-center gap-2 px-3 py-2 text-sm`} role="status">
              <span className="font-medium">
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
          {reducedMotion && !playing && time === loaded?.startTime && <p className={`${overlay} px-3 py-2 text-sm text-muted`}>{strings.controls.reducedMotion}</p>}
          {statusNote && (
            <p className={`${overlay} px-3 py-2 text-sm font-medium`} role="status">
              <span className="text-ok">●</span> {strings.controls.finished}: {statusNote}
            </p>
          )}
          {error && (
            <p className={`${overlay} pointer-events-auto px-3 py-2 text-sm font-medium text-bad`} role="alert">
              {strings.errors.worker}: {error}
            </p>
          )}
        </div>

        {/* Bottom: the legend, then the playback bar. */}
        <div className="absolute right-3 bottom-3 left-3 flex flex-col gap-2">
          <div className={`${overlay} flex flex-col gap-2 px-3 py-2.5`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" className={`${btnPrimary} w-[5.5rem]`} onClick={onPlayPause} disabled={playDisabled}>
                {playing ? <IconPause /> : <IconPlay />}
                {playing ? strings.controls.pause : strings.controls.play}
              </button>
              <button type="button" className={btnIcon} onClick={() => controllerRef.current?.step(STEP_TICKS)} disabled={stepDisabled} aria-label={strings.controls.step} title={strings.controls.stepHint}>
                <IconStep />
              </button>
              <button type="button" className={btnGhost} onClick={() => controllerRef.current?.step(MINUTE_TICKS)} disabled={stepDisabled} title={strings.controls.plusMinuteHint}>
                {strings.controls.plusMinute}
              </button>
              <button type="button" className={btnIcon} onClick={() => controllerRef.current?.restart()} disabled={!loaded} aria-label={strings.controls.restart} title={strings.controls.restart}>
                <IconRestart />
              </button>
              <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
              <button type="button" className={btn} onClick={() => loaded && controllerRef.current?.seek(loaded.peakStart)} disabled={!loaded || seek !== null} title={strings.controls.jumpToPeakHint}>
                <IconPeak />
                {strings.controls.jumpToPeak}
              </button>
              {loaded?.departurePeakStart !== null && loaded?.departurePeakStart !== undefined && (
                <button type="button" className={btn} onClick={() => loaded.departurePeakStart !== null && controllerRef.current?.seek(loaded.departurePeakStart)} disabled={seek !== null} title={strings.controls.jumpToDeparturesHint}>
                  <IconExit />
                  {strings.controls.jumpToDepartures}
                </button>
              )}
              {!done && loaded && (
                <button type="button" className={btnGhost} onClick={() => controllerRef.current?.seek(loaded.endTime)} disabled={seek !== null} title={strings.runActions.runToEndFirst}>
                  {strings.runActions.runToEnd}
                </button>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-xs text-subtle" aria-hidden="true">
                  {strings.controls.speed}
                </span>
                <select aria-label={strings.controls.speed} className={`${select} h-7 px-1.5 text-xs`} value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {loaded && (
              <div className="flex items-center gap-3">
                <span className="w-14 shrink-0 font-mono text-[11px] text-subtle tabular">{formatRelativeClock(loaded.startTime, clock.anchor, clock.fixedStart)}</span>
                <input
                  type="range"
                  aria-label={strings.controls.scrubber}
                  aria-valuetext={formatRelativeClock(scrub ?? time, clock.anchor, clock.fixedStart)}
                  min={loaded.startTime}
                  max={loaded.endTime}
                  step={30}
                  value={scrub ?? seek?.target ?? time}
                  onChange={(e) => onScrub(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer"
                />
                <span className="w-14 shrink-0 text-right font-mono text-[11px] text-subtle tabular">{formatRelativeClock(loaded.endTime, clock.anchor, clock.fixedStart)}</span>
              </div>
            )}
            {seek && (
              <div className="flex items-center gap-2 text-xs text-muted" role="status">
                <progress className="h-1.5 flex-1 accent-amber-500" max={1} value={seek.fraction} />
                <span>{applyingSeek === seek.seekId ? strings.laneActions.applying : strings.controls.seeking}</span>
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => controllerRef.current?.cancelSeek()}>
                  {strings.controls.cancel}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Inspector: the answer first, details below. */}
      <aside className="flex min-h-0 w-full shrink-0 flex-col gap-3 overflow-y-auto border-line bg-canvas p-3 scroll-thin lg:w-[384px] lg:border-l [&>*]:shrink-0">
        {parkingHeads && <ParkingHeadlineCard h={parkingHeads} names={names} clock={clock} />}
        {heads.length > 0 && <Headlines items={heads} clock={clock} />}
        <WorstLane name={worst ? (laneNames.get(worst.laneId) ?? null) : null} queue={worst?.queueLength ?? 0} onAddLane={worstElement ? () => onAddLane(worstElement) : undefined} addDisabled={busy} />
        {selectedLayout && (
          <section className={`${card} border-info/40 p-3 text-sm`} aria-labelledby="lane-actions-heading">
            <h2 id="lane-actions-heading" className={cardTitle}>
              {strings.laneActions.heading}: {laneNames.get(selectedLayout.laneId)}
            </h2>
            {selectedLayout.manual ? (
              <p className={cardHint}>{strings.laneActions.manual}</p>
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
                <p className={cardHint}>{strings.laneActions.intro}</p>
              </>
            )}
          </section>
        )}
        {selectedReport && loaded && (
          <Suspense fallback={<p className="text-xs text-subtle">{strings.charts.loading}</p>}>
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
        {layout && stats && <CarCounts counts={stats.carCounts} />}
        {layout && stats && <LotTable rows={lots} onClose={onLotClose} closeDisabled={busy || done} onCharts={(id) => setLotChart((cur) => (cur === id ? null : id))} chartsFor={lotChart} />}
        {lotChartReport && loaded && (
          <Suspense fallback={<p className="text-xs text-subtle">{strings.charts.loading}</p>}>
            <LotChart name={names(lotChartReport.lotId)} report={lotChartReport} startTime={loaded.startTime} binSeconds={loaded.parameters.throughputBin} anchor={clock.anchor} fixedStart={clock.fixedStart} />
          </Suspense>
        )}
        {layout && stats && <BarrierTable rows={barriers} clock={clock} onCharts={(id) => setBarrierChart((cur) => (cur === id ? null : id))} chartsFor={barrierChart} />}
        {barrierChart && metrics?.parking && loaded && (
          <Suspense fallback={<p className="text-xs text-subtle">{strings.charts.loading}</p>}>
            <BarrierChart name={names(barrierChart)} barrierId={barrierChart} lanes={metrics.parking.barrierLanes} startTime={loaded.startTime} queueInterval={loaded.parameters.queueSampleInterval} anchor={clock.anchor} fixedStart={clock.fixedStart} />
          </Suspense>
        )}
        {stats && <StateCounts counts={stats.countsByState} time={stats.time} cars={layout !== null} leaving={!!loaded?.parameters.departureCurve} />}

        <Section id="legend-heading" title={strings.legend.heading} collapsible defaultOpen={false}>
          <Legend heatmap={heatmap} cars={layout !== null} />
        </Section>

        {/* This run: batch over seeds, scan-log export, saving to the server. */}
        <section className={`${card} p-3`} aria-labelledby="run-actions-heading">
          <h2 id="run-actions-heading" className={cardTitle}>
            {strings.runActions.heading}
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnSmall} onClick={() => onCompare([{ key: "adhoc:current", label: effectiveLabel, scenario: effective }], 5)} title={strings.runActions.batchHint}>
              {strings.runActions.batch}
            </button>
            <button type="button" className={btnSmall} onClick={() => void onExportScanLog()} disabled={!done || exporting || seek !== null} title={strings.runActions.exportScanLogHint}>
              {strings.runActions.exportScanLog}
            </button>
            {onSaveRun && (
              <button type="button" className={btnSmall} onClick={() => void onSaveRunClick()} disabled={!done || savingRun || seek !== null} title={strings.share.saveRun.hint}>
                {savingRun ? strings.share.saveRun.busy : strings.share.saveRun.button}
              </button>
            )}
          </div>
          {!done && <p className={cardHint}>{strings.runActions.runToEndFirst}</p>}
          {runSaved && (
            <p className={`mt-2 text-xs ${runSaved.ok ? "text-ok" : "text-bad"}`} role={runSaved.ok ? "status" : "alert"}>
              {runSaved.text}
            </p>
          )}
        </section>
        {paramRows.length > 0 && <ParametersList rows={paramRows} />}
        {venue.attribution && <p className="px-1 text-[11px] text-subtle">{venue.attribution}</p>}
        {!showMap && perf && <PerfOverlay controller={controllerRef} renderer={rendererRef} stats={stats} agentCount={loaded?.agentCount ?? 0} />}
      </aside>
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
    <div className="pointer-events-none absolute top-16 right-3 rounded-md bg-black/75 px-3 py-2 font-mono text-xs text-white" aria-label={P.heading}>
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
