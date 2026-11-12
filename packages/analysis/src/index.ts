/**
 * @bottleneck/analysis: statistics helpers, the synthetic scan-log generator and the scan-log importer.
 * Pure TypeScript, no DOM or Node APIs.
 */
export { summarise, type Summary } from "./stats.ts";
export { formatClock, laneName, parseScanLogCsv, scanLogFromRun, toScanLogCsv, type ScanLogEvent, type ScanLogOptions, type ScanLogRow } from "./scanLog.ts";
export { IDLE_GAP_FACTOR, fitScanLog, groupOf, type ScanLogFit, type ScanLogFitOptions } from "./fit.ts";
