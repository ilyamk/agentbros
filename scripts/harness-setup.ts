/**
 * Wires this checkout into the user's coding-agent harnesses: skill/agent links and the agentbros MCP server.
 * Plan by default; --apply writes project files (git-ignored), --global also user configs (with a backup).
 * --hooks plans the studio console's harness hooks (RFC 0004 §7.1); --hooks --apply installs them and
 * --hooks --remove removes only ours, both after the user's yes. --statusline does the same for the optional Claude Code
 * status line showing the console's waiting count (RFC 0004 D1, WP15).
 */
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import {
  applyHookPlans,
  HOOK_HARNESS_IDS,
  HOOK_HARNESSES,
  HOOK_TRUST_STEPS,
  hooksStatus,
  planHooks,
  type HookHarness,
} from "../src/lib/harness/hooks";
import { HARNESSES, harnessById } from "../src/lib/harness/registry";
import { applyStatusLinePlan, planStatusLine } from "../src/lib/harness/statusline";
import { applyHarnesses, manualSnippet, planHarnesses } from "../src/lib/harness/setup";

runScript(async () => {
  const args = parseArgs([
    { name: "apply", type: "boolean", description: "Create links and write project-scoped configs" },
    {
      name: "global",
      type: "boolean",
      description: "With --apply, also merge the server into user-scope configs (a .agentbros-backup copy is kept)",
    },
    {
      name: "harness",
      description: `Comma-separated ids to wire (default: detected ones, plus claude-code and codex): ${HARNESSES.map((spec) => spec.id).join(", ")}`,
    },
    { name: "all", type: "boolean", description: "Wire every known harness, detected or not" },
    {
      name: "hooks",
      type: "boolean",
      description:
        "Plan the console's hooks for Claude Code (.claude/settings.local.json) and Codex (.codex/hooks.json); with --apply install them, with --remove remove ours",
    },
    {
      name: "statusline",
      type: "boolean",
      description:
        "Plan the optional Claude Code status line with the console's waiting count (.claude/settings.local.json); with --apply install it, with --remove remove ours",
    },
    {
      name: "remove",
      type: "boolean",
      description: "With --hooks or --statusline, remove only our entries (a backup is kept)",
    },
    { name: "snippet", description: "Print the MCP entry for one harness id (for configs set by hand) and exit" },
    {
      name: "list",
      type: "boolean",
      description: "List the supported harnesses and how each finds AGENTS.md and skills",
    },
  ] as const);
  const codeRoot = process.cwd();
  if (args.remove && !args.hooks && !args.statusline)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--remove needs --hooks or --statusline" });
  if (args.hooks && args.statusline)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Run --hooks and --statusline separately" });
  if (args.statusline) return statusLineMode(codeRoot, { apply: !!args.apply, remove: !!args.remove });
  if (args.hooks) return hooksMode(codeRoot, { apply: !!args.apply, remove: !!args.remove, harness: args.harness });
  if (args.list)
    return {
      metadata: {
        harnesses: HARNESSES.map(({ id, name, instructions, skills, mcp, docs, checked }) => ({
          id,
          name,
          instructions,
          skills,
          mcp: mcp.map(({ scope, file, toolsets }) => ({ scope, file, toolsets })),
          docs,
          checked,
        })),
      },
    };
  if (args.snippet) {
    const spec = harnessById(args.snippet);
    if (!spec || spec.mcp.length === 0)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `No MCP config for harness: ${args.snippet}` });
    const snippets = spec.mcp.map((target) => ({
      file: target.file,
      scope: target.scope,
      text: manualSnippet(target, codeRoot),
    }));
    for (const snippet of snippets)
      emitProgress(`${snippet.scope === "user" ? "~/" : ""}${snippet.file}:\n${snippet.text}`);
    return { metadata: { harness: spec.id, snippets } };
  }
  if (args.global && !args.apply)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--global needs --apply" });
  const only = args.harness
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  let statuses;
  try {
    statuses = planHarnesses({ codeRoot, only, all: args.all });
  } catch (error) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  let applied: ReturnType<typeof applyHarnesses> | null = null;
  if (args.apply) {
    applied = applyHarnesses(statuses, { codeRoot, global: args.global });
    statuses = planHarnesses({ codeRoot, only, all: args.all });
  }
  const selected = statuses.filter((status) => status.selected);
  const pending = selected.flatMap((status) => status.actions.filter((action) => action.state === "todo"));
  const conflicts = selected.flatMap((status) => status.actions.filter((action) => action.state === "conflict"));
  const manual = selected.flatMap((status) => status.actions.filter((action) => action.state === "manual"));
  const userConfigs = manual.filter((action) => action.kind === "mcp");
  for (const status of selected)
    emitProgress(
      `${status.name}${status.detectedBy ? ` (${status.detectedBy})` : ""}: ${status.actions.map((action) => `${action.path} ${action.state}`).join("; ") || "nothing to wire"}`,
    );
  return {
    outputs: applied?.written ?? [],
    metadata: {
      mode: args.apply ? (args.global ? "apply-global" : "apply") : "plan",
      harnesses: statuses,
      pending,
      conflicts,
      manual,
      ...(applied ? { written: applied.written, backups: applied.backups } : {}),
      next:
        pending.length > 0
          ? "pnpm harness:setup --apply"
          : userConfigs.length > 0
            ? "pnpm harness:setup --apply --global (after the user agrees), or pnpm harness:setup --snippet <id>"
            : "Restart the harness so it loads the new skills and MCP server; approve the agentbros server when asked.",
    },
  };
});

/** `--statusline`: plan, `--apply` or `--remove` the console's Claude Code status line (RFC 0004 D1, WP15). */
function statusLineMode(codeRoot: string, options: { apply: boolean; remove: boolean }) {
  if (options.apply && options.remove)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--statusline takes --apply or --remove, not both" });
  const plan = planStatusLine(codeRoot, options.remove ? "remove" : "install");
  const applied = options.apply || options.remove ? applyStatusLinePlan(codeRoot, plan) : undefined;
  emitProgress(
    `claude-code: ${plan.file} status line ${plan.state}; ${plan.action === "conflict" ? `conflict: ${plan.conflict}` : plan.action === "write" ? (applied ? "written" : "would change") : "nothing to change"}`,
  );
  return {
    outputs: applied?.written ?? [],
    metadata: {
      mode: options.remove ? "statusline-remove" : options.apply ? "statusline-apply" : "statusline-plan",
      statusLine: { file: plan.file, state: plan.state, action: plan.action, entry: plan.entry },
      ...(plan.conflict ? { conflict: plan.conflict } : {}),
      ...(applied ? { written: applied.written, backups: applied.backups } : {}),
      next: options.remove
        ? "Status line removed; Claude Code picks it up on the next session."
        : options.apply
          ? plan.action === "conflict"
            ? "Another status line is set; nothing was changed."
            : "Installed; Claude Code shows it in this folder once the workspace is trusted (restart the session)."
          : plan.action === "write"
            ? "Show the user this plan; after their yes run pnpm harness:setup --statusline --apply."
            : "Nothing to change.",
    },
  };
}

/** `--hooks`: plan, `--apply` or `--remove` the console's harness hooks (RFC 0004 §7.1 H2, H3). */
function hooksMode(codeRoot: string, options: { apply: boolean; remove: boolean; harness?: string }) {
  if (options.apply && options.remove)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--hooks takes --apply or --remove, not both" });
  const wanted = options.harness
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const harnesses = HOOK_HARNESSES.filter((harness) => !wanted?.length || wanted.includes(HOOK_HARNESS_IDS[harness]));
  if (wanted?.some((id) => !Object.values(HOOK_HARNESS_IDS).includes(id)))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--hooks supports --harness ${Object.values(HOOK_HARNESS_IDS).join(", ")}`,
    });
  const plans = harnesses.map((harness) => planHooks(codeRoot, harness, options.remove ? "remove" : "install"));
  const applied = options.apply || options.remove ? applyHookPlans(codeRoot, plans) : undefined;
  const status = hooksStatus(codeRoot);
  for (const plan of plans)
    emitProgress(
      `${plan.harness}: ${plan.file} ${plan.state}; ${plan.action === "conflict" ? `conflict: ${plan.conflict}` : plan.action === "write" ? (applied ? "written" : "would change") : "nothing to change"}`,
    );
  const installed = harnesses.filter((harness: HookHarness) => status[harness] === "installed");
  return {
    outputs: applied?.written ?? [],
    metadata: {
      mode: options.remove ? "hooks-remove" : options.apply ? "hooks-apply" : "hooks-plan",
      hooks: plans,
      status,
      conflicts: plans.filter((plan) => plan.action === "conflict").map(({ file, conflict }) => ({ file, conflict })),
      ...(applied ? { written: applied.written, backups: applied.backups } : {}),
      trust: options.remove ? [] : installed.map((harness) => HOOK_TRUST_STEPS[harness]),
      next: options.remove
        ? "Hooks removed; restart the harness session."
        : options.apply
          ? "Tell the user the one trust step per harness (trust)."
          : plans.some((plan) => plan.action === "write")
            ? "Show the user this plan; after their yes run pnpm harness:setup --hooks --apply."
            : "Nothing to change.",
    },
  };
}
