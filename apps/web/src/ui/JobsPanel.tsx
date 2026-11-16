import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { Scenario } from "@bottleneck/schema";
import { ApiError, READ_ONLY_MESSAGE, type JobResponse, type JobSummary, type RunSummary } from "../api/client.ts";
import {
  KIND_LABEL,
  METRIC_LABEL,
  SWEEP_METRICS,
  batchRequest,
  batchRows,
  gateSweepHeadline,
  gateSweepRequest,
  gateSweepRows,
  jobResult,
  jobStatusText,
  laneSweepRequest,
  laneSweepSentences,
  newRequestId,
  parseGateCandidates,
  progressFraction,
  sweepElements,
  type JobScenario,
  type SweepMetric,
  type SweepRule,
} from "../api/jobs.ts";
import { isTerminal } from "../api/poll.ts";
import { userChoices } from "../library/catalog.ts";
import { formatDuration, formatPercent } from "../sim/format.ts";
import { elementName } from "../sim/parameters.ts";
import { strings } from "../strings.ts";
import { btnPrimary, btnSmall, card, input, labelText } from "./styles.ts";
import type { Library } from "./useLibrary.ts";
import type { Jobs } from "./useJobs.ts";
import type { Server, SharedVenue } from "./useServer.ts";

const SweepChart = lazy(() => import("./SweepChart.tsx").then((m) => ({ default: m.SweepChart })));
const J = strings.share.jobs;

type Kind = "batch" | "laneSweep" | "gateOpeningSweep";

interface Option {
  key: string;
  label: string;
  scenario: Scenario;
  on: JobScenario;
}

/** Server jobs for the shared venue (spec 6.4): submit, follow, cancel, delete, and the results. */
export function JobsPanel({ venue, jobs, canEdit, library, server }: { venue: SharedVenue; jobs: Jobs; canEdit: boolean; library: Library; server: Server }) {
  const options: Option[] = [
    ...venue.scenarios.map((r) => ({ key: `server:${r.id}`, label: `${r.scenario.name} (${J.onServer})`, scenario: r.scenario, on: { scenarioId: r.id } })),
    ...userChoices(library.entries, venue.id).map((c) => ({ key: c.key, label: `${c.label} (${J.mine})`, scenario: c.scenario, on: { scenario: c.scenario } })),
  ];
  const [key, setKey] = useState("");
  const option = options.find((o) => o.key === key) ?? options[0];
  const [kind, setKind] = useState<Kind>("batch");
  const [seeds, setSeeds] = useState(20);
  const elements = option ? sweepElements(venue.venue, option.scenario) : [];
  const [elementId, setElementId] = useState("");
  const element = elements.find((e) => e.id === elementId) ?? elements[0];
  const [minLanes, setMinLanes] = useState<number | null>(null);
  const [maxLanes, setMaxLanes] = useState<number | null>(null);
  const [seedsPerPoint, setSeedsPerPoint] = useState(5);
  const [targetMinutes, setTargetMinutes] = useState(10);
  const [metric, setMetric] = useState<SweepMetric>("peakHourP95Wait");
  const [rule, setRule] = useState<SweepRule>("mean");
  const [candidates, setCandidates] = useState("150, 135, 120, 105, 90, 75, 60");
  const [targetShare, setTargetShare] = useState(95);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  // One request id per submission: reused while it is in flight or retried, replaced after success.
  const requestId = useRef<string>(newRequestId());

  const lo = minLanes ?? Math.max(1, (element?.laneCount ?? 1) - 2);
  const hi = maxLanes ?? Math.min(64, Math.max(lo, (element?.laneCount ?? 1) + 4));
  const eventStart = option?.scenario.timeline.eventStart ?? null;

  const submit = async () => {
    if (!option || busy) return;
    setMessage(null);
    let body: Record<string, unknown> & { requestId: string };
    if (kind === "batch") body = batchRequest(requestId.current, option.on, { seeds });
    else if (kind === "laneSweep") {
      if (!element) return;
      body = laneSweepRequest(requestId.current, option.on, { elementId: element.id, minLanes: lo, maxLanes: hi, seedsPerPoint, targetWait: Math.round(targetMinutes * 60), metric, rule });
    } else {
      if (eventStart === null) {
        setMessage({ ok: false, lines: [J.needsStart] });
        return;
      }
      const parsed = parseGateCandidates(candidates, eventStart);
      if ("error" in parsed) {
        setMessage({ ok: false, lines: [parsed.error] });
        return;
      }
      body = gateSweepRequest(requestId.current, option.on, { gatesOpen: parsed.values, targetShareInside: targetShare / 100, seedsPerPoint, rule });
    }
    setBusy(true);
    try {
      const r = await jobs.submit(body);
      requestId.current = newRequestId();
      setMessage({ ok: true, lines: [r.created ? J.submitted : J.alreadySubmitted] });
    } catch (e) {
      setMessage({ ok: false, lines: [e instanceof Error ? e.message : String(e), ...(e instanceof ApiError ? e.fieldErrors.slice(0, 8) : [])] });
    } finally {
      setBusy(false);
    }
  };

  // Each control gets aria-label: a control inside a <label> would otherwise be named with its own
  // value too ("Seeds 20"), which is noisy for screen readers and for tests.
  const numberField = (label: string, value: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <label className={labelText}>
      {label}
      <input aria-label={label} className={`${input} w-24`} type="number" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <>
      <section className={card} aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="text-lg font-semibold">
          {J.heading}
        </h2>
        <p className="mt-1 text-sm text-muted">{J.intro}</p>
        {!canEdit && <p className="mt-2 text-sm text-muted">{J.readOnly}</p>}
        {options.length === 0 ? (
          <p className="mt-2 text-sm text-subtle">{J.noScenarios}</p>
        ) : (
          <fieldset disabled={!canEdit} className="mt-3 flex flex-col gap-3" title={canEdit ? undefined : READ_ONLY_MESSAGE}>
            <div className="flex flex-wrap items-end gap-3">
              <label className={labelText}>
                {J.scenario}
                <select aria-label={J.scenario} className={`${input} min-w-[16rem]`} value={option?.key} onChange={(e) => setKey(e.target.value)}>
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelText}>
                {J.kind}
                <select aria-label={J.kind} className={input} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  <option value="batch">{J.kinds.batch}</option>
                  <option value="laneSweep">{J.kinds.laneSweep}</option>
                  <option value="gateOpeningSweep">{J.kinds.gateOpeningSweep}</option>
                </select>
              </label>
            </div>
            {kind === "batch" && <div className="flex flex-wrap items-end gap-3">{numberField(J.seeds, seeds, setSeeds, 1, 100)}</div>}
            {kind === "laneSweep" && (
              <div className="flex flex-wrap items-end gap-3">
                <label className={labelText}>
                  {J.element}
                  <select
                    aria-label={J.element}
                    className={input}
                    value={element?.id ?? ""}
                    onChange={(e) => {
                      setElementId(e.target.value);
                      setMinLanes(null);
                      setMaxLanes(null);
                    }}
                  >
                    {elements.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name} ({J.elementKinds[e.kind]}, {J.lanesNow(e.laneCount)})
                      </option>
                    ))}
                  </select>
                </label>
                {numberField(J.minLanes, lo, setMinLanes, 1, 64)}
                {numberField(J.maxLanes, hi, setMaxLanes, 1, 64)}
                {numberField(J.seedsPerPoint, seedsPerPoint, setSeedsPerPoint, 1, 30)}
                {numberField(J.targetMinutes, targetMinutes, setTargetMinutes, 0, 600, 0.5)}
                <label className={labelText}>
                  {J.metric}
                  <select aria-label={J.metric} className={input} value={metric} onChange={(e) => setMetric(e.target.value as SweepMetric)}>
                    {SWEEP_METRICS.map((m) => (
                      <option key={m} value={m}>
                        {METRIC_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <RuleField rule={rule} setRule={setRule} />
              </div>
            )}
            {kind === "gateOpeningSweep" && (
              <div className="flex flex-wrap items-end gap-3">
                <label className={labelText}>
                  {J.candidates}
                  <input aria-label={J.candidates} className={`${input} min-w-[18rem]`} value={candidates} onChange={(e) => setCandidates(e.target.value)} />
                </label>
                {numberField(J.targetShare, targetShare, setTargetShare, 1, 100)}
                {numberField(J.seedsPerPoint, seedsPerPoint, setSeedsPerPoint, 1, 30)}
                <RuleField rule={rule} setRule={setRule} />
                {eventStart === null && <p className="text-sm text-bad">{J.needsStart}</p>}
              </div>
            )}
            <div>
              <button type="button" className={btnPrimary} onClick={() => void submit()} disabled={busy || !canEdit}>
                {busy ? J.submitting : J.submit}
              </button>
              <p className="mt-1 text-xs text-subtle">{J.budget}</p>
            </div>
          </fieldset>
        )}
        {message && (
          <p className={`mt-2 text-sm ${message.ok ? "text-ok" : "text-bad"}`} role={message.ok ? "status" : "alert"}>
            {message.lines.join(" ")}
          </p>
        )}
      </section>

      <section className={card} aria-labelledby="joblist-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="joblist-heading" className="text-lg font-semibold">
            {J.listHeading}
          </h2>
          <button type="button" className={btnSmall} onClick={() => void jobs.refresh()}>
            {J.refresh}
          </button>
        </div>
        {jobs.error && (
          <p className="mt-1 text-sm text-bad" role="alert">
            {jobs.error}
          </p>
        )}
        {jobs.list.length === 0 ? <p className="mt-2 text-sm text-subtle">{J.none}</p> : <ul className="mt-2 flex flex-col gap-2">{jobs.list.map((j) => <JobRow key={j.id} job={j} detail={jobs.details[j.id]} jobs={jobs} venue={venue} canEdit={canEdit} />)}</ul>}
      </section>

      <RunsPanel venue={venue} server={server} canEdit={canEdit} />
    </>
  );
}

function RuleField({ rule, setRule }: { rule: SweepRule; setRule: (r: SweepRule) => void }) {
  return (
    <label className={labelText} title={J.ruleHint}>
      {J.rule}
      <select aria-label={J.rule} className={input} value={rule} onChange={(e) => setRule(e.target.value as SweepRule)}>
        <option value="mean">{J.rules.mean}</option>
        <option value="ci">{J.rules.ci}</option>
      </select>
    </label>
  );
}

function JobRow({ job, detail, jobs, venue, canEdit }: { job: JobSummary | JobResponse; detail: JobResponse | undefined; jobs: Jobs; venue: SharedVenue; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = !isTerminal(job.status);
  const request = (detail ?? (job as Partial<JobResponse>)).request;
  const scenarioName = (request?.scenario as Scenario | undefined)?.name ?? "";
  const act = (f: () => Promise<void>) => {
    setError(null);
    f().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    if (open && job.status === "succeeded") void jobs.open(job.id);
    // `jobs.open` changes identity with every result; opening once per status is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job.status, job.id]);

  return (
    <li className="rounded-lg border border-line p-2" data-testid="job-row" data-status={job.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {KIND_LABEL[job.kind]}
            {scenarioName && ` · ${scenarioName}`}
          </p>
          <p className="text-xs text-muted" role="status">
            {jobStatusText(job)} · {new Date(job.createdAt).toLocaleString("en-GB")}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {job.status === "succeeded" && (
            <button type="button" className={btnSmall} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? J.hideResult : J.showResult}
            </button>
          )}
          {active ? (
            <button type="button" className={btnSmall} disabled={!canEdit || (job as JobResponse).cancelRequested} onClick={() => act(() => jobs.cancel(job.id))}>
              {J.cancel}
            </button>
          ) : (
            <button type="button" className={btnSmall} disabled={!canEdit} onClick={() => act(() => jobs.remove(job.id))}>
              {J.delete}
            </button>
          )}
        </div>
      </div>
      {active && <progress className="mt-1 h-2 w-full accent-amber-500" max={1} value={progressFraction(job)} aria-label={J.progress} />}
      {error && (
        <p className="mt-1 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
      {open && detail && <JobResultView job={detail} venue={venue} />}
    </li>
  );
}

function TrustedNote({ job }: { job: JobResponse }) {
  const r = jobResult(job);
  return (
    <p className="text-xs text-ok">
      ✓ {J.trusted} · {J.engine(job.engineVersion ?? "?")} · {J.runs(r?.runs ?? job.progress.totalRuns)} · {J.seedsUsed(r?.seeds.length ?? 0)}
    </p>
  );
}

export function JobResultView({ job, venue }: { job: JobResponse; venue: SharedVenue }) {
  const r = jobResult(job);
  if (!r) return <p className="mt-2 text-sm text-subtle">{J.noResult}</p>;
  const names = (id: string) => elementName(venue.venue, id);
  const scenario = job.request.scenario as Scenario | undefined;
  const timeline = scenario?.timeline ?? { eventStart: 0, referenceClock: "00:00" };

  if (r.kind === "batch") {
    const rows = batchRows(r, names);
    return (
      <div className="mt-2" data-testid="batch-result">
        <TrustedNote job={job} />
        <table className="mt-1 w-full text-left text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="py-1 pr-3 font-normal">{J.measure}</th>
              <th className="py-1 pr-3 text-right font-normal">{J.meanCi}</th>
              <th className="py-1 text-right font-normal">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-line">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {row.label}
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{row.value}</td>
                <td className="py-1 text-right tabular-nums">{row.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (r.kind === "laneSweep") {
    const s = laneSweepSentences(r, names(r.elementId));
    return (
      <div className="mt-2" data-testid="lane-sweep-result">
        <TrustedNote job={job} />
        <p className="mt-1 font-semibold">{s.main}</p>
        <p className="text-sm">{s.byMean}</p>
        <p className="text-sm">{s.byCi}</p>
        <Suspense fallback={null}>
          <SweepChart result={r} />
        </Suspense>
        <table className="mt-2 w-full text-left text-sm">
          <caption className="text-left text-xs text-subtle">{J.sweepTable(METRIC_LABEL[r.metric], formatDuration(r.targetWait))}</caption>
          <thead className="text-xs text-subtle">
            <tr>
              <th className="py-1 pr-3 font-normal">{J.laneCount}</th>
              <th className="py-1 pr-3 text-right font-normal">{J.meanCi}</th>
              <th className="py-1 text-right font-normal">{J.meets}</th>
            </tr>
          </thead>
          <tbody>
            {r.points.map((p) => (
              <tr key={p.laneCount} className={`border-t border-line ${p.laneCount === r.answer ? "font-semibold" : ""}`}>
                <th scope="row" className="py-1 pr-3 font-normal">
                  {p.laneCount}
                  {p.laneCount === r.answer ? ` ← ${J.answer}` : ""}
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{p.target.mean === null ? "–" : `${formatDuration(p.target.mean)}${p.target.ci95HalfWidth !== null && Number.isFinite(p.target.ci95HalfWidth) ? ` ± ${formatDuration(p.target.ci95HalfWidth)}` : ""}`}</td>
                <td className="py-1 text-right">{p.meetsByCi ? J.meetsCi : p.meetsByMean ? J.meetsMean : J.meetsNo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const h = gateSweepHeadline(r, timeline);
  return (
    <div className="mt-2" data-testid="gate-sweep-result">
      <TrustedNote job={job} />
      <p className="mt-1 font-semibold">{h.main}</p>
      <p className="text-sm">{h.byMean}</p>
      <p className="text-sm">{h.byCi}</p>
      <table className="mt-2 w-full text-left text-sm">
        <caption className="text-left text-xs text-subtle">{J.gateTable(formatPercent(r.targetShareInside))}</caption>
        <thead className="text-xs text-subtle">
          <tr>
            <th className="py-1 pr-3 font-normal">{J.gatesOpen}</th>
            <th className="py-1 pr-3 text-right font-normal">{J.shareInside}</th>
            <th className="py-1 text-right font-normal">{J.meets}</th>
          </tr>
        </thead>
        <tbody>
          {gateSweepRows(r, timeline).map((row) => (
            <tr key={row.gatesOpen} className={`border-t border-line ${row.gatesOpen === r.answer ? "font-semibold" : ""}`}>
              <th scope="row" className="py-1 pr-3 font-normal">
                {row.time}
              </th>
              <td className="py-1 pr-3 text-right tabular-nums">{row.share}</td>
              <td className="py-1 text-right">{row.meets}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Runs stored with the venue: computed by server jobs (trusted) or reported by a browser. */
function RunsPanel({ venue, server, canEdit }: { venue: SharedVenue; server: Server; canEdit: boolean }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const access = server.access;
  const load = useCallback(() => {
    if (!access) return Promise.resolve();
    return server.client
      .listRuns(venue.id, access, { limit: 50 })
      .then((list) => {
        setRuns(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [server.client, venue.id, access]);
  useEffect(() => {
    void load();
  }, [load]);
  const name = (id: string | null) => venue.scenarios.find((s) => s.id === id)?.scenario.name ?? "";

  return (
    <section className={card} aria-labelledby="runs-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="runs-heading" className="text-lg font-semibold">
          {J.runsHeading}
        </h2>
        <button type="button" className={btnSmall} onClick={() => void load()}>
          {J.refresh}
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">{J.runsIntro}</p>
      {error && (
        <p className="mt-1 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
      {runs && runs.length === 0 && <p className="mt-2 text-sm text-subtle">{J.noRuns}</p>}
      {runs && runs.length > 0 && (
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-xs text-subtle">
            <tr>
              <th className="py-1 pr-3 font-normal">{J.origin}</th>
              <th className="py-1 pr-3 font-normal">{J.scenario}</th>
              <th className="py-1 pr-3 text-right font-normal">{J.seed}</th>
              <th className="py-1 pr-3 font-normal">{J.hash}</th>
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-1 pr-3">{r.origin === "job" ? `✓ ${J.trusted}` : J.reported}</td>
                <td className="py-1 pr-3">{name(r.scenarioId)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{r.seed}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.metricsHash}</td>
                <td className="py-1 text-right">
                  {r.origin === "clientReported" && (
                    <button
                      type="button"
                      className={btnSmall}
                      disabled={!canEdit}
                      onClick={() => {
                        if (!access) return;
                        server.client
                          .deleteRun(venue.id, r.id, access)
                          .then(load)
                          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      {J.delete}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
