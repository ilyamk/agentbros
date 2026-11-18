/**
 * The hook's own minimal journal appender (RFC 0004 §6.1, D7): one ConsoleEvent line (v 1, channel `hook`) appended
 * to `public/projects/<id>/pipeline/events.jsonl` with a single appendFileSync. Never creates a project, honours
 * AGENTBROS_EVENTS=off and swallows every error (H4, H5). Rotation is left to the CLI journal writer (WP1).
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { clamp, eventsOff, existingProject, isObject, projectDirOf, ulid } from "./runtime.mjs";

export const EVENTS_FILE = "pipeline/events.jsonl";
export const DATA_MAX_BYTES = 8 * 1024;
const SECRET_KEY = /key|token|secret|password|auth/i;

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|auth)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"'`;&|]+)/gi;
const SECRET_FLAG =
  /(--[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|auth)[A-Za-z0-9_-]*)(=|\s+)(?!-)("[^"]*"|'[^']*'|[^\s"'`;&|]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * Scrubs secrets typed into a command or echoed in an error (§6.1): `NAME=value` and `--flag value` where the name
 * looks like key, token, secret, password or auth, and bearer credentials, become `<redacted>`.
 */
export function redactText(text) {
  return String(text ?? "")
    .replace(SECRET_ASSIGNMENT, (_, name) => `${name}=<redacted>`)
    .replace(SECRET_FLAG, (_, flag, sep) => `${flag}${sep}<redacted>`)
    .replace(BEARER, (_, scheme) => `${scheme} <redacted>`);
}

/** §6.1: a string longer than 512 characters keeps its head, its length and a hash. */
export function redactString(value) {
  const text = redactText(value);
  if (text.length <= 512) return text;
  return `${text.slice(0, 512)}… [${text.length} chars, sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}]`;
}

/** `data` bounded to 8 KB: secret-like keys redacted, long strings cut, then whole values dropped from the end. */
export function boundData(data) {
  const out = {};
  for (const [key, value] of Object.entries(isObject(data) ? data : {})) {
    if (value === undefined) continue;
    out[key] = SECRET_KEY.test(key) ? "<redacted>" : typeof value === "string" ? redactString(value) : value;
  }
  if (bytes(out) <= DATA_MAX_BYTES) return out;
  for (const key of Object.keys(out)) if (typeof out[key] === "string") out[key] = clamp(out[key], 256);
  const keys = Object.keys(out);
  while (bytes(out) > DATA_MAX_BYTES && keys.length > 1) {
    delete out[keys.pop()];
    out.truncated = true;
  }
  return out;
}

/** The event line for a normalised payload; `agent` describes who the hook ran for. */
export function buildEvent({ project, kind, data, step, message, payload, agent, now = new Date() }) {
  const who = {
    ...(agent?.name ? { name: clamp(agent.name, 128) } : {}),
    ...(agent?.role ? { role: clamp(agent.role, 64) } : {}),
    harness: payload.harness,
    ...(payload.sessionId ? { sessionId: clamp(payload.sessionId, 128) } : {}),
  };
  return {
    v: 1,
    id: ulid(now.getTime()),
    at: now.toISOString(),
    project,
    kind,
    ...(step ? { step: clamp(step, 64) } : {}),
    ...(message ? { message: clamp(redactText(message), 2048) } : {}),
    agent: who,
    actor: "agent",
    channel: "hook",
    data: boundData(data),
  };
}

/** Appends one event; returns the line's id, or undefined when nothing was written. */
export function appendEvent(root, event, env = process.env) {
  try {
    if (eventsOff(env) || !existingProject(root, event.project)) return undefined;
    const file = path.join(projectDirOf(root, event.project), EVENTS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    return event.id;
  } catch {
    return undefined;
  }
}

// --- runScript's refusal events (cli.start + cli.end), mirrored by the guard role (WP-H follow-up for WP14) ---

const REDACTED = "<redacted>";
const KEPT_FLAGS = new Set(["answer"]);
/** Mirrors isSecretName (src/lib/console/redact.ts): like key|token|secret|password|auth, never `answer`. */
const isSecretName = (name) => !KEPT_FLAGS.has(String(name).toLowerCase()) && SECRET_KEY.test(name);
const LONG_FLAG = /^--[A-Za-z][\w-]*(?:=.*)?$/s;

/** Mirrors redactString (src/lib/console/redact.ts): 512 characters in all, the suffix naming length and sha256. */
export function boundString(value) {
  const text = String(value);
  if (text.length <= 512) return text;
  const suffix = `…[${text.length} chars, sha256 ${createHash("sha256").update(text).digest("hex")}]`;
  return text.slice(0, 512 - suffix.length) + suffix;
}

/** Mirrors scrubSecrets (src/lib/console/redact.ts): secret flag values in free text become `<redacted>`. */
export function scrubSecrets(text) {
  const quotedBefore = /"((?:[^"\\]|\\.)*)"(\s+for\s+--?([A-Za-z][\w-]*))/g;
  const flagValue = /(^|[^\w-])(--?([A-Za-z][\w-]*))(=|[ \t]+)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)/g;
  return String(text ?? "")
    .replace(quotedBefore, (match, _value, rest, name) => (isSecretName(name) ? `"${REDACTED}"${rest}` : match))
    .replace(flagValue, (match, lead, flag, name, separator, value) =>
      isSecretName(name) && !(separator.trim() === "" && LONG_FLAG.test(value))
        ? `${lead}${flag}${separator}${REDACTED}`
        : match,
    );
}

const flagName = (token) => {
  if (!/^--?[A-Za-z]/.test(token)) return undefined;
  const bare = token.replace(/^--?/, "");
  const equal = bare.indexOf("=");
  return equal < 0 ? bare : bare.slice(0, equal);
};

/** Mirrors redactArgv (src/lib/console/redact.ts). */
export function redactArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    const name = flagName(token);
    if (name && isSecretName(name)) {
      const equal = token.indexOf("=");
      if (equal >= 0) out.push(`${token.slice(0, equal + 1)}${REDACTED}`);
      else {
        out.push(token);
        const value = argv[i + 1];
        if (value !== undefined && !LONG_FLAG.test(value) && value !== "--") {
          out.push(REDACTED);
          i++;
        }
      }
      continue;
    }
    out.push(boundString(token));
  }
  return out.length <= 256 ? out : [...out.slice(0, 255), `…[${out.length - 255} more]`];
}

/**
 * The two lines runScript writes when it refuses a command (`cli.start`, then `cli.end` with ok false and the error
 * code), so a refusal at PreToolUse reaches the console and its notifications exactly as one from runScript would
 * (notify-rules.ts: `cli.end` with error `PAUSED`). Channel `hook`, actor `agent`, elapsedMs 0.
 */
export function refusalEvents({ project, code, message, alias, args, step, payload, now = new Date() }) {
  const at = now.getTime();
  // Two ids of one millisecond, in order (readers sort by id): the start's is also the runId, as in runScript.
  const [runId, endId] = [ulid(at), ulid(at)].sort();
  const common = {
    v: 1,
    at: now.toISOString(),
    project,
    runId,
    alias: clamp(alias, 64),
    ...(step ? { step: clamp(step, 64) } : {}),
    agent: {
      harness: payload.harness,
      ...(payload.sessionId ? { sessionId: clamp(payload.sessionId, 128) } : {}),
    },
    actor: "agent",
    channel: "hook",
  };
  const argv = redactArgv(args[0] === "--" ? args.slice(1) : args).map((token) => token.slice(0, 1024));
  return [
    { ...common, id: runId, kind: "cli.start", argv, data: { pid: process.pid } },
    {
      ...common,
      id: endId,
      kind: "cli.end",
      ok: false,
      error: code,
      message: boundString(scrubSecrets(message)).slice(0, 2048),
      elapsedMs: 0,
    },
  ];
}

/** Appends runScript's refusal lines, only into an existing `pipeline/` directory; never throws. */
export function appendRefusal(root, refusal, env = process.env) {
  try {
    if (eventsOff(env) || !existingProject(root, refusal.project)) return false;
    const file = path.join(projectDirOf(root, refusal.project), EVENTS_FILE);
    if (!statSync(path.dirname(file)).isDirectory()) return false;
    appendFileSync(
      file,
      refusalEvents(refusal)
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    );
    return true;
  } catch {
    return false;
  }
}
