import { describe, expect, it } from "vitest";
import type { RunMetrics } from "@bottleneck/engine";
import { exampleVenues } from "@bottleneck/examples";
import type { Scenario } from "@bottleneck/schema";
import { ApiError, createApiClient, parseRetryAfter, readProblem, resolveConflict, type Access, type JobResponse } from "./client.ts";
import { batchRows, gateSweepHeadline, gateSweepRows, laneSweepChart, laneSweepSentences, parseGateCandidates, sweepElements, type BatchResult, type GateSweepResult, type LaneSweepResult } from "./jobs.ts";
import { backoffDelay, pollJob } from "./poll.ts";
import { consumeLocation, editLink, loadAccess, parseFragment, parseRoute, shareLink, type SessionStore } from "./route.ts";
import { buildRunRecord, fitRunRecord, venueHash } from "./runRecord.ts";

const VENUE = "abcdefghijklmnopqrstuvwxyz";
const SCEN = "zyxwvutsrqponmlkjihgfedcba";
const JOB = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const EDIT_KEY = "E".repeat(20) + "dit_key-secret-0123456789";
const READ_TOKEN = "R".repeat(20) + "ead_token-secret-012345678";
const edit: Access = { kind: "edit", editKey: EDIT_KEY };
const read: Access = { kind: "read", readToken: READ_TOKEN };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake fetch answering from a queue of responses, recording every request. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const r = responses.shift();
    if (!r) throw new Error("no response queued");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const problem = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/problem+json", ...headers } });

describe("API client", () => {
  it("sends the edit key and the read token only as headers, never in the URL", async () => {
    const { fetch, calls } = fakeFetch([json({ id: VENUE }, 200, { ETag: '"3"' }), json([]), json({ id: SCEN }, 201, { ETag: '"1"' }), json({ editKey: "new" })]);
    const api = createApiClient({ fetch });
    const v = await api.getVenue(VENUE, read);
    expect(v.etag).toBe('"3"');
    await api.listScenarios(VENUE, edit);
    await api.createScenario(VENUE, { name: "x" } as Scenario, edit);
    await api.rotateEditKey(VENUE, edit);

    expect(calls[0]?.headers["X-Read-Token"]).toBe(READ_TOKEN);
    expect(calls[0]?.headers["X-Edit-Key"]).toBeUndefined();
    expect(calls[1]?.headers["X-Edit-Key"]).toBe(EDIT_KEY);
    expect(calls[1]?.headers["X-Read-Token"]).toBeUndefined();
    expect(calls[2]?.method).toBe("POST");
    expect(calls[2]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[3]?.url).toBe(`/api/venues/${VENUE}/edit-key`);
    for (const c of calls) {
      expect(c.url).not.toContain(EDIT_KEY);
      expect(c.url).not.toContain(READ_TOKEN);
      expect(c.url).not.toMatch(/[?&]t=/);
    }
  });

  it("sends If-Match on updates and turns 412 into a conflict that can be resolved", async () => {
    const { fetch, calls } = fakeFetch([
      problem(412, { type: "https://bottleneck.dev/problems/concurrent-update", title: "Changed by someone else", status: 412, detail: "The document was changed since you read it (ETag mismatch). Reload it and apply your change again." }),
      json({ id: SCEN, document: { name: "theirs" } }, 200, { ETag: '"5"' }),
      json({ id: SCEN, document: { name: "mine" } }, 200, { ETag: '"6"' }),
    ]);
    const api = createApiClient({ fetch });
    const mine = { name: "mine" } as Scenario;
    const err = await api.updateScenario(VENUE, SCEN, mine, '"4"', edit).catch((e: unknown) => e);
    expect(calls[0]?.headers["If-Match"]).toBe('"4"');
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("conflict");
    expect((err as ApiError).message).toBe("Changed by someone else: The document was changed since you read it (ETag mismatch). Reload it and apply your change again.");

    // "Overwrite with mine": read the current ETag, then write with it.
    const r = await resolveConflict(
      "overwrite",
      () => api.getScenario(VENUE, SCEN, edit),
      (etag) => api.updateScenario(VENUE, SCEN, mine, etag, edit),
    );
    expect(calls[2]?.headers["If-Match"]).toBe('"5"');
    expect(r.etag).toBe('"6"');
  });

  it("'reload' after a conflict only reads the server's version", async () => {
    const { fetch, calls } = fakeFetch([json({ id: SCEN, document: { name: "theirs" } }, 200, { ETag: '"5"' })]);
    const api = createApiClient({ fetch });
    const r = await resolveConflict(
      "reload",
      () => api.getScenario(VENUE, SCEN, edit),
      () => {
        throw new Error("must not write");
      },
    );
    expect(r.value.document.name).toBe("theirs");
    expect(calls).toHaveLength(1);
  });

  it("reports 428 (missing If-Match) clearly", async () => {
    const { fetch } = fakeFetch([problem(428, { title: "If-Match required", detail: "Send the ETag you last read in an If-Match header, so a concurrent change is not overwritten.", status: 428 })]);
    const err = (await createApiClient({ fetch })
      .updateVenue(VENUE, {} as never, null, edit)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("precondition-required");
    expect(err.message).toContain("If-Match required");
  });

  it("reads Retry-After on 429", async () => {
    const { fetch } = fakeFetch([problem(429, { title: "Too many requests", status: 429 }, { "Retry-After": "17" }), new Response("", { status: 429 })]);
    const api = createApiClient({ fetch });
    const e1 = (await api.listJobs(VENUE, read).catch((e: unknown) => e)) as ApiError;
    expect(e1.kind).toBe("rate-limited");
    expect(e1.retryAfterSeconds).toBe(17);
    expect(e1.message).toBe("Too many requests. Try again in 17 s."); // the title, then the wait
    const e2 = (await api.listJobs(VENUE, read).catch((e: unknown) => e)) as ApiError;
    expect(e2.retryAfterSeconds).toBeNull();
    expect(e2.message).toContain("Try again in a minute.");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30);
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("turns schema validation problems into field messages", async () => {
    const { fetch } = fakeFetch([
      problem(422, { type: "https://bottleneck.dev/problems/schema-invalid", title: "Schema validation failed", detail: "The document does not match the JSON Schema in /schema.", status: 422, errors: { "/timeline/horizon": ["Required"], "/attendance": ["Must be at least 0", "Must be an integer"] } }),
    ]);
    const err = (await createApiClient({ fetch })
      .createScenario(VENUE, {} as Scenario, edit)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("invalid");
    expect(err.fieldErrors).toEqual(["/attendance: Must be at least 0", "/attendance: Must be an integer", "/timeline/horizon: Required"]);
    expect(readProblem("not json")).toBeNull();
    expect(readProblem({ foo: 1 })).toBeNull();
  });

  it("maps 401/403/404/409 and non-JSON errors", async () => {
    const { fetch } = fakeFetch([
      problem(403, { title: "Wrong credential", detail: "The edit key does not match.", status: 403 }),
      problem(409, { title: "Limit reached", detail: "A venue can hold at most 100 scenarios. Delete one first.", status: 409 }),
      new Response("<html>oops</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
      new Response("", { status: 404 }),
    ]);
    const api = createApiClient({ fetch });
    const kinds: string[] = [];
    const messages: string[] = [];
    for (const call of [() => api.getVenue(VENUE, edit), () => api.createScenario(VENUE, {} as Scenario, edit), () => api.listScenarios(VENUE, edit), () => api.getJob(VENUE, JOB, read)]) {
      const e = (await call().catch((x: unknown) => x)) as ApiError;
      kinds.push(e.kind);
      messages.push(e.message);
    }
    expect(kinds).toEqual(["unauthorized", "limit", "server", "not-found"]);
    expect(messages[2]).toBe("The server answered 502.");
    expect(messages[3]).toContain("Not found on the server");
  });

  it("refuses writes with a read-only link before sending anything", async () => {
    const { fetch, calls } = fakeFetch([]);
    const api = createApiClient({ fetch });
    for (const call of [() => api.createScenario(VENUE, {} as Scenario, read), () => api.deleteVenue(VENUE, read), () => api.submitJob(VENUE, { requestId: "r" }, read), () => api.rotateReadToken(VENUE, read)]) {
      const e = (await call().catch((x: unknown) => x)) as ApiError;
      expect(e.kind).toBe("read-only");
      expect(e.message).toContain("read-only link");
    }
    expect(calls).toHaveLength(0);
  });

  it("network failures and malformed ids", async () => {
    const { fetch } = fakeFetch([new TypeError("Failed to fetch")]);
    const api = createApiClient({ fetch });
    const e = (await api.getVenue(VENUE, read).catch((x: unknown) => x)) as ApiError;
    expect(e.kind).toBe("network");
    expect(() => api.getVenue("../etc", read)).toThrow(ApiError);
  });

  it("submitJob is idempotent by requestId: 201 creates, 200 returns the same job", async () => {
    const job = { id: JOB, status: "queued" };
    const { fetch, calls } = fakeFetch([json(job, 201), json(job, 200)]);
    const api = createApiClient({ fetch });
    const body = { requestId: "11111111-2222-3333-4444-555555555555", kind: "batch", scenarioId: SCEN };
    const a = await api.submitJob(VENUE, body, edit);
    const b = await api.submitJob(VENUE, body, edit);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(JSON.parse(calls[0]?.body ?? "{}").requestId).toBe(body.requestId);
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });

  it("puts filters (not secrets) in the run list's query string", async () => {
    const { fetch, calls } = fakeFetch([json([]), json({ id: "r" }, 201)]);
    const api = createApiClient({ fetch });
    await api.listRuns(VENUE, edit, { jobId: JOB, limit: 50 });
    await api.createRun(VENUE, {} as never, edit, SCEN);
    expect(calls[0]?.url).toBe(`/api/venues/${VENUE}/runs?jobId=${JOB}&limit=50`);
    expect(calls[1]?.url).toBe(`/api/venues/${VENUE}/runs?scenarioId=${SCEN}`);
  });

  it("detects the API only when /health/ready answers Healthy (not the SPA fallback or a 404)", async () => {
    const html = new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const cases: [Response | Error, boolean][] = [
      [new Response("Healthy", { status: 200, headers: { "Content-Type": "text/plain" } }), true],
      [html, false],
      [new Response("Not found", { status: 404 }), false],
      [new Response("Unhealthy", { status: 503 }), false],
      [new TypeError("offline"), false],
    ];
    for (const [r, expected] of cases) {
      const { fetch, calls } = fakeFetch([r]);
      expect(await createApiClient({ fetch }).available()).toBe(expected);
      expect(calls[0]?.url).toBe("/health/ready");
    }
  });
});

describe("router and link fragments", () => {
  function memoryStore(): SessionStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
  }
  function fakeHistory() {
    const replaced: (string | null | undefined)[] = [];
    return { replaced, replaceState: (_d: unknown, _u: string, url?: string | null) => void replaced.push(url), pushState: () => undefined };
  }

  it("parses routes", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute(`/v/${VENUE}`)).toEqual({ kind: "venue", venueId: VENUE });
    expect(parseRoute(`/v/${VENUE}/`)).toEqual({ kind: "venue", venueId: VENUE });
    expect(parseRoute("/v/NOT-AN-ID")).toEqual({ kind: "notFound", path: "/v/NOT-AN-ID" });
    expect(parseRoute("/other")).toEqual({ kind: "notFound", path: "/other" });
  });

  it("parses the fragment: #k= is the edit key, #t= the read token", () => {
    expect(parseFragment(`#k=${EDIT_KEY}`)).toEqual(edit);
    expect(parseFragment(`#t=${READ_TOKEN}`)).toEqual(read);
    expect(parseFragment(`#k=${EDIT_KEY}&t=${READ_TOKEN}`)).toEqual(edit);
    expect(parseFragment("#k=short")).toBeNull();
    expect(parseFragment("#k=<script>")).toBeNull();
    expect(parseFragment("")).toBeNull();
    expect(parseFragment("#%E0%A4%A")).toBeNull();
  });

  it("builds links with the secret in the fragment only", () => {
    const e = editLink("https://x.test", VENUE, EDIT_KEY);
    const s = shareLink("https://x.test", VENUE, READ_TOKEN);
    expect(e).toBe(`https://x.test/v/${VENUE}#k=${EDIT_KEY}`);
    expect(s).toBe(`https://x.test/v/${VENUE}#t=${READ_TOKEN}`);
    expect(new URL(e).pathname + new URL(e).search).not.toContain(EDIT_KEY);
    expect(parseFragment(new URL(e).hash)).toEqual(edit);
  });

  it("stores the key from the fragment and removes the fragment with replaceState", () => {
    const store = memoryStore();
    const history = fakeHistory();
    const r = consumeLocation({ pathname: `/v/${VENUE}`, search: "", hash: `#k=${EDIT_KEY}` }, history, store);
    expect(r).toEqual({ route: { kind: "venue", venueId: VENUE }, access: edit });
    expect(history.replaced).toEqual([`/v/${VENUE}`]);
    expect(loadAccess(store, VENUE)).toEqual(edit);
    // A reload in the same tab (no fragment any more) finds the key again; nothing is replaced.
    const again = consumeLocation({ pathname: `/v/${VENUE}`, search: "", hash: "" }, history, store);
    expect(again.access).toEqual(edit);
    expect(history.replaced).toHaveLength(1);
  });

  it("removes even a malformed fragment, and ignores fragments on other pages", () => {
    const history = fakeHistory();
    const r = consumeLocation({ pathname: `/v/${VENUE}`, search: "?x=1", hash: "#k=bad" }, history, memoryStore());
    expect(r.access).toBeNull();
    expect(history.replaced).toEqual([`/v/${VENUE}?x=1`]);
    const home = consumeLocation({ pathname: "/", search: "", hash: "#section" }, history, memoryStore());
    expect(home).toEqual({ route: { kind: "home" }, access: null });
    expect(history.replaced).toHaveLength(1);
  });

  it("works without storage (the key stays in memory)", () => {
    const history = fakeHistory();
    const broken: SessionStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    expect(consumeLocation({ pathname: `/v/${VENUE}`, search: "", hash: `#t=${READ_TOKEN}` }, history, broken).access).toEqual(read);
    expect(consumeLocation({ pathname: `/v/${VENUE}`, search: "", hash: "" }, history, null).access).toBeNull();
  });
});

describe("job polling with backoff", () => {
  const job = (status: JobResponse["status"], done: number, total = 20): JobResponse =>
    ({ id: JOB, status, progress: { completedRuns: done, totalRuns: total }, cancelRequested: false }) as unknown as JobResponse;

  it("grows the delay up to a cap", () => {
    expect([0, 1, 2, 3, 20].map((a) => backoffDelay(a))).toEqual([1000, 1500, 2250, 3375, 15000]);
    expect(backoffDelay(5, { initialMs: 100, factor: 2, maxMs: 1000 })).toBe(1000);
  });

  it("polls until the job finishes, starting short again whenever it moves", async () => {
    const answers = [job("queued", 0), job("queued", 0), job("queued", 0), job("running", 3), job("running", 3), job("succeeded", 20)];
    const sleeps: number[] = [];
    const seen: string[] = [];
    const last = await pollJob({
      get: async () => answers.shift() as JobResponse,
      onUpdate: (j) => seen.push(`${j.status}:${j.progress.completedRuns}`),
      sleep: async (ms) => void sleeps.push(ms),
      stopped: () => false,
    });
    expect(last?.status).toBe("succeeded");
    expect(seen).toEqual(["queued:0", "queued:0", "queued:0", "running:3", "running:3", "succeeded:20"]);
    expect(sleeps).toEqual([1000, 1500, 2250, 1000, 1500]);
  });

  it("waits Retry-After on 429 and keeps going after network errors", async () => {
    const answers: (JobResponse | ApiError)[] = [new ApiError("rate-limited", 429, "slow down", null, 30), new ApiError("network", 0, "offline"), job("succeeded", 20)];
    const sleeps: number[] = [];
    const errors: string[] = [];
    const last = await pollJob({
      get: async () => {
        const a = answers.shift();
        if (a instanceof ApiError) throw a;
        return a as JobResponse;
      },
      onUpdate: () => undefined,
      onError: (e) => errors.push(e.kind),
      sleep: async (ms) => void sleeps.push(ms),
      stopped: () => false,
    });
    expect(last?.status).toBe("succeeded");
    expect(errors).toEqual(["rate-limited", "network"]);
    expect(sleeps).toEqual([30_000, 2250]);
  });

  it("stops when told to, or when the job is gone", async () => {
    let n = 0;
    const r = await pollJob({ get: async () => job("running", n++), onUpdate: () => undefined, sleep: async () => undefined, stopped: () => n >= 3 });
    // The answer that arrives after the stop is dropped.
    expect(r?.progress.completedRuns).toBe(1);
    const gone = await pollJob({
      get: async () => {
        throw new ApiError("not-found", 404, "gone");
      },
      onUpdate: () => undefined,
      sleep: async () => undefined,
      stopped: () => false,
    });
    expect(gone).toBeNull();
  });
});

describe("job results in words", () => {
  const s = (mean: number | null, half: number | null = null, n = 5) => ({ n, mean, sd: 0, ci95HalfWidth: half, low: mean === null || half === null ? null : mean - half, high: mean === null || half === null ? null : mean + half });

  it("lane sweep: both answers and the chart data", () => {
    const r: LaneSweepResult = {
      kind: "laneSweep",
      engineVersion: "0.0.1",
      seeds: [1, 2, 3, 4, 5],
      runs: 15,
      elementId: "gate-main",
      metric: "peakHourP95Wait",
      metricKey: "peakHourP95Wait",
      targetWait: 600,
      rule: "mean",
      points: [
        { laneCount: 4, target: s(1500, 200), meetsByMean: false, meetsByCi: false, metrics: {} },
        { laneCount: 5, target: s(560, 90), meetsByMean: true, meetsByCi: false, metrics: {} },
        { laneCount: 6, target: s(300, 50), meetsByMean: true, meetsByCi: true, metrics: {} },
      ],
      smallestLaneCountByMean: 5,
      smallestLaneCountByCi: 6,
      answer: 5,
    };
    expect(laneSweepSentences(r, "Main turnstiles")).toEqual({
      main: "Main turnstiles needs 5 lanes to keep peak-hour p95 wait at or below 10 min.",
      byMean: "By the mean over the seeds: 5 lanes.",
      byCi: "By the whole 95% interval (cautious): 6 lanes.",
    });
    expect(laneSweepChart(r)).toEqual({ x: [4, 5, 6], mean: [1500, 560, 300], low: [1300, 470, 250], high: [1700, 650, 350], target: [600, 600, 600], highlight: 5 });
    expect(laneSweepChart({ ...r, rule: "ci" }).highlight).toBe(6);
    const none = laneSweepSentences({ ...r, smallestLaneCountByMean: null, smallestLaneCountByCi: null, answer: null }, "Main turnstiles");
    expect(none.main).toBe("No lane count of Main turnstiles from 4–6 keeps peak-hour p95 wait at or below 10 min.");
    expect(none.byCi).toBe("By the whole 95% interval (cautious): no lane count in 4–6 meets it.");
  });

  it("gate-opening sweep: the E6 headline and the table", () => {
    const r: GateSweepResult = {
      kind: "gateOpeningSweep",
      engineVersion: "0.0.1",
      seeds: [1, 2, 3],
      runs: 9,
      targetShareInside: 0.95,
      rule: "mean",
      points: [
        { gatesOpen: -7200, shareInsideAtStart: s(0.99, 0.004), meetsByMean: true, meetsByCi: true, metrics: {} },
        { gatesOpen: -5400, shareInsideAtStart: s(0.955, 0.01), meetsByMean: true, meetsByCi: false, metrics: {} },
        { gatesOpen: -3600, shareInsideAtStart: s(0.82, 0.02), meetsByMean: false, meetsByCi: false, metrics: {} },
      ],
      latestGatesOpenByMean: -5400,
      latestGatesOpenByCi: -7200,
      answer: -5400,
    };
    const tl = { eventStart: 0, referenceClock: "20:00" };
    expect(gateSweepHeadline(r, tl)).toEqual({
      main: "Latest gate opening for 95% inside by the start: 18:30 (1:30:00 before the start).",
      byMean: "By the mean over the seeds: 18:30 (1:30:00 before the start).",
      byCi: "By the whole 95% interval (cautious): 18:00 (2:00:00 before the start).",
    });
    expect(gateSweepHeadline({ ...r, latestGatesOpenByMean: null, latestGatesOpenByCi: null }, tl).main).toBe("No candidate gate opening gets 95% inside by the start.");
    expect(gateSweepRows(r, tl).map((x) => [x.time, x.share, x.meets])).toEqual([
      ["19:00 (1:00:00 before the start)", "82.0% ± 2.0 pts", "✗ no"],
      ["18:30 (1:30:00 before the start)", "95.5% ± 1.0 pts", "✓ by the mean"],
      ["18:00 (2:00:00 before the start)", "99.0% ± 0.4 pts", "✓ yes (whole interval)"],
    ]);
  });

  it("batch: mean ± CI rows for the headline metrics", () => {
    const r: BatchResult = {
      kind: "batch",
      engineVersion: "0.0.1",
      seeds: [1, 2],
      runs: 20,
      metrics: { peakHourP95Wait: s(754, 61, 20), shareInside: s(0.97, 0.005, 20), stillOutsideAtStart: s(412.3, 20.04, 20), "elements/gate-main/p95Wait": s(700, 50, 20), "lanes/gate-main/0/p95Wait": s(1, 1, 20), meanWait: s(null, null, 0) },
    };
    expect(batchRows(r, (id) => (id === "gate-main" ? "Main turnstiles" : id)).map((x) => `${x.label}: ${x.value}`)).toEqual([
      "Peak-hour p95 wait: 12 min 34 s ± 1 min 1 s",
      "Share inside: 97.0% ± 0.5 pts",
      "Still outside at the start: 412 ± 20",
      "Main turnstiles: p95 queue wait (worst lane): 11 min 40 s ± 50 s",
    ]);
  });

  it("parses candidate gate openings typed as minutes before the start", () => {
    expect(parseGateCandidates("120, 90 60;90", 0)).toEqual({ values: [-7200, -5400, -3600] });
    expect(parseGateCandidates("30", 1800)).toEqual({ values: [0] });
    expect(parseGateCandidates("", 0)).toHaveProperty("error");
    expect(parseGateCandidates("abc", 0)).toHaveProperty("error");
    expect(parseGateCandidates("-5", 0)).toHaveProperty("error");
  });

  it("lists the elements a lane sweep can vary, with the scenario's lane counts", () => {
    const ex = exampleVenues.find((v) => v.id === "belgrade-fair-concert");
    if (!ex) throw new Error("example missing");
    const sc = ex.scenarios[0] as Scenario;
    const els = sweepElements(ex.venue, sc);
    expect(els.length).toBeGreaterThan(0);
    const gate = els.find((e) => e.id === "gate-main");
    expect(gate?.kind).toBe("gate");
    expect(gate?.laneCount).toBe(sc.overrides?.["gate-main"]?.laneCount ?? ex.venue.gateGroups.find((g) => g.id === "gate-main")?.laneCount);
  });
});

describe("client-reported run records", () => {
  const metrics = (series: number) =>
    ({
      parameters: { seed: 1 },
      agentCount: 2,
      lanes: [{ laneId: 0, throughput: Array.from({ length: series }, (_, k) => k), queueLength: Array.from({ length: series }, () => 1.5), metrics: {} }],
      elements: [{ utilisation: Array.from({ length: series }, () => 0.5) }],
      countsByState: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0],
      density: { cols: 1, rows: 1, cellSize: 2, mean: [0], max: [0] },
    }) as unknown as RunMetrics;
  const scenario = { name: "s", seed: 1 } as Scenario;

  it("builds a clientReported record with the parameters apart from the metrics", () => {
    const r = buildRunRecord({ scenario, metrics: metrics(3), metricsHash: "0123456789abcdef", venueHash: "fedcba9876543210", engineVersion: "0.0.1", createdAt: "2026-11-15T00:00:00.000Z" });
    expect(r.origin).toBe("clientReported");
    expect(r.parameters).toEqual({ seed: 1 });
    expect("parameters" in r.metrics).toBe(false);
  });

  it("keeps a small record as is and empties long series of a big one", () => {
    const small = buildRunRecord({ scenario, metrics: metrics(10), metricsHash: "0", venueHash: "0", engineVersion: "0", createdAt: "x" });
    expect(fitRunRecord(small)).toMatchObject({ trimmed: false, removed: [] });
    const big = buildRunRecord({ scenario, metrics: metrics(40_000), metricsHash: "0", venueHash: "0", engineVersion: "0", createdAt: "x" });
    const fitted = fitRunRecord(big);
    expect(fitted?.trimmed).toBe(true);
    expect(fitted?.removed).toEqual(["/metrics/lanes/0/throughput", "/metrics/lanes/0/queueLength", "/metrics/elements/0/utilisation"]);
    expect(fitted?.record.metrics.countsByState).toHaveLength(10);
    expect(fitted?.bytes).toBeLessThanOrEqual(256 * 1024);
    // The original is untouched.
    expect(big.metrics.lanes[0]?.throughput).toHaveLength(40_000);
    expect(fitRunRecord(big, 50)).toBeNull();
  });

  it("hashes the venue to 16 hex characters", async () => {
    const h = await venueHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(await venueHash({ a: 1 })).toBe(h);
    expect(await venueHash({ a: 2 })).not.toBe(h);
  });
});
