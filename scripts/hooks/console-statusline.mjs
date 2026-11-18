#!/usr/bin/env node
/**
 * Claude Code status line for the studio console (RFC 0004 D1, WP15), opt-in through `pnpm harness:setup --statusline`:
 * `node "$CLAUDE_PROJECT_DIR"/scripts/hooks/console-statusline.mjs`. Prints one line with how many decisions and
 * cards wait for the user, and the paused projects:
 *
 *   Agent Bros console: 2 waiting · 1 paused
 *
 * Source: the running console's `GET /api/projects` (127.0.0.1 only, the per-machine token as `x-console-token`, at
 * most 60 ms), else the project files the hooks read (step lease gates, waiting cards, control), scanned within the
 * budget. The whole run, counted from the process's start, ends by 100 ms (a hard exit); any failure prints nothing
 * and exits 0. Plain Node, no dependencies, no
 * network beyond 127.0.0.1, nothing written.
 */
import { readdirSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutRoot, isObject, readJson } from "./lib/runtime.mjs";
import { SERVER_LOCK_FILE, waitingFor } from "./lib/state.mjs";

export const BUDGET_MS = 100;
/** A slower machine may allow more (100–2000 ms): AGENTBROS_STATUSLINE_BUDGET_MS. */
export function budgetMs(env = process.env) {
  const value = Number(env.AGENTBROS_STATUSLINE_BUDGET_MS);
  return Number.isFinite(value) && value >= BUDGET_MS ? Math.min(2000, Math.floor(value)) : BUDGET_MS;
}
export const SERVER_TIMEOUT_MS = 60;
const STDIN_TIMEOUT_MS = 30;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PROJECTS = 500;
const SESSION_FILE = "out/console/session.json";
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The live console's port and token, or undefined (no lock, a dead pid, no token). */
export function liveConsole(root) {
  const lock = readJson(path.join(root, SERVER_LOCK_FILE));
  if (!isObject(lock) || lock.v !== 1 || !Number.isInteger(lock.pid) || !Number.isInteger(lock.port)) return undefined;
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return undefined;
  }
  const session = readJson(path.join(root, SESSION_FILE));
  const token = isObject(session) && typeof session.token === "string" ? session.token : undefined;
  if (!token || lock.port <= 0 || lock.port > 65535) return undefined;
  return { port: lock.port, token };
}

/** `{ waiting, paused }` from the server's home answer, or undefined on any failure or after `timeoutMs`. */
export function fromServer({ port, token }, timeoutMs = SERVER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/projects",
        method: "GET",
        headers: { Host: `127.0.0.1:${port}`, accept: "application/json", "x-console-token": token },
        agent: false,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) req.destroy();
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return done(undefined);
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!Array.isArray(body?.projects) || !Array.isArray(body?.waiting)) return done(undefined);
            done({
              waiting: body.waiting.length,
              paused: body.projects.filter((project) => project?.control && project.control !== "running").length,
              source: "server",
            });
          } catch {
            done(undefined);
          }
        });
        res.on("error", () => done(undefined));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(undefined);
    }, timeoutMs);
    req.on("error", () => done(undefined));
    req.end();
  });
}

/** `{ waiting, paused }` from the project files, scanning until `deadline` (performance.now()). */
export function fromFiles(root, deadline, now = new Date()) {
  let names;
  try {
    names = readdirSync(path.join(root, "public/projects")).filter((name) => PROJECT_ID.test(name));
  } catch {
    names = [];
  }
  let waiting = 0;
  let paused = 0;
  for (const project of names.slice(0, MAX_PROJECTS)) {
    if (performance.now() > deadline) break;
    try {
      const state = waitingFor(root, project, now);
      waiting += state.cards + (state.gate ? 1 : 0);
      if (state.paused) paused += 1;
    } catch {
      // a project that cannot be read adds nothing
    }
  }
  return { waiting, paused, source: "files" };
}

/** The status line's text for a checkout root (empty outside one). */
export async function statusLine(root, { started = performance.now(), server, budget = BUDGET_MS } = {}) {
  if (!root) return "";
  const live = server === undefined ? liveConsole(root) : server;
  const counts =
    (live &&
      (await fromServer(
        live,
        Math.max(5, Math.min(SERVER_TIMEOUT_MS, budget - 20 - (performance.now() - started))),
      ))) ||
    fromFiles(root, started + budget - 10);
  const parts = [counts.waiting ? `${counts.waiting} waiting` : "nothing waiting"];
  if (counts.paused) parts.push(`${counts.paused} paused`);
  return `Agent Bros console: ${parts.join(" · ")}`;
}

/** The harness's JSON on stdin (bounded), or undefined. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(undefined);
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => resolve(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        clearTimeout(timer);
        resolve(undefined);
      } else chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    process.stdin.on("error", () => resolve(undefined));
  });
}

async function main() {
  // performance.now() counts from the process's start: the budget includes Node's own start-up and module loading.
  const started = 0;
  const budget = budgetMs();
  setTimeout(() => process.exit(0), Math.max(1, budget - performance.now())).unref();
  const input = await readStdin();
  const cwd =
    (isObject(input) && isObject(input.workspace) && typeof input.workspace.current_dir === "string"
      ? input.workspace.current_dir
      : isObject(input) && typeof input.cwd === "string"
        ? input.cwd
        : undefined) ?? process.cwd();
  const line = await statusLine(checkoutRoot(cwd), { started, budget });
  if (line) process.stdout.write(`${line}\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => process.exit(0));
