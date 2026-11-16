import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentState,
  type LaneLayout,
  type LaneLive,
  type LaneReport,
} from "@bottleneck/engine";
import type { ElementReport, LanePeriod } from "@bottleneck/schema";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeClock,
  formatWallClock,
} from "../sim/format.ts";
import type { Headline, HeadlineKind } from "../sim/headline.ts";
import type { ParameterRow } from "../sim/parameters.ts";
import type { EventPhase } from "../sim/parking.ts";
import { strings } from "../strings.ts";
import { IconChevron } from "./icons.tsx";
import { ShapeIcon, stateShape } from "./Legend.tsx";
import { btnSmall, cardHint, cardTitle } from "./styles.ts";

/**
 * A card in the inspector: a title, an optional hint, and its content. Collapsible ones use
 * <details>, so they work without JavaScript and keyboard users get the native disclosure.
 */
export function Section({
  id,
  title,
  hint,
  right,
  collapsible = false,
  defaultOpen = true,
  className = "",
  children,
  ...rest
}: {
  id: string;
  title: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children?: ReactNode;
} & Record<`data-${string}`, unknown>) {
  const heading = (
    <h2 id={id} className={cardTitle}>
      {title}
    </h2>
  );
  if (!collapsible)
    return (
      <section
        className={`${cardBase} p-3.5 ${className}`}
        aria-labelledby={id}
        {...rest}
      >
        <div className="flex items-center gap-2">
          {heading}
          {right && <div className="ml-auto">{right}</div>}
        </div>
        {hint && <p className={cardHint}>{hint}</p>}
        {children}
      </section>
    );
  return (
    <section
      className={`${cardBase} ${className}`}
      aria-labelledby={id}
      {...rest}
    >
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-3.5 py-3 select-none hover:bg-sunken/50">
          <IconChevron className="chevron text-subtle transition-transform" />
          {heading}
          {right && <div className="ml-auto">{right}</div>}
        </summary>
        <div className="px-3.5 pb-3.5">
          {hint && <p className={`${cardHint} mt-0 mb-2`}>{hint}</p>}
          {children}
        </div>
      </details>
    </section>
  );
}

const cardBase = "rounded-xl border border-line bg-surface";

export interface ClockInfo {
  anchor: number;
  fixedStart: boolean;
  referenceClock: string;
}

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

function headlineText(
  h: Headline,
  clock: ClockInfo,
): { label: string; value: string } {
  const H = strings.headline;
  switch (h.kind) {
    case "stillOutside":
      return h.final
        ? {
            label: H.stillOutsideFinal,
            value: `${formatCount(h.value)} ${H.people}`,
          }
        : {
            label: `${H.stillOutsideSoFar} ${formatWallClock(clock.referenceClock, h.at ?? 0)})`,
            value: `${formatCount(h.value)} ${H.people}`,
          };
    case "p95PeakWait":
      return {
        label: h.final ? H.p95PeakWait : `${H.p95PeakWait} (${H.soFar})`,
        value: formatDuration(h.value),
      };
    case "shareInside":
      return {
        label: `${H.shareInside} ${formatWallClock(clock.referenceClock, h.at ?? 0)}${h.final ? "" : ` (${H.soFar})`}`,
        value: formatPercent(h.value),
      };
  }
}

/** Headline numbers. The visible numbers update live; the screen-reader copy at most every 15 s. */
export function Headlines({
  items,
  clock,
}: {
  items: Headline[];
  clock: ClockInfo;
}) {
  const texts = items.map((h) => headlineText(h, clock));
  const spoken = texts.map((t) => `${t.label}: ${t.value}`).join(". ");
  const latest = useRef(spoken);
  useEffect(() => {
    latest.current = spoken;
  }, [spoken]);
  const [announced, setAnnounced] = useState(spoken);
  useEffect(() => {
    const id = setInterval(
      () =>
        setAnnounced((prev) =>
          prev === latest.current ? prev : latest.current,
        ),
      15000,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <Section id="headline-heading" title={strings.headline.heading}>
      <dl className="mt-3 grid gap-4">
        {texts.map((t, k) => {
          const split = items[k]?.split;
          return (
            <div key={t.label}>
              <dt className="text-xs text-muted">{t.label}</dt>
              <dd
                className={`${k === 0 ? "text-[30px]" : "text-2xl"} mt-0.5 leading-tight font-semibold tracking-tight tabular`}
              >
                {t.value}
              </dd>
              {split && (
                <dd className="mt-0.5 text-xs text-muted tabular">
                  {formatCount(split.onSite)} {strings.headline.onSite} ·{" "}
                  {formatCount(split.notArrived)} {strings.headline.notArrived}
                </dd>
              )}
            </div>
          );
        })}
      </dl>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </p>
    </Section>
  );
}

export function WorstLane({
  name,
  queue,
  onAddLane,
  addDisabled,
}: {
  name: string | null;
  queue: number;
  onAddLane?: () => void;
  addDisabled?: boolean;
}) {
  const W = strings.worstLane;
  const calm = name === null;
  return (
    <section
      className={`${cardBase} relative overflow-hidden p-3.5 pl-4 text-sm`}
      aria-labelledby="worst-lane-heading"
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 ${calm ? "bg-ok" : "bg-warn"}`}
        aria-hidden="true"
      />
      <h2 id="worst-lane-heading" className="text-xs font-medium text-muted">
        {W.heading}
      </h2>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {calm ? W.none : `${name}: ${formatCount(queue)} ${W.queue}`}
        </p>
        {!calm && onAddLane && (
          <button
            type="button"
            className={btnSmall}
            onClick={onAddLane}
            disabled={addDisabled}
            title={W.addLaneHint}
          >
            {W.addLane}
          </button>
        )}
      </div>
    </section>
  );
}

const SHOWN_STATES = [
  AgentState.Pending,
  AgentState.Walking,
  AgentState.Queuing,
  AgentState.InService,
  AgentState.Inside,
  AgentState.TurnedAway,
] as const;
/** With cars or departures, people can also be in a car on the way out, or gone. */
const SHOWN_STATES_LEAVING = [
  AgentState.Pending,
  AgentState.Walking,
  AgentState.Queuing,
  AgentState.InService,
  AgentState.Inside,
  AgentState.Driving,
  AgentState.Departed,
  AgentState.TurnedAway,
] as const;
const STATE_KEYS = {
  0: "Pending",
  1: "Walking",
  2: "Queuing",
  3: "InService",
  4: "Inside",
  5: "Driving",
  7: "Departed",
  8: "TurnedAway",
} as const;

/** `time` (scenario s of these counts) is exposed as data-time for the end-to-end tests. */
export function StateCounts({
  counts,
  time,
  cars = false,
  leaving = false,
}: {
  counts: number[];
  time: number;
  cars?: boolean;
  leaving?: boolean;
}) {
  return (
    <Section
      id="states-heading"
      title={strings.states.heading}
      collapsible
      data-time={time}
    >
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-sm">
        {(cars || leaving ? SHOWN_STATES_LEAVING : SHOWN_STATES).map((s) => {
          const shape = stateShape(s);
          return (
            <div key={s} className="contents">
              <span className="w-3">
                {shape && <ShapeIcon shape={shape.shape} color={shape.css} />}
              </span>
              <dt>
                {s === AgentState.Pending && cars
                  ? strings.states.PendingWithCars
                  : strings.states[STATE_KEYS[s]]}
              </dt>
              <dd className="text-right tabular">
                {formatCount(counts[s] ?? 0)}
              </dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

export function LaneTable({
  lanes,
  states,
  names,
  selected,
  onSelect,
}: {
  lanes: LaneLayout[];
  states: LaneLive[];
  names: Map<number, string>;
  selected: number | null;
  onSelect: (laneId: number) => void;
}) {
  const T = strings.lanes;
  const max = Math.max(1, ...states.map((s) => s.queueLength));
  return (
    <Section
      id="lanes-heading"
      title={T.heading}
      hint={T.clickHint}
      collapsible
      right={
        <span className="text-xs text-subtle tabular">{lanes.length}</span>
      }
    >
      <table className="w-full text-sm">
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
              <tr key={lane.laneId} className={isSel ? "bg-info-soft" : ""}>
                <td className="py-1 pr-2">
                  <button
                    type="button"
                    aria-pressed={isSel}
                    onClick={() => onSelect(lane.laneId)}
                    className="text-left text-[13px] underline-offset-2 hover:underline"
                  >
                    {names.get(lane.laneId)}
                  </button>
                  {lane.manual && <ManualBadge />}
                </td>
                <td className="w-1/3 py-0.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-sunken">
                      <div
                        className="h-1.5 rounded-full bg-accent"
                        style={{ width: `${(100 * q) / max}%` }}
                      />
                    </div>
                    <span className="w-8 text-right tabular">{q}</span>
                  </div>
                </td>
                <td
                  className={`py-0.5 pl-2 text-right text-xs ${s?.failed ? "font-semibold text-bad" : "text-subtle"}`}
                >
                  {s?.failed ? "✕ " : ""}
                  {status}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

export function ParametersList({ rows }: { rows: ParameterRow[] }) {
  const P = strings.parameters;
  return (
    <Section
      id="parameters-heading"
      title={P.heading}
      hint={P.intro}
      collapsible
      defaultOpen={false}
    >
      <dl className="grid gap-1 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="flex flex-wrap justify-between gap-x-2">
            <dt className="text-muted">{r.label}</dt>
            <dd className="font-mono">
              {r.value}{" "}
              {r.assumed ? (
                <span className="rounded bg-warn-soft px-1 font-sans text-warn">
                  {P.assumed}
                </span>
              ) : (
                <span className="font-sans text-subtle">
                  ({P.fromScenario})
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function ClockDisplay({
  time,
  clock,
  phase,
}: {
  time: number;
  clock: ClockInfo;
  phase?: EventPhase;
}) {
  const C = strings.clock;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <div className="flex items-baseline gap-3" aria-label={C.eventClock}>
        <span className="font-mono text-2xl font-bold tabular-nums">
          {formatRelativeClock(time, clock.anchor, clock.fixedStart)}
        </span>
        <span className="text-sm text-subtle">
          {formatWallClock(clock.referenceClock, time, true)} ·{" "}
          {clock.fixedStart ? C.relativeToStart : C.relativeToOpening}
        </span>
      </div>
      {phase && (
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${phase === "departures" ? "bg-sky-100 text-sky-900 dark:text-sky-200" : "bg-sunken text-muted"}`}
          aria-label={C.phaseLabel}
          data-phase={phase}
        >
          {C.phases[phase]}
        </span>
      )}
    </div>
  );
}

export function ManualBadge() {
  return (
    <span
      className="ml-1 rounded bg-sunken px-1 text-[10px] font-semibold tracking-wide text-muted uppercase"
      title={strings.lanes.manualHint}
    >
      {strings.lanes.manualBadge}
    </span>
  );
}

/** Capacity in people per hour next to peak demand per hour, and when the crunch ends (review E1). */
export function CapacityTable({
  elements,
  names,
  clock,
  onAddLane,
  addDisabled,
}: {
  elements: readonly ElementReport[];
  names: (id: string) => string;
  clock: ClockInfo;
  onAddLane: (elementId: string) => void;
  addDisabled: boolean;
}) {
  const C = strings.capacity;
  return (
    <Section id="capacity-heading" title={C.heading} hint={C.intro} collapsible>
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>{C.element}</th>
            <th>{C.capacity}</th>
            <th>{C.addLane}</th>
          </tr>
        </thead>
        <tbody>
          {elements.map((e) => {
            const over = e.peakDemandPerHour > e.capacityPerHour;
            const load =
              e.capacityPerHour > 0
                ? e.peakDemandPerHour / e.capacityPerHour
                : 0;
            const below =
              e.below85At !== null
                ? formatRelativeClock(
                    e.below85At,
                    clock.anchor,
                    clock.fixedStart,
                  )
                : e.peakUtilisation < 0.85
                  ? C.neverAbove
                  : C.notYet;
            return (
              <tr
                key={e.elementId}
                className="border-t border-line first:border-t-0"
              >
                <td className="py-2.5 pr-2 align-top">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium">
                      {names(e.elementId)}
                    </span>
                    <span className="text-xs text-subtle tabular">
                      {e.laneCount} {C.lanes.toLowerCase()}
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 rounded-full bg-sunken"
                    title={`${C.peakDemand} / ${C.capacity}`}
                  >
                    <div
                      className={`h-1.5 rounded-full ${over ? "bg-bad" : load >= 0.85 ? "bg-warn" : "bg-ok"}`}
                      style={{ width: `${Math.min(100, 100 * load)}%` }}
                    />
                  </div>
                  <dl className="mt-1.5 grid grid-cols-3 gap-x-2 text-[11px] text-muted">
                    <div>
                      <dt className="text-subtle">{C.capacity}</dt>
                      <dd className="text-fg tabular">
                        {formatCount(e.capacityPerHour)}
                        <span className="text-subtle">{C.perHour}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-subtle">{C.peakDemand}</dt>
                      <dd
                        className={`tabular ${over ? "font-semibold text-bad" : "text-fg"}`}
                      >
                        {formatCount(e.peakDemandPerHour)}
                        <span className="text-subtle">{C.perHour}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-subtle">{C.peakUtilisation}</dt>
                      <dd className="text-fg tabular">
                        {formatPercent(e.peakUtilisation)}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-1 text-[11px] text-subtle">
                    {C.below85}:{" "}
                    <span className="text-muted tabular">{below}</span>
                  </p>
                </td>
                <td className="w-14 py-2.5 text-right align-top">
                  <button
                    type="button"
                    className={btnSmall}
                    onClick={() => onAddLane(e.elementId)}
                    disabled={addDisabled}
                    aria-label={`${C.addLaneLabel} ${names(e.elementId)}`}
                    title={strings.worstLane.addLaneHint}
                  >
                    {C.addLane}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
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
  if (report.beforeStart)
    periods.push({ label: W.beforeStart, p: report.beforeStart });
  if (report.afterStart)
    periods.push({ label: W.afterStart, p: report.afterStart });
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left font-mono text-xs tabular-nums">
        <caption className="text-left font-sans text-xs font-medium text-muted">
          {W.heading}
        </caption>
        <thead className="font-sans text-subtle">
          <tr>
            <th className="py-0.5 pr-2 font-normal">{W.period}</th>
            <th className="py-0.5 pr-2 text-right font-normal">{W.started}</th>
            <th className="py-0.5 pr-2 text-right font-normal">{W.wait}</th>
            <th className="py-0.5 pr-2 text-right font-normal">
              {W.queueWait}
            </th>
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
          <tr className="border-t border-line">
            <td className="py-0.5 pr-2 font-sans">{W.wholeRun}</td>
            <PeriodCells
              p={{
                started: m.started,
                meanWait: m.meanWait,
                p95Wait: m.p95Wait,
                queueWait: report.queueWait,
                utilisation: m.utilisation,
              }}
            />
          </tr>
        </tbody>
      </table>
      <p className="mt-1 text-xs text-subtle">{W.note}</p>
    </div>
  );
}
