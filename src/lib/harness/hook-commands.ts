/**
 * The command table the plain-Node `guard` hook reads (scripts/hooks/lib/commands.json): every registry alias that
 * runs a script, with its script and spend, so the hook judges a `pnpm <alias>` exactly as runScript judges the
 * script (sibling aliases, highest spend). tests/console-hooks-guard.test.ts fails when the file lags the registry
 * and rewrites it with AGENTBROS_WRITE_HOOK_TABLE=1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { COMMAND_REGISTRY, type CommandSpend } from "../cli/commands";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export const HOOK_COMMANDS_FILE = "scripts/hooks/lib/commands.json";

export interface HookCommandTable {
  v: 1;
  generatedFrom: string;
  /** `guarded`: the script calls runScript, so guardStep judges it; the hook judges only these. */
  aliases: Record<string, { script: string; spend: CommandSpend; guarded: boolean }>;
}

/** Whether a script reaches runScript's guardStep: it calls runScript itself (an unreadable script counts as not). */
export function reachesGuard(script: string, rootDir: string = REPO_ROOT): boolean {
  try {
    return /\brunScript\s*\(/.test(readFileSync(path.join(rootDir, script), "utf8"));
  } catch {
    return false;
  }
}

export function hookCommandTable(rootDir: string = REPO_ROOT): HookCommandTable {
  const aliases: HookCommandTable["aliases"] = {};
  const guarded = new Map<string, boolean>();
  // Registry order: runScript names the first alias of a script, so the hook must too.
  for (const entry of COMMAND_REGISTRY)
    if (entry.alias && entry.script) {
      if (!guarded.has(entry.script)) guarded.set(entry.script, reachesGuard(entry.script, rootDir));
      aliases[entry.alias] = { script: entry.script, spend: entry.paid, guarded: guarded.get(entry.script)! };
    }
  return { v: 1, generatedFrom: "src/lib/cli/commands.ts", aliases };
}

export const hookCommandTableText = () => `${JSON.stringify(hookCommandTable(), null, 2)}\n`;
