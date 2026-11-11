import { useEffect, useRef, useState } from "react";
import { AgentState, type LaneLayout, type LaneLive } from "@bottleneck/engine";
import { formatCount, formatDuration, formatPercent, formatRelativeClock, formatWallClock } from "../sim/format.ts";
import type { Headline } from "../sim/headline.ts";
import type { ParameterRow } from "../sim/parameters.ts";
import { strings } from "../strings.ts";
import { ShapeIcon, stateShape } from "./Legend.tsx";

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900";

export interface ClockInfo {
  anchor: number;
  fixedStart: boolean;
  referenceClock: string;
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
        {texts.map((t) => (
          <div key={t.label}>
            <dt className="text-xs text-slate-600 dark:text-slate-400">{t.label}</dt>
            <dd className="text-2xl font-bold tabular-nums">{t.value}</dd>
          </div>
        ))}
      </dl>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </p>
    </section>
  );
}

export function WorstLane({ name, queue }: { name: string | null; queue: number }) {
  const W = strings.worstLane;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10" aria-labelledby="worst-lane-heading">
      <h2 id="worst-lane-heading" className="text-xs font-semibold text-amber-900 dark:text-amber-300">
        {W.heading}
      </h2>
      <p className="mt-1 font-medium">{name === null ? W.none : `${name}: ${formatCount(queue)} ${W.queue}`}</p>
    </section>
  );
}

const SHOWN_STATES = [AgentState.Pending, AgentState.Walking, AgentState.Queuing, AgentState.InService, AgentState.Inside, AgentState.TurnedAway] as const;
const STATE_KEYS = { 0: "Pending", 1: "Walking", 2: "Queuing", 3: "InService", 4: "Inside", 8: "TurnedAway" } as const;

export function StateCounts({ counts }: { counts: number[] }) {
  return (
    <section className={card} aria-labelledby="states-heading">
      <h2 id="states-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {strings.states.heading}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-sm">
        {SHOWN_STATES.map((s) => {
          const shape = stateShape(s);
          return (
            <div key={s} className="contents">
              <span className="w-3">{shape && <ShapeIcon shape={shape.shape} color={shape.css} />}</span>
              <dt>{strings.states[STATE_KEYS[s]]}</dt>
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

export function ClockDisplay({ time, clock }: { time: number; clock: ClockInfo }) {
  const C = strings.clock;
  return (
    <div className="flex items-baseline gap-3" aria-label={C.eventClock}>
      <span className="font-mono text-2xl font-bold tabular-nums">{formatRelativeClock(time, clock.anchor, clock.fixedStart)}</span>
      <span className="text-sm text-slate-500">
        {formatWallClock(clock.referenceClock, time, true)} · {clock.fixedStart ? C.relativeToStart : C.relativeToOpening}
      </span>
    </div>
  );
}
