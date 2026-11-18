/**
 * Waiting for the user's console action (RFC 0004 D11, §8, WP7b): `pnpm console:wait` blocks until the project's
 * journal gains a `decision.applied`, `decision.refused`, `control.changed` or `card.answered` event after the start
 * (or after `--since`), then returns it. Watches the journal's folder with fs.watch plus an interval poll (a missing
 * folder, a platform without watch events); each waiter tails the file itself, so any number of waiters all wake.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { ConsoleEvent } from "../../types/console";
import { projectEventsPath, readEventsAfter, readEventsFile, readTailEvents, type EventsCursor } from "./events-reader";

export const WAIT_EVENTS = ["decision.applied", "decision.refused", "control.changed", "card.answered"] as const;
export type WaitEventKind = (typeof WAIT_EVENTS)[number];

export const DEFAULT_WAIT_MINUTES = 30;
/** Commands whose answer carries the console block: a wait without `--since` starts after the newest one's end. */
export const NEXT_STEP_ALIASES: readonly string[] = ["next", "film:next", "footage:next", "film:init"];
/** How much of the journal's tail is searched for that answer. */
const NEXT_SEARCH_BYTES = 4 * 1024 * 1024;

/**
 * The id of the newest `cli.end` of a next-step command in the project's journal, or undefined (no journal, events
 * off, or none in its last 4 MB). A decision applied between that answer and the wait is then not missed.
 */
export function lastNextAnswerId(rootDir: string, project: string): string | undefined {
  const events = readTailEvents(projectEventsPath(rootDir, project), NEXT_SEARCH_BYTES);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === "cli.end" && event.alias && NEXT_STEP_ALIASES.includes(event.alias)) return event.id;
  }
  return undefined;
}

/** The id of the project's newest journal event, or undefined (the `console.lastEventId` of next-step answers). */
export function lastEventId(rootDir: string, project: string): string | undefined {
  return readTailEvents(projectEventsPath(rootDir, project)).at(-1)?.id;
}
/** setTimeout's ceiling is 2^31-1 ms (about 24.8 days); a wait is capped at 24 hours. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WAIT_POLL_MS = 1000;

export interface WaitOutcome {
  event: WaitEventKind | "timeout" | "interrupted";
  /** The journal event's id: pass it as `--since` to wait for the next one. */
  eventId?: string;
  at?: string;
  step?: string;
  decisionId?: string;
  decisionKind?: string;
  cardId?: string;
  /** The user's words (empty when a card was answered with only a choice or ratings). */
  answer?: string;
  choice?: string;
  state?: string;
  previous?: string;
  reason?: string;
  /** decision.refused: the refusing command's error code and message, when the event carries them. */
  error?: string;
  message?: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The outcome an event stands for, or undefined when it is not a console action of `project`. */
export function outcomeOf(event: ConsoleEvent, project: string): WaitOutcome | undefined {
  if (!(WAIT_EVENTS as readonly string[]).includes(event.kind)) return undefined;
  if (event.project !== undefined && event.project !== project) return undefined;
  const data = (event.data ?? {}) as Record<string, unknown>;
  const base = {
    event: event.kind as WaitEventKind,
    eventId: event.id,
    at: event.at,
    ...((str(event.step) ?? str(data.step)) ? { step: str(event.step) ?? str(data.step) } : {}),
  };
  const optional = (fields: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  switch (event.kind) {
    case "decision.applied":
    case "decision.refused":
      return {
        ...base,
        answer: str(data.answer) ?? "",
        ...optional({
          decisionId: str(data.decisionId),
          decisionKind: str(data.decisionKind),
          choice: str(data.choice),
          error: str(event.error) ?? str(data.error),
          message: str(event.message) ?? str(data.message),
        }),
      };
    case "control.changed":
      return {
        ...base,
        answer: str(data.answer) ?? "",
        ...optional({ state: str(data.state), previous: str(data.previous), reason: str(data.reason) }),
      };
    default:
      return {
        ...base,
        answer: str(data.text) ?? "",
        ...optional({ cardId: str(data.cardId), choice: str(data.choice) }),
      };
  }
}

export interface WaitOptions {
  rootDir: string;
  project: string;
  /** An event id: events after it count (default: only events after the start). */
  since?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Aborting resolves `interrupted`. */
  signal?: AbortSignal;
}

/** Resolves with the first console action of the project after the start (or `since`), on timeout or on abort. */
export function waitForConsole(options: WaitOptions): Promise<WaitOutcome> {
  const file = projectEventsPath(options.rootDir, options.project);
  const timeoutMs = Math.min(Math.max(0, options.timeoutMs ?? DEFAULT_WAIT_MINUTES * 60_000), MAX_WAIT_MS);
  // The tail starts at the file's end now; the page read below covers everything between `since` and here.
  let cursor: EventsCursor = endOf(file);

  return new Promise((resolve) => {
    let done = false;
    let watcher: FSWatcher | undefined;
    let pending: NodeJS.Timeout | undefined;
    const finish = (outcome: WaitOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      watcher?.close();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const first = (events: ConsoleEvent[]) => {
      for (const event of events) {
        const outcome = outcomeOf(event, options.project);
        if (outcome) return outcome;
      }
      return undefined;
    };
    const check = () => {
      if (done) return;
      try {
        const read = readEventsAfter(file, cursor);
        cursor = read.cursor;
        const outcome = first(read.events);
        if (outcome) finish(outcome);
      } catch {
        // an unreadable journal is retried at the next poll
      }
    };
    const onAbort = () => finish({ event: "interrupted" });
    // Referenced on purpose: it keeps the process alive while the watcher and the poll are not.
    const timer = setTimeout(() => finish({ event: "timeout" }), timeoutMs);
    const poll = setInterval(check, Math.max(20, options.pollMs ?? DEFAULT_WAIT_POLL_MS));
    poll.unref();
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.since) {
      for (let since: string | null = options.since, pages = 0; since && pages < 1000 && !done; pages++) {
        const page = readEventsFile(file, { since, limit: 1000 });
        const outcome = first(page.events);
        if (outcome) return finish(outcome);
        since = page.next;
      }
    }
    try {
      watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
        if (name && !String(name).startsWith("events")) return;
        if (pending) clearTimeout(pending);
        pending = setTimeout(check, 30);
        pending.unref();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      // no pipeline folder yet: the poll covers it
    }
    check();
  });
}

/** The journal's end now (size and inode; empty when missing), so the tail reads only lines appended from here on. */
function endOf(file: string): EventsCursor {
  try {
    const stat = statSync(file);
    return { offset: stat.size, ino: stat.ino };
  } catch {
    return { offset: 0 };
  }
}
