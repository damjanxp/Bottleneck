/**
 * Typed client for the Bottleneck API (apps/api, spec section 8). Pure TypeScript: `fetch` is
 * injected, so the tests run it against a fake. Same origin only (the CSP says connect-src 'self';
 * Caddy serves the web build and proxies /api and /health to the API).
 *
 * Credentials (spec 8, "Sharing without logins"):
 * - the edit key travels only in the `X-Edit-Key` header (the API refuses it anywhere else);
 * - the read token travels in the `X-Read-Token` header (the API also accepts `?t=`, which this
 *   client never uses, so no secret ever appears in a URL, a server log or the Referer).
 * Nothing here logs; error messages are built from the server's ProblemDetails, which never echo
 * a credential.
 *
 * Concurrency: GET returns an ETag (the row's revision); PUT needs it back in If-Match. Without it
 * the API answers 428, after someone else's change 412. Both become an ApiError with `kind`
 * "precondition-required" / "conflict", so the UI can offer "reload or overwrite".
 */

import type { RunRecord, Scenario, Venue } from "@bottleneck/schema";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a link carries: the edit key (everything) or the read token (read-only). */
export type Access = { kind: "edit"; editKey: string } | { kind: "read"; readToken: string };

export type ApiErrorKind =
  /** The server could not be reached at all. */
  | "network"
  /** 401/403: missing or wrong key. */
  | "unauthorized"
  | "not-found"
  /** 412: someone else changed the document since it was read. */
  | "conflict"
  /** 428: a PUT without If-Match (a bug in the caller, reported clearly anyway). */
  | "precondition-required"
  /** 429: too many requests; see retryAfterSeconds. */
  | "rate-limited"
  /** 422 schema or job validation; see fieldErrors. */
  | "invalid"
  /** 409 count limits, 507 storage quotas, 413 size limits. */
  | "limit"
  /** A write was attempted with a read-only link (refused before any request). */
  | "read-only"
  | "server";

export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  /** JSON Pointer → messages (schema and job validation). */
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly problem: ProblemDetails | null;
  /** 429 only: seconds to wait before trying again (from Retry-After), if the server said. */
  readonly retryAfterSeconds: number | null;
  constructor(kind: ApiErrorKind, status: number, message: string, problem: ProblemDetails | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.problem = problem;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  /** "/timeline/gatesOpen: must be a number" lines from a validation problem. */
  get fieldErrors(): string[] {
    const errs = this.problem?.errors;
    if (!errs) return [];
    return Object.keys(errs)
      .sort()
      .flatMap((path) => (errs[path] ?? []).map((m) => (path ? `${path}: ${m}` : m)));
  }
}

export const READ_ONLY_MESSAGE = "This is a read-only link: it can show the venue but not change it. Saving needs the private edit link.";

// ---- Response shapes (camelCase JSON from ASP.NET Core)

export interface VenueResponse {
  id: string;
  name: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  document: Venue;
  /** Present only when the request carried the edit key. */
  readToken?: string;
}
export interface VenueCreated extends VenueResponse {
  readToken: string;
  /** Shown once; cannot be recovered, only rotated. */
  editKey: string;
}
export interface ScenarioSummary {
  id: string;
  name: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ScenarioResponse extends ScenarioSummary {
  venueId: string;
  document: Scenario;
}
export type RunOrigin = "job" | "clientReported";
export interface RunSummary {
  id: string;
  scenarioId: string | null;
  jobId: string | null;
  origin: RunOrigin;
  engineVersion: string;
  seed: number;
  metricsHash: string;
  sizeBytes: number;
  createdAt: string;
}
export interface RunResponse extends Omit<RunSummary, "sizeBytes"> {
  venueId: string;
  record: RunRecord;
}
export type JobKind = "batch" | "laneSweep" | "gateOpeningSweep";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface JobSummary {
  id: string;
  requestId: string;
  kind: JobKind;
  status: JobStatus;
  progress: { completedRuns: number; totalRuns: number };
  engineVersion: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface JobResponse extends JobSummary {
  venueId: string;
  cancelRequested: boolean;
  attempts: number;
  heartbeatAt: string | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
}
export interface UploadSummary {
  id: string;
  [key: string]: unknown;
}

/** A document with the ETag to send back in If-Match. */
export interface Tagged<T> {
  value: T;
  etag: string | null;
}

// ---- Problem details → readable message

const STATUS_KIND: Record<number, ApiErrorKind> = {
  401: "unauthorized",
  403: "unauthorized",
  404: "not-found",
  409: "limit",
  412: "conflict",
  413: "limit",
  422: "invalid",
  428: "precondition-required",
  429: "rate-limited",
  507: "limit",
};

const FALLBACK_MESSAGE: Partial<Record<ApiErrorKind, string>> = {
  unauthorized: "The link's key was not accepted. It may have been rotated: ask the venue's owner for a new link.",
  "not-found": "Not found on the server. It may have been deleted, or removed after 90 days without use.",
  conflict: "Someone else changed this since you loaded it.",
  "precondition-required": "The server needs to know which version you changed (If-Match). Reload and try again.",
  "rate-limited": "Too many requests to the server.",
  limit: "A server limit was reached.",
};

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); null if absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Reads a ProblemDetails body (RFC 9457) leniently; null if the body is not one. */
export function readProblem(body: unknown): ProblemDetails | null {
  if (!isObject(body)) return null;
  const p: ProblemDetails = {};
  if (typeof body.type === "string") p.type = body.type;
  if (typeof body.title === "string") p.title = body.title;
  if (typeof body.status === "number") p.status = body.status;
  if (typeof body.detail === "string") p.detail = body.detail;
  if (isObject(body.errors)) {
    const errors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(body.errors)) {
      if (Array.isArray(v)) errors[k] = v.filter((m): m is string => typeof m === "string");
      else if (typeof v === "string") errors[k] = [v];
    }
    p.errors = errors;
  }
  return p.title || p.detail || p.errors ? p : null;
}

/** One sentence (or two) a person can act on. */
export function problemMessage(kind: ApiErrorKind, status: number, problem: ProblemDetails | null, retryAfterSeconds: number | null): string {
  let text: string;
  if (problem?.detail && problem.title) text = `${problem.title}: ${problem.detail}`;
  else text = problem?.detail ?? problem?.title ?? FALLBACK_MESSAGE[kind] ?? `The server answered ${status}.`;
  if (kind === "rate-limited" && !/[.!?]$/.test(text)) text += ".";
  if (kind === "rate-limited") text += retryAfterSeconds !== null ? ` Try again in ${retryAfterSeconds} s.` : " Try again in a minute.";
  return text;
}

export async function errorFromResponse(res: Response, now: number = Date.now()): Promise<ApiError> {
  const kind: ApiErrorKind = STATUS_KIND[res.status] ?? "server";
  let problem: ProblemDetails | null = null;
  try {
    const text = await res.text();
    if (text) problem = readProblem(JSON.parse(text));
  } catch {
    problem = null;
  }
  const retry = res.status === 429 ? parseRetryAfter(res.headers.get("Retry-After"), now) : null;
  return new ApiError(kind, res.status, problemMessage(kind, res.status, problem, retry), problem, retry);
}

// ---- The client

export interface ApiClientOptions {
  fetch: FetchLike;
  /** "" for same origin (the default); tests may use "http://test". */
  baseUrl?: string;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  access?: Access | null;
  /** Writes need the edit key; refused locally with a read-only link. */
  needsEdit?: boolean;
  body?: unknown;
  ifMatch?: string | null;
  query?: Record<string, string | number | undefined>;
}

/** Venue/scenario/run/job ids are 26 base32 characters; anything else is refused before it reaches a URL. */
const ID = /^[a-z2-7]{26}$/;
function id(value: string): string {
  if (!ID.test(value)) throw new ApiError("not-found", 404, `Not a valid id: "${value.slice(0, 40)}".`);
  return value;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient({ fetch, baseUrl = "" }: ApiClientOptions) {
  async function send(path: string, o: RequestOptions = {}): Promise<Response> {
    if (o.needsEdit && o.access?.kind !== "edit") throw new ApiError("read-only", 0, READ_ONLY_MESSAGE);
    const headers: Record<string, string> = { Accept: "application/json, application/problem+json" };
    if (o.access?.kind === "edit") headers["X-Edit-Key"] = o.access.editKey;
    else if (o.access?.kind === "read") headers["X-Read-Token"] = o.access.readToken;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.ifMatch) headers["If-Match"] = o.ifMatch;
    const qs = o.query
      ? Object.entries(o.query)
          .filter((e): e is [string, string | number] => e[1] !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: o.method ?? "GET",
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        // No cookies exist; never send any, never cache a response holding a secret.
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ApiError("network", 0, "Could not reach the server. Check the connection and try again.");
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  async function json<T>(path: string, o: RequestOptions = {}): Promise<T> {
    const res = await send(path, o);
    return (await res.json()) as T;
  }

  async function tagged<T>(path: string, o: RequestOptions = {}): Promise<Tagged<T>> {
    const res = await send(path, o);
    return { value: (await res.json()) as T, etag: res.headers.get("ETag") };
  }

  const v = (venueId: string) => `/api/venues/${id(venueId)}`;

  return {
    /**
     * True if the API (and its database) answers on this origin. On static hosting the path is
     * missing (404) or the SPA fallback answers with index.html: both count as "no backend".
     */
    async available(): Promise<boolean> {
      try {
        const res = await fetch(`${baseUrl}/health/ready`, { method: "GET", cache: "no-store", credentials: "omit" });
        if (!res.ok) return false;
        const type = res.headers.get("Content-Type") ?? "";
        if (type.includes("html")) return false;
        return (await res.text()).trim() === "Healthy";
      } catch {
        return false;
      }
    },

    // Venues
    createVenue: (document: Venue) => tagged<VenueCreated>("/api/venues", { method: "POST", body: document }),
    getVenue: (venueId: string, access: Access) => tagged<VenueResponse>(v(venueId), { access }),
    updateVenue: (venueId: string, document: Venue, etag: string | null, access: Access) => tagged<VenueResponse>(v(venueId), { method: "PUT", access, needsEdit: true, body: document, ifMatch: etag }),
    deleteVenue: async (venueId: string, access: Access) => {
      await send(v(venueId), { method: "DELETE", access, needsEdit: true });
    },
    rotateEditKey: async (venueId: string, access: Access) => (await json<{ editKey: string }>(`${v(venueId)}/edit-key`, { method: "POST", access, needsEdit: true })).editKey,
    rotateReadToken: async (venueId: string, access: Access) => (await json<{ readToken: string }>(`${v(venueId)}/read-token`, { method: "POST", access, needsEdit: true })).readToken,

    // Scenarios
    listScenarios: (venueId: string, access: Access) => json<ScenarioSummary[]>(`${v(venueId)}/scenarios`, { access }),
    getScenario: (venueId: string, scenarioId: string, access: Access) => tagged<ScenarioResponse>(`${v(venueId)}/scenarios/${id(scenarioId)}`, { access }),
    createScenario: (venueId: string, document: Scenario, access: Access) => tagged<ScenarioResponse>(`${v(venueId)}/scenarios`, { method: "POST", access, needsEdit: true, body: document }),
    updateScenario: (venueId: string, scenarioId: string, document: Scenario, etag: string | null, access: Access) =>
      tagged<ScenarioResponse>(`${v(venueId)}/scenarios/${id(scenarioId)}`, { method: "PUT", access, needsEdit: true, body: document, ifMatch: etag }),
    deleteScenario: async (venueId: string, scenarioId: string, access: Access) => {
      await send(`${v(venueId)}/scenarios/${id(scenarioId)}`, { method: "DELETE", access, needsEdit: true });
    },

    // Runs
    listRuns: (venueId: string, access: Access, filter: { scenarioId?: string; jobId?: string; limit?: number } = {}) => json<RunSummary[]>(`${v(venueId)}/runs`, { access, query: filter }),
    getRun: (venueId: string, runId: string, access: Access) => json<RunResponse>(`${v(venueId)}/runs/${id(runId)}`, { access }),
    createRun: (venueId: string, record: RunRecord, access: Access, scenarioId?: string) =>
      json<RunResponse>(`${v(venueId)}/runs`, { method: "POST", access, needsEdit: true, body: record, query: { scenarioId: scenarioId === undefined ? undefined : id(scenarioId) } }),
    deleteRun: async (venueId: string, runId: string, access: Access) => {
      await send(`${v(venueId)}/runs/${id(runId)}`, { method: "DELETE", access, needsEdit: true });
    },

    // Jobs
    /** Idempotent by body.requestId: a resubmission returns the existing job (`created` false). */
    submitJob: async (venueId: string, body: Record<string, unknown> & { requestId: string }, access: Access) => {
      const res = await send(`${v(venueId)}/jobs`, { method: "POST", access, needsEdit: true, body });
      return { job: (await res.json()) as JobResponse, created: res.status === 201 };
    },
    listJobs: (venueId: string, access: Access) => json<JobSummary[]>(`${v(venueId)}/jobs`, { access }),
    getJob: (venueId: string, jobId: string, access: Access) => json<JobResponse>(`${v(venueId)}/jobs/${id(jobId)}`, { access }),
    cancelJob: (venueId: string, jobId: string, access: Access) => json<JobResponse>(`${v(venueId)}/jobs/${id(jobId)}/cancel`, { method: "POST", access, needsEdit: true }),
    deleteJob: async (venueId: string, jobId: string, access: Access) => {
      await send(`${v(venueId)}/jobs/${id(jobId)}`, { method: "DELETE", access, needsEdit: true });
    },

    // Uploads (background images; used by the venue editor in Phase 5)
    listUploads: (venueId: string, access: Access) => json<UploadSummary[]>(`${v(venueId)}/uploads`, { access }),
    uploadImage: async (venueId: string, image: Blob, access: Access) => {
      if (access.kind !== "edit") throw new ApiError("read-only", 0, READ_ONLY_MESSAGE);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${v(venueId)}/uploads`, {
          method: "POST",
          headers: { "X-Edit-Key": access.editKey, "Content-Type": image.type || "application/octet-stream", Accept: "application/json, application/problem+json" },
          body: image,
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw new ApiError("network", 0, "Could not reach the server. Check the connection and try again.");
      }
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as UploadSummary;
    },
    deleteUpload: async (venueId: string, uploadId: string, access: Access) => {
      await send(`${v(venueId)}/uploads/${id(uploadId)}`, { method: "DELETE", access, needsEdit: true });
    },
  };
}

/**
 * The "someone else changed this" choice after a 412 (or a 428): `reload` fetches the server's
 * version (the caller drops its own change); `overwrite` fetches the current ETag and writes the
 * caller's version over it. Either way the result carries the new ETag.
 */
export async function resolveConflict<T>(choice: "reload" | "overwrite", fetchCurrent: () => Promise<Tagged<T>>, write: (etag: string | null) => Promise<Tagged<T>>): Promise<Tagged<T>> {
  const current = await fetchCurrent();
  if (choice === "reload") return current;
  return write(current.etag);
}
