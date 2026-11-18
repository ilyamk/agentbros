/**
 * Harness hooks installer and status (RFC 0004 §7.1 H2, H3, H5): the exact entries `pnpm harness:setup --hooks`
 * plans, merges into `.claude/settings.local.json` and `.codex/hooks.json` (both git-ignored) and removes again.
 * Our entries are recognised by a command containing scripts/hooks/agentbros-hook.mjs (or the deprecated
 * claude-step-guard.mjs, which an apply replaces); every other key, group and handler is kept as it was.
 * Commands are relative, so no machine path is written. Installing is the user's decision (H3): agents plan and
 * show, and apply only after the user's yes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HooksStatus } from "../../types/console";

export const HOOK_SCRIPT = "scripts/hooks/agentbros-hook.mjs";
/** The deprecated Claude Code guard (one release): treated as ours, replaced on apply, removed on remove. */
export const LEGACY_HOOK_SCRIPT = "scripts/hooks/claude-step-guard.mjs";
export const BACKUP_SUFFIX = ".agentbros-backup";

export type HookHarness = "claude" | "codex";
export type HookRole = "observe" | "guard" | "orient" | "relay" | "present" | "surface" | "wake";
export const HOOK_HARNESSES: readonly HookHarness[] = ["claude", "codex"];
/** harness:setup ids of the two harnesses. */
export const HOOK_HARNESS_IDS: Record<HookHarness, string> = { claude: "claude-code", codex: "codex" };
export const HOOK_FILES: Record<HookHarness, string> = {
  claude: ".claude/settings.local.json",
  codex: ".codex/hooks.json",
};

export interface HookHandler {
  type: "command";
  command: string;
  /** Seconds. */
  timeout?: number;
  async?: true;
  /** Claude Code: an async hook that wakes Claude when it exits 2. */
  asyncRewake?: true;
}
/**
 * Codex's subagent matcher (a regex: Codex matches it against the canonical `tool_name` and its aliases). Codex reports
 * `spawn_agent` and lets `Agent` select it as an alias (default and multi_agent_v1 namespaces); a spawn tool in another
 * namespace is reported as `<namespace>spawn_agent` without the alias (Rust `regex`: no lookaround, so an MCP tool
 * named `mcp__…spawn_agent` also starts the hook, and the adapter reads it as an other tool). Source: openai/codex
 * codex-rs/core/src/tools/hook_names.rs and registry.rs (main at 5a4aff8, checked 2026-11-17).
 */
export const CODEX_AGENT_MATCHER = "^(Agent|[A-Za-z0-9_]*spawn_agent)$";

/** Claude Code's guard matcher: the shell and every tool that reads or writes a named file. */
export const CLAUDE_GUARD_MATCHER = "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep";
/** Codex: shell (`Bash`) and file edits (`apply_patch`, which Codex also matches as `Edit`/`Write`). */
export const CODEX_GUARD_MATCHER = "Bash|apply_patch";
export const CONSOLE_PRESENT_MATCHER =
  "^(Bash|(?:mcp__[A-Za-z0-9_.-]+__)?avc_(next|film_init|film_next|footage_next|project_create|call))$";

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type HookEntries = Record<string, HookGroup[]>;

interface EntrySpec {
  event: string;
  matcher?: string;
  role: HookRole;
  timeout?: number;
  async?: true;
  asyncRewake?: true;
}

/**
 * Per-entry bounds (H5): guard 5 s, orient, relay and present 3 s, everything else async; SessionEnd runs synchronously in
 * both harnesses (Codex always does; Claude Code may cut background work at exit), bounded at 1 s. Tool matchers
 * use `Bash` for both harnesses' shells and select the relevant file, subagent or MCP tools. Behaviour
 * changes live in the script (H3).
 */
const ENTRY_SPECS: Record<HookHarness, EntrySpec[]> = {
  claude: [
    { event: "SessionStart", role: "observe", async: true },
    { event: "SessionStart", role: "orient", timeout: 3 },
    { event: "SessionEnd", role: "observe", timeout: 1 },
    { event: "UserPromptSubmit", role: "relay", timeout: 3 },
    // The file tools too: the guard keeps the console's session token from agents (console-secret denials).
    { event: "PreToolUse", matcher: CLAUDE_GUARD_MATCHER, role: "guard", timeout: 5 },
    { event: "PostToolUse", matcher: "Agent", role: "observe", async: true },
    { event: "PostToolUse", matcher: CONSOLE_PRESENT_MATCHER, role: "present", timeout: 3 },
    { event: "PostToolUseFailure", matcher: "Bash|Agent", role: "observe", async: true },
    { event: "SubagentStart", role: "observe", async: true },
    { event: "SubagentStart", role: "orient", timeout: 3 },
    { event: "SubagentStop", role: "observe", async: true },
    { event: "Stop", role: "observe", async: true },
    { event: "Stop", role: "wake", timeout: 3600, async: true, asyncRewake: true },
    { event: "StopFailure", role: "observe", async: true },
    { event: "Notification", matcher: "permission_prompt|idle_prompt", role: "surface", async: true },
  ],
  codex: [
    { event: "SessionStart", role: "observe", async: true },
    { event: "SessionStart", role: "orient", timeout: 3 },
    { event: "SessionEnd", role: "observe", timeout: 1 },
    { event: "UserPromptSubmit", role: "relay", timeout: 3 },
    // apply_patch too: the guard keeps agents' patches off the session token and pipeline/inbox/ (an older install
    // with matcher Bash shows as stale).
    { event: "PreToolUse", matcher: CODEX_GUARD_MATCHER, role: "guard", timeout: 5 },
    { event: "PostToolUse", matcher: CODEX_AGENT_MATCHER, role: "observe", async: true },
    { event: "PostToolUse", matcher: CONSOLE_PRESENT_MATCHER, role: "present", timeout: 3 },
    { event: "SubagentStart", role: "observe", async: true },
    { event: "SubagentStart", role: "orient", timeout: 3 },
    { event: "SubagentStop", role: "observe", async: true },
    { event: "Stop", role: "observe", async: true },
    { event: "Interrupt", role: "observe", timeout: 1, async: true },
  ],
};

/** The command of one role: `"$CLAUDE_PROJECT_DIR"/…` for Claude Code, relative to the session's cwd for Codex. */
export const hookCommand = (harness: HookHarness, role: HookRole): string =>
  harness === "claude"
    ? `node "$CLAUDE_PROJECT_DIR"/${HOOK_SCRIPT} claude ${role}`
    : `node ${HOOK_SCRIPT} codex ${role}`;

/** Our entries for a harness, one group per event and matcher, in a fixed order. */
export function hookEntries(harness: HookHarness): HookEntries {
  const entries: HookEntries = {};
  for (const spec of ENTRY_SPECS[harness]) {
    const handler: HookHandler = {
      type: "command",
      command: hookCommand(harness, spec.role),
      ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
      ...(spec.async ? { async: true as const } : {}),
      ...(spec.asyncRewake ? { asyncRewake: true as const } : {}),
    };
    const groups = (entries[spec.event] ??= []);
    const group = groups.find((entry) => entry.matcher === spec.matcher);
    if (group) group.hooks.push(handler);
    else groups.push({ ...(spec.matcher !== undefined ? { matcher: spec.matcher } : {}), hooks: [handler] });
  }
  return entries;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** A handler is ours when its command names our hook script (or the deprecated guard). */
export const isOurHandler = (handler: unknown): boolean =>
  isObject(handler) &&
  typeof handler.command === "string" &&
  (handler.command.includes(HOOK_SCRIPT) || handler.command.includes(LEGACY_HOOK_SCRIPT));

/** The settings object without our handlers; groups and events left empty by that are dropped. */
export function withoutOurs(settings: Json): Json {
  if (!isObject(settings.hooks)) return settings;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurHandler)) return [group];
      const handlers = group.hooks.filter((handler) => !isOurHandler(handler));
      return handlers.length ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** The settings object with exactly our entries: ours removed, then ours appended after each event's other groups. */
export function withOurs(settings: Json, harness: HookHarness): Json {
  const base = withoutOurs(settings);
  const hooks: Json = isObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, groups] of Object.entries(hookEntries(harness)))
    hooks[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), ...groups];
  return { ...base, hooks };
}

/** Our handlers in a settings object, as comparable `event|matcher|handler` keys. */
function ourKeys(settings: Json): string[] {
  if (!isObject(settings.hooks)) return [];
  const keys: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks)
        if (isOurHandler(handler))
          keys.push(JSON.stringify([event, group.matcher ?? "", canonical(handler as HookHandler)]));
    }
  }
  return keys.sort();
}

const canonical = (handler: HookHandler) => ({
  type: handler.type,
  command: handler.command,
  timeout: handler.timeout ?? null,
  async: handler.async ?? null,
  asyncRewake: handler.asyncRewake ?? null,
});

const expectedKeys = (harness: HookHarness) => ourKeys({ hooks: hookEntries(harness) });

type Loaded = { settings: Json | null } | { invalid: string };

function load(file: string): Loaded {
  if (!existsSync(file)) return { settings: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(parsed) ? { settings: parsed } : { invalid: "not a JSON object" };
  } catch {
    return { invalid: "not plain JSON (comments?); edit it by hand" };
  }
}

export type HookInstallState = HooksStatus["claude"];

function stateOf(harness: HookHarness, settings: Json | null): HookInstallState {
  const keys = settings ? ourKeys(settings) : [];
  if (!keys.length) return "missing";
  return JSON.stringify(keys) === JSON.stringify(expectedKeys(harness)) ? "installed" : "stale";
}

/** `installed`, `missing` or `stale` per harness (H3); an unreadable file is `stale` when it names our script. */
export function hooksStatus(rootDir: string): HooksStatus {
  const one = (harness: HookHarness): HookInstallState => {
    const file = path.join(rootDir, HOOK_FILES[harness]);
    const loaded = load(file);
    if ("invalid" in loaded) {
      try {
        const text = readFileSync(file, "utf8");
        return text.includes(HOOK_SCRIPT) || text.includes(LEGACY_HOOK_SCRIPT) ? "stale" : "missing";
      } catch {
        return "missing";
      }
    }
    return stateOf(harness, loaded.settings);
  };
  return { claude: one("claude"), codex: one("codex") };
}

export interface HookPlan {
  harness: string;
  /** Repository-relative. */
  file: string;
  state: HookInstallState;
  /** What `--apply` (or `--remove`) would do. */
  action: "none" | "write" | "conflict";
  /** Our exact entries, keyed by event (what an apply installs). */
  entries: HookEntries;
  /** Commands of ours the change removes or replaces. */
  removes: string[];
  /** The file's full content after the change (null when nothing changes or on conflict). */
  next: string | null;
  conflict?: string;
}

/** The plan for one harness: install (default) or remove. */
export function planHooks(rootDir: string, harness: HookHarness, mode: "install" | "remove" = "install"): HookPlan {
  const file = HOOK_FILES[harness];
  const base = { harness: HOOK_HARNESS_IDS[harness], file, entries: hookEntries(harness) };
  const loaded = load(path.join(rootDir, file));
  if ("invalid" in loaded)
    return {
      ...base,
      state: hooksStatus(rootDir)[harness],
      action: "conflict",
      removes: [],
      next: null,
      conflict: loaded.invalid,
    };
  const current = loaded.settings;
  const state = stateOf(harness, current);
  const expected = new Set(expectedKeys(harness));
  const removes = (current ? ourKeys(current) : [])
    .filter((key) => mode === "remove" || !expected.has(key))
    .map((key) => (JSON.parse(key) as [string, string, { command: string }])[2].command);
  const after = mode === "remove" ? (current ? withoutOurs(current) : null) : withOurs(current ?? {}, harness);
  const changed = after !== null && JSON.stringify(after) !== JSON.stringify(current);
  return {
    ...base,
    state,
    action: changed ? "write" : "none",
    removes: [...new Set(removes)],
    next: changed ? `${JSON.stringify(after, null, 2)}\n` : null,
  };
}

/**
 * Writes the planned changes atomically. Before the first change to an existing file it keeps `<file>.agentbros-backup`
 * (git-ignored: `.codex/` is ignored, the Claude Code backup has its own .gitignore line); an existing backup is kept.
 */
export function applyHookPlans(rootDir: string, plans: readonly HookPlan[]): { written: string[]; backups: string[] } {
  const written: string[] = [];
  const backups: string[] = [];
  for (const plan of plans) {
    if (plan.action !== "write" || plan.next === null) continue;
    const file = path.join(rootDir, plan.file);
    mkdirSync(path.dirname(file), { recursive: true });
    // The first backup keeps the user's original file; later runs never overwrite it.
    if (existsSync(file) && !existsSync(`${file}${BACKUP_SUFFIX}`)) {
      copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
      backups.push(`${plan.file}${BACKUP_SUFFIX}`);
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, plan.next);
    renameSync(temporary, file);
    written.push(plan.file);
  }
  return { written, backups };
}

/** The one step per harness the user takes after an install (H3). */
export const HOOK_TRUST_STEPS: Record<HookHarness, string> = {
  claude:
    "Claude Code: start Claude Code from this folder and accept the workspace trust dialog once (hooks from settings files run only in a trusted folder); a running session picks the entries up after a restart or in /hooks.",
  codex:
    "Codex: trust the project, then review new or changed agentbros-hook entries in /hooks (CLI) or Settings > Hooks (app); the review is bound to each entry's hash.",
};
