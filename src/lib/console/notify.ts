/**
 * Console notifications (RFC 0004 D23, WP14, A12): the console server calls the user when they are needed. A scan
 * reads each project's new journal lines (from a persisted cursor) and its waiting decisions, turns them into notices
 * ({@link eventNotice}, {@link decisionNotice}), drops what was already sent (dedupe by decision, card, job or event
 * key), what its kind toggle switches off and what a cooldown holds, then rate-limits the rest (the overflow becomes
 * one "N more" notice). Each notice goes to exactly one channel: nothing while a console tab is focused (the page
 * shows it), the tab's browser notification when it has permission, else the OS sender.
 *
 * Runs only inside the console server process (never in a CLI). Off until the user enables it; `AGENTBROS_NOTIFY=off`
 * turns it off whatever the settings say.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PROJECTS_DIR, ProjectIdSchema, type Decision } from "../../types/console";
import { readControlLenient } from "./control";
import { eventsFileSize, projectEventsPath, readEventsAfter } from "./events-reader";
import {
  decisionNotice,
  eventNotice,
  overflowNotice,
  type Notice,
  type NotifyChannel,
  type NotifyKind,
} from "./notify-rules";
import { detectSender, type NotificationSender } from "./notify-sender";
import {
  applySettingsPatch,
  notifyDisabledByEnv,
  readNotifyState,
  SEEN_MAX,
  writeNotifyState,
  type NotifySettings,
  type NotifySettingsPatch,
  type NotifyState,
} from "./notify-state";

export const NOTIFY_POLL_MS = 5000;
export const NOTIFY_DEBOUNCE_MS = 300;
/** The same gate, failing step or agent prompt is notified at most once per this period. */
export const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
/** Rate limit: a bucket of this many notices, one more every `refillMs`. */
export const NOTIFY_RATE = { capacity: 4, refillMs: 30_000 } as const;
/** A tab that has not reported for this long is gone (background tabs are throttled to about a minute). */
export const PRESENCE_TTL_MS = 75_000;
/** Notices kept for the open tabs to pick up. */
export const RING_MAX = 50;

export interface NotifierOptions {
  rootDir: string;
  /** Server origin for the click's deep link, e.g. `http://127.0.0.1:4317`. */
  origin: string;
  sender?: NotificationSender;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The project's waiting decisions (default: none; the server passes the projector's view). */
  waiting?: (project: string) => Promise<readonly Decision[]>;
  /** Subscribes to any project change (the server passes `source.watch(undefined, …)`). */
  watch?: (onChange: () => void) => () => void;
  /** Fallback scan interval; 0 disables the timer (tests call {@link Notifier.scan}). */
  pollMs?: number;
  cooldownMs?: number;
  rate?: { capacity: number; refillMs: number };
  presenceTtlMs?: number;
  log?: (line: string) => void;
}

export interface SentNotice {
  seq: number;
  at: string;
  channel: NotifyChannel;
  notice: Notice;
}

export interface NotifyStatus {
  settings: NotifySettings;
  sender: { name: NotificationSender["name"]; clickThrough: boolean };
  /** `env` when AGENTBROS_NOTIFY=off. */
  disabledBy?: "env";
}

export interface PresenceReport {
  /** A random id per tab. */
  tab: string;
  focused: boolean;
  /** The tab's `Notification.permission` (or `unsupported`). */
  browser: "granted" | "denied" | "default" | "unsupported";
  /** The last `seq` the tab has seen; omitted on the first report (no backlog). */
  since?: number;
  /** The tab is closing. */
  gone?: boolean;
}

/** The deep link a notification click opens: the console's hash route, never the session token. */
export const deepLink = (origin: string, route: string) => `${origin.replace(/\/$/, "")}/#${route}`;

export class Notifier {
  readonly sender: NotificationSender;
  private state: NotifyState;
  private readonly now: () => number;
  private readonly presences = new Map<string, { at: number; focused: boolean; browser: PresenceReport["browser"] }>();
  private readonly ring: SentNotice[] = [];
  private seq = 0;
  private bucket: { tokens: number; at: number };
  private overflow = 0;
  private running: Promise<SentNotice[]> | undefined;
  private again = false;
  private stops: (() => void)[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: NotifierOptions) {
    this.sender = options.sender ?? detectSender({ env: options.env });
    this.now = options.now ?? Date.now;
    this.state = readNotifyState(options.rootDir);
    this.bucket = { tokens: this.rate.capacity, at: this.now() };
  }

  private get rate() {
    return this.options.rate ?? NOTIFY_RATE;
  }

  /** AGENTBROS_NOTIFY=off. */
  get killed(): boolean {
    return notifyDisabledByEnv(this.options.env ?? process.env);
  }

  get active(): boolean {
    return !this.killed && this.state.settings.enabled;
  }

  status(): NotifyStatus {
    return {
      settings: this.state.settings,
      sender: { name: this.sender.name, clickThrough: this.sender.clickThrough },
      ...(this.killed ? { disabledBy: "env" as const } : {}),
    };
  }

  /** Changes the switches. Turning notifications on starts every project at its present state (no backlog). */
  async update(patch: NotifySettingsPatch): Promise<NotifyStatus> {
    const before = this.state.settings.enabled;
    this.state = { ...this.state, settings: applySettingsPatch(this.state.settings, patch) };
    if (!before && this.state.settings.enabled) {
      this.state.enabledAt = this.now();
      this.state.cursors = {};
      for (const project of this.projects()) await this.baseline(project);
    }
    // A failed write is the caller's error (the route answers 500 without the path); the scan's writes stay quiet.
    writeNotifyState(this.options.rootDir, this.state);
    this.dirty = false;
    return this.status();
  }

  /** Records a tab's presence; returns the notices after its `since`. */
  presence(report: PresenceReport): { seq: number; notices: SentNotice[] } {
    if (report.gone) this.presences.delete(report.tab);
    else this.presences.set(report.tab, { at: this.now(), focused: report.focused, browser: report.browser });
    if (this.presences.size > 64) {
      const oldest = [...this.presences.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.presences.delete(oldest[0]);
    }
    const since = report.since;
    return { seq: this.seq, notices: since === undefined ? [] : this.ring.filter((item) => item.seq > since) };
  }

  /** Where a notice goes now: a focused tab shows it, a tab with browser permission notifies, else the OS. */
  channel(): NotifyChannel {
    const ttl = this.options.presenceTtlMs ?? PRESENCE_TTL_MS;
    const now = this.now();
    const live = [...this.presences.values()].filter((presence) => now - presence.at < ttl);
    if (live.some((presence) => presence.focused)) return "page";
    if (live.some((presence) => presence.browser === "granted")) return "browser";
    return "os";
  }

  /** Subscribes to changes and starts the fallback poll. */
  start(): this {
    if (this.options.watch) this.stops.push(this.options.watch(() => this.schedule()));
    const pollMs = this.options.pollMs ?? NOTIFY_POLL_MS;
    if (pollMs > 0) {
      const timer = setInterval(() => void this.scan(), pollMs);
      timer.unref();
      this.stops.push(() => clearInterval(timer));
    }
    void this.scan();
    return this;
  }

  private schedule(): void {
    if (this.closed || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.scan();
    }, NOTIFY_DEBOUNCE_MS);
    this.debounce.unref();
  }

  close(): void {
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    for (const stop of this.stops.splice(0)) stop();
  }

  /** One scan at a time; a scan asked for meanwhile runs once more afterwards. Resolves with what this scan sent. */
  scan(): Promise<SentNotice[]> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      try {
        return await this.scanOnce();
      } catch (error) {
        this.options.log?.(`notify: scan failed: ${(error as Error).message ?? error}`);
        return [];
      } finally {
        this.running = undefined;
        if (this.again && !this.closed) {
          this.again = false;
          void this.scan();
        }
      }
    })();
    this.running = run;
    return run;
  }

  private projects(): string[] {
    try {
      return readdirSync(path.join(this.options.rootDir, PROJECTS_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ProjectIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async waitingOf(project: string): Promise<readonly Decision[]> {
    try {
      return (await this.options.waiting?.(project)) ?? [];
    } catch {
      return [];
    }
  }

  /** The project's journal end and its present waiting decisions count as seen. */
  private async baseline(project: string): Promise<void> {
    const file = projectEventsPath(this.options.rootDir, project);
    let ino: number | undefined;
    try {
      ino = statSync(file).ino;
    } catch {
      ino = undefined;
    }
    this.state.cursors[project] = { offset: eventsFileSize(file), ...(ino !== undefined ? { ino } : {}) };
    this.dirty = true;
    for (const decision of await this.waitingOf(project)) this.markSeen(decisionNotice(decision).key);
  }

  private seenSet?: Set<string>;
  private isSeen(key: string): boolean {
    this.seenSet ??= new Set(this.state.seen);
    return this.seenSet.has(key);
  }

  private markSeen(key: string): void {
    if (this.isSeen(key)) return;
    this.seenSet!.add(key);
    this.state.seen.push(key);
    this.dirty = true;
    if (this.state.seen.length > SEEN_MAX) {
      for (const dropped of this.state.seen.splice(0, this.state.seen.length - SEEN_MAX)) this.seenSet!.delete(dropped);
    }
  }

  private dirty = false;

  private persist(): void {
    try {
      writeNotifyState(this.options.rootDir, this.state);
      this.dirty = false;
    } catch (error) {
      this.options.log?.(`notify: cannot write its state: ${(error as Error).message ?? error}`);
    }
  }

  /** Projects created after notifications were turned on are read from their journal's start. */
  private isNew(project: string): boolean {
    try {
      const dir = path.join(this.options.rootDir, PROJECTS_DIR, project);
      const stat = statSync(dir);
      const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
      return this.state.enabledAt !== undefined && born >= this.state.enabledAt;
    } catch {
      return false;
    }
  }

  private async collect(): Promise<Notice[]> {
    const candidates: Notice[] = [];
    const projects = this.projects();
    for (const project of Object.keys(this.state.cursors))
      if (!projects.includes(project)) {
        delete this.state.cursors[project];
        this.dirty = true;
      }
    for (const project of projects) {
      const cursor = this.state.cursors[project];
      if (!cursor && !this.isNew(project)) {
        await this.baseline(project);
        continue;
      }
      const read = readEventsAfter(projectEventsPath(this.options.rootDir, project), cursor ?? { offset: 0 });
      if (!cursor || cursor.offset !== read.cursor.offset || cursor.ino !== read.cursor.ino) this.dirty = true;
      this.state.cursors[project] = read.cursor;
      let pausedAt: string | undefined;
      for (const event of read.events) {
        if (event.kind === "cli.end" && event.error === "PAUSED" && pausedAt === undefined)
          pausedAt = readControlLenient(path.join(this.options.rootDir, PROJECTS_DIR, project))?.at ?? "";
        const notice = eventNotice(event, { pausedAt: pausedAt || undefined });
        if (notice) candidates.push(notice);
      }
      for (const decision of await this.waitingOf(project)) candidates.push(decisionNotice(decision));
    }
    return candidates;
  }

  /** Tokens left after refilling the bucket. */
  private tokens(): number {
    const { capacity, refillMs } = this.rate;
    const now = this.now();
    const refill = Math.floor((now - this.bucket.at) / refillMs);
    if (refill > 0) this.bucket = { tokens: Math.min(capacity, this.bucket.tokens + refill), at: now };
    return this.bucket.tokens;
  }

  /**
   * What the rate limit lets out: each notice while tokens last; when the bucket runs low, the rest as one "N more"
   * notice; with no token left they wait (counted) and come out as that one notice when a token is free.
   */
  private limit(fresh: Notice[]): Notice[] {
    const outgoing: Notice[] = [];
    const overflow = (count: number) => {
      this.bucket.tokens -= 1;
      outgoing.push(overflowNotice(count, this.seq + outgoing.length + 1));
    };
    if (this.overflow > 0) {
      if (this.tokens() === 0) this.overflow += fresh.length;
      else {
        overflow(this.overflow + fresh.length);
        this.overflow = 0;
      }
      return outgoing;
    }
    for (const [index, notice] of fresh.entries()) {
      const left = fresh.length - index;
      const tokens = this.tokens();
      if (tokens === 0) {
        this.overflow += left;
        break;
      }
      if (left > 1 && tokens === 1) {
        overflow(left);
        break;
      }
      this.bucket.tokens -= 1;
      outgoing.push(notice);
    }
    return outgoing;
  }

  private async scanOnce(): Promise<SentNotice[]> {
    if (!this.active || this.closed) return [];
    const now = this.now();
    const cooldownMs = this.options.cooldownMs ?? NOTIFY_COOLDOWN_MS;
    for (const [key, at] of Object.entries(this.state.cooldowns))
      if (now - at >= cooldownMs) {
        delete this.state.cooldowns[key];
        this.dirty = true;
      }
    const fresh: Notice[] = [];
    for (const notice of await this.collect()) {
      // At most once: a key counts as sent before delivery. A kind switched off drops its notices for good (seen), so
      // turning it on later sends no history. A cooldown holds a standing notice (a waiting decision is derived again
      // next scan and sent once the cooldown ends) and folds a journal event into the notice that started it.
      if (this.isSeen(notice.key)) continue;
      if (!this.state.settings.kinds[notice.kind as NotifyKind]) {
        this.markSeen(notice.key);
        continue;
      }
      if (notice.cooldown && this.state.cooldowns[notice.cooldown] !== undefined) {
        if (!notice.standing) this.markSeen(notice.key);
        continue;
      }
      // Two standing notices of one situation in the same scan: the first goes, the second waits its turn.
      if (notice.cooldown) {
        this.state.cooldowns[notice.cooldown] = now;
        this.dirty = true;
      }
      this.markSeen(notice.key);
      fresh.push(notice);
    }
    const outgoing = this.limit(fresh);
    // Written only when something moved: an idle scan touches no file.
    if (this.dirty) this.persist();
    const channel = this.channel();
    const sent: SentNotice[] = [];
    for (const notice of outgoing) {
      const item: SentNotice = { seq: ++this.seq, at: new Date(now).toISOString(), channel, notice };
      this.ring.push(item);
      if (this.ring.length > RING_MAX) this.ring.shift();
      sent.push(item);
      if (channel !== "os") continue;
      try {
        await this.sender.send({
          title: notice.title,
          body: notice.body,
          url: deepLink(this.options.origin, notice.route),
          group: `agentbros:${notice.key}`,
        });
      } catch (error) {
        this.options.log?.(`notify: ${this.sender.name} failed: ${(error as Error).message ?? error}`);
      }
    }
    return sent;
  }
}
