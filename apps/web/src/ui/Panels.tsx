import { useEffect, useRef, useState } from "react";
import { AgentState, type LaneLayout, type LaneLive, type LaneReport } from "@bottleneck/engine";
import type { ElementReport, LanePeriod } from "@bottleneck/schema";
import { formatCount, formatDuration, formatPercent, formatRelativeClock, formatWallClock } from "../sim/format.ts";
import type { Headline, HeadlineKind } from "../sim/headline.ts";
import type { ParameterRow } from "../sim/parameters.ts";
import type { EventPhase } from "../sim/parking.ts";
import { strings } from "../strings.ts";
import { ShapeIcon, stateShape } from "./Legend.tsx";

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";

export interface ClockInfo {
  anchor: number;
  fixedStart: boolean;
  referenceClock: string;
}

const btnSmall =
  "rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-semibold shadow-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800";

/** A headline value as text: people, a duration or a percentage. */
export function formatHeadlineValue(kind: HeadlineKind, value: number): string {
  switch (kind) {
    case "stillOutside":
      return `${formatCount(value)} ${strings.headline.people}`;
    case "p95PeakWait":
      return formatDuration(value);
    case "shareInside":
      return formatPercent(value);
  }
}

function headlineText(h: Headline, clock: ClockInfo): { label: string; value: string } {
  const H = strings.headline;
  switch (h.kind) {
    case "stillOutside":
      return h.final
        ? { label: H.stillOutsideFinal, value: `${formatCount(h.value)} ${H.people}` }
        : { label: `${H.stillOutsideSoFar} ${formatWallClock(clock.referenceClock, h.at ?? 0)})`, value: `${formatCount(h.value)} ${H.people}` };
    case "p95PeakWait":
      return { label: h.final ? H.p95PeakWait : `${H.p95PeakWait} (${H.soFar})`, value: formatDuration(h.value) };
    case "shareInside":
      return { label: `${H.shareInside} ${formatWallClock(clock.referenceClock, h.at ?? 0)}${h.final ? "" : ` (${H.soFar})`}`, value: formatPercent(h.value) };
  }
}

/** Headline numbers. The visible numbers update live; the screen-reader copy at most every 15 s. */
export function Headlines({ items, clock }: { items: Headline[]; clock: ClockInfo }) {
  const texts = items.map((h) => headlineText(h, clock));
  const spoken = texts.map((t) => `${t.label}: ${t.value}`).join(". ");
  const latest = useRef(spoken);
  useEffect(() => {
    latest.current = spoken;
  }, [spoken]);
  const [announced, setAnnounced] = useState(spoken);
  useEffect(() => {
    const id = setInterval(() => setAnnounced((prev) => (prev === latest.current ? prev : latest.current)), 15000);
    return () => clearInterval(id);
  }, []);
  return (
    <section className={card} aria-labelledby="headline-heading">
      <h2 id="headline-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {strings.headline.heading}
      </h2>
      <dl className="mt-2 grid gap-3">
        {texts.map((t, k) => {
          const split = items[k]?.split;
          return (
            <div key={t.label}>
              <dt className="text-xs text-slate-600 dark:text-slate-400">{t.label}</dt>
              <dd className="text-2xl font-bold tabular-nums">{t.value}</dd>
              {split && (
                <dd className="text-xs text-slate-600 tabular-nums dark:text-slate-400">
                  {formatCount(split.onSite)} {strings.headline.onSite} · {formatCount(split.notArrived)} {strings.headline.notArrived}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </p>
    </section>
  );
}

export function WorstLane({ name, queue, onAddLane, addDisabled }: { name: string | null; queue: number; onAddLane?: () => void; addDisabled?: boolean }) {
  const W = strings.worstLane;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10" aria-labelledby="worst-lane-heading">
      <h2 id="worst-lane-heading" className="text-xs font-semibold text-amber-900 dark:text-amber-300">
        {W.heading}
      </h2>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{name === null ? W.none : `${name}: ${formatCount(queue)} ${W.queue}`}</p>
        {name !== null && onAddLane && (
          <button type="button" className={btnSmall} onClick={onAddLane} disabled={addDisabled} title={W.addLaneHint}>
            {W.addLane}
          </button>
        )}
      </div>
    </section>
  );
}

const SHOWN_STATES = [AgentState.Pending, AgentState.Walking, AgentState.Queuing, AgentState.InService, AgentState.Inside, AgentState.TurnedAway] as const;
/** With cars or departures, people can also be in a car on the way out, or gone. */
const SHOWN_STATES_LEAVING = [AgentState.Pending, AgentState.Walking, AgentState.Queuing, AgentState.InService, AgentState.Inside, AgentState.Driving, AgentState.Departed, AgentState.TurnedAway] as const;
const STATE_KEYS = { 0: "Pending", 1: "Walking", 2: "Queuing", 3: "InService", 4: "Inside", 5: "Driving", 7: "Departed", 8: "TurnedAway" } as const;

/** `time` (scenario s of these counts) is exposed as data-time for the end-to-end tests. */
export function StateCounts({ counts, time, cars = false, leaving = false }: { counts: number[]; time: number; cars?: boolean; leaving?: boolean }) {
  return (
    <section className={card} aria-labelledby="states-heading" data-time={time}>
      <h2 id="states-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {strings.states.heading}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-sm">
        {(cars || leaving ? SHOWN_STATES_LEAVING : SHOWN_STATES).map((s) => {
          const shape = stateShape(s);
          return (
            <div key={s} className="contents">
              <span className="w-3">{shape && <ShapeIcon shape={shape.shape} color={shape.css} />}</span>
              <dt>{s === AgentState.Pending && cars ? strings.states.PendingWithCars : strings.states[STATE_KEYS[s]]}</dt>
              <dd className="text-right font-mono tabular-nums">{formatCount(counts[s] ?? 0)}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function LaneTable({ lanes, states, names, selected, onSelect }: { lanes: LaneLayout[]; states: LaneLive[]; names: Map<number, string>; selected: number | null; onSelect: (laneId: number) => void }) {
  const T = strings.lanes;
  const max = Math.max(1, ...states.map((s) => s.queueLength));
  return (
    <section className={card} aria-labelledby="lanes-heading">
      <h2 id="lanes-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {T.heading}
      </h2>
      <p className="mt-1 text-xs text-slate-500">{T.clickHint}</p>
      <table className="mt-2 w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>{T.laneColumn}</th>
            <th>{T.queueColumn}</th>
            <th>{T.statusColumn}</th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => {
            const s = states[lane.laneId];
            const q = s?.queueLength ?? 0;
            const status = s?.failed ? T.failed : s?.open ? T.open : T.closed;
            const isSel = selected === lane.laneId;
            return (
              <tr key={lane.laneId} className={isSel ? "bg-sky-50 dark:bg-sky-500/10" : ""}>
                <td className="py-0.5 pr-2">
                  <button type="button" aria-pressed={isSel} onClick={() => onSelect(lane.laneId)} className="text-left underline-offset-2 hover:underline">
                    {names.get(lane.laneId)}
                  </button>
                  {lane.manual && <ManualBadge />}
                </td>
                <td className="w-1/3 py-0.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded bg-slate-100 dark:bg-slate-800">
                      <div className="h-2 rounded bg-amber-500" style={{ width: `${(100 * q) / max}%` }} />
                    </div>
                    <span className="w-10 text-right font-mono tabular-nums">{q}</span>
                  </div>
                </td>
                <td className={`py-0.5 pl-2 text-right text-xs ${s?.failed ? "font-semibold text-orange-700 dark:text-orange-400" : "text-slate-500"}`}>
                  {s?.failed ? "✕ " : ""}
                  {status}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function ParametersList({ rows }: { rows: ParameterRow[] }) {
  const P = strings.parameters;
  return (
    <details className={card}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-500 dark:text-slate-400">{P.heading}</summary>
      <p className="mt-2 text-xs text-slate-500">{P.intro}</p>
      <dl className="mt-2 grid gap-1 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="flex flex-wrap justify-between gap-x-2">
            <dt className="text-slate-600 dark:text-slate-400">{r.label}</dt>
            <dd className="font-mono">
              {r.value}{" "}
              {r.assumed ? (
                <span className="rounded bg-amber-100 px-1 font-sans text-amber-900 dark:bg-amber-500/15 dark:text-amber-300">{P.assumed}</span>
              ) : (
                <span className="font-sans text-slate-400">({P.fromScenario})</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ClockDisplay({ time, clock, phase }: { time: number; clock: ClockInfo; phase?: EventPhase }) {
  const C = strings.clock;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <div className="flex items-baseline gap-3" aria-label={C.eventClock}>
        <span className="font-mono text-2xl font-bold tabular-nums">{formatRelativeClock(time, clock.anchor, clock.fixedStart)}</span>
        <span className="text-sm text-slate-500">
          {formatWallClock(clock.referenceClock, time, true)} · {clock.fixedStart ? C.relativeToStart : C.relativeToOpening}
        </span>
      </div>
      {phase && (
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${phase === "departures" ? "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-200" : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"}`} aria-label={C.phaseLabel} data-phase={phase}>
          {C.phases[phase]}
        </span>
      )}
    </div>
  );
}

export function ManualBadge() {
  return (
    <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-800 dark:text-slate-300" title={strings.lanes.manualHint}>
      {strings.lanes.manualBadge}
    </span>
  );
}

/** Capacity in people per hour next to peak demand per hour, and when the crunch ends (review E1). */
export function CapacityTable({ elements, names, clock, onAddLane, addDisabled }: { elements: readonly ElementReport[]; names: (id: string) => string; clock: ClockInfo; onAddLane: (elementId: string) => void; addDisabled: boolean }) {
  const C = strings.capacity;
  return (
    <section className={card} aria-labelledby="capacity-heading">
      <h2 id="capacity-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {C.heading}
      </h2>
      <p className="mt-1 text-xs text-slate-500">{C.intro}</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-2 font-normal">{C.element}</th>
              <th className="py-1 pr-2 text-right font-normal">{C.lanes}</th>
              <th className="py-1 pr-2 text-right font-normal">
                {C.capacity} {C.perHour}
              </th>
              <th className="py-1 pr-2 text-right font-normal">
                {C.peakDemand} {C.perHour}
              </th>
              <th className="py-1 pr-2 text-right font-normal">{C.peakUtilisation}</th>
              <th className="py-1 pr-2 font-normal">{C.below85}</th>
              <th className="py-1 font-normal">
                <span className="sr-only">{C.addLane}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {elements.map((e) => {
              const over = e.peakDemandPerHour > e.capacityPerHour;
              const below = e.below85At !== null ? formatRelativeClock(e.below85At, clock.anchor, clock.fixedStart) : e.peakUtilisation < 0.85 ? C.neverAbove : C.notYet;
              return (
                <tr key={e.elementId} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1 pr-2">{names(e.elementId)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{e.laneCount}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{formatCount(e.capacityPerHour)}</td>
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${over ? "font-semibold text-orange-700 dark:text-orange-400" : ""}`}>{formatCount(e.peakDemandPerHour)}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums">{formatPercent(e.peakUtilisation)}</td>
                  <td className="py-1 pr-2 font-mono tabular-nums">{below}</td>
                  <td className="py-1 text-right">
                    <button type="button" className={btnSmall} onClick={() => onAddLane(e.elementId)} disabled={addDisabled} aria-label={`${C.addLaneLabel} ${names(e.elementId)}`} title={strings.worstLane.addLaneHint}>
                      {C.addLane}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface PeriodRow {
  started: number;
  meanWait: number;
  p95Wait: number;
  queueWait: { mean: number; p95: number };
  utilisation: number;
}

function PeriodCells({ p }: { p: PeriodRow }) {
  return (
    <>
      <td className="py-0.5 pr-2 text-right">{formatCount(p.started)}</td>
      <td className="py-0.5 pr-2 text-right">
        {formatDuration(p.meanWait)} / {formatDuration(p.p95Wait)}
      </td>
      <td className="py-0.5 pr-2 text-right">
        {formatDuration(p.queueWait.mean)} / {formatDuration(p.queueWait.p95)}
      </td>
      <td className="py-0.5 text-right">{formatPercent(p.utilisation)}</td>
    </>
  );
}

/** Waits before and after the start, from choosing the lane and from joining the line (spec 4.5). */
export function LaneWaits({ report }: { report: LaneReport }) {
  const W = strings.laneWaits;
  const m = report.metrics;
  const periods: { label: string; p: LanePeriod }[] = [];
  if (report.beforeStart) periods.push({ label: W.beforeStart, p: report.beforeStart });
  if (report.afterStart) periods.push({ label: W.afterStart, p: report.afterStart });
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left font-mono text-xs tabular-nums">
        <caption className="text-left font-sans text-xs font-medium text-slate-600 dark:text-slate-400">{W.heading}</caption>
        <thead className="font-sans text-slate-500">
          <tr>
            <th className="py-0.5 pr-2 font-normal">{W.period}</th>
            <th className="py-0.5 pr-2 text-right font-normal">{W.started}</th>
            <th className="py-0.5 pr-2 text-right font-normal">{W.wait}</th>
            <th className="py-0.5 pr-2 text-right font-normal">{W.queueWait}</th>
            <th className="py-0.5 text-right font-normal">{W.utilisation}</th>
          </tr>
        </thead>
        <tbody>
          {periods.map(({ label, p }) => (
            <tr key={label}>
              <td className="py-0.5 pr-2 font-sans">{label}</td>
              <PeriodCells p={p} />
            </tr>
          ))}
          <tr className="border-t border-slate-200 dark:border-slate-700">
            <td className="py-0.5 pr-2 font-sans">{W.wholeRun}</td>
            <PeriodCells p={{ started: m.started, meanWait: m.meanWait, p95Wait: m.p95Wait, queueWait: report.queueWait, utilisation: m.utilisation }} />
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-xs text-slate-500">{W.note}</p>
    </div>
  );
}
