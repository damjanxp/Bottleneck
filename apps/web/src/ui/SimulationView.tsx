import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exampleVenues } from "@bottleneck/examples";
import { MAX_SPEED, MIN_SPEED, TICK_SECONDS } from "@bottleneck/engine";
import type { Scenario } from "@bottleneck/schema";
// Type-only: PixiJS and uPlot are loaded on demand, so they stay out of the main chunk.
import type { FrameStats, VenueRenderer } from "../render/VenueRenderer.ts";
import { formatBytesPerSecond, formatCount, formatDuration, formatRelativeClock } from "../sim/format.ts";
import { MAX_LANES, compareHeadlines, headlines, laneLabel, withExtraLane, worstLane, type Headline } from "../sim/headline.ts";
import { describeParameters, elementName } from "../sim/parameters.ts";
import { SimController, type SeekState } from "../sim/SimController.ts";
import { strings } from "../strings.ts";
import type { LoadedInfo, MetricsSummary, StatsMessage } from "../workerProtocol.ts";
import { Legend } from "./Legend.tsx";
import { CapacityTable, ClockDisplay, Comparison, Headlines, LaneTable, ParametersList, StateCounts, WorstLane, type ClockInfo } from "./Panels.tsx";

const LaneCharts = lazy(() => import("./LaneCharts.tsx").then((m) => ({ default: m.LaneCharts })));

const SPEEDS = [1, 2, 5, 10, 30, 60].filter((s) => s >= MIN_SPEED && s <= MAX_SPEED);
const DEFAULT_SPEED = 30;
/** "Step" advances one tick; "+1 min" one simulated minute. */
const STEP_TICKS = 1;
const MINUTE_TICKS = Math.round(60 / TICK_SECONDS);
const NARROW_PX = 768;

const DEFAULT_VENUE = Math.max(0, exampleVenues.findIndex((v) => v.id === "belgrade-fair-concert"));

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

function perfEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf") === "1";
}

const btn =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800";
const btnPrimary = "rounded-md bg-amber-500 px-4 py-1.5 text-sm font-semibold text-slate-950 shadow-sm hover:bg-amber-400 disabled:opacity-50";

/** The "+1 lane" fix (review A9): the finished previous run's headline numbers and what changed. */
interface LaneFix {
  elementId: string;
  elementName: string;
  beforeLanes: number;
  afterLanes: number;
  before: Headline[];
}

/** A "+1 lane" waiting for the current run to finish (a seek to the end) before reloading. */
interface PendingFix {
  elementId: string;
  laneCount: number;
  seekId: number | null;
  awaitingMetrics: boolean;
}

export function SimulationView() {
  const [venueIndex, setVenueIndex] = useState(DEFAULT_VENUE);
  const [scenarioIndex, setScenarioIndex] = useState(0);
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
  /** A modified copy of the example scenario ("+1 lane"); null means the example as shipped. */
  const [scenarioOverride, setScenarioOverride] = useState<Scenario | null>(null);
  const [laneFix, setLaneFix] = useState<LaneFix | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [perf] = useState(perfEnabled);

  const controllerRef = useRef<SimController | null>(null);
  const rendererRef = useRef<VenueRenderer | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<LoadedInfo | null>(null);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFix = useRef<PendingFix | null>(null);

  const example = exampleVenues[venueIndex] ?? exampleVenues[0];
  const scenarioInfo = example?.scenarioInfo[scenarioIndex] ?? example?.scenarioInfo[0];
  const venue = example?.venue;
  const scenario = scenarioOverride ?? scenarioInfo?.scenario;
  const scenarioRef = useRef<Scenario | undefined>(scenario);
  const venueRef = useRef(venue);
  useEffect(() => {
    scenarioRef.current = scenario;
    venueRef.current = venue;
  }, [scenario, venue]);

  /** Second half of "+1 lane": keep the finished run's numbers, reload with one more lane. */
  const applyFix = useCallback((fix: PendingFix, finalMetrics: MetricsSummary) => {
    const sc = scenarioRef.current;
    const v = venueRef.current;
    pendingFix.current = null;
    setFinishing(false);
    if (!sc || !v) return;
    setLaneFix({
      elementId: fix.elementId,
      elementName: elementName(v, fix.elementId),
      beforeLanes: fix.laneCount,
      afterLanes: Math.min(MAX_LANES, fix.laneCount + 1),
      // The previous run is finished, so every number is final.
      before: headlines(finalMetrics, sc.timeline.eventStart, Infinity),
    });
    setScenarioOverride(withExtraLane(sc, fix.elementId, fix.laneCount));
  }, []);

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
      onMetrics: (m) => {
        setMetrics(m);
        const fix = pendingFix.current;
        if (fix?.awaitingMetrics) applyFix(fix, m);
      },
      onSeek: (s) => {
        setSeek(s);
        // Another seek replaced the one finishing the run for "+1 lane": give up on the fix.
        const fix = pendingFix.current;
        if (fix && s !== null && fix.seekId !== null && s.seekId !== fix.seekId) {
          pendingFix.current = null;
          setFinishing(false);
        }
      },
      onSeekDone: (d) => {
        const fix = pendingFix.current;
        if (!fix || fix.seekId !== d.seekId) return;
        if (d.cancelled) {
          pendingFix.current = null;
          setFinishing(false);
        } else fix.awaitingMetrics = true; // the worker sends the final metrics right after
      },
      onError: (m) => setError(m),
    });
    return () => {
      unsubscribe();
      c.dispose();
      controllerRef.current = null;
    };
  }, [applyFix]);

  // Load the chosen example.
  useEffect(() => {
    if (!venue || !scenario) return;
    loadedRef.current = null;
    controllerRef.current?.load(venue, scenario, DEFAULT_SPEED);
    // Speed resets to the examples' default on every load (review A9).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSpeed(DEFAULT_SPEED);
  }, [venue, scenario]);

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
        if (info && venue) r.setVenue(venue, info.lanes);
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
    if (r && loaded && venue) r.setVenue(venue, loaded.lanes);
  }, [loaded, venue]);

  useEffect(() => {
    rendererRef.current?.setSelectedLane(selectedLane);
  }, [selectedLane]);

  useEffect(() => {
    controllerRef.current?.setDensity(heatmap);
    if (!heatmap) rendererRef.current?.setDensity(null);
  }, [heatmap, loaded]);

  const playing = stats?.playing ?? false;
  const time = stats?.time ?? loaded?.startTime ?? 0;
  const done = stats?.done ?? false;

  const clock: ClockInfo | null = useMemo(() => {
    if (!scenario) return null;
    const tl = scenario.timeline;
    return { anchor: tl.eventStart ?? tl.gatesOpen, fixedStart: tl.eventStart !== null, referenceClock: tl.referenceClock };
  }, [scenario]);

  const laneNames = useMemo(() => {
    const m = new Map<number, string>();
    if (!loaded || !venue) return m;
    for (const l of loaded.lanes) m.set(l.laneId, laneLabel(l, elementName(venue, l.elementId), strings.lanes.lane, strings.lanes.manual));
    return m;
  }, [loaded, venue]);

  const paramRows = useMemo(() => (loaded && venue && scenario ? describeParameters(loaded.parameters, venue, scenario) : []), [loaded, venue, scenario]);

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

  /** "+1 lane" (review A9): finish the current run (exact seek to the end), then reload with one more lane. */
  const onAddLane = (elementId: string) => {
    const c = controllerRef.current;
    if (!c || !loaded || seek || pendingFix.current) return;
    const el = loaded.parameters.elements.find((e) => e.id === elementId);
    if (!el || el.laneCount >= MAX_LANES) return;
    const fix: PendingFix = { elementId, laneCount: el.laneCount, seekId: null, awaitingMetrics: false };
    pendingFix.current = fix;
    if (stats?.done && metrics) {
      applyFix(fix, metrics);
      return;
    }
    setFinishing(true);
    fix.seekId = c.seek(loaded.endTime);
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
  const heads = metrics && scenario ? headlines(metrics, scenario.timeline.eventStart, done ? Infinity : time) : [];
  const busy = !loaded || seek !== null || finishing;
  const names = (id: string) => (venue ? elementName(venue, id) : id);
  const selectedReport = selectedLane !== null ? metrics?.lanes.find((l) => l.laneId === selectedLane) : undefined;

  const statusNote = stats?.done ? (stats.deadlock ? strings.controls.deadlock : stats.drained ? strings.controls.drained : strings.controls.horizon) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Example picker */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-slate-600 dark:text-slate-400">
          {strings.picker.venue}
          <select
            className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            value={venueIndex}
            onChange={(e) => {
              setVenueIndex(Number(e.target.value));
              setScenarioIndex(0);
              setScenarioOverride(null);
              setLaneFix(null);
            }}
          >
            {exampleVenues.map((v, i) => (
              <option key={v.id} value={i}>
                {v.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-slate-600 dark:text-slate-400">
          {strings.picker.scenario}
          <select
            className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            value={scenarioIndex}
            onChange={(e) => {
              setScenarioIndex(Number(e.target.value));
              setScenarioOverride(null);
              setLaneFix(null);
            }}
          >
            {example?.scenarioInfo.map((s, i) => (
              <option key={s.id} value={i}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        {scenarioInfo && (
          <p className="max-w-md flex-1 text-sm text-slate-600 dark:text-slate-400">
            {scenarioInfo.description}
            {scenarioOverride && laneFix && (
              <span className="mt-1 block font-medium text-sky-800 dark:text-sky-300">
                {strings.picker.modified} {laneFix.elementName}: {laneFix.afterLanes} {strings.comparison.lanes}
              </span>
            )}
          </p>
        )}
      </div>

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
            <button
              type="button"
              className={btn}
              onClick={() => {
                pendingFix.current = null;
                setFinishing(false);
                controllerRef.current?.restart();
              }}
              disabled={!loaded}
            >
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

          {clock && <ClockDisplay time={scrub ?? time} clock={clock} />}

          {/* Scrubber */}
          {loaded && clock && (
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
                  <span>{finishing ? strings.controls.finishing : strings.controls.seeking}</span>
                  <button type="button" className="underline" onClick={() => controllerRef.current?.cancelSeek()}>
                    {strings.controls.cancel}
                  </button>
                </div>
              )}
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
          {venue?.attribution && <p className="text-xs text-slate-500">{venue.attribution}</p>}
        </section>

        <aside className="flex min-w-0 flex-col gap-3">
          {clock && heads.length > 0 && <Headlines items={heads} clock={clock} />}
          {laneFix && (
            <Comparison
              rows={compareHeadlines(laneFix.before, heads)}
              title={laneFix.elementName}
              beforeLanes={laneFix.beforeLanes}
              afterLanes={laneFix.afterLanes}
              finished={done}
              busy={busy}
              onRunToEnd={() => loaded && controllerRef.current?.seek(loaded.endTime)}
              onClose={() => setLaneFix(null)}
            />
          )}
          <WorstLane name={worst ? (laneNames.get(worst.laneId) ?? null) : null} queue={worst?.queueLength ?? 0} onAddLane={worstElement ? () => onAddLane(worstElement) : undefined} addDisabled={busy} />
          {selectedReport && loaded && clock && (
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
          {metrics && clock && metrics.elements.length > 0 && <CapacityTable elements={metrics.elements} names={names} clock={clock} onAddLane={onAddLane} addDisabled={busy} />}
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
