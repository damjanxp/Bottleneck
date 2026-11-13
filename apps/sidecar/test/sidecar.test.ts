import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, ENGINE_VERSION } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario, Venue } from "@bottleneck/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App, type AppConfig } from "../src/app.ts";
// @ts-expect-error plain .mjs build script without types
import { buildSidecar } from "../scripts/build.mjs";

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "test");
const workerPath = path.join(distDir, "worker.mjs");

const carPark = exampleVenues.find((e) => e.id === "standalone-car-park")!;
const carScenario = carPark.scenarios.find((s) => s.id === "car-park-pay-station")!;
const fair = exampleVenues.find((e) => e.id === "belgrade-fair-fair-day")!;
const fairScenario = fair.scenarios.find((s) => s.id === "fair-day-baseline")!;

function inProcessHash(venue: Venue, scenario: Scenario): string {
  const run = createRun(venue, scenario);
  while (!run.done) run.step();
  return run.metricsHash();
}

interface Reply {
  status: number;
  contentType: string;
  body: Record<string, unknown>;
}

interface Started {
  app: App;
  port: number;
  logs: string[];
  close: () => Promise<void>;
}

async function start(config: Partial<AppConfig> = {}): Promise<Started> {
  const logs: string[] = [];
  const app = createApp({ workerPath, log: (l) => logs.push(l), ...config });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, logs, close: () => new Promise<void>((resolve) => (app.server.closeAllConnections(), app.server.close(() => resolve()))) };
}

function call(port: number, method: string, url: string, body?: string | Buffer): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"]), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const post = (port: number, payload: unknown) => call(port, "POST", "/run", JSON.stringify(payload));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sidecar", () => {
  let s: Started;
  beforeAll(async () => {
    await buildSidecar(distDir);
    s = await start({ maxBodyBytes: 200_000 });
  }, 60_000);
  afterAll(async () => {
    await s.close();
  });

  it("GET /health", async () => {
    const r = await call(s.port, "GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", engineVersion: ENGINE_VERSION });
  });

  it("runs a scenario and returns the same metricsHash as the in-process engine", async () => {
    const r = await post(s.port, { venue: carPark.venue, scenario: carScenario });
    expect(r.status).toBe(200);
    expect(r.body.metricsHash).toBe(inProcessHash(carPark.venue, carScenario));
    expect(r.body.engineVersion).toBe(ENGINE_VERSION);
    expect(r.body.seed).toBe(carScenario.seed);
    expect(r.body.drained).toBe(true);
    expect(r.body.deadlock).toBe(false);
    expect(r.body.simulatedSeconds).toBeGreaterThan(0);
    expect(r.body.wallMs).toBeTypeOf("number");
    expect(r.body.parameters).toBeTypeOf("object");
    expect((r.body.metrics as Record<string, unknown>).parameters).toBeUndefined();
    expect(s.logs.some((l) => l.includes(String(r.body.metricsHash)) && !l.includes("venue"))).toBe(true);
  });

  it("seed changes the hash and matches the in-process run with that seed", async () => {
    const base = inProcessHash(carPark.venue, carScenario);
    const r = await post(s.port, { venue: carPark.venue, scenario: carScenario, seed: 12345 });
    expect(r.status).toBe(200);
    expect(r.body.seed).toBe(12345);
    expect(r.body.metricsHash).not.toBe(base);
    expect(r.body.metricsHash).toBe(inProcessHash(carPark.venue, { ...carScenario, seed: 12345 }));
  });

  it("overrides equal a scenario carrying them (laneCount sweep)", async () => {
    const baseline = await post(s.port, { venue: fair.venue, scenario: fairScenario });
    const swept = await post(s.port, { venue: fair.venue, scenario: fairScenario, overrides: { "gate-a": { laneCount: 1 } } });
    expect(swept.status).toBe(200);
    expect(swept.body.metricsHash).not.toBe(baseline.body.metricsHash);
    expect(swept.body.metricsHash).toBe(inProcessHash(fair.venue, { ...fairScenario, overrides: { "gate-a": { laneCount: 1 } } }));
  }, 30_000);

  it("400 for malformed JSON, missing documents and schema-invalid venue", async () => {
    const bad = await call(s.port, "POST", "/run", "{not json");
    expect(bad.status).toBe(400);
    expect(bad.contentType).toContain("application/problem+json");
    expect(bad.body).toMatchObject({ title: "Bad Request", status: 400 });
    expect((await post(s.port, { scenario: carScenario })).status).toBe(400);
    const invalid = await post(s.port, { venue: { ...carPark.venue, schemaVersion: 99 }, scenario: carScenario });
    expect(invalid.status).toBe(400);
    expect(String(invalid.body.detail)).toContain("venue");
    expect((await post(s.port, { venue: carPark.venue, scenario: carScenario, seed: -1 })).status).toBe(400);
    expect((await post(s.port, { venue: carPark.venue, scenario: carScenario, overrides: { "exit-barrier": { laneCount: 0 } } })).status).toBe(400);
  });

  it("413 for a body over the cap", async () => {
    const r = await call(s.port, "POST", "/run", JSON.stringify({ venue: carPark.venue, scenario: carScenario, pad: "x".repeat(300_000) }));
    expect(r.status).toBe(413);
    expect(r.contentType).toContain("application/problem+json");
  });

  it("404 and 405", async () => {
    expect((await call(s.port, "GET", "/nope")).status).toBe(404);
    const get = await call(s.port, "GET", "/run");
    expect(get.status).toBe(405);
    expect(get.contentType).toContain("application/problem+json");
    expect((await call(s.port, "POST", "/health", "{}")).status).toBe(405);
  });
});

describe("sidecar limits", () => {
  it("503 when busy, then recovers", async () => {
    const t = await start({ concurrency: 1 });
    try {
      const slow = post(t.port, { venue: fair.venue, scenario: fairScenario });
      while (t.app.active() === 0) await sleep(10);
      const busy = await post(t.port, { venue: carPark.venue, scenario: carScenario });
      expect(busy.status).toBe(503);
      expect(busy.contentType).toContain("application/problem+json");
      expect((await slow).status).toBe(200);
      expect((await post(t.port, { venue: carPark.venue, scenario: carScenario })).status).toBe(200);
    } finally {
      await t.close();
    }
  }, 60_000);

  it("504 when the wall-clock budget is exceeded, and the slot is freed", async () => {
    const t = await start();
    try {
      const r = await post(t.port, { venue: fair.venue, scenario: fairScenario, timeoutMs: 50 });
      expect(r.status).toBe(504);
      expect(r.contentType).toContain("application/problem+json");
      expect(t.app.active()).toBe(0);
      expect((await post(t.port, { venue: carPark.venue, scenario: carScenario })).status).toBe(200);
    } finally {
      await t.close();
    }
  }, 60_000);

  it("a client abort stops the run and frees the slot", async () => {
    const t = await start({ concurrency: 1 });
    try {
      const body = JSON.stringify({ venue: fair.venue, scenario: fairScenario });
      const req = request({ host: "127.0.0.1", port: t.port, method: "POST", path: "/run", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
      req.on("error", () => undefined);
      req.end(body);
      while (t.app.active() === 0) await sleep(10);
      req.destroy();
      const t0 = Date.now();
      while (t.app.active() > 0 && Date.now() - t0 < 5000) await sleep(10);
      expect(t.app.active()).toBe(0);
      expect((await post(t.port, { venue: carPark.venue, scenario: carScenario })).status).toBe(200);
    } finally {
      await t.close();
    }
  }, 60_000);
});
