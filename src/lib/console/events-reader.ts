/**
 * Reading the event journal (RFC 0004 D7, §9.1) for the console server (WP2) and the projector (WP3): pages by event
 * id, the newest lines of the global journal, and a tail cursor by byte offset for watchers. Torn, garbage or
 * schema-invalid lines are skipped, never fatal. Reads the live file and any not-yet-compressed `.rotating` files;
 * compressed `events.<n>.jsonl.gz` archives are history the console does not page through.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import {
  ConsoleEventSchema,
  EVENTS_FILE,
  GLOBAL_EVENTS_FILE,
  ProjectIdSchema,
  type ConsoleEvent,
  type EventsPage,
} from "../../types/console";

export const DEFAULT_EVENTS_LIMIT = 200;
export const MAX_EVENTS_LIMIT = 1000;

/** Absolute path of a project's live journal (it may not exist). Throws on an invalid project id. */
export function projectEventsPath(rootDir: string, projectId: string): string {
  ProjectIdSchema.parse(projectId);
  return path.resolve(rootDir, "public", "projects", projectId, EVENTS_FILE);
}

/** Absolute path of the global journal, `out/console/events.jsonl`. */
export const globalEventsPath = (rootDir: string): string => path.resolve(rootDir, GLOBAL_EVENTS_FILE);

/** One line as an event, or undefined for a torn, garbage or invalid line. */
export function parseEventLine(line: string): ConsoleEvent | undefined {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = ConsoleEventSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every valid event of a JSONL text, in file order. */
export const parseEventLines = (text: string): ConsoleEvent[] =>
  text.split("\n").flatMap((line) => parseEventLine(line) ?? []);

const readText = (file: string): string => {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
};

/** Rotated files not yet compressed (`events.<ulid>.<pid>.rotating`, see journal.ts), oldest first. */
const ROTATING = /^events\.[0-9A-Z]{26}\.\d+\.rotating$/;

/**
 * A journal's recent text: the plain `.rotating` files beside it (rotated, not yet compressed, oldest first), then the
 * live file, so nothing written around a rotation is missed. Each part ends with a newline before the next starts.
 */
function readJournalText(file: string): string {
  let rotating: string[] = [];
  try {
    rotating = readdirSync(path.dirname(file))
      .filter((name) => ROTATING.test(name))
      .sort();
  } catch {
    // no directory: no journal
  }
  return [...rotating.map((name) => path.join(path.dirname(file), name)), file]
    .map(readText)
    .filter(Boolean)
    .map((text) => (text.endsWith("\n") ? text : `${text}\n`))
    .join("");
}

const clampLimit = (limit: number | undefined) =>
  Math.min(MAX_EVENTS_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_EVENTS_LIMIT)));

/** The id of a line without validating it (finding a cursor must not parse every event); writers put `id` first. */
const idOf = (line: string): string | undefined => /"id":"([0-9A-Za-z]{26})"/.exec(line)?.[1];

/**
 * A page of a journal file, oldest first. `since` is the last event id the caller has: the page starts after that
 * line (or, when the line is gone after a rotation, after every id that sorts at or below it). `next` is the id to pass
 * as `since` for the following page, or null when this page reached the end of the file.
 */
export function readEventsFile(file: string, options: { since?: string; limit?: number } = {}): EventsPage {
  const limit = clampLimit(options.limit);
  const lines = readJournalText(file).split("\n");
  let start = 0;
  if (options.since) {
    const at = lines.findIndex((line) => idOf(line) === options.since);
    if (at >= 0) start = at + 1;
    else {
      const since = options.since.toUpperCase();
      start = lines.findIndex((line) => (idOf(line) ?? "").toUpperCase() > since);
      if (start < 0) start = lines.length;
    }
  }
  const events: ConsoleEvent[] = [];
  let index = start;
  for (; index < lines.length && events.length < limit; index++) {
    const event = parseEventLine(lines[index]!);
    if (event) events.push(event);
  }
  const more = lines.slice(index).some((line) => parseEventLine(line) !== undefined);
  return { v: 1, events, next: more && events.length ? events.at(-1)!.id : null };
}

/** A page of a project's journal (see {@link readEventsFile}); an empty page when the project has none. */
export function readEvents(
  rootDir: string,
  projectId: string,
  options: { since?: string; limit?: number } = {},
): EventsPage {
  return readEventsFile(projectEventsPath(rootDir, projectId), options);
}

/** The newest `limit` events of the global journal (or of `project` within it), oldest first. */
export function readRecentEvents(rootDir: string, options: { limit?: number; project?: string } = {}): ConsoleEvent[] {
  const limit = clampLimit(options.limit);
  const lines = readJournalText(globalEventsPath(rootDir)).split("\n");
  const events: ConsoleEvent[] = [];
  for (let index = lines.length - 1; index >= 0 && events.length < limit; index--) {
    const event = parseEventLine(lines[index]!);
    if (event && (!options.project || event.project === options.project)) events.push(event);
  }
  return events.reverse();
}

/** Where a tail reader stopped: the byte offset after the last complete line, and the file's inode. */
export type EventsCursor = { offset: number; ino?: number };

/**
 * The complete lines appended after `cursor` (a torn last line waits for the next call). When the file shrank or was
 * replaced (rotation: another inode), reading starts again from the top and `reset` is true. A missing file is empty.
 */
export function readEventsAfter(
  file: string,
  cursor: EventsCursor = { offset: 0 },
  options: { maxBytes?: number } = {},
): { events: ConsoleEvent[]; cursor: EventsCursor; reset: boolean } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    // Missing for a moment while a rotation renames it: keep the cursor (and its inode), so the next read finishes the
    // rotated file past the cursor before the new file's lines. A file that reappears smaller or replaced resets then.
    return { events: [], cursor, reset: false };
  }
  try {
    const stat = fstatSync(fd);
    const replaced = cursor.ino !== undefined && cursor.ino !== stat.ino;
    const reset = stat.size < cursor.offset || replaced;
    const from = reset ? 0 : cursor.offset;
    // After a rotation, first the old file's lines past the cursor (it is a `.rotating` file now, same inode).
    const earlier = replaced ? rotatedRest(file, cursor) : [];
    const length = Math.min(stat.size - from, options.maxBytes ?? 16 * 1024 * 1024);
    if (length <= 0) return { events: earlier, cursor: { offset: from, ino: stat.ino }, reset };
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, from);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a);
    if (end < 0) return { events: earlier, cursor: { offset: from, ino: stat.ino }, reset };
    return {
      events: [...earlier, ...parseEventLines(buffer.subarray(0, end).toString("utf8"))],
      cursor: { offset: from + end + 1, ino: stat.ino },
      reset,
    };
  } finally {
    closeSync(fd);
  }
}

/** The complete lines past the cursor in the rotated (`.rotating`) file that still has the cursor's inode, if any. */
function rotatedRest(file: string, cursor: EventsCursor): ConsoleEvent[] {
  try {
    const directory = path.dirname(file);
    for (const name of readdirSync(directory).filter((entry) => ROTATING.test(entry))) {
      const rotated = path.join(directory, name);
      if (statSync(rotated).ino !== cursor.ino) continue;
      const text = readFileSync(rotated).subarray(cursor.offset).toString("utf8");
      return parseEventLines(text.slice(0, text.lastIndexOf("\n") + 1));
    }
  } catch {
    // nothing recoverable: the reset still reads the new file from the top
  }
  return [];
}

/** The size of a journal file now (0 when missing): a watcher's starting offset when it wants only new lines. */
export function eventsFileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The valid events in the last `maxBytes` of a journal file (the first, partial line dropped), oldest first; empty
 * when the file is missing. Cheap for "the newest event" questions on a large journal.
 */
export function readTailEvents(file: string, maxBytes = 64 * 1024): ConsoleEvent[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    let text = buffer.subarray(0, read).toString("utf8");
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return parseEventLines(text);
  } finally {
    closeSync(fd);
  }
}
