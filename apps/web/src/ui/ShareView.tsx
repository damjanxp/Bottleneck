import { Suspense, lazy, useState } from "react";
import type { Scenario } from "@bottleneck/schema";
import { ApiError, READ_ONLY_MESSAGE } from "../api/client.ts";
import { editLink, shareLink } from "../api/route.ts";
import { builtInChoices, isRemoteVenue, userChoices, venueById, venueTitle } from "../library/catalog.ts";
import { strings } from "../strings.ts";
import { btn, btnPrimary, btnSmall, card, input } from "./styles.ts";
import type { Library } from "./useLibrary.ts";
import type { Jobs } from "./useJobs.ts";
import type { Server, SharedVenue } from "./useServer.ts";

const JobsPanel = lazy(() => import("./JobsPanel.tsx").then((m) => ({ default: m.JobsPanel })));
const S = strings.share;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Sharing without logins (spec 8) and server runs (spec 6.4). Shown only when the API is reachable. */
export function ShareView({ server, jobs, venueId, library, onOpenScenario }: { server: Server; jobs: Jobs; venueId: string; library: Library; onOpenScenario: (key: string, venueId: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      {server.fresh && <FreshLinks server={server} />}
      {server.route.kind === "venue" ? <SharedVenuePanel server={server} jobs={jobs} library={library} onOpenScenario={onOpenScenario} /> : <PublishPanel server={server} venueId={venueId} library={library} />}
    </div>
  );
}

function CopyField({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${input} min-w-0 flex-1 font-mono text-xs`} readOnly value={value} aria-label={label} data-testid={testId} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className={btnSmall} onClick={() => void copy()}>
          {copied ? S.copied : S.copy}
        </button>
      </div>
    </div>
  );
}

/** The links right after publishing or rotating. The edit link is never shown again. */
function FreshLinks({ server }: { server: Server }) {
  const f = server.fresh;
  if (!f) return null;
  const origin = window.location.origin;
  const onThisVenue = server.route.kind === "venue" && server.route.venueId === f.venueId;
  return (
    <section className="rounded-xl border-2 border-amber-400 bg-warn-soft p-4" aria-labelledby="fresh-heading">
      <h2 id="fresh-heading" className="text-lg font-semibold">
        {f.editKey ? S.fresh.headingPublished : S.fresh.headingShare}
      </h2>
      {f.editKey && (
        <>
          <p className="mt-2 text-sm font-semibold text-bad" role="alert">
            ⚠ {S.fresh.warning}
          </p>
          <div className="mt-2">
            <CopyField label={S.fresh.editLink} value={editLink(origin, f.venueId, f.editKey)} testId="edit-link" />
          </div>
        </>
      )}
      {f.readToken && (
        <div className="mt-3">
          <CopyField label={S.fresh.shareLink} value={shareLink(origin, f.venueId, f.readToken)} testId="share-link" />
          <p className="mt-1 text-xs text-muted">{S.fresh.shareNote}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {f.editKey && !onThisVenue && (
          <button type="button" className={btnPrimary} onClick={() => server.openVenue(f.venueId, { kind: "edit", editKey: f.editKey as string })}>
            {S.fresh.open}
          </button>
        )}
        <button type="button" className={btn} onClick={server.dismissFresh}>
          {S.fresh.saved}
        </button>
      </div>
    </section>
  );
}

function PublishPanel({ server, venueId, library }: { server: Server; venueId: string; library: Library }) {
  const venue = venueById(venueId);
  const builtIns = builtInChoices(venueId);
  const mine = userChoices(library.entries, venueId);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  if (!venue || isRemoteVenue(venueId)) return null;
  const isPicked = (key: string, byDefault: boolean) => picked[key] ?? byDefault;
  const choices = [...mine.map((c) => ({ c, byDefault: true })), ...builtIns.map((c, k) => ({ c, byDefault: k === 0 && mine.length === 0 }))];

  const publish = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const scenarios: Scenario[] = choices.filter(({ c, byDefault }) => isPicked(c.key, byDefault)).map(({ c }) => c.scenario);
      const r = await server.publish(venue, scenarios);
      setMessage({ ok: r.failed.length === 0, lines: r.failed.length === 0 ? [S.publish.done(scenarios.length)] : [S.publish.partly, ...r.failed] });
    } catch (e) {
      setMessage({ ok: false, lines: [S.publish.failed, errorText(e), ...(e instanceof ApiError ? e.fieldErrors.slice(0, 8) : [])] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={card} aria-labelledby="publish-heading">
      <h2 id="publish-heading" className="text-lg font-semibold">
        {S.publish.heading(venueTitle(venueId))}
      </h2>
      <p className="mt-1 text-sm text-muted">{S.publish.intro}</p>
      <fieldset className="mt-3">
        <legend className="text-sm font-semibold">{S.publish.scenarios}</legend>
        <ul className="mt-1 flex flex-col gap-1">
          {choices.map(({ c, byDefault }) => (
            <li key={c.key}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isPicked(c.key, byDefault)} onChange={(e) => setPicked((p) => ({ ...p, [c.key]: e.target.checked }))} />
                {c.label} <span className="text-xs text-subtle">({c.builtIn ? S.publish.example : S.publish.mine})</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="mt-2 text-xs text-subtle">{S.publish.privacy}</p>
      <button type="button" className={`${btnPrimary} mt-3`} onClick={() => void publish()} disabled={busy}>
        {busy ? S.publish.busy : S.publish.button}
      </button>
      {message && <Message ok={message.ok} lines={message.lines} />}
    </section>
  );
}

function Message({ ok, lines }: { ok: boolean; lines: string[] }) {
  return (
    <div className={`mt-3 rounded-lg border p-2 text-sm ${ok ? "border-ok/30 bg-ok-soft" : "border-bad/40 bg-bad-soft"}`} role={ok ? "status" : "alert"}>
      {lines.map((l, k) => (
        <p key={k}>{l}</p>
      ))}
    </div>
  );
}

/** A destructive or link-breaking action behind a second click. */
function ConfirmButton({ label, question, confirm, onConfirm, disabled }: { label: string; question: string; confirm: string; onConfirm: () => Promise<void>; disabled: boolean }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking)
    return (
      <button type="button" className={btnSmall} disabled={disabled} title={disabled ? READ_ONLY_MESSAGE : undefined} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2 rounded-md border border-bad/40 bg-bad-soft px-2 py-1 text-sm">
      {question}
      <button
        type="button"
        className={btnSmall}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onConfirm().finally(() => {
            setBusy(false);
            setAsking(false);
          });
        }}
      >
        {confirm}
      </button>
      <button type="button" className={btnSmall} onClick={() => setAsking(false)}>
        {S.cancel}
      </button>
    </span>
  );
}

function SharedVenuePanel({ server, jobs, library, onOpenScenario }: { server: Server; jobs: Jobs; library: Library; onOpenScenario: (key: string, venueId: string) => void }) {
  const sh = server.shared;
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  if (sh.status === "loading" || sh.status === "none" || server.status === "checking")
    return (
      <section className={card}>
        <p className="text-sm text-subtle">{S.venue.loading}</p>
      </section>
    );
  if (sh.status === "error")
    return (
      <section className={card}>
        <p className="text-sm font-medium text-bad" role="alert">
          {sh.message}
        </p>
        <button type="button" className={`${btn} mt-3`} onClick={server.leave}>
          {S.venue.backHome}
        </button>
      </section>
    );
  const v = sh.venue;
  const canEdit = server.access?.kind === "edit";
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await f();
      setMessage({ ok: true, lines: [ok] });
    } catch (e) {
      setMessage({ ok: false, lines: [errorText(e)] });
    }
  };

  return (
    <>
      <section className={card} aria-labelledby="shared-heading">
        <h2 id="shared-heading" className="text-lg font-semibold">
          {S.venue.heading(v.name)}
        </h2>
        <p className={`mt-1 inline-block rounded-md px-2 py-0.5 text-sm font-medium ${canEdit ? "bg-emerald-100 text-emerald-900 dark:text-emerald-200" : "bg-sky-100 text-sky-900 dark:text-sky-200"}`} data-testid="access-level">
          {canEdit ? S.venue.editAccess : S.venue.readAccess}
        </p>
        {!canEdit && <p className="mt-2 text-sm text-muted">{READ_ONLY_MESSAGE}</p>}
        <p className="mt-2 text-xs text-subtle">{S.venue.retention}</p>
        {v.readToken && (
          <div className="mt-3">
            <CopyField label={S.fresh.shareLink} value={shareLink(window.location.origin, v.id, v.readToken)} testId="current-share-link" />
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ConfirmButton label={S.venue.rotateShare} question={S.venue.rotateShareQ} confirm={S.venue.rotateShareYes} disabled={!canEdit} onConfirm={() => run(server.rotateReadToken, S.venue.rotatedShare)} />
          <ConfirmButton label={S.venue.rotateEdit} question={S.venue.rotateEditQ} confirm={S.venue.rotateEditYes} disabled={!canEdit} onConfirm={() => run(server.rotateEditKey, S.venue.rotatedEdit)} />
          <ConfirmButton label={S.venue.delete} question={S.venue.deleteQ(v.name)} confirm={S.venue.deleteYes} disabled={!canEdit} onConfirm={() => run(server.deleteVenue, S.venue.deleted)} />
          <button type="button" className={btnSmall} onClick={server.leave}>
            {S.venue.backHome}
          </button>
        </div>
        {message && <Message ok={message.ok} lines={message.lines} />}
      </section>

      <ServerScenarios venue={v} server={server} canEdit={canEdit} library={library} onOpenScenario={onOpenScenario} />

      <Suspense fallback={<p className="text-sm text-subtle">{strings.controls.loading}</p>}>
        <JobsPanel venue={v} jobs={jobs} canEdit={canEdit} library={library} server={server} />
      </Suspense>
    </>
  );
}

interface Conflict {
  scenario: Scenario;
  message: string;
}

function ServerScenarios({ venue, server, canEdit, library, onOpenScenario }: { venue: SharedVenue; server: Server; canEdit: boolean; library: Library; onOpenScenario: (key: string, venueId: string) => void }) {
  const [message, setMessage] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const drafts = userChoices(library.entries, venue.id);

  const save = async (s: Scenario) => {
    setBusy(s.id ?? "");
    setMessage(null);
    setConflict(null);
    try {
      await server.saveScenario(s);
      // The draft is now on the server (a new one under the server's id), so the local copy goes.
      library.remove(s.id as string);
      setMessage({ ok: true, lines: [S.scenarios.saved(s.name)] });
    } catch (e) {
      if (e instanceof ApiError && (e.kind === "conflict" || e.kind === "precondition-required")) setConflict({ scenario: s, message: e.message });
      else setMessage({ ok: false, lines: [errorText(e), ...(e instanceof ApiError ? e.fieldErrors.slice(0, 8) : [])] });
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (choice: "reload" | "overwrite") => {
    if (!conflict) return;
    const s = conflict.scenario;
    setConflict(null);
    try {
      const r = await server.resolveScenarioConflict(s, choice);
      library.remove(s.id as string);
      setMessage({ ok: true, lines: [choice === "reload" ? S.scenarios.reloaded(r.scenario.name) : S.scenarios.saved(s.name)] });
    } catch (e) {
      setMessage({ ok: false, lines: [errorText(e)] });
    }
  };

  return (
    <section className={card} aria-labelledby="server-scenarios-heading">
      <h2 id="server-scenarios-heading" className="text-lg font-semibold">
        {S.scenarios.heading}
      </h2>
      <p className="mt-1 text-sm text-muted">{S.scenarios.intro}</p>
      {venue.scenarios.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">{S.scenarios.none}</p>
      ) : (
        <ul className="mt-2">
          {venue.scenarios.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
              <span className="font-medium">{r.scenario.name}</span>
              <span className="flex flex-wrap gap-1">
                <button type="button" className={btnSmall} onClick={() => onOpenScenario(`server:${r.id}`, venue.id)}>
                  {strings.library.open}
                </button>
                <button
                  type="button"
                  className={btnSmall}
                  onClick={() => {
                    library.save(r.scenario);
                    setMessage({ ok: true, lines: [S.scenarios.copied(r.scenario.name)] });
                  }}
                >
                  {S.scenarios.copy}
                </button>
                <ConfirmButton label={strings.library.delete} question={S.scenarios.deleteQ(r.scenario.name)} confirm={S.scenarios.deleteYes} disabled={!canEdit} onConfirm={() => server.deleteScenario(r.id).catch((e: unknown) => setMessage({ ok: false, lines: [errorText(e)] }))} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 text-sm font-semibold">{S.scenarios.draftsHeading}</h3>
      <p className="text-xs text-subtle">{S.scenarios.draftsIntro}</p>
      {drafts.length === 0 ? (
        <p className="mt-1 text-sm text-subtle">{S.scenarios.noDrafts}</p>
      ) : (
        <ul className="mt-1">
          {drafts.map((c) => {
            const onServer = venue.scenarios.some((r) => r.id === c.scenario.id);
            return (
              <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2">
                <span>
                  {c.label} <span className="text-xs text-subtle">({onServer ? S.scenarios.draftOf : S.scenarios.newDraft})</span>
                </span>
                <button type="button" className={btnSmall} disabled={!canEdit || busy !== null} title={canEdit ? undefined : READ_ONLY_MESSAGE} onClick={() => void save(c.scenario)}>
                  {onServer ? S.scenarios.update : S.scenarios.upload}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {conflict && (
        <div className="mt-3 rounded-lg border border-bad/40 bg-bad-soft p-3 text-sm" role="alert">
          <p className="font-semibold">{S.scenarios.conflictHeading(conflict.scenario.name)}</p>
          <p>{conflict.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btnSmall} onClick={() => void resolve("reload")}>
              {S.scenarios.conflictReload}
            </button>
            <button type="button" className={btnSmall} onClick={() => void resolve("overwrite")}>
              {S.scenarios.conflictOverwrite}
            </button>
          </div>
        </div>
      )}
      {message && <Message ok={message.ok} lines={message.lines} />}
    </section>
  );
}
