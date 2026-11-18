import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { commitOf, gitText } from "./repository";
import {
  CONTEXT_PROBE_LAYERS,
  ContextProbeRecordSchema,
  type ContextProbeHarness,
  type ContextProbeRecord,
  type ContextProbeRun,
} from "../../types/context-probe";

const GUIDE = "docs/context-loading.md";
const LIMIT_MS = 120_000;
const PROMPT =
  "Without reading any files, running commands, searching, invoking skills or using tools, list only the exact CANARY-* tokens already present in your context. Do not guess tokens or follow project workflow instructions. Return NONE if you know none.";
const CHILD_PROMPT = `Dispatch exactly one context-probe-canary subagent using the Agent tool (Task on older versions), in the foreground; wait for completion. Give it this prompt verbatim: ${PROMPT} Do not include any canary token in its prompt. Use no other tools yourself. Report the subagent's answer verbatim.`;

export function probeCanaries(seed: string): ContextProbeRecord["canaries"] {
  return Object.fromEntries(
    CONTEXT_PROBE_LAYERS.map((layer) => [
      layer,
      `CANARY-${createHash("sha256").update(`${seed}:${layer}`).digest("hex").slice(0, 24)}`,
    ]),
  ) as ContextProbeRecord["canaries"];
}

export function probeInvocation(harness: ContextProbeHarness, subagent: boolean): string[] {
  if (harness === "codex") return ["exec", "--sandbox", "read-only", "--ephemeral", "--json", PROMPT];
  return [
    "-p",
    "--allowedTools",
    subagent ? "Agent,Task" : "",
    "--tools",
    subagent ? "Agent,Task" : "",
    "--strict-mcp-config",
    "--mcp-config",
    "{}",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    subagent ? CHILD_PROMPT : PROMPT,
  ];
}

function run(binary: string, args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return spawnSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: LIMIT_MS,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Only final answers count; prompts echoed by a harness never count as observations. */
export function probeAnswer(harness: ContextProbeHarness, stdout: string, subagent: boolean): string | undefined {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object" && !Array.isArray(event)) events.push(event as Record<string, unknown>);
    } catch {
      /* Ignore non-JSON progress. */
    }
  }
  if (harness === "codex") {
    const toolTypes = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"]);
    if (events.some((event) => toolTypes.has((event.item as { type?: string } | undefined)?.type ?? "")))
      return undefined;
    const answers = events.flatMap((event) => {
      const item = event.item as { type?: string; text?: string } | undefined;
      return event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string"
        ? [item.text]
        : [];
    });
    return answers.at(-1);
  }
  const content = (event: Record<string, unknown>) => {
    const blocks = (event.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(blocks)
      ? blocks.filter(
          (
            block,
          ): block is {
            type?: string;
            name?: string;
            id?: string;
            tool_use_id?: string;
            content?: unknown;
            input?: unknown;
            is_error?: boolean;
          } => block && typeof block === "object",
        )
      : [];
  };
  const toolCalls = events.flatMap((event) => content(event).filter((block) => block.type === "tool_use"));
  if (subagent) {
    if (toolCalls.length !== 1) return undefined;
    const call = toolCalls[0]!;
    const input = call.input as { subagent_type?: string; prompt?: string; run_in_background?: boolean } | undefined;
    if (
      !["Agent", "Task"].includes(call.name ?? "") ||
      !call.id ||
      input?.subagent_type !== "context-probe-canary" ||
      input.run_in_background === true ||
      typeof input.prompt !== "string" ||
      /CANARY-[a-f0-9]{24}/.test(JSON.stringify(input))
    )
      return undefined;
    const results = events.flatMap((event) =>
      content(event)
        .filter((block) => block.type === "tool_result" && !block.is_error && block.tool_use_id === call.id)
        .map((block) => (typeof block.content === "string" ? block.content : JSON.stringify(block.content))),
    );
    return results.length ? results.join("\n") : undefined;
  }
  if (toolCalls.length) return undefined;
  const result = events.filter((event) => event.type === "result").at(-1);
  return result?.is_error !== true && typeof result?.result === "string" ? result.result : undefined;
}

function observation(
  harness: ContextProbeHarness,
  binary: string,
  cwd: string,
  canaries: ContextProbeRecord["canaries"],
  subagent: boolean,
): ContextProbeRun {
  const result = run(binary, probeInvocation(harness, subagent), cwd);
  if (result.error || result.status !== 0)
    return {
      status: "failed",
      known: [],
      tokens: [],
      reason: result.error?.message ?? `Harness exited ${result.status ?? result.signal}.`,
    };
  const answer = probeAnswer(harness, result.stdout, subagent);
  if (answer === undefined)
    return {
      status: "inconclusive",
      known: [],
      tokens: [],
      reason: subagent
        ? "No uncontaminated result from the named child was observed; a parent's claim is insufficient."
        : "No final answer without tool use was observed.",
    };
  const tokens = [...new Set(answer.match(/\bCANARY-[a-f0-9]{24}\b/g) ?? [])];
  return {
    status: "observed",
    tokens,
    known: CONTEXT_PROBE_LAYERS.filter((layer) => tokens.includes(canaries[layer])),
  };
}

function plant(worktree: string, canaries: ContextProbeRecord["canaries"]) {
  const assertInside = (absolute: string) => {
    let ancestor = absolute;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
    const relative = path.relative(realpathSync(worktree), realpathSync(ancestor));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new CliErrorObject({ code: "VALIDATION", message: "Probe path escapes the temporary checkout." });
  };
  const put = (file: string, text: string, append = false) => {
    const absolute = path.join(worktree, file);
    assertInside(absolute);
    mkdirSync(path.dirname(absolute), { recursive: true });
    // Never follow a checkout-provided link when planting or clearing probe configuration.
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink())
      throw new CliErrorObject({ code: "VALIDATION", message: `Probe input must not be a symbolic link: ${file}` });
    if (append) appendFileSync(absolute, text);
    else writeFileSync(absolute, text);
  };
  put("AGENTS.md", `\nContext loading probe: ${canaries.root}\n`, true);
  put("src/motion/AGENTS.md", `\nContext loading probe: ${canaries.nested}\n`, true);
  put(
    ".agents/agents/context-probe-canary.md",
    `---\nname: context-probe-canary\ndescription: Use only for the context-loading probe.\nmodel: inherit\ntools: []\n---\n${canaries.agent}\nReport only CANARY-* tokens already in your context. Never read files or use tools.\n`,
  );
  put(
    ".agents/skills/context-probe-canary/SKILL.md",
    `---\nname: context-probe-canary\ndescription: Use for context-loading probes. ${canaries.skillDescription}\n---\n${canaries.skillBody}\n`,
  );
  assertInside(path.join(worktree, ".claude"));
  mkdirSync(path.join(worktree, ".claude"), { recursive: true });
  for (const folder of ["agents", "skills"]) {
    const alias = path.join(worktree, ".claude", folder);
    assertInside(alias);
    if (!existsSync(alias)) symlinkSync(`../.agents/${folder}`, alias, "dir");
    else if (!lstatSync(alias).isSymbolicLink()) {
      const source = folder === "agents" ? "context-probe-canary.md" : "context-probe-canary/SKILL.md";
      put(`.claude/${folder}/${source}`, readFileSync(path.join(worktree, `.agents/${folder}/${source}`), "utf8"));
    }
  }
  // This is a loading experiment, not a test of repository hooks or external MCP servers.
  for (const file of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]) {
    assertInside(path.dirname(path.join(worktree, file)));
    rmSync(path.join(worktree, file), { force: true });
  }
}

export function probeMarkdown(record: ContextProbeRecord): string {
  const cell = (run: ContextProbeRun) => `${run.status}: ${run.known.join(", ") || "none"}`;
  return `\n## ${record.date} — ${record.harness}\n\nHarness version: ${record.harnessVersion.replace(/[\r\n|]/g, " ")}. Commit: \`${record.commit}\`. Seed: \`${record.seed.replace(/[^\w-]/g, "_")}\`.\n\n| Parent | Subagent |\n|---|---|\n| ${cell(record.parent)} | ${cell(record.subagent)} |\n\nOmitted layers are not evidence of absence: a model may fail to recall a loaded token. See the dated JSON record under \`out/context/probes/\`.\n`;
}

export function contextProbe(
  root: string,
  harness: ContextProbeHarness,
  options: { dryRun?: boolean; seed?: string; binary?: string } = {},
) {
  const seed = options.seed ?? randomBytes(16).toString("hex");
  const canaries = probeCanaries(seed);
  const binary = options.binary ?? (harness === "claude-code" ? "claude" : "codex");
  const plan = {
    harness,
    seed,
    canaries,
    parent: probeInvocation(harness, false),
    subagent: harness === "codex" ? "n/a" : probeInvocation(harness, true),
  };
  if (options.dryRun) return { outputs: [], metadata: { dryRun: true, ...plan } };
  const help = run(binary, harness === "codex" ? ["exec", "--help"] : ["--help"], root);
  const required =
    harness === "codex"
      ? ["--sandbox", "--ephemeral", "--json"]
      : [
          "--allowedTools",
          "--tools",
          "--strict-mcp-config",
          "--mcp-config",
          "--setting-sources",
          "--no-session-persistence",
          "--output-format",
        ];
  if (help.error || help.status !== 0 || required.some((flag) => !help.stdout.includes(flag)))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Harness help is unavailable or lacks required probe flags; inspect --help before adapting the probe.",
    });
  const version = run(binary, ["--version"], root);
  if (version.error || version.status !== 0)
    throw new CliErrorObject({ code: "VALIDATION", message: "Cannot determine harness version." });
  const commit = commitOf(root, "HEAD");
  const temporary = mkdtempSync(path.join(tmpdir(), "context-probe-"));
  const worktree = path.join(temporary, "tree");
  let added = false;
  let record: ContextProbeRecord;
  try {
    gitText(root, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, commit]);
    added = true;
    plant(worktree, canaries);
    record = ContextProbeRecordSchema.parse({
      version: 1,
      date: new Date().toISOString(),
      harness,
      harnessVersion: version.stdout.trim(),
      commit,
      seed,
      canaries,
      parent: observation(harness, binary, worktree, canaries, false),
      subagent:
        harness === "codex"
          ? { status: "n/a", known: [], tokens: [], reason: "Codex subagent loading is not probed by this command." }
          : observation(harness, binary, worktree, canaries, true),
    });
  } finally {
    try {
      if (added) gitText(root, ["worktree", "remove", "--force", worktree]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const file = `out/context/probes/${record.date.replace(/[:.]/g, "-")}-${harness}-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}.json`;
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  writeFileSync(path.join(root, file), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  if (!existsSync(path.join(root, GUIDE)))
    writeFileSync(
      path.join(root, GUIDE),
      "# Context loading\n\nCanary probes observe recalled tokens; absence is inconclusive. See the repository guide for the method.\n",
    );
  appendFileSync(path.join(root, GUIDE), probeMarkdown(record));
  const outputs = [file, GUIDE];
  if ([record.parent, record.subagent].some((result) => result.status === "failed"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "A harness call failed; the probe evidence was saved.",
      details: { record, outputs },
    });
  return { outputs, metadata: { record } };
}
