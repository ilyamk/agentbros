/**
 * The optional Claude Code status line of the studio console (RFC 0004 D1, WP15): `pnpm harness:setup --statusline`
 * plans the `statusLine` entry of `.claude/settings.local.json` (git-ignored) that runs
 * scripts/hooks/console-statusline.mjs (the waiting count); `--apply` writes it and `--remove` removes ours, both only
 * after the user's yes. `statusLine` is one key, not a list: another tool's status line is a conflict, never replaced.
 * Every other key (the hooks among them) is kept as it was; the first change keeps a `.agentbros-backup` copy.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKUP_SUFFIX, HOOK_FILES } from "./hooks";

export const STATUSLINE_SCRIPT = "scripts/hooks/console-statusline.mjs";
export const STATUSLINE_FILE = HOOK_FILES.claude;

/** Our entry: relative to the project, so no machine path is written. */
export const statusLineEntry = () => ({
  type: "command" as const,
  command: `node "$CLAUDE_PROJECT_DIR"/${STATUSLINE_SCRIPT}`,
  padding: 0,
});

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
export const isOurStatusLine = (value: unknown): boolean =>
  isObject(value) && typeof value.command === "string" && value.command.includes(STATUSLINE_SCRIPT);

export type StatusLineState = "installed" | "missing" | "stale" | "foreign";

export interface StatusLinePlan {
  harness: "claude-code";
  file: string;
  state: StatusLineState;
  action: "none" | "write" | "conflict";
  entry: ReturnType<typeof statusLineEntry>;
  /** The file's content after the change (null when nothing changes or on conflict). */
  next: string | null;
  conflict?: string;
}

function load(file: string): { settings: Json | null } | { invalid: string } {
  if (!existsSync(file)) return { settings: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObject(parsed) ? { settings: parsed } : { invalid: "not a JSON object" };
  } catch {
    return { invalid: "not plain JSON (comments?); edit it by hand" };
  }
}

function stateOf(settings: Json | null): StatusLineState {
  const current = settings?.statusLine;
  if (current === undefined) return "missing";
  if (!isOurStatusLine(current)) return "foreign";
  return JSON.stringify(current) === JSON.stringify(statusLineEntry()) ? "installed" : "stale";
}

export function statusLineStatus(rootDir: string): StatusLineState {
  const loaded = load(path.join(rootDir, STATUSLINE_FILE));
  return "invalid" in loaded ? "foreign" : stateOf(loaded.settings);
}

export function planStatusLine(rootDir: string, mode: "install" | "remove" = "install"): StatusLinePlan {
  const base = { harness: "claude-code" as const, file: STATUSLINE_FILE, entry: statusLineEntry() };
  const loaded = load(path.join(rootDir, STATUSLINE_FILE));
  if ("invalid" in loaded)
    return { ...base, state: "foreign", action: "conflict", next: null, conflict: loaded.invalid };
  const settings = loaded.settings;
  const state = stateOf(settings);
  if (mode === "remove") {
    if (state === "missing" || state === "foreign") return { ...base, state, action: "none", next: null };
    const next = { ...settings };
    delete next.statusLine;
    return { ...base, state, action: "write", next: `${JSON.stringify(next, null, 2)}\n` };
  }
  if (state === "installed") return { ...base, state, action: "none", next: null };
  if (state === "foreign")
    return {
      ...base,
      state,
      action: "conflict",
      next: null,
      conflict: "another status line is set; Claude Code takes one, so remove it by hand first if you want ours",
    };
  return {
    ...base,
    state,
    action: "write",
    next: `${JSON.stringify({ ...(settings ?? {}), statusLine: statusLineEntry() }, null, 2)}\n`,
  };
}

/** Writes a planned change atomically, keeping the user's original file as a backup once. */
export function applyStatusLinePlan(rootDir: string, plan: StatusLinePlan): { written: string[]; backups: string[] } {
  if (plan.action !== "write" || plan.next === null) return { written: [], backups: [] };
  const file = path.join(rootDir, plan.file);
  mkdirSync(path.dirname(file), { recursive: true });
  const backups: string[] = [];
  if (existsSync(file) && !existsSync(`${file}${BACKUP_SUFFIX}`)) {
    copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
    backups.push(`${plan.file}${BACKUP_SUFFIX}`);
  }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, plan.next);
  renameSync(temporary, file);
  return { written: [plan.file], backups };
}
