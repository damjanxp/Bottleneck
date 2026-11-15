import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { laneSweepChart, type LaneSweepResult } from "../api/jobs.ts";
import { strings } from "../strings.ts";

const J = strings.share.jobs;

/**
 * Lane sweep: the target metric (minutes) against the lane count, the mean with its 95% CI as
 * vertical bars, the target as a dashed line, and the smallest count that meets the target
 * circled. A table next to it carries the same numbers (no information by colour alone).
 */
export function SweepChart({ result }: { result: LaneSweepResult }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const d = laneSweepChart(result);
    const min = (v: number | null) => (v === null ? null : v / 60);
    const data: uPlot.AlignedData = [d.x, d.mean.map(min), d.target.map((t) => t / 60)];
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const axisColor = dark ? "#cbd5e1" : "#334155";
    const grid = { stroke: dark ? "#334155" : "#e2e8f0", width: 1 };
    const highlight = d.highlight;
    const drawBars = (u: uPlot) => {
      const ctx = u.ctx;
      ctx.save();
      ctx.strokeStyle = "#0072B2";
      ctx.lineWidth = 2 * devicePixelRatio;
      d.x.forEach((x, i) => {
        const lo = d.low[i];
        const hi = d.high[i];
        if (lo === null || lo === undefined || hi === null || hi === undefined) return;
        const px = u.valToPos(x, "x", true);
        const y1 = u.valToPos(lo / 60, "y", true);
        const y2 = u.valToPos(hi / 60, "y", true);
        const w = 5 * devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(px, y1);
        ctx.lineTo(px, y2);
        ctx.moveTo(px - w, y1);
        ctx.lineTo(px + w, y1);
        ctx.moveTo(px - w, y2);
        ctx.lineTo(px + w, y2);
        ctx.stroke();
      });
      if (highlight !== null) {
        const i = d.x.indexOf(highlight);
        const m = d.mean[i];
        if (i >= 0 && m !== null && m !== undefined) {
          ctx.strokeStyle = "#009E73";
          ctx.lineWidth = 3 * devicePixelRatio;
          ctx.beginPath();
          ctx.arc(u.valToPos(highlight, "x", true), u.valToPos(m / 60, "y", true), 9 * devicePixelRatio, 0, 2 * Math.PI);
          ctx.stroke();
        }
      }
      ctx.restore();
    };
    const top = Math.max(1, ...d.high.map((v) => (v ?? 0) / 60), result.targetWait / 60) * 1.1;
    const opts: uPlot.Options = {
      width: Math.max(260, el.clientWidth),
      height: 240,
      legend: { show: true },
      cursor: { drag: { x: false, y: false } },
      scales: { x: { time: false, range: (_u, a, b) => [a - 0.5, b + 0.5] }, y: { range: () => [0, top] } },
      axes: [
        { stroke: axisColor, grid, label: J.laneCount, values: (_u, splits) => splits.map((s) => (Number.isInteger(s) ? String(s) : "")) },
        { stroke: axisColor, grid, size: 50, label: J.minutes },
      ],
      series: [
        { label: J.laneCount },
        { label: J.meanWithCi, stroke: "#0072B2", width: 2, points: { show: true, size: 7 } },
        { label: J.targetLine, stroke: "#E69F00", width: 2, dash: [8, 4], points: { show: false } },
      ],
      hooks: { draw: [drawBars] },
    };
    const p = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => p.setSize({ width: Math.max(260, el.clientWidth), height: 240 }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      p.destroy();
    };
  }, [result]);

  return <div ref={host} className="w-full" role="img" aria-label={J.chartLabel} />;
}
