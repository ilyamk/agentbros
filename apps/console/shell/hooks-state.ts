/**
 * One shared hooks status per API client (`GET /api/hooks`, RFC 0004 §7.1 H3), read by the top banner, its dialog
 * and Settings, so an install or a check in one place updates the others at once. The banner's "hide for good" choice
 * is a per-browser convenience in localStorage, wrapped in try/catch like the preferences.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { HooksResponse, HooksStatus } from "@contract";
import type { ApiClient } from "@/api/types";
import { asFailure } from "@/api/errors";

export interface HooksState {
  hooks?: HooksResponse;
  error?: string;
  checking: boolean;
}

interface Entry {
  state: HooksState;
  listeners: Set<() => void>;
  inflight?: Promise<void>;
}

const entries = new WeakMap<ApiClient, Entry>();

function entryOf(client: ApiClient): Entry {
  let entry = entries.get(client);
  if (!entry) {
    entry = { state: { checking: false }, listeners: new Set() };
    entries.set(client, entry);
  }
  return entry;
}

function publish(entry: Entry, state: HooksState): void {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

/** Asks the server for the hooks status again; concurrent calls share one request. */
export function refreshHooks(client: ApiClient): Promise<void> {
  if (!client.hooks) return Promise.resolve();
  const entry = entryOf(client);
  if (entry.inflight) return entry.inflight;
  publish(entry, { ...entry.state, checking: true });
  const request = client.hooks().then(
    (hooks) => publish(entry, { hooks, checking: false }),
    (failure: unknown) => publish(entry, { ...entry.state, error: asFailure(failure).message, checking: false }),
  );
  entry.inflight = request.finally(() => {
    entry.inflight = undefined;
  });
  return entry.inflight;
}

/** The shared status; loads it once when `live` and nothing is known yet. */
export function useHooksState(client: ApiClient, live: boolean): HooksState {
  const entry = entryOf(client);
  const state = useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    () => entry.state,
  );
  useEffect(() => {
    if (live && !entry.state.hooks && !entry.inflight) void refreshHooks(client);
  }, [live, client, entry]);
  return state;
}

export const hooksComplete = (status: HooksStatus): boolean =>
  status.claude === "installed" && status.codex === "installed";

export const hooksStale = (status: HooksStatus): boolean => status.claude === "stale" || status.codex === "stale";

const DISMISS_KEY = "agentbros.console.hooksBannerDismissed";

export function hooksBannerDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissHooksBanner(): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, "1");
  } catch {
    // storage blocked: the notice stays hidden for this page only
  }
}
