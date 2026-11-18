/** WP14 browser path (RFC 0004 D23): presence, one browser notification per notice, focus, click-through, permission. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FixtureApiClient } from "@/api/fixture";
import type { TextTransport } from "@/api/types";
import { NotificationSettings, NotifyPrompt, NotifyProvider } from "@/shell/notify";
import { FIXTURE_NOW, fixtureStore, renderWith } from "@/test/utils";
import { NotifyBridge, type SentNotice } from "./notify";
import { parseRoute } from "./router";

const ROUTE = "/projects/promo-acme/decision/01JDEC.script";

function sent(seq: number, channel: SentNotice["channel"], key = `decision:${seq}`): SentNotice {
  return {
    seq,
    at: "2026-11-17T09:18:00.000Z",
    channel,
    notice: {
      key,
      kind: "decision",
      project: "promo-acme",
      title: "Agent Bros.: a decision is waiting",
      body: "promo-acme · script",
      route: ROUTE,
    },
  };
}

const STATUS = {
  ok: true,
  settings: {
    enabled: false,
    prompted: false,
    kinds: { decision: true, card: true, failure: true, render: true, job: true, agent: true },
  },
  sender: { name: "osascript", clickThrough: false },
};

/** A fake server: presence replies come from `queue`, settings echo the patch. */
function fakeServer(queue: SentNotice[][] = []) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let status = structuredClone(STATUS);
  let seq = 0;
  const transport: TextTransport = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/notify") return { status: 200, text: JSON.stringify(status) };
    if (path === "/api/notify/settings") {
      const patch = body as any;
      status = {
        ...status,
        settings: { ...status.settings, ...patch, kinds: { ...status.settings.kinds, ...patch.kinds } },
      };
      return { status: 200, text: JSON.stringify(status) };
    }
    const notices = queue.shift() ?? [];
    seq = Math.max(seq, ...notices.map((item) => item.seq));
    return { status: 200, text: JSON.stringify({ ok: true, seq, notices }) };
  };
  return { transport, calls };
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted";
    return "granted" as NotificationPermission;
  });
  static made: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.made.push(this);
  }
}

let visible = true;
let focused = true;
beforeEach(() => {
  FakeNotification.made = [];
  FakeNotification.permission = "granted";
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  visible = true;
  focused = true;
});

describe("NotifyBridge", () => {
  it("reports presence and shows one browser notification per notice while the page is hidden; a click opens the card", async () => {
    visible = false;
    focused = false;
    const { transport, calls } = fakeServer([[], [sent(1, "browser")], [sent(1, "browser")]]);
    const open = vi.fn();
    const page = vi.fn();
    const bridge = new NotifyBridge(transport, { open, page });
    await bridge.report();
    expect(calls[0]!.body).toMatchObject({ focused: false, browser: "granted" });
    expect(calls[0]!.body.since).toBeUndefined();
    await bridge.report();
    expect(calls[1]!.body.since).toBe(0);
    await bridge.report();
    expect(FakeNotification.made).toHaveLength(1);
    const made = FakeNotification.made[0]!;
    expect(made.title).toBe("Agent Bros.: a decision is waiting");
    expect(made.options).toMatchObject({ body: "promo-acme · script", tag: "decision:1" });
    const focus = vi.fn();
    vi.stubGlobal("focus", focus);
    made.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(ROUTE);
    expect(page).not.toHaveBeenCalled();
  });

  it("a focused page shows the notice in the page, never as a browser notification", async () => {
    const { transport, calls } = fakeServer([[], [sent(1, "page"), sent(2, "browser", "card:x")]]);
    const page = vi.fn();
    const bridge = new NotifyBridge(transport, { open: vi.fn(), page });
    await bridge.report();
    await bridge.report();
    expect(calls[0]!.body.focused).toBe(true);
    expect(FakeNotification.made).toHaveLength(0);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("an OS notice is not repeated as a browser notification", async () => {
    visible = false;
    focused = false;
    const { transport } = fakeServer([[], [sent(1, "os")]]);
    const bridge = new NotifyBridge(transport, { open: vi.fn(), page: vi.fn() });
    await bridge.report();
    await bridge.report();
    expect(FakeNotification.made).toHaveLength(0);
  });

  it("stays idle without a server (fixture mode)", async () => {
    const bridge = new NotifyBridge(undefined, { open: vi.fn(), page: vi.fn() });
    expect(bridge.available).toBe(false);
    bridge.start();
    await bridge.report();
    bridge.stop();
  });
});

describe("router", () => {
  it("opens a project canvas at a decision", () => {
    expect(parseRoute(`#${ROUTE}`)).toEqual({
      name: "project",
      project: "promo-acme",
      view: "canvas",
      decision: "01JDEC.script",
    });
    expect(parseRoute("#/projects/promo-acme/decision/../x").name).toBe("not-found");
  });
});

describe("notification settings and prompt", () => {
  function setup(permission: NotificationPermission = "default") {
    FakeNotification.permission = permission;
    const server = fakeServer();
    const client = new FixtureApiClient({ fixture: "cards", now: () => FIXTURE_NOW });
    (client as unknown as { text: TextTransport }).text = server.transport;
    const store = fixtureStore(client);
    return { server, store };
  }

  it("never asks for the browser permission on load; the button asks once", async () => {
    const { store } = setup();
    await act(() => store.start());
    renderWith(
      <NotifyProvider intervalMs={60_000}>
        <NotificationSettings />
      </NotifyProvider>,
      { store },
    );
    const allow = await screen.findByRole("button", { name: "Allow browser notifications" });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await userEvent.click(allow);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await screen.findByText(/allowed: while a console tab is open/);
  });

  it("the first-run prompt turns notifications on (and asks the browser on that click)", async () => {
    const { server, store } = setup();
    await act(() => store.start());
    renderWith(
      <NotifyProvider intervalMs={60_000}>
        <NotifyPrompt />
      </NotifyProvider>,
      { store },
    );
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.path === "/api/notify/settings")?.body).toEqual({
        enabled: true,
        prompted: true,
      }),
    );
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull());
  });

  it("in fixture mode Settings says notifications are not running", async () => {
    const store = fixtureStore();
    await act(() => store.start());
    renderWith(<NotificationSettings />, { store });
    expect(screen.getByText("Notifications are not running in this server.")).toBeTruthy();
  });
});
