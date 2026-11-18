/**
 * Session bootstrap (RFC 0004 D15; WP2's `/api/session`). The user opens `http://127.0.0.1:<port>/#token=<hex>`,
 * optionally `&project=<id>` and `&view=timeline|history` (src/lib/console/urls.ts `sessionUrl`). The page reads the
 * token, strips it from the address bar with `history.replaceState` before anything else reads the location, keeps it
 * in this tab's sessionStorage (scoped to the exact origin, port included, and gone with the tab) so a reload works,
 * and posts it to `/api/session` in the `x-console-token` header; the reply is exactly `{ ok: true }` and sets the
 * HttpOnly media cookie, which holds a derived read-only value, never the token. No route returns the token: a reload
 * reposts the stored one. A fresh browser opened from an agent's answer gets `#pair=<code>` instead (a one-use code,
 * src/lib/console/pairing.ts), which `POST /api/session/pair` exchanges for the token and the cookie. The token goes in
 * the `x-console-token` header of every API request and the stream.
 */
import { z } from "zod";
import { KEY_EDITOR_PATH } from "../../../src/types/console-credentials";

/** The per-machine token: 32 random bytes as hex (src/lib/console/session.ts). */
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `&view=` values that open a project page other than the canvas; anything else opens the canvas. */
const PROJECT_VIEWS = new Set(["timeline", "history"]);

export interface FragmentToken {
  token?: string;
  credentials?: string;
  /** A one-use pairing code (`#pair=`, src/lib/console/pairing.ts), exchanged for the token once. */
  pair?: string;
  /** Route to open after boot (`/projects/<id>`, or `/projects/<id>/<view>`), from `&project=` and `&view=`. */
  route?: string;
}

/** A pairing code: 16 random bytes as hex. */
export const PAIR_PATTERN = /^[a-f0-9]{32}$/;

/** Reads and strips `#token=` or `#pair=` from the location. Leaves any other hash alone. */
export function takeFragmentToken(
  location: Location = window.location,
  history: History = window.history,
): FragmentToken {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("token=") && !hash.startsWith("pair=")) return {};
  const params = new URLSearchParams(hash);
  const token = params.get("token") ?? undefined;
  const pair = params.get("pair") ?? undefined;
  const credentials = params.get("credentials");
  const project = params.get("project") ?? undefined;
  const view = params.get("view") ?? "";
  const owner =
    token && TOKEN_PATTERN.test(token) && credentials && TOKEN_PATTERN.test(credentials) ? credentials : undefined;
  const route =
    owner && view === "api-keys"
      ? KEY_EDITOR_PATH
      : project && PROJECT_PATTERN.test(project)
        ? `/projects/${project}${PROJECT_VIEWS.has(view) ? `/${view}` : ""}`
        : undefined;
  const query = new URLSearchParams(location.search);
  let search = location.search;
  if (owner && query.has("credential-launch")) {
    query.delete("credential-launch");
    search = query.size ? `?${query}` : "";
  }
  history.replaceState(history.state, "", `${location.pathname}${search}${route ? `#${route}` : ""}`);
  return {
    ...(token && TOKEN_PATTERN.test(token) ? { token } : pair && PAIR_PATTERN.test(pair) ? { pair } : {}),
    ...(owner ? { credentials: owner } : {}),
    route,
  };
}

/** `POST /api/session` reply. */
export const SessionPostReplySchema = z.strictObject({ ok: z.literal(true) });
/** `POST /api/session/pair` reply: the only reply that carries the token, to the page that redeemed the code. */
export const PairReplySchema = z.strictObject({ ok: z.literal(true), token: z.string().regex(TOKEN_PATTERN) });

/** sessionStorage key of the tab's token (per origin, so per port: two checkouts' consoles never share it). */
export const TOKEN_STORAGE_KEY = "agentbros.console.token";
const CREDENTIALS_STORAGE_KEY = "agentbros.console.credentials";

export function readStoredCredentials(): string | undefined {
  try {
    const token = tabStorage()?.getItem(CREDENTIALS_STORAGE_KEY);
    return token && TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function storeCredentials(token?: string): void {
  try {
    const storage = tabStorage();
    if (token) storage?.setItem(CREDENTIALS_STORAGE_KEY, token);
    else storage?.removeItem(CREDENTIALS_STORAGE_KEY);
  } catch {
    // The current tab can still use the value in memory.
  }
}

function tabStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The token this tab stored, when it is well formed (storage may be absent or throw). */
export function readStoredToken(storage: Storage | undefined = tabStorage()): string | undefined {
  try {
    const token = storage?.getItem(TOKEN_STORAGE_KEY) ?? undefined;
    return token && TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the token for reloads of this tab; best effort. */
export function storeToken(token: string, storage: Storage | undefined = tabStorage()): void {
  try {
    storage?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // private mode or blocked storage: a reload then needs the URL again
  }
}

/** Forgets a token the server refused; best effort. */
export function clearStoredToken(storage: Storage | undefined = tabStorage()): void {
  try {
    storage?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // nothing to clear
  }
}
