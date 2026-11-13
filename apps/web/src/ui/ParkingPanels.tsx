import { AgentState } from "@bottleneck/engine";
import { CAR_STYLES, type CarShape } from "../render/palette.ts";
import { formatCount, formatDuration, formatPercent, formatRelativeClock } from "../sim/format.ts";
import { CAR_STATES, carsOnSite, type BarrierRow, type LotRow, type ParkingHeadlines } from "../sim/parking.ts";
import { strings } from "../strings.ts";
import type { ClockInfo } from "./Panels.tsx";
import { btnSmall, card } from "./styles.ts";

/** Small SVG of a car marker, matching the renderer's shapes (nose to the right). */
export function CarIcon({ shape, color }: { shape: CarShape; color: string }) {
  let el;
  switch (shape) {
    case "arrow":
      el = <polygon points="1,2 12,2 17,6 12,10 1,10" fill={color} />;
      break;
    case "stopped":
      el = (
        <>
          <rect x="1" y="2" width="16" height="8" fill={color} />
          <rect x="6" y="3.5" width="1.6" height="5" fill="#fff" />
          <rect x="10" y="3.5" width="1.6" height="5" fill="#fff" />
        </>
      );
      break;
    case "parked":
      el = <rect x="1" y="2" width="16" height="8" rx="1.5" fill={color} opacity="0.85" />;
      break;
    case "striped":
      el = (
        <>
          <polygon points="1,2 12,2 17,6 12,10 1,10" fill={color} />
          <rect x="2.5" y="5.2" width="9" height="1.6" fill="#fff" />
        </>
      );
      break;
  }
  return (
    <svg aria-hidden="true" width="18" height="12" viewBox="0 0 18 12" className="inline-block shrink-0">
      {el}
    </svg>
  );
}

const carStyle = (key: string) => CAR_STYLES.find((s) => s.key === key);

function carIconFor(state: number) {
  const key = state === AgentState.Driving ? "CarDriving" : state === AgentState.Parked ? "CarParked" : state === AgentState.Diverted ? "CarDiverted" : null;
  const s = key ? carStyle(key) : undefined;
  return s ? <CarIcon shape={s.shape} color={s.css} /> : null;
}

const CAR_STATE_KEYS = { [AgentState.Pending]: "Pending", [AgentState.Driving]: "Driving", [AgentState.Diverted]: "Diverted", [AgentState.Parked]: "Parked", [AgentState.Departed]: "Departed", [AgentState.TurnedAway]: "TurnedAway" } as const;

/** Cars per state. The rows carry data-car-state for the end-to-end tests. */
export function CarCounts({ counts }: { counts: number[] }) {
  const C = strings.cars;
  return (
    <section className={card} aria-labelledby="cars-heading">
      <h2 id="cars-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {C.heading}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-sm">
        {CAR_STATES.map((s) => (
          <div key={s} className="contents" data-car-state={CAR_STATE_KEYS[s]}>
            <span className="w-5">{carIconFor(s)}</span>
            <dt>{C[CAR_STATE_KEYS[s]]}</dt>
            <dd className="text-right font-mono tabular-nums">{formatCount(counts[s] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-xs text-slate-500" data-cars-on-site={carsOnSite(counts)}>
        {formatCount(carsOnSite(counts))} {C.onSite}
      </p>
    </section>
  );
}

/** The parking headline numbers (spec 4.4, 4.5): time until empty, exit and entry queues, cars turned away. */
export function ParkingHeadlineCard({ h, names, clock }: { h: ParkingHeadlines; names: (id: string) => string; clock: ClockInfo }) {
  const H = strings.parkingHeadline;
  const t = h.timeToEmpty;
  const empty = t.status === "empty" && t.seconds !== null ? formatDuration(t.seconds) : t.status === "notYet" ? H.notYet : t.status === "notEmpty" ? H.notEmpty : H.noDepartures;
  const when = (at: number) => formatRelativeClock(at, clock.anchor, clock.fixedStart);
  return (
    <section className={card} aria-labelledby="parking-headline-heading">
      <h2 id="parking-headline-heading" className="sr-only">
        {strings.lots.heading}
      </h2>
      <dl className="grid gap-3">
        <div data-headline="timeToEmpty" data-status={t.status}>
          <dt className="text-xs text-slate-600 dark:text-slate-400">{H.timeToEmpty}</dt>
          <dd className="text-2xl font-bold tabular-nums">{empty}</dd>
          {t.lotId && t.status === "empty" && <dd className="text-xs text-slate-500">{names(t.lotId)}</dd>}
        </div>
        {h.longestExitQueue && (
          <div data-headline="longestExitQueue">
            <dt className="text-xs text-slate-600 dark:text-slate-400">{H.longestExitQueue}</dt>
            <dd className="text-xl font-bold tabular-nums">
              {formatCount(h.longestExitQueue.metres)} m · {formatCount(h.longestExitQueue.cars)} {H.cars}
            </dd>
            <dd className="text-xs text-slate-500">
              {names(h.longestExitQueue.barrierId)}
              {h.longestExitQueue.at !== null && h.longestExitQueue.cars > 0 ? `, ${when(h.longestExitQueue.at)}` : ""}
            </dd>
          </div>
        )}
        {h.longestEntryQueue && (
          <div data-headline="longestEntryQueue">
            <dt className="text-xs text-slate-600 dark:text-slate-400">{H.longestEntryQueue}</dt>
            <dd className="text-xl font-bold tabular-nums">
              {formatCount(h.longestEntryQueue.metres)} m · {formatCount(h.longestEntryQueue.cars)} {H.cars}
            </dd>
            <dd className={`text-xs ${h.entryReachedPublicRoad ? "font-semibold text-orange-700 dark:text-orange-400" : "text-slate-500"}`}>
              {h.entryReachedPublicRoad ? `▲ ${names(h.entryReachedPublicRoad.barrierId)}: ${H.reachedPublicRoad} ${when(h.entryReachedPublicRoad.at)}` : H.stayedOnSite}
            </dd>
          </div>
        )}
        <div data-headline="turnedAway">
          <dt className="text-xs text-slate-600 dark:text-slate-400">{H.turnedAway}</dt>
          <dd className="text-xl font-bold tabular-nums">
            {formatCount(h.turnedAwayCars)} / {formatCount(h.divertedCars)} {H.cars}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function LotTable({ rows, onClose, closeDisabled, onCharts, chartsFor }: { rows: LotRow[]; onClose: (lotId: string) => void; closeDisabled: boolean; onCharts: (lotId: string) => void; chartsFor: string | null }) {
  const T = strings.lots;
  return (
    <section className={card} aria-labelledby="lots-heading">
      <h2 id="lots-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {T.heading}
      </h2>
      <table className="mt-2 w-full text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="py-1 pr-2 text-left font-normal">{T.lot}</th>
            <th className="py-1 pr-2 text-right font-normal">{T.used}</th>
            <th className="py-1 font-normal">
              <span className="sr-only">{T.closeNow}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.lotId} className="border-t border-slate-100 align-top dark:border-slate-800" data-lot={r.lotId}>
              <td className="py-1 pr-2">
                <div>{r.name}</div>
                <div className={`text-xs ${r.closed ? "font-semibold text-orange-700 dark:text-orange-400" : "text-slate-500"}`}>
                  {r.closed ? `✕ ${T.closed}` : T.open}
                  {r.maxOccupancy !== null && ` · ${formatCount(r.maxOccupancy)} ${T.maxOccupancy}`}
                  {r.turnedAway !== null && r.turnedAway > 0 && ` · ${formatCount(r.turnedAway)} ${T.turnedAway}`}
                </div>
              </td>
              <td className="py-1 pr-2 text-right">
                <div className="font-mono tabular-nums" data-lot-used={r.occupied}>
                  {formatCount(r.occupied)} / {formatCount(r.stalls)}
                </div>
                <div className="mt-0.5 h-2 w-full rounded bg-slate-100 dark:bg-slate-800">
                  <div className="h-2 rounded bg-slate-500" style={{ width: `${Math.min(100, 100 * r.share)}%` }} />
                </div>
                <div className="text-xs text-slate-500">
                  {formatPercent(r.share)} · {formatCount(r.free)} {T.free}
                </div>
              </td>
              <td className="py-1 text-right">
                <div className="flex flex-col items-end gap-1">
                  <button type="button" className={btnSmall} onClick={() => onClose(r.lotId)} disabled={closeDisabled || r.closed} title={T.closeHint}>
                    {T.closeNow}
                  </button>
                  <button type="button" className={btnSmall} aria-pressed={chartsFor === r.lotId} onClick={() => onCharts(r.lotId)}>
                    {chartsFor === r.lotId ? T.hideCharts : T.charts}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-slate-500">{T.closeHint}</p>
    </section>
  );
}

export function BarrierTable({ rows, clock, onCharts, chartsFor }: { rows: BarrierRow[]; clock: ClockInfo; onCharts: (barrierId: string) => void; chartsFor: string | null }) {
  const T = strings.barriers;
  return (
    <section className={card} aria-labelledby="barriers-heading">
      <h2 id="barriers-heading" className="text-sm font-semibold text-slate-500 dark:text-slate-400">
        {T.heading}
      </h2>
      <table className="mt-2 w-full text-sm">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="py-1 pr-2 text-left font-normal">{T.barrier}</th>
            <th className="py-1 pr-2 text-right font-normal">{T.waiting}</th>
            <th className="py-1 pr-2 text-right font-normal">{T.maxQueue}</th>
            <th className="py-1 font-normal">
              <span className="sr-only">{strings.lots.charts}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.barrierId} className="border-t border-slate-100 align-top dark:border-slate-800" data-barrier={r.barrierId}>
              <td className="py-1 pr-2">
                <div>{r.name}</div>
                <div className="text-xs text-slate-500">
                  {r.kind === "entry" ? T.entry : T.exit} · {r.busyLanes}/{r.laneCount} {T.busy}
                </div>
                <div className={`text-xs ${r.reachedPublicRoadAt !== null ? "font-semibold text-orange-700 dark:text-orange-400" : "text-slate-500"}`}>
                  {T.reachedPublicRoad}: {r.reachedPublicRoadAt !== null ? `▲ ${T.yesAt} ${formatRelativeClock(r.reachedPublicRoadAt, clock.anchor, clock.fixedStart)}` : T.no}
                </div>
              </td>
              <td className="py-1 pr-2 text-right font-mono tabular-nums" data-barrier-waiting={r.waiting}>
                {formatCount(r.waiting)}
              </td>
              <td className="py-1 pr-2 text-right font-mono text-xs tabular-nums">
                {r.maxQueueMetres !== null ? `${formatCount(r.maxQueueMetres)} ${T.metres}` : "–"}
                <br />
                {r.maxQueueCars !== null ? `${formatCount(r.maxQueueCars)} ${T.cars}` : ""}
              </td>
              <td className="py-1 text-right">
                <button type="button" className={btnSmall} aria-pressed={chartsFor === r.barrierId} onClick={() => onCharts(r.barrierId)}>
                  {chartsFor === r.barrierId ? strings.lots.hideCharts : strings.lots.charts}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-slate-500">{T.note}</p>
    </section>
  );
}
