import type { LaneReport } from "@bottleneck/engine";

export interface ChartSeries {
  x: number[];
  y: number[];
}

/** Queue-length and throughput series of a lane, in scenario time. */
export function laneSeries(report: LaneReport, startTime: number, queueInterval: number, binSeconds: number): { queue: ChartSeries; throughput: ChartSeries } {
  return {
    queue: { x: report.queueLength.map((_, k) => startTime + (k + 1) * queueInterval), y: [...report.queueLength] },
    throughput: { x: report.throughput.map((_, k) => startTime + k * binSeconds), y: report.throughput.map((v) => (v * 60) / binSeconds) },
  };
}
