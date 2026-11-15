/**
 * A tiny client-side router and the link format for shared venues (spec section 8).
 *
 *   /                      the app with the built-in examples
 *   /v/{venueId}#k={key}   the private edit link (the edit key)
 *   /v/{venueId}#t={token} the read-only share link (the read token)
 *
 * The secret sits in the fragment, which browsers never send to a server and never put in the
 * Referer. On arrival the page reads it, keeps it in sessionStorage for this venue (so a reload in
 * the same tab still works), and removes it from the address bar with history.replaceState
 * (Fixed rule F19), so it does not stay in the history, in screenshots or in a copied URL.
 *
 * Pure: location, history and storage are passed in (fakes in the tests).
 */

import type { Access } from "./client.ts";

export type Route = { kind: "home" } | { kind: "venue"; venueId: string } | { kind: "notFound"; path: string };

const VENUE_PATH = /^\/v\/([a-z2-7]{26})\/?$/;

export function parseRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "" || pathname === "/index.html") return { kind: "home" };
  const m = VENUE_PATH.exec(pathname);
  if (m) return { kind: "venue", venueId: m[1] as string };
  return { kind: "notFound", path: pathname };
}

export function venuePath(venueId: string): string {
  return `/v/${venueId}`;
}

/** Edit key and read token: base64url, 256 bits (43 characters); accept a little slack. */
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;

/** The credential in a fragment ("#k=…" or "#t=…"); null if there is none or it is malformed. */
export function parseFragment(hash: string): Access | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  let k: string | null = null;
  let t: string | null = null;
  for (const part of h.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    if (name === "k") k = value;
    else if (name === "t") t = value;
  }
  if (k !== null && SECRET.test(k)) return { kind: "edit", editKey: k };
  if (t !== null && SECRET.test(t)) return { kind: "read", readToken: t };
  return null;
}

/** Full links for the owner to copy. `origin` is e.g. "https://bottleneck.example". */
export function editLink(origin: string, venueId: string, editKey: string): string {
  return `${origin}${venuePath(venueId)}#k=${encodeURIComponent(editKey)}`;
}
export function shareLink(origin: string, venueId: string, readToken: string): string {
  return `${origin}${venuePath(venueId)}#t=${encodeURIComponent(readToken)}`;
}

// ---- Credential storage (per tab)

export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const ACCESS_KEY = (venueId: string) => `bottleneck.access.${venueId}`;

export function storeAccess(store: SessionStore | null, venueId: string, access: Access): void {
  try {
    store?.setItem(ACCESS_KEY(venueId), JSON.stringify(access));
  } catch {
    // Storage disabled: the key lives in memory (the page keeps it in state) until the tab closes.
  }
}

export function loadAccess(store: SessionStore | null, venueId: string): Access | null {
  try {
    const raw = store?.getItem(ACCESS_KEY(venueId));
    if (!raw) return null;
    const a = JSON.parse(raw) as unknown;
    if (typeof a !== "object" || a === null) return null;
    const o = a as Record<string, unknown>;
    if (o.kind === "edit" && typeof o.editKey === "string" && SECRET.test(o.editKey)) return { kind: "edit", editKey: o.editKey };
    if (o.kind === "read" && typeof o.readToken === "string" && SECRET.test(o.readToken)) return { kind: "read", readToken: o.readToken };
    return null;
  } catch {
    return null;
  }
}

export function forgetAccess(store: SessionStore | null, venueId: string): void {
  try {
    store?.removeItem(ACCESS_KEY(venueId));
  } catch {
    // nothing stored
  }
}

export function browserSession(): SessionStore | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
  pushState(data: unknown, unused: string, url?: string | null): void;
}

/**
 * Reads the route and the fragment of the current address. A credential in the fragment is stored
 * for the venue and the fragment is removed with replaceState (any fragment on a venue page is
 * removed, so a malformed key does not linger either). Without a fragment, a credential stored
 * earlier in this tab is used.
 */
export function consumeLocation(loc: LocationLike, history: HistoryLike, store: SessionStore | null): { route: Route; access: Access | null } {
  const route = parseRoute(loc.pathname);
  if (route.kind !== "venue") return { route, access: null };
  let access: Access | null = null;
  if (loc.hash && loc.hash !== "#") {
    access = parseFragment(loc.hash);
    if (access) storeAccess(store, route.venueId, access);
    history.replaceState(null, "", `${loc.pathname}${loc.search}`);
  }
  return { route, access: access ?? loadAccess(store, route.venueId) };
}
