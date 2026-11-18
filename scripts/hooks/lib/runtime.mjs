/**
 * Shared helpers of the harness hook (RFC 0004 §7.1): kill switches, the checkout root, safe JSON reads, ULIDs,
 * hashing, text bounds and project resolution. Plain Node, no dependencies; nothing here throws to the caller
 * except programming errors, and the entry point catches those too (H4: fail open).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Repository-relative path that marks a checkout of this repository (and our entries in harness settings). */
export const HOOK_SCRIPT = "scripts/hooks/agentbros-hook.mjs";
export const PROJECTS_DIR = "public/projects";
export const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Same rule as ConsoleIdSchema (src/types/console.ts): a file-name-safe id. */
export const CONSOLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ROLES = ["observe", "guard", "orient", "relay", "present", "surface", "wake"];
export const HARNESS_IDS = { claude: "claude-code", codex: "codex" };

/** AGENTBROS_HOOKS: `off` disables every role, `observe` keeps only observe; anything else (or unset) is on (H8). */
export function hooksMode(env = process.env) {
  const value = String(env.AGENTBROS_HOOKS ?? "")
    .trim()
    .toLowerCase();
  return value === "off" || value === "observe" ? value : "on";
}

export const roleEnabled = (role, env = process.env) => {
  const mode = hooksMode(env);
  return mode === "on" || (mode === "observe" && role === "observe");
};

export const eventsOff = (env = process.env) =>
  String(env.AGENTBROS_EVENTS ?? "")
    .trim()
    .toLowerCase() === "off";

/** The JSON in a file, or undefined when it is missing, unreadable or not JSON. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Bounds a string to `max` characters with an ellipsis. */
export function clamp(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** One line: whitespace runs collapsed, bounded. */
export const oneLine = (text, max) =>
  clamp(
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );

/**
 * The checkout whose hooks run: the nearest ancestor of `cwd` (inclusive) holding this hook script and a
 * package.json. Undefined outside a checkout (H6: then no role does anything).
 */
export function checkoutRoot(cwd) {
  if (!str(cwd)) return undefined;
  let dir;
  try {
    dir = realpathSync(path.resolve(cwd));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(path.join(dir, HOOK_SCRIPT)) && existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export const projectDirOf = (root, project) => path.join(root, PROJECTS_DIR, project);

/** An existing project directory, or undefined (an invalid id never reaches the file system). */
export function existingProject(root, project) {
  if (!str(project) || !PROJECT_ID.test(project) || project.length > 128) return undefined;
  try {
    return statSync(projectDirOf(root, project)).isDirectory() ? project : undefined;
  } catch {
    return undefined;
  }
}

/** The project named by `--project X` / `--project=X` in a shell command (the first valid one). */
export function projectInCommand(command) {
  for (const match of String(command ?? "").matchAll(/--project(?:=|\s+)["']?([^\s"'`;&|)]+)/g))
    if (PROJECT_ID.test(match[1])) return match[1];
  return undefined;
}

/** The project of the newest unexpired lease (`pipeline/session/lease.json`), by file time. */
export function newestLeaseProject(root, now = new Date()) {
  let entries;
  try {
    entries = readdirSync(path.join(root, PROJECTS_DIR), { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best;
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
    const file = path.join(root, PROJECTS_DIR, entry.name, "pipeline/session/lease.json");
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (best && best.mtime >= mtime) continue;
    const lease = readJson(file);
    const expires = Date.parse(lease?.expiresAt ?? "");
    if (!Number.isFinite(expires) || expires <= now.getTime()) continue;
    best = { project: entry.name, mtime };
  }
  return best?.project;
}

/**
 * H6: the command's --project, else the project this session already worked on (its cursor), else the newest
 * unexpired lease, else AGENTBROS_PROJECT; only an existing project counts.
 */
export function resolveProject({ root, command, cursor, env = process.env, now = new Date() }) {
  return (
    existingProject(root, projectInCommand(command)) ??
    existingProject(root, cursor?.project) ??
    existingProject(root, newestLeaseProject(root, now)) ??
    existingProject(root, str(env.AGENTBROS_PROJECT))
  );
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (48-bit time, 80 random bits), sortable by time. */
export function ulid(time = Date.now()) {
  let out = "";
  let t = Math.max(0, Math.floor(time));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/** The millisecond time a ULID encodes, or NaN. */
export function ulidTime(id) {
  if (typeof id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return Number.NaN;
  let t = 0;
  for (const char of id.slice(0, 10).toUpperCase()) t = t * 32 + CROCKFORD.indexOf(char);
  return t;
}

/** Names of this repository's own leaf agents: `name:` of each `.agents/agents/*.md` front matter (H7). */
export function ownAgents(root) {
  const dir = path.join(root, ".agents/agents");
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md");
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const file of files) {
    try {
      const head = readFileSync(path.join(dir, file), "utf8").slice(0, 2048);
      const front = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
      const name = /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front)?.[1];
      names.add(name ?? file.slice(0, -3));
    } catch {
      // an unreadable agent file is simply not one of ours
    }
  }
  return names;
}
