import type { BarrierLaneReport, LotReport } from "@bottleneck/schema";
import { formatRelativeClock } from "../sim/format.ts";
import { barrierQueueSeries, lotOccupancySeries } from "../sim/parking.ts";
import type { ChartSeries } from "../sim/series.ts";
import { strings } from "../strings.ts";
import { Chart } from "./LaneCharts.tsx";

/** Table alternative to a chart (review C6): one row every `every` samples. */
function SeriesTable({ series, every, anchor, fixedStart, unit }: { series: ChartSeries; every: number; anchor: number; fixedStart: boolean; unit: string }) {
  const rows: { t: number; v: number }[] = [];
  for (let k = every - 1; k < series.x.length; k += every) rows.push({ t: series.x[k] as number, v: series.y[k] as number });
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{strings.charts.tableSummary}</summary>
      <table className="mt-1 w-full text-left font-mono">
        <thead>
          <tr className="text-slate-500">
            <th className="font-normal">{strings.charts.time}</th>
            <th className="font-normal">{unit}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <td>{formatRelativeClock(r.t, anchor, fixedStart)}</td>
              <td>{r.v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function LotChart({ name, report, startTime, binSeconds, anchor, fixedStart }: { name: string; report: LotReport; startTime: number; binSeconds: number; anchor: number; fixedStart: boolean }) {
  const series = lotOccupancySeries(report, startTime, binSeconds);
  return (
    <section aria-label={`${name}: ${strings.lots.occupancyTitle}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="text-sm font-semibold">{name}</h3>
      <Chart title={`${strings.lots.occupancyTitle} (${report.stalls} ${strings.parameters.labels.stalls})`} series={series} anchor={anchor} fixedStart={fixedStart} color="#64748B" unit={strings.lots.cars} />
      <SeriesTable series={series} every={Math.max(1, Math.round(300 / binSeconds))} anchor={anchor} fixedStart={fixedStart} unit={strings.lots.cars} />
    </section>
  );
}

export function BarrierChart({ name, barrierId, lanes, startTime, queueInterval, anchor, fixedStart }: { name: string; barrierId: string; lanes: readonly BarrierLaneReport[]; startTime: number; queueInterval: number; anchor: number; fixedStart: boolean }) {
  const series = barrierQueueSeries(lanes, barrierId, startTime, queueInterval);
  return (
    <section aria-label={`${name}: ${strings.barriers.queueTitle}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="text-sm font-semibold">{name}</h3>
      <Chart title={strings.barriers.queueTitle} series={series} anchor={anchor} fixedStart={fixedStart} color="#E69F00" unit={strings.barriers.cars} />
      <SeriesTable series={series} every={Math.max(1, Math.round(300 / queueInterval))} anchor={anchor} fixedStart={fixedStart} unit={strings.barriers.cars} />
    </section>
  );
}
