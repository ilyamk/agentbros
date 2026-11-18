#!/usr/bin/env node
/**
 * Agent Bros. harness hook (RFC 0004 §7.1, docs/harnesses.md#hooks): `node scripts/hooks/agentbros-hook.mjs
 * <claude|codex> <observe|guard|orient|relay|present|surface|wake>`. Reads one JSON object on stdin, normalises it
 * (lib/payload.mjs) and runs one role. Plain Node, no dependencies.
 *
 * Fail open (H4): any error, a malformed or oversized payload, a cwd outside a checkout, no project, or a role switched
 * off (AGENTBROS_HOOKS=off|observe) exits 0 with no output. Only `guard` denies (JSON on stdout, exit 0); only `wake`
 * exits 2, as an async Stop hook that wakes Claude when the user acted in the console.
 */
import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalise } from "./lib/payload.mjs";
import { checkoutRoot, HARNESS_IDS, roleEnabled, ROLES } from "./lib/runtime.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 2000;
/** Internal deadlines below the entries' timeouts; async roles get more room. */
const DEADLINE_MS = { guard: 4000, orient: 2500, relay: 2500, present: 2500, observe: 10_000, surface: 10_000 };

/** Runs one role on a raw payload; returns `{ stdout?, stderr?, exit? }` (never throws). */
export async function runHook(harness, role, raw, { env = process.env, now = new Date() } = {}) {
  try {
    if (!Object.hasOwn(HARNESS_IDS, String(harness)) || !ROLES.includes(role) || !roleEnabled(role, env)) return {};
    const payload = normalise(harness, raw);
    if (!payload) return {};
    const { ROLE_EVENTS, SYNC_ROLES } = await import("./lib/roles.mjs");
    if (!ROLE_EVENTS[role].includes(payload.event)) return {};
    const root = checkoutRoot(payload.cwd ?? process.cwd());
    if (!root) return {};
    const ctx = { root, env, now };
    if (role === "wake") {
      const { wake } = await import("./lib/wake.mjs");
      return (await wake(payload, ctx)) ?? {};
    }
    return SYNC_ROLES[role](payload, ctx) ?? {};
  } catch {
    return {};
  }
}

/** stdin as text, or undefined when it is too large or does not close in time. */
function readStdin() {
  return new Promise((resolve) => {
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
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

/** Synchronous write, so process.exit never cuts a pipe write short. */
function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  for (let tries = 0; offset < bytes.length && tries < 1000; tries++) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (error?.code !== "EAGAIN") return;
    }
  }
}

async function main() {
  const [harness, role] = process.argv.slice(2);
  if (!Object.hasOwn(HARNESS_IDS, String(harness)) || !ROLES.includes(role) || !roleEnabled(role)) process.exit(0);
  if (DEADLINE_MS[role]) setTimeout(() => process.exit(0), DEADLINE_MS[role]).unref();
  const text = await readStdin();
  let raw;
  try {
    raw = text === undefined ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const result = raw === undefined ? {} : await runHook(harness, role, raw);
  if (result.stdout) writeAll(1, `${JSON.stringify(result.stdout)}\n`);
  if (result.stderr) writeAll(2, result.stderr);
  process.exit(result.exit === 2 && role === "wake" ? 2 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => process.exit(0));
