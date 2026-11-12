import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { RunResult } from "../batchProtocol.ts";
import { alignSeries, chartElements, queueSamples, type OverlaySeries } from "../compare/chartData.ts";
import { formatRelativeClock } from "../sim/format.ts";
import { strings } from "../strings.ts";
import { input, labelText } from "./styles.ts";

/** Okabe–Ito colours plus a dash pattern each, so the series differ without colour too. */
const SERIES_STYLE = [
  { stroke: "#E69F00", dash: undefined },
  { stroke: "#0072B2", dash: [8, 4] },
  { stroke: "#009E73", dash: [2, 3] },
  { stroke: "#CC79A7", dash: [10, 3, 2, 3] },
];
const DASH_WORDS = ["solid", "dashed", "dotted", "dash-dot"];

/** Overlaid lines on a shared time axis (uPlot). Generic: also used for the scan-log arrival curve. */
export function OverlayChart({ data, labels, anchor, fixedStart, height = 220, unit }: { data: OverlaySeries; labels: string[]; anchor: number; fixedStart: boolean; height?: number; unit: string }) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const labelKey = labels.join("\n");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const axisColor = dark ? "#cbd5e1" : "#334155";
    const grid = { stroke: dark ? "#334155" : "#e2e8f0", width: 1 };
    const opts: uPlot.Options = {
      width: Math.max(240, el.clientWidth),
      height,
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, Math.max(1, max * 1.1)] } },
      axes: [
        { stroke: axisColor, grid, values: (_u, splits) => splits.map((s) => formatRelativeClock(s, anchor, fixedStart)), space: 70 },
        { stroke: axisColor, grid, size: 50, label: unit },
      ],
      series: [{ label: strings.charts2.time, value: (_u, v) => (v === null ? "–" : formatRelativeClock(v, anchor, fixedStart)) }, ...labelKey.split("\n").map((l, k) => ({ label: l, stroke: SERIES_STYLE[k % 4]?.stroke, width: 2, dash: SERIES_STYLE[k % 4]?.dash, spanGaps: false }))],
    };
    const p = new uPlot(opts, [[], ...labelKey.split("\n").map(() => [])], el);
    plot.current = p;
    const ro = new ResizeObserver(() => p.setSize({ width: Math.max(240, el.clientWidth), height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      p.destroy();
      plot.current = null;
    };
  }, [anchor, fixedStart, height, labelKey, unit]);

  useEffect(() => {
    plot.current?.setData([data.x, ...data.ys] as uPlot.AlignedData);
  }, [data]);

  return <div ref={host} className="w-full" />;
}

/** Queue length over time per element (or one lane), one line per scenario, with a table alternative. */
export function CompareCharts({ results, labels, names, anchor, fixedStart }: { results: (RunResult | null)[]; labels: string[]; names: (id: string) => string; anchor: number; fixedStart: boolean }) {
  const present = results.filter((r): r is RunResult => r !== null);
  const elements = useMemo(() => chartElements(present), [present]);
  const [elementId, setElementId] = useState<string | null>(null);
  const [lane, setLane] = useState<number | null>(null);
  const el = elements.find((e) => e.elementId === elementId) ?? elements.find((e) => e.kind === "gate") ?? elements[0];
  const data = useMemo(() => (el ? alignSeries(results.map((r) => (r ? queueSamples(r, el.elementId, lane) : { x: [], y: [] }))) : { x: [], ys: [] }), [results, el, lane]);
  if (!el) return null;

  // Table alternative (review C6): every 5 minutes.
  const step = Math.max(1, Math.round(300 / (present[0]?.queueSampleInterval ?? 10)));
  const rows: number[] = [];
  for (let k = step - 1; k < data.x.length; k += step) rows.push(k);

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <label className={labelText}>
          {strings.charts2.element}
          <select
            className={input}
            value={el.elementId}
            onChange={(e) => {
              setElementId(e.target.value);
              setLane(null);
            }}
          >
            {elements.map((e) => (
              <option key={e.elementId} value={e.elementId}>
                {names(e.elementId)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelText}>
          {strings.charts2.lane}
          <select className={input} value={lane ?? ""} onChange={(e) => setLane(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">{strings.charts2.allLanes}</option>
            {Array.from({ length: el.maxLanes }, (_, k) => (
              <option key={k} value={k}>
                {strings.lanes.lane} {k + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-500">{labels.map((l, k) => `${l}: ${DASH_WORDS[k % 4]}`).join(" · ")}</p>
      <OverlayChart data={data} labels={labels} anchor={anchor} fixedStart={fixedStart} unit={strings.charts.people} />
      <details className="text-xs">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{strings.charts2.tableSummary}</summary>
        <table className="mt-1 w-full text-left font-mono tabular-nums">
          <thead>
            <tr className="text-slate-500">
              <th className="font-normal">{strings.charts2.time}</th>
              {labels.map((l, k) => (
                <th key={k} className="text-right font-normal">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k}>
                <td>{formatRelativeClock(data.x[k] as number, anchor, fixedStart)}</td>
                {data.ys.map((y, i) => (
                  <td key={i} className="text-right">
                    {y[k] ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
