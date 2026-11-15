/**
 * React state for the optional backend: is the API reachable on this origin, which route is open
 * (/ or /v/{id}), the link's credential, and the shared venue with its scenarios. Without a backend
 * (static hosting) `status` becomes "unavailable" and the app shows none of this.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scenario, Venue } from "@bottleneck/schema";
import { ApiError, createApiClient, resolveConflict, type Access, type ApiClient, type Tagged, type ScenarioResponse, type VenueResponse } from "../api/client.ts";
import { browserSession, consumeLocation, forgetAccess, parseRoute, storeAccess, venuePath, type Route } from "../api/route.ts";
import { remoteVenues, setRemoteVenues, type RemoteScenario } from "../library/remoteVenues.ts";

export type ApiStatus = "checking" | "available" | "unavailable";

export interface SharedVenue {
  id: string;
  name: string;
  venue: Venue;
  etag: string | null;
  /** Only known with the edit key (the GET returns it then) or from the link itself. */
  readToken: string | null;
  scenarios: RemoteScenario[];
}

export type SharedState = { status: "none" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; venue: SharedVenue };

/** Links shown right after publishing or rotating: the edit link is shown only this once. */
export interface FreshLinks {
  venueId: string;
  editKey?: string;
  readToken?: string;
}

export interface Server {
  client: ApiClient;
  status: ApiStatus;
  route: Route;
  access: Access | null;
  shared: SharedState;
  fresh: FreshLinks | null;
  dismissFresh(): void;
  /** Goes to /v/{id} with this credential (kept in sessionStorage; never put in the URL). */
  openVenue(venueId: string, access: Access): void;
  /** Back to the examples at /. */
  leave(): void;
  reload(): Promise<void>;
  /** Publishes a venue document with scenarios; returns the new venue's id. */
  publish(venue: Venue, scenarios: Scenario[]): Promise<{ venueId: string; editKey: string; readToken: string; failed: string[] }>;
  /** Creates or updates a scenario on the shared venue (PUT with If-Match when the id is the server's). */
  saveScenario(s: Scenario): Promise<RemoteScenario>;
  /** After a 412: reload the server's version, or overwrite it with `s`. */
  resolveScenarioConflict(s: Scenario, choice: "reload" | "overwrite"): Promise<RemoteScenario>;
  deleteScenario(id: string): Promise<void>;
  rotateEditKey(): Promise<void>;
  rotateReadToken(): Promise<void>;
  deleteVenue(): Promise<void>;
}

const VENUE_SUFFIX = " (shared)";
const NONE: SharedState = { status: "none" };
const LOADING: SharedState = { status: "loading" };
const NO_SERVER: SharedState = { status: "error", message: "This link needs the Bottleneck server, which cannot be reached from this page." };
const NO_KEY: SharedState = { status: "error", message: "This link has no key. Open the full link you were given (it ends in #k=… or #t=…)." };

/** The address is read (and its fragment removed) once per page load, also under StrictMode's double render. */
let initialLocation: ReturnType<typeof consumeLocation> | null = null;
function readInitialLocation() {
  initialLocation ??= consumeLocation(window.location, window.history, browserSession());
  return initialLocation;
}

function toRemote(t: Tagged<ScenarioResponse>): RemoteScenario {
  return { id: t.value.id, scenario: t.value.document, etag: t.etag };
}

export function useServer(): Server {
  const client = useMemo(() => createApiClient({ fetch: (input, init) => window.fetch(input, init) }), []);
  const [status, setStatus] = useState<ApiStatus>("checking");
  const [{ route, access }, setLocationState] = useState(readInitialLocation);
  // The last load result, for the venue and credential it was loaded with (`key`).
  const [loaded, setLoaded] = useState<{ key: string; state: SharedState } | null>(null);
  const [fresh, setFresh] = useState<FreshLinks | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.available().then((ok) => {
      if (!cancelled) setStatus(ok ? "available" : "unavailable");
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Back/forward between / and /v/{id}.
  useEffect(() => {
    const onPop = () => setLocationState(consumeLocation(window.location, window.history, browserSession()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const venueId = route.kind === "venue" ? route.venueId : null;
  const loadKey = venueId && access ? `${venueId}|${access.kind === "edit" ? `k:${access.editKey}` : `t:${access.readToken}`}` : null;

  useEffect(() => {
    if (venueId === null || status !== "available" || !access || loadKey === null) return;
    let cancelled = false;
    void fetchShared(client, venueId, access).then((state) => {
      if (!cancelled) setLoaded({ key: loadKey, state });
    });
    return () => {
      cancelled = true;
    };
  }, [venueId, access, status, client, loadKey]);

  const shared: SharedState = useMemo(() => {
    if (venueId === null) return NONE;
    if (status === "checking") return LOADING;
    if (status === "unavailable") return NO_SERVER;
    if (!access) return NO_KEY;
    return loaded && loaded.key === loadKey ? loaded.state : LOADING;
  }, [venueId, status, access, loaded, loadKey]);

  const setShared = (f: (s: SharedState) => SharedState) => setLoaded((l) => (l ? { ...l, state: f(l.state) } : l));

  // The shared venue joins the catalogue, so every section can use it.
  useEffect(() => {
    if (shared.status === "ready") setRemoteVenues([{ id: shared.venue.id, title: `${shared.venue.name}${VENUE_SUFFIX}`, venue: shared.venue.venue, scenarios: shared.venue.scenarios }]);
    else if (remoteVenues().length > 0) setRemoteVenues([]);
  }, [shared]);

  const openVenue = useCallback((id: string, a: Access) => {
    storeAccess(browserSession(), id, a);
    window.history.pushState(null, "", venuePath(id));
    setLocationState({ route: parseRoute(venuePath(id)), access: a });
  }, []);

  const leave = useCallback(() => {
    window.history.pushState(null, "", "/");
    setLocationState({ route: { kind: "home" }, access: null });
  }, []);

  const reload = useCallback(async () => {
    if (venueId && access && loadKey) setLoaded({ key: loadKey, state: await fetchShared(client, venueId, access) });
  }, [venueId, access, loadKey, client]);

  const ready = shared.status === "ready" ? shared.venue : null;

  const updateScenarios = (f: (list: RemoteScenario[]) => RemoteScenario[]) =>
    setShared((s) => (s.status === "ready" ? { status: "ready", venue: { ...s.venue, scenarios: f(s.venue.scenarios) } } : s));

  const need = (): { id: string; a: Access; v: SharedVenue } => {
    if (!ready || !access) throw new ApiError("not-found", 0, "No shared venue is open.");
    return { id: ready.id, a: access, v: ready };
  };

  const upsert = (r: RemoteScenario) => updateScenarios((list) => (list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r]));

  const saveScenario = async (s: Scenario): Promise<RemoteScenario> => {
    const { id, a, v } = need();
    const existing = v.scenarios.find((x) => x.id === s.id);
    const doc = { ...s, venueId: id };
    const r = existing ? toRemote(await client.updateScenario(id, existing.id, doc, existing.etag, a)) : toRemote(await client.createScenario(id, doc, a));
    upsert(r);
    return r;
  };

  const resolveScenarioConflict = async (s: Scenario, choice: "reload" | "overwrite"): Promise<RemoteScenario> => {
    const { id, a } = need();
    const sid = s.id as string;
    const r = toRemote(
      await resolveConflict(
        choice,
        () => client.getScenario(id, sid, a),
        (etag) => client.updateScenario(id, sid, { ...s, venueId: id }, etag, a),
      ),
    );
    upsert(r);
    return r;
  };

  const deleteScenario = async (sid: string) => {
    const { id, a } = need();
    await client.deleteScenario(id, sid, a);
    updateScenarios((list) => list.filter((x) => x.id !== sid));
  };

  const rotateEditKey = async () => {
    const { id, a } = need();
    const editKey = await client.rotateEditKey(id, a);
    const next: Access = { kind: "edit", editKey };
    storeAccess(browserSession(), id, next);
    setLocationState((cur) => ({ ...cur, access: next }));
    setFresh({ venueId: id, editKey });
  };

  const rotateReadToken = async () => {
    const { id, a } = need();
    const readToken = await client.rotateReadToken(id, a);
    setShared((s) => (s.status === "ready" ? { status: "ready", venue: { ...s.venue, readToken } } : s));
    setFresh({ venueId: id, readToken });
  };

  const deleteVenue = async () => {
    const { id, a } = need();
    await client.deleteVenue(id, a);
    forgetAccess(browserSession(), id);
    leave();
  };

  const publish = async (venue: Venue, scenarios: Scenario[]) => {
    const created = (await client.createVenue(venue)).value;
    const a: Access = { kind: "edit", editKey: created.editKey };
    const failed: string[] = [];
    for (const s of scenarios) {
      try {
        await client.createScenario(created.id, { ...s, venueId: created.id }, a);
      } catch (e) {
        failed.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setFresh({ venueId: created.id, editKey: created.editKey, readToken: created.readToken });
    return { venueId: created.id, editKey: created.editKey, readToken: created.readToken, failed };
  };

  return {
    client,
    status,
    route,
    access,
    shared,
    fresh,
    dismissFresh: () => setFresh(null),
    openVenue,
    leave,
    reload,
    publish,
    saveScenario,
    resolveScenarioConflict,
    deleteScenario,
    rotateEditKey,
    rotateReadToken,
    deleteVenue,
  };
}

/** The venue and all its scenarios (each with its ETag), as a SharedState. */
async function fetchShared(client: ApiClient, id: string, a: Access): Promise<SharedState> {
  try {
    const v = await client.getVenue(id, a);
    const list = await client.listScenarios(id, a);
    const scenarios: RemoteScenario[] = [];
    for (const s of list) scenarios.push(toRemote(await client.getScenario(id, s.id, a)));
    return { status: "ready", venue: toShared(v, scenarios, a) };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

function toShared(v: Tagged<VenueResponse>, scenarios: RemoteScenario[], a: Access): SharedVenue {
  return {
    id: v.value.id,
    name: v.value.name,
    venue: v.value.document,
    etag: v.etag,
    readToken: v.value.readToken ?? (a.kind === "read" ? a.readToken : null),
    scenarios,
  };
}
