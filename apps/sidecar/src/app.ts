/**
 * The sidecar HTTP app (createApp). See server.ts for the usage notes and the contract.
 *
 * Each run executes in its own worker_threads Worker: the engine is synchronous and CPU-bound, so
 * a worker keeps the event loop free for /health and 503s, and lets a timeout or a client
 * disconnect stop the run for real with worker.terminate() (time-slicing with setImmediate could
 * only stop between slices and would add latency to every run).
 */
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { stdout } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { Worker } from "node:worker_threads";
import { ENGINE_VERSION } from "@bottleneck/engine";
import type { Scenario, Venue } from "@bottleneck/schema";
import { validateDocuments } from "./validate.ts";
import type { WorkerInput } from "./worker.ts";

export interface AppConfig {
  /** Max simultaneous runs (default 1). Further /run requests get 503. */
  concurrency: number;
  /** Request body cap in bytes (default 2 MB). */
  maxBodyBytes: number;
  /** Default wall-clock budget of a run in ms (default 120000). */
  runTimeoutMs: number;
  /** Worker heap limit in MB. */
  workerMemoryMb: number;
  /** The bundled worker script (dist/worker.mjs). */
  workerPath: string | URL;
  /** Where the one JSON line per request goes (default stdout). */
  log: (line: string) => void;
}

export const DEFAULT_CONFIG: Omit<AppConfig, "workerPath"> = {
  concurrency: 1,
  maxBodyBytes: 2 * 1024 * 1024,
  runTimeoutMs: 120_000,
  workerMemoryMb: 1024,
  log: (line) => void stdout.write(line + "\n"),
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    detail: string,
  ) {
    super(detail);
  }
}

interface RunRequest {
  venue: Venue;
  scenario: Scenario;
  seed?: number;
  overrides?: Record<string, Record<string, unknown>>;
  timeoutMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      reject(new HttpError(413, "Payload Too Large", `Request body exceeds ${max} bytes.`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > max) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, "Payload Too Large", `Request body exceeds ${max} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new HttpError(400, "Bad Request", "Request aborted.")));
  });
}

/** Applies seed and overrides (per element id, field by field over the scenario's own overrides) to a copy of the scenario. */
function applyRunRequest(body: RunRequest): Scenario {
  const scenario = { ...body.scenario } as Record<string, unknown>;
  if (body.seed !== undefined) scenario.seed = body.seed;
  if (body.overrides !== undefined) {
    const merged: Record<string, unknown> = { ...(isObject(scenario.overrides) ? scenario.overrides : {}) };
    for (const id of Object.keys(body.overrides)) {
      const base = merged[id];
      merged[id] = { ...(isObject(base) ? base : {}), ...body.overrides[id] };
    }
    scenario.overrides = merged;
  }
  return scenario as unknown as Scenario;
}

function parseRunRequest(raw: Buffer, defaultTimeout: number): { body: RunRequest; scenario: Scenario; timeoutMs: number } {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new HttpError(400, "Bad Request", `Malformed JSON: ${(e as Error).message}`);
  }
  if (!isObject(json) || !isObject(json.venue) || !isObject(json.scenario)) throw new HttpError(400, "Bad Request", 'Body must be an object with "venue" and "scenario" objects.');
  const body = json as unknown as RunRequest;
  if (body.seed !== undefined && !(Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 4294967295)) throw new HttpError(400, "Bad Request", '"seed" must be an integer in 0..4294967295.');
  if (body.overrides !== undefined && (!isObject(body.overrides) || Object.values(body.overrides).some((o) => !isObject(o)))) throw new HttpError(400, "Bad Request", '"overrides" must map element ids to override objects.');
  if (body.timeoutMs !== undefined && !(typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0)) throw new HttpError(400, "Bad Request", '"timeoutMs" must be a positive number.');
  const scenario = applyRunRequest(body);
  const errors = validateDocuments(body.venue, scenario);
  if (errors.length > 0) throw new HttpError(400, "Bad Request", `Schema validation failed: ${errors.join("; ")}`);
  return { body, scenario, timeoutMs: body.timeoutMs ?? defaultTimeout };
}

export interface App {
  server: Server;
  /** Runs currently executing. */
  active(): number;
}

export function createApp(partial: Partial<AppConfig> & Pick<AppConfig, "workerPath">): App {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, ...partial };
  let active = 0;

  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }

  /** Runs the engine in a worker; resolves with its result or rejects with an HttpError. `onWorker` receives a cancel function. */
  function runInWorker(input: WorkerInput, timeoutMs: number, onWorker: (cancel: () => void) => void): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(cfg.workerPath, { workerData: input, resourceLimits: { maxOldGenerationSizeMb: cfg.workerMemoryMb } });
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new HttpError(504, "Gateway Timeout", `Run exceeded its wall-clock budget of ${timeoutMs} ms.`))), timeoutMs);
      onWorker(() => finish(() => reject(new HttpError(499, "Client Closed Request", "Client disconnected."))));
      worker.on("message", (m: { ok: boolean; result?: Record<string, unknown>; message?: string }) => {
        if (m.ok && m.result) finish(() => resolve(m.result as Record<string, unknown>));
        else finish(() => reject(new HttpError(422, "Unprocessable Entity", `Engine error: ${m.message ?? "unknown"}`)));
      });
      worker.on("error", (e) => finish(() => reject(new HttpError(422, "Unprocessable Entity", `Engine failed: ${e.message}`))));
      worker.on("exit", (code) => finish(() => reject(new HttpError(500, "Internal Server Error", `Worker exited with code ${code}.`))));
    });
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse, info: { seed?: number; hash?: string }): Promise<void> {
    const raw = await readBody(req, cfg.maxBodyBytes);
    const { body, scenario, timeoutMs } = parseRunRequest(raw, cfg.runTimeoutMs);
    info.seed = scenario.seed as number;
    // Check-and-take is synchronous, so two requests cannot both pass the limit.
    if (active >= cfg.concurrency) throw new HttpError(503, "Service Unavailable", `Busy: ${active} of ${cfg.concurrency} runs in progress. Retry later.`);
    active++;
    const t0 = performance.now();
    let cancel: (() => void) | undefined;
    const onClose = (): void => {
      if (!res.writableFinished) cancel?.();
    };
    res.on("close", onClose);
    try {
      const result = await runInWorker({ venue: body.venue, scenario }, timeoutMs, (c) => (cancel = c));
      info.hash = result.metricsHash as string;
      send(res, 200, { engineVersion: ENGINE_VERSION, seed: scenario.seed, ...result, wallMs: Math.round(performance.now() - t0) });
    } finally {
      active--;
      res.off("close", onClose);
    }
  }

  const server = createServer((req, res) => {
    const t0 = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const info: { seed?: number; hash?: string; error?: string } = {};
    let status = 500;
    void (async () => {
      try {
        if (url.pathname === "/health") {
          if (req.method !== "GET") throw new HttpError(405, "Method Not Allowed", "Use GET.");
          status = 200;
          send(res, 200, { status: "ok", engineVersion: ENGINE_VERSION });
        } else if (url.pathname === "/run") {
          if (req.method !== "POST") throw new HttpError(405, "Method Not Allowed", "Use POST.");
          status = 200;
          await handleRun(req, res, info);
        } else {
          throw new HttpError(404, "Not Found", `No route ${url.pathname}.`);
        }
      } catch (e) {
        const err = e instanceof HttpError ? e : new HttpError(500, "Internal Server Error", e instanceof Error ? e.message : "Unexpected error.");
        status = err.status;
        info.error = err.message;
        if (!res.headersSent && !res.destroyed) {
          const text = JSON.stringify({ type: "about:blank", title: err.title, status: err.status, detail: err.message });
          const headers: Record<string, string | number> = { "content-type": "application/problem+json", "content-length": Buffer.byteLength(text) };
          if (err.status === 405) headers.allow = url.pathname === "/health" ? "GET" : "POST";
          if (err.status === 413) headers.connection = "close";
          res.writeHead(err.status, headers);
          res.end(text);
        }
      } finally {
        cfg.log(JSON.stringify({ time: new Date().toISOString(), method: req.method, path: url.pathname, status, ms: Math.round(performance.now() - t0), seed: info.seed, metricsHash: info.hash, error: info.error }));
      }
    })();
  });

  return { server, active: () => active };
}
