/**
 * Per-session hook state, `out/console/hooks/<session>.json` (HookCursorSchema, RFC 0004 §7.1 H6, H7): the project
 * the session works on, the relay watermark (`lastEventId`, a ULID whose time is the newest item already told) and
 * the hashes of the last `orient` facts and dashboard target. Written atomically.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONSOLE_ID, isObject, PROJECT_ID, readJson, str } from "./runtime.mjs";

export const HOOKS_CURSOR_DIR = "out/console/hooks";

export const cursorFile = (root, session) => path.join(root, HOOKS_CURSOR_DIR, `${session}.json`);

/** The session's cursor, or undefined (no session id, no file, or a file that does not look like a cursor). */
export function readCursor(root, session) {
  if (!str(session) || !CONSOLE_ID.test(session)) return undefined;
  const value = readJson(cursorFile(root, session));
  if (!isObject(value) || value.v !== 1 || value.session !== session) return undefined;
  return value;
}

/** Writes the cursor with the given changes; returns it, or undefined when it could not be written. */
export function writeCursor(root, { session, harness }, previous, changes, now = new Date()) {
  if (!str(session) || !CONSOLE_ID.test(session)) return undefined;
  const next = { v: 1, session, harness, ...(previous ?? {}), ...changes, updatedAt: now.toISOString() };
  next.v = 1;
  next.session = session;
  next.harness = harness;
  if (next.project !== undefined && !PROJECT_ID.test(String(next.project))) delete next.project;
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  const file = cursorFile(root, session);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next)}\n`);
    renameSync(temp, file);
    return next;
  } catch {
    return undefined;
  }
}
