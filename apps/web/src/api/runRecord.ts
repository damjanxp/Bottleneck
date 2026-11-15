/**
 * A run computed in this browser, as a run record for the server (origin "clientReported",
 * /schema/run.schema.json). The API accepts at most 256 KB; a long run's time series (queue length
 * and throughput per lane, utilisation per element, the density grid) can be bigger, so they are
 * emptied when needed and the caller says so. The metrics hash stays the hash of the FULL run, so
 * anyone can still check the record by re-running its scenario and seed. Pure.
 */

import type { RunMetrics } from "@bottleneck/engine";
import type { RunRecord, Scenario } from "@bottleneck/schema";

export const MAX_CLIENT_RUN_BYTES = 256 * 1024;
/** Arrays of numbers longer than this count as a time series that may be left out. */
const SERIES_MIN_LENGTH = 32;

export function buildRunRecord(o: { scenario: Scenario; metrics: RunMetrics; metricsHash: string; venueHash: string; engineVersion: string; createdAt: string }): RunRecord {
  const { parameters, ...metrics } = o.metrics;
  return {
    schemaVersion: 1,
    engineVersion: o.engineVersion,
    createdAt: o.createdAt,
    origin: "clientReported",
    scenario: o.scenario,
    venueHash: o.venueHash,
    parameters,
    metrics,
    metricsHash: o.metricsHash,
  };
}

export function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Empties every long numeric array below `node`, recording the JSON paths it emptied. */
function emptySeries(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, k) => {
      if (Array.isArray(item) && item.length >= SERIES_MIN_LENGTH && item.every((x) => typeof x === "number" || x === null)) {
        out.push(`${path}/${k}`);
        node[k] = [];
      } else emptySeries(item, `${path}/${k}`, out);
    });
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (Array.isArray(v) && v.length >= SERIES_MIN_LENGTH && v.every((x) => typeof x === "number" || x === null)) {
      out.push(`${path}/${key}`);
      obj[key] = [];
    } else emptySeries(v, `${path}/${key}`, out);
  }
}

export interface FittedRecord {
  record: RunRecord;
  bytes: number;
  /** True if time series were left out to fit. */
  trimmed: boolean;
  /** JSON pointers of the emptied series (for the message). */
  removed: string[];
}

/** The record as is if it fits, otherwise with the metrics' time series emptied; null if even that is too big. */
export function fitRunRecord(record: RunRecord, limit = MAX_CLIENT_RUN_BYTES): FittedRecord | null {
  const bytes = byteLength(record);
  if (bytes <= limit) return { record, bytes, trimmed: false, removed: [] };
  const copy = JSON.parse(JSON.stringify(record)) as RunRecord;
  const removed: string[] = [];
  emptySeries(copy.metrics, "/metrics", removed);
  const after = byteLength(copy);
  return after <= limit ? { record: copy, bytes: after, trimmed: true, removed } : null;
}

/** 16 hex characters of SHA-256 over the venue document as JSON (the record's venueHash). */
export async function venueHash(venue: unknown, digest: (data: Uint8Array) => Promise<ArrayBuffer> = (d) => crypto.subtle.digest("SHA-256", d as BufferSource)): Promise<string> {
  const buf = new Uint8Array(await digest(new TextEncoder().encode(JSON.stringify(venue))));
  return Array.from(buf.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
