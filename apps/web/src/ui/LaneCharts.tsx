import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { LaneReport } from "@bottleneck/engine";
import { formatRelativeClock } from "../sim/format.ts";
import { laneSeries, type ChartSeries } from "../sim/series.ts";
import { strings } from "../strings.ts";
import { LaneWaits, ManualBadge } from "./Panels.tsx";

function Chart({ title, series, anchor, fixedStart, color, bars, unit }: { title: string; series: ChartSeries; anchor: number; fixedStart: boolean; color: string; bars?: boolean; unit: string }) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const axisColor = dark ? "#cbd5e1" : "#334155";
    const grid = { stroke: dark ? "#334155" : "#e2e8f0", width: 1 };
    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height: 150,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, Math.max(1, max * 1.1)] } },
      axes: [
        { stroke: axisColor, grid, values: (_u, splits) => splits.map((s) => formatRelativeClock(s, anchor, fixedStart)), space: 70 },
        { stroke: axisColor, grid, size: 40 },
      ],
      series: [
        {},
        {
          label: unit,
          stroke: color,
          width: 1.5,
          fill: `${color}33`,
          ...(bars ? { paths: uPlot.paths.bars?.({ size: [0.9, 40] }) } : {}),
        },
      ],
    };
    const p = new uPlot(opts, [[], []], el);
    plot.current = p;
    const ro = new ResizeObserver(() => p.setSize({ width: Math.max(200, el.clientWidth), height: 150 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      p.destroy();
      plot.current = null;
    };
  }, [anchor, fixedStart, color, bars, unit]);

  useEffect(() => {
    plot.current?.setData([series.x, series.y]);
  }, [series]);

  return (
    <figure className="mt-3">
      <figcaption className="text-xs font-medium text-slate-600 dark:text-slate-400">{title}</figcaption>
      <div ref={host} className="w-full" />
    </figure>
  );
}

export function LaneCharts({ name, report, startTime, queueInterval, binSeconds, anchor, fixedStart, onClose }: { name: string; report: LaneReport; startTime: number; queueInterval: number; binSeconds: number; anchor: number; fixedStart: boolean; onClose: () => void }) {
  const C = strings.charts;
  const { queue, throughput } = laneSeries(report, startTime, queueInterval, binSeconds);
  // Table alternative (review C6): one row per 5 minutes.
  const rows: { t: number; q: number; th: number }[] = [];
  const stepQ = Math.max(1, Math.round(300 / queueInterval));
  for (let k = stepQ - 1; k < queue.y.length; k += stepQ) {
    const t = queue.x[k] as number;
    const bin = Math.floor((t - startTime) / binSeconds) - 1;
    rows.push({ t, q: queue.y[k] as number, th: bin >= 0 ? ((throughput.y[bin] as number | undefined) ?? 0) : 0 });
  }
  return (
    <section aria-label={name} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {name}
          {report.laneType === "manual" && <ManualBadge />}
        </h3>
        <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-xs text-slate-600 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
          {C.close}
        </button>
      </div>
      <LaneWaits report={report} />
      <Chart title={C.queueTitle} series={queue} anchor={anchor} fixedStart={fixedStart} color="#E69F00" unit={C.people} />
      <Chart title={C.throughputTitle} series={throughput} anchor={anchor} fixedStart={fixedStart} color="#0072B2" bars unit={C.perMinute} />
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{C.tableSummary}</summary>
        <table className="mt-1 w-full text-left font-mono">
          <thead>
            <tr className="text-slate-500">
              <th className="font-normal">{C.time}</th>
              <th className="font-normal">{C.queue}</th>
              <th className="font-normal">{C.throughput}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t}>
                <td>{formatRelativeClock(r.t, anchor, fixedStart)}</td>
                <td>{r.q}</td>
                <td>{r.th}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
