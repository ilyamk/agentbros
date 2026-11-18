/**
 * The page half of console notifications (RFC 0004 D23, WP14). The server decides what deserves a notice and sends
 * each to one channel; this bridge reports the tab's presence (focus and browser permission) every few seconds and on
 * focus changes, and receives the notices since its last `seq`:
 *
 * - `browser` (the server left it to an open tab with permission): a browser `Notification` while the page is hidden,
 *   its click focuses the tab at the notice's route; an in-page notice when the page is visible;
 * - `page` and `os`: an in-page notice when the page is visible (the OS already had its own).
 *
 * The browser permission is asked only on a user gesture ({@link requestBrowserPermission}), never on load. The
 * server routes are `/api/notify` (status), `/api/notify/settings` and `/api/notify/presence`
 * (src/lib/console/http/notify-routes.ts); fixture mode has none, and the bridge stays idle.
 */
import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { TextTransport } from "@/api/types";

export const NOTIFY_KINDS = ["decision", "card", "failure", "render", "job", "agent"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export type BrowserPermission = "granted" | "denied" | "default" | "unsupported";

const Kinds = z.object(
  Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, z.boolean()])) as Record<NotifyKind, z.ZodBoolean>,
);

export const NotifyStatusSchema = z.object({
  ok: z.literal(true),
  settings: z.object({ enabled: z.boolean(), prompted: z.boolean(), kinds: Kinds }),
  sender: z.object({ name: z.enum(["terminal-notifier", "osascript", "none"]), clickThrough: z.boolean() }),
  disabledBy: z.literal("env").optional(),
});
export type NotifyStatus = z.infer<typeof NotifyStatusSchema>;

const SentNoticeSchema = z.object({
  seq: z.number(),
  at: z.string(),
  channel: z.enum(["page", "browser", "os"]),
  notice: z.object({
    key: z.string(),
    kind: z.enum(NOTIFY_KINDS),
    project: z.string().optional(),
    title: z.string(),
    body: z.string(),
    route: z.string(),
  }),
});
export type SentNotice = z.infer<typeof SentNoticeSchema>;

const PresenceReplySchema = z.object({ ok: z.literal(true), seq: z.number(), notices: z.array(SentNoticeSchema) });

export const PRESENCE_INTERVAL_MS = 5000;

export interface NotifySettingsPatch {
  enabled?: boolean;
  prompted?: boolean;
  kinds?: Partial<Record<NotifyKind, boolean>>;
}

export function browserPermission(): BrowserPermission {
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  return N ? (N.permission as BrowserPermission) : "unsupported";
}

/** Asks for the browser permission: call it only from a click handler. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  if (!N) return "unsupported";
  try {
    return (await N.requestPermission()) as BrowserPermission;
  } catch {
    return browserPermission();
  }
}

/** Status of the server's notifications, for Settings and the first-run prompt. */
type Snapshot = { status?: NotifyStatus; unavailable?: boolean; permission: BrowserPermission };

export interface NotifyHandlers {
  /** An in-page notice (the page is visible). */
  page(item: SentNotice): void;
  /** Opens a hash route (`/projects/<id>/…`). */
  open(route: string): void;
}

const randomTab = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `tab-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export class NotifyBridge {
  private snapshot: Snapshot = { permission: browserPermission() };
  private readonly listeners = new Set<() => void>();
  private readonly tab = randomTab();
  private since: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly shown = new Set<string>();
  private stops: (() => void)[] = [];

  constructor(
    private readonly transport: TextTransport | undefined,
    private readonly handlers: NotifyHandlers,
    private readonly doc: Document = document,
  ) {}

  get available() {
    return !!this.transport;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    if (!this.transport) throw new Error("no server");
    const reply = await this.transport(method, path, body);
    if (reply.status === 501) {
      this.set({ unavailable: true });
      throw new Error("notifications unavailable");
    }
    if (reply.status !== 200) throw new Error(`notify ${path}: ${reply.status}`);
    return JSON.parse(reply.text);
  }

  async refresh(): Promise<void> {
    try {
      this.set({ status: NotifyStatusSchema.parse(await this.call("GET", "/api/notify")), unavailable: false });
    } catch {
      // unavailable or offline: Settings shows it
    }
  }

  async update(patch: NotifySettingsPatch): Promise<void> {
    this.set({ status: NotifyStatusSchema.parse(await this.call("POST", "/api/notify/settings", patch)) });
  }

  /** After a user gesture: asks the browser and reports the answer at once. */
  async allowBrowser(): Promise<BrowserPermission> {
    const permission = await requestBrowserPermission();
    this.set({ permission });
    void this.report();
    return permission;
  }

  /** One presence report; shows the notices it returns. */
  async report(gone = false): Promise<void> {
    if (!this.transport || this.snapshot.unavailable) return;
    const permission = browserPermission();
    if (permission !== this.snapshot.permission) this.set({ permission });
    try {
      const reply = PresenceReplySchema.parse(
        await this.call("POST", "/api/notify/presence", {
          tab: this.tab,
          focused: this.doc.hasFocus() && this.doc.visibilityState === "visible",
          browser: permission,
          ...(this.since !== undefined ? { since: this.since } : {}),
          ...(gone ? { gone: true } : {}),
        }),
      );
      this.since = reply.seq;
      for (const item of reply.notices) this.show(item);
    } catch {
      // the next heartbeat retries
    }
  }

  private show(item: SentNotice): void {
    if (this.shown.has(item.notice.key)) return;
    this.shown.add(item.notice.key);
    const hidden = this.doc.visibilityState !== "visible" || !this.doc.hasFocus();
    const N = (globalThis as { Notification?: typeof Notification }).Notification;
    if (item.channel === "browser" && hidden && N && N.permission === "granted") {
      try {
        const notification = new N(item.notice.title, { body: item.notice.body, tag: item.notice.key });
        notification.onclick = () => {
          globalThis.focus?.();
          this.handlers.open(item.notice.route);
          notification.close();
        };
        return;
      } catch {
        // fall through to the page
      }
    }
    if (this.doc.visibilityState === "visible") this.handlers.page(item);
  }

  /** Starts the heartbeat: every few seconds and on every focus or visibility change. */
  start(intervalMs = PRESENCE_INTERVAL_MS): this {
    if (!this.transport) return this;
    void this.refresh();
    void this.report();
    this.timer = setInterval(() => void this.report(), intervalMs);
    const onChange = () => void this.report();
    const onHide = () => void this.report(true);
    const win = this.doc.defaultView;
    win?.addEventListener("focus", onChange);
    win?.addEventListener("blur", onChange);
    win?.addEventListener("pagehide", onHide);
    this.doc.addEventListener("visibilitychange", onChange);
    this.stops.push(() => {
      win?.removeEventListener("focus", onChange);
      win?.removeEventListener("blur", onChange);
      win?.removeEventListener("pagehide", onHide);
      this.doc.removeEventListener("visibilitychange", onChange);
    });
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const stop of this.stops.splice(0)) stop();
  }
}

export function useNotify(bridge: NotifyBridge | undefined): Snapshot {
  return useSyncExternalStore(bridge?.subscribe ?? noopSubscribe, bridge?.getSnapshot ?? emptySnapshot);
}

const noopSubscribe = () => () => undefined;
const EMPTY: Snapshot = { permission: "unsupported" };
const emptySnapshot = () => EMPTY;
