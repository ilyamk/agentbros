/**
 * The `wake` role (RFC 0004 §7.1, Claude Code only): installed on Stop as `async` + `asyncRewake`. When something
 * waits for the user (an agent card, an approval at the leased step, a pause), it waits up to 30 minutes for the user
 * to act in the console and exits 2 with a one-line fact, which wakes Claude. It exits 0 at once on
 * `stop_hook_active`, without a project or anything waiting; and later on timeout, or when the session moved on
 * (its cursor changed: a new prompt, a newer wake, the session's end).
 *
 * AGENTBROS_HOOK_WAKE_MINUTES (default 30, at most 58: the entry's timeout is 3,600 s) or AGENTBROS_HOOK_WAKE_MS sets
 * the wait; AGENTBROS_HOOK_WAKE_POLL_MS (default 2,000) the fallback poll beside fs.watch.
 */
import { watch } from "node:fs";
import path from "node:path";
import { readCursor, writeCursor } from "./cursor.mjs";
import { wakeLine } from "./facts.mjs";
import { projectDirOf, resolveProject, ulid, ulidTime } from "./runtime.mjs";
import { CARDS_DIR, consoleItemsSince, INBOX_DIR, waitingFor } from "./state.mjs";

export const WAKE_MAX_MS = 58 * 60 * 1000;

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

export function wakeTimeoutMs(env = process.env) {
  const ms = positive(env.AGENTBROS_HOOK_WAKE_MS) ?? (positive(env.AGENTBROS_HOOK_WAKE_MINUTES) ?? 30) * 60_000;
  return Math.min(ms, WAKE_MAX_MS);
}

/** Resolves to `{ exit: 2, stderr }` when the user acted, else `{ exit: 0 }`. */
export async function wake(payload, ctx) {
  const { root, env } = ctx;
  if (payload.event !== "Stop" || payload.harness !== "claude-code" || payload.stopHookActive || !payload.sessionId)
    return { exit: 0 };
  const cursor = readCursor(root, payload.sessionId);
  const project = resolveProject({ root, cursor, env, now: ctx.now });
  if (!project) return { exit: 0 };
  const dir = projectDirOf(root, project);
  // Everything after the session's watermark counts, so an answer given before this Stop and not yet told still wakes.
  const told = ulidTime(cursor?.lastEventId);
  const since = Number.isFinite(told) ? told : ctx.now.getTime();
  const waiting = waitingFor(root, project, ctx.now);
  if (!waiting.cards && !waiting.gate && !waiting.paused && !consoleItemsSince(dir, since).length) return { exit: 0 };
  const session = { session: payload.sessionId, harness: payload.harness };
  const mine = writeCursor(root, session, cursor, { project }, ctx.now);
  if (!mine) return { exit: 0 };
  const timeout = wakeTimeoutMs(env);
  const poll = Math.max(20, positive(env.AGENTBROS_HOOK_WAKE_POLL_MS) ?? 2000);

  return new Promise((resolve) => {
    const watchers = [];
    let done = false;
    let timer;
    let interval;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(interval);
      for (const watcher of watchers) watcher.close();
      resolve(result);
    };
    const check = () => {
      if (done) return;
      try {
        const now = readCursor(root, payload.sessionId);
        if (!now || now.updatedAt !== mine.updatedAt) return finish({ exit: 0 });
        const items = consoleItemsSince(dir, since);
        if (!items.length) return;
        const { text, through } = wakeLine(project, items);
        writeCursor(root, session, now, { lastEventId: ulid(through) });
        finish({ exit: 2, stderr: `${text}\n` });
      } catch {
        finish({ exit: 0 });
      }
    };
    for (const sub of [INBOX_DIR, CARDS_DIR, "pipeline/session"]) {
      try {
        const watcher = watch(path.join(dir, sub), { persistent: false }, () => setTimeout(check, 50));
        watcher.on("error", () => watcher.close());
        watchers.push(watcher);
      } catch {
        // a directory that does not exist yet is covered by the poll
      }
    }
    interval = setInterval(check, poll);
    timer = setTimeout(() => finish({ exit: 0 }), timeout);
    check();
  });
}
