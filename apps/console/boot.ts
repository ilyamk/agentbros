/**
 * Boot (RFC 0004 D15, RU-H04): reads the CSP nonce, takes the session token out of the URL fragment before anything else
 * reads the location, loads preferences and picks the API client — the real server, or fixture mode with
 * `?fixture=<name>` (a contract fixture basename such as `view-film-build`, `cards` for all seven card kinds, or
 * `projects-response` for the home page). Fixture mode freezes the clock at the latest fixture `generatedAt`/`updatedAt` and shows times
 * in UTC so screenshots are stable.
 */
import { FixtureApiClient } from "@/api/fixture";
import { HttpApiClient } from "@/api/http";
import { readSnapshot, SnapshotApiClient } from "@/api/snapshot";
import { takeFragmentToken } from "@/api/session";
import type { ApiClient } from "@/api/types";
import { setFixedNow } from "@/lib/clock";
import { fixtureNow, isFixtureName } from "@/lib/fixtures";
import { setDisplayTimeZone } from "@/lib/format";
import { installCspNonce } from "@/lib/nonce";
import { setSnapshotMode } from "@/lib/snapshot-mode";
import { applyDocument, initPreferences, resolveLanguage, resolveTheme } from "@/lib/preferences";
import { createConsoleStore, type ConsoleStore } from "@/store/store";

/**
 * A `#token=` or `#pair=` link opened in a tab that already shows the console is a same-document hash change (no
 * reload, so boot never sees it). With a session, the credential is stripped and only its route is followed: a pairing
 * code is left unredeemed to expire, so re-opening each next-step answer's link records no pairing and shows no toast.
 * Without one, the page reloads so boot redeems it.
 */
export function watchCredentialHash(win: Window, client: { readonly authenticated: boolean }): void {
  win.addEventListener("hashchange", () => {
    const hash = win.location.hash;
    if (!hash.startsWith("#token=") && !hash.startsWith("#pair=")) return;
    if (!client.authenticated) {
      win.location.reload();
      return;
    }
    takeFragmentToken(win.location, win.history);
    win.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

export function boot(win: Window = window): ConsoleStore {
  installCspNonce(win.document);
  const fragment = takeFragmentToken(win.location, win.history);
  const preferences = initPreferences(win.location.search);
  applyDocument(resolveTheme(preferences.theme), resolveLanguage(preferences.language), win.document);

  const fixture = new URLSearchParams(win.location.search).get("fixture");
  const snapshot = readSnapshot(win.document);
  let client: ApiClient;
  if (snapshot) {
    // A static snapshot (pnpm console:snapshot): read-only, no server, the clock frozen when it was taken.
    const now = Date.parse(snapshot.takenAt);
    setFixedNow(now);
    setSnapshotMode({ project: snapshot.view.project.id, takenAt: snapshot.takenAt });
    client = new SnapshotApiClient(snapshot);
    const hash = win.location.hash;
    if (!hash.startsWith(`#/projects/${snapshot.view.project.id}`))
      win.history.replaceState(
        win.history.state,
        "",
        `${win.location.pathname}${win.location.search}#/projects/${snapshot.view.project.id}`,
      );
  } else if (isFixtureName(fixture)) {
    const now = fixtureNow();
    setFixedNow(now);
    setDisplayTimeZone("UTC");
    client = new FixtureApiClient({ fixture, now: () => now });
    const project = FixtureApiClient.projectOf(fixture);
    if (project && (!win.location.hash || win.location.hash === "#" || win.location.hash === "#/"))
      win.history.replaceState(
        win.history.state,
        "",
        `${win.location.pathname}${win.location.search}#/projects/${project}`,
      );
  } else {
    const http = new HttpApiClient({ fragment });
    client = http;
    watchCredentialHash(win, http);
    if (fragment.route)
      win.history.replaceState(
        win.history.state,
        "",
        `${win.location.pathname}${win.location.search}#${fragment.route}`,
      );
  }
  const store = createConsoleStore(client);
  void store.start();
  return store;
}
