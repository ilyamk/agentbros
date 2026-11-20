/**
 * Hash routing (RFC 0004 §5.1): `#/` home, `#/projects/<id>` project canvas, `#/projects/<id>/history`,
 * `#/projects/<id>/timeline` (WP13), `#/projects/<id>/media` (albums, 2026-11-20), `#/projects/<id>/decision/<decision id>` (the canvas focused on that card: a
 * notification's click, WP14), `#/settings`, `#/metrics` (WP12), `#/library` (the motion library, WP15). The session
 * credential fragments (`#token=`, `#pair=`) are stripped before the router first reads the location (api/session.ts),
 * and again when one arrives in an open tab (boot.ts `watchCredentialHash`).
 */
import { useSyncExternalStore } from "react";
import { KEY_EDITOR_PATH } from "../../../src/types/console-credentials";

/** A project's pages: the route canvas, History, Timeline and Media (2026-11-20). */
export type ProjectPageName = "canvas" | "history" | "timeline" | "media";

export type Route =
  | { name: "home" }
  | { name: "project"; project: string; view: ProjectPageName; decision?: string }
  | { name: "settings"; focusKeys?: true }
  | { name: "library" }
  | { name: "metrics" }
  | { name: "not-found"; path: string };

const PROJECT = /^\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(history|timeline|media))?\/?$/;
const DECISION = /^\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)\/decision\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/?$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/" || path === "") return { name: "home" };
  if (path === KEY_EDITOR_PATH) return { name: "settings", focusKeys: true };
  if (path === "/settings") return { name: "settings" };
  if (path === "/library") return { name: "library" };
  const focus = DECISION.exec(path);
  if (focus?.[1] && focus[2]) return { name: "project", project: focus[1], view: "canvas", decision: focus[2] };
  if (path === "/metrics") return { name: "metrics" };
  const match = PROJECT.exec(path);
  if (match?.[1]) return { name: "project", project: match[1], view: (match[2] as ProjectPageName) ?? "canvas" };
  return { name: "not-found", path };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "settings":
      return route.focusKeys ? `#${KEY_EDITOR_PATH}` : "#/settings";
    case "library":
      return "#/library";
    case "metrics":
      return "#/metrics";
    case "project":
      if (route.view === "canvas" && route.decision) return `#/projects/${route.project}/decision/${route.decision}`;
      return `#/projects/${route.project}${route.view === "canvas" ? "" : `/${route.view}`}`;
    case "not-found":
      return `#${route.path}`;
  }
}

export const projectHref = (project: string, view: ProjectPageName = "canvas") =>
  hrefFor({ name: "project", project, view });

export function navigate(href: string): void {
  if (window.location.hash !== href) window.location.hash = href;
}

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function useRoute(): Route {
  return parseRoute(useHash());
}
