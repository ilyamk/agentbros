#!/usr/bin/env node
/**
 * Deprecated shim, kept for one release (RFC 0004 §7.1 H1): the Claude Code PreToolUse step guard is now the `guard`
 * role of scripts/hooks/agentbros-hook.mjs, installed with `pnpm harness:setup --hooks`. Settings that still name this
 * file run that role; `harness:setup --hooks --apply` replaces the old entry. Same verdicts as runScript (step lease
 * and pause), fail open.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "./agentbros-hook.mjs";
import { ALWAYS_ADMITTED, decide as guardDecide, invocations } from "./lib/guard.mjs";
import { normalise } from "./lib/payload.mjs";

export { ALWAYS_ADMITTED, invocations };

/** The verdict for one Claude Code PreToolUse input, judged against `cwd` as the checkout: `{ deny }` or `{}`. */
export function decide(input, { cwd = input?.cwd ?? process.cwd(), env = process.env, now = new Date() } = {}) {
  try {
    const payload = normalise("claude", { hook_event_name: "PreToolUse", ...input });
    const verdict = payload ? guardDecide(payload, { root: cwd, env, now }) : {};
    return verdict.deny ? { deny: verdict.deny } : {};
  } catch {
    return {};
  }
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  const result = await runHook("claude", "guard", { hook_event_name: "PreToolUse", ...raw });
  if (result.stdout) process.stdout.write(`${JSON.stringify(result.stdout)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => process.exit(0));
