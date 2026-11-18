/**
 * File watching for the console (RFC 0004 FR1: a view updates within 1 s of a file change or a journal line):
 * a recursive `fs.watch` on the project directory, debounced 250 ms (flushed at the latest 750 ms after the first
 * change), ignoring downloads and caches, plus a tail of the project's journal that yields only new complete lines.
 * When recursive watching is unavailable it falls back to a one-second poll of the journal and the pipeline folder.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { ConsoleEventSchema, type ConsoleEvent } from "../../types/console";

export const WATCH_DEBOUNCE_MS = 250;
export const WATCH_MAX_WAIT_MS = 750;

const IGNORED_SEGMENTS = new Set([
  "downloads",
  "cache",
  ".cache",
  "caches",
  "node_modules",
  ".git",
  "tmp",
  ".tmp",
  "__pycache__",
]);

/** Downloads, caches, temporary and editor files never change a view. */
export function ignoredChange(relative: string): boolean {
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return true;
  const name = segments.at(-1) ?? "";
  return name === ".DS_Store" || /\.(?:tmp|swp|lock)$/i.test(name) || name.endsWith("~");
}

/** Reads new complete lines appended to a journal since the last call; a shrunken file (rotation) restarts at 0. */
export class JournalTail {
  private offset: number;
  private rest = "";
  constructor(
    readonly file: string,
    fromStart = false,
  ) {
    this.offset = fromStart ? 0 : sizeOf(file);
  }
  read(maxBytes = 4 * 1024 * 1024): ConsoleEvent[] {
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      this.offset = 0;
      this.rest = "";
      return [];
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.rest = "";
      }
      if (size === this.offset) return [];
      const length = Math.min(size - this.offset, maxBytes);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, this.offset);
      this.offset += read;
      const text = this.rest + buffer.subarray(0, read).toString("utf8");
      const lines = text.split("\n");
      this.rest = lines.pop() ?? "";
      const events: ConsoleEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = ConsoleEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) events.push(parsed.data);
        } catch {
          // A malformed line is skipped; the journal writer never fails a command and neither does its reader.
        }
      }
      return events;
    } finally {
      closeSync(fd);
    }
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export interface TreeWatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  /** Polling interval when recursive `fs.watch` is unavailable. */
  pollMs?: number;
  /** Files whose mtime and size the polling fallback compares (absolute). */
  pollFiles?: string[];
}

/**
 * Watches `directory` recursively and calls `onFlush` with the changed relative paths (an empty list when the platform
 * did not say which file changed), at most once per debounce window. Returns the stop function.
 */
export function watchTree(
  directory: string,
  onFlush: (changed: string[]) => void,
  options: TreeWatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
  let pending: Set<string> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let firstAt = 0;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    const changed = pending ? [...pending] : [];
    pending = undefined;
    if (!stopped) onFlush(changed);
  };
  const schedule = (relative: string | undefined) => {
    if (stopped) return;
    if (relative && ignoredChange(relative)) return;
    const now = performance.now();
    if (!pending) {
      pending = new Set();
      firstAt = now;
    }
    if (relative) pending.add(relative.split(path.sep).join("/"));
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now));
    timer = setTimeout(flush, wait);
    timer.unref();
  };

  let watcher: FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;
  const startPolling = () => {
    const files = options.pollFiles ?? [directory];
    const signature = () =>
      files
        .map((file) => {
          try {
            const info = statSync(file);
            return `${info.mtimeMs}:${info.size}`;
          } catch {
            return "-";
          }
        })
        .join("|");
    let last = signature();
    poll = setInterval(() => {
      const next = signature();
      if (next !== last) {
        last = next;
        schedule(undefined);
      }
    }, options.pollMs ?? 1000);
    poll.unref();
  };
  try {
    watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) =>
      schedule(filename ? String(filename) : undefined),
    );
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
      if (!stopped && !poll) startPolling();
    });
  } catch {
    if (existsSync(directory)) startPolling();
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    watcher?.close();
  };
}
