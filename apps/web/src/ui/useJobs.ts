/**
 * The shared venue's server jobs: the list, one polling loop per active job (api/poll.ts, with
 * backoff), submit / cancel / delete. Submits are idempotent: the caller passes the requestId it
 * made for this submission, so a double click or a retry returns the same job.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Access, type ApiClient, type JobResponse, type JobSummary } from "../api/client.ts";
import { isTerminal, pollJob } from "../api/poll.ts";

export interface Jobs {
  list: (JobSummary | JobResponse)[];
  /** Full jobs (request + result) by id, once fetched. */
  details: Record<string, JobResponse>;
  error: string | null;
  refresh(): Promise<void>;
  submit(body: Record<string, unknown> & { requestId: string }): Promise<{ job: JobResponse; created: boolean }>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Fetches a finished job's result (once). */
  open(id: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function useJobs(client: ApiClient, venueId: string | null, access: Access | null): Jobs {
  const [list, setList] = useState<(JobSummary | JobResponse)[]>([]);
  const [details, setDetails] = useState<Record<string, JobResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const polling = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const set = polling.current;
    return () => {
      alive.current = false;
      set.clear();
    };
  }, [venueId]);

  const apply = useCallback((job: JobResponse) => {
    setList((l) => (l.some((j) => j.id === job.id) ? l.map((j) => (j.id === job.id ? job : j)) : [job, ...l]));
    setDetails((d) => (d[job.id] === job ? d : { ...d, [job.id]: job }));
  }, []);

  const watch = useCallback(
    (id: string) => {
      if (!venueId || !access || polling.current.has(id)) return;
      polling.current.add(id);
      void pollJob({
        get: () => client.getJob(venueId, id, access),
        onUpdate: (job) => {
          if (alive.current) {
            apply(job);
            setError(null);
          }
        },
        onError: (e) => alive.current && setError(e.message),
        sleep,
        stopped: () => !alive.current || !polling.current.has(id),
      }).finally(() => polling.current.delete(id));
    },
    [client, venueId, access, apply],
  );

  const refresh = useCallback((): Promise<void> => {
    if (!venueId || !access) return Promise.resolve();
    return client.listJobs(venueId, access).then(
      (jobs) => {
        if (!alive.current) return;
        setList(jobs);
        setError(null);
        for (const j of jobs) if (!isTerminal(j.status)) watch(j.id);
      },
      (e: unknown) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [client, venueId, access, watch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = useCallback(
    async (body: Record<string, unknown> & { requestId: string }) => {
      if (!venueId || !access) throw new ApiError("not-found", 0, "No shared venue is open.");
      const r = await client.submitJob(venueId, body, access);
      apply(r.job);
      if (!isTerminal(r.job.status)) watch(r.job.id);
      return r;
    },
    [client, venueId, access, apply, watch],
  );

  const cancel = useCallback(
    async (id: string) => {
      if (!venueId || !access) return;
      const job = await client.cancelJob(venueId, id, access);
      apply(job);
      if (!isTerminal(job.status)) watch(id);
    },
    [client, venueId, access, apply, watch],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!venueId || !access) return;
      await client.deleteJob(venueId, id, access);
      polling.current.delete(id);
      setList((l) => l.filter((j) => j.id !== id));
      setDetails((d) => {
        const { [id]: _gone, ...rest } = d;
        return rest;
      });
    },
    [client, venueId, access],
  );

  const open = useCallback(
    async (id: string) => {
      if (!venueId || !access || details[id]?.result) return;
      try {
        apply(await client.getJob(venueId, id, access));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, venueId, access, details, apply],
  );

  return { list, details, error, refresh, submit, cancel, remove, open };
}
