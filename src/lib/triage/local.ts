import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { TriageArtefactMetadataSchema } from "../../types/triage";
import { readArtefact, truncateDiff } from "./artefact";
import { decide } from "./decide";
import { buildPrompt, type JudgePrompt } from "./prompt";
import type { JudgeResult } from "./vendors";

export type Harness = "codex" | "claude";
export type CommandOptions = { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeout?: number };
export type CommandRunner = (command: string, args: string[], options: CommandOptions) => string;
const commandRunner: CommandRunner = (command, args, options) =>
  execFileSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
  });

export function harnessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
    ] /* USER/LOGNAME: macOS keychain login for Claude Code */
      .flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])),
  );
}

export function localJudge(
  harness: Harness,
  prompt: JudgePrompt,
  options: { model?: string; runner?: CommandRunner; env?: NodeJS.ProcessEnv } = {},
): JudgeResult {
  const directory = mkdtempSync(path.join(tmpdir(), "triage-judge-"));
  const runner = options.runner ?? commandRunner;
  const env = harnessEnvironment(options.env ?? process.env);
  try {
    const output = path.join(directory, "judgement.json");
    const args =
      harness === "codex"
        ? [
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            ...[
              "shell_tool",
              "unified_exec",
              "code_mode",
              "apps",
              "plugins",
              "computer_use",
              "browser_use",
              "view_image",
              "image_generation",
              "multi_agent",
              "multi_agent_v2",
              "skill_search",
            ].flatMap((feature) => ["--disable", feature]),
            "-c",
            'web_search="disabled"',
            "-C",
            directory,
            "--output-last-message",
            output,
            ...(options.model ? ["--model", options.model] : []),
            "-",
          ]
        : [
            "-p",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--setting-sources",
            "",
            "--safe-mode",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--system-prompt",
            prompt.system,
            ...(options.model ? ["--model", options.model] : []),
          ];
    // Claude takes the rubric as its system prompt; codex exec has no system-prompt flag, so it reads both on stdin.
    const stdout = runner(harness, args, {
      cwd: directory,
      env,
      input: harness === "claude" ? prompt.user : `${prompt.system}\n\n${prompt.user}`,
      timeout: 600_000,
    });
    let text = harness === "codex" ? readFileSync(output, "utf8") : stdout;
    if (harness === "claude") {
      const envelope = z.object({ is_error: z.boolean().optional(), result: z.string() }).parse(JSON.parse(text));
      if (envelope.is_error) throw new Error("Local harness reported an error");
      text = envelope.result;
    }
    return { json: JSON.parse(text), usage: null, costUsd: 0 };
  } catch {
    return { abstain: "Local harness failed, timed out or returned invalid JSON.", usage: null, costUsd: 0 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const PullSchema = z.object({
  number: z.number().int().positive(),
  body: z.string(),
  headRefOid: z.string().regex(/^[a-f\d]{40}$/i),
  files: z
    .array(
      z.object({
        path: z.string(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      }),
    )
    .max(3000),
  labels: z.array(z.object({ name: z.string() })),
  changedFiles: z.number().int().nonnegative(),
});
export function localTriage(options: {
  pr: number;
  repository?: string;
  harness: Harness | "both";
  model?: string;
  post?: boolean;
  maxDiffBytes: number;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}) {
  if (!Number.isSafeInteger(options.pr) || options.pr < 1) throw new Error("Expected a positive PR number");
  if (options.repository && !/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error("Expected owner/repository");
  const runner = options.runner ?? commandRunner;
  const repoArgs = options.repository ? ["--repo", options.repository] : [];
  const gh = (args: string[], input?: string) => runner("gh", args, { input });
  const pull = PullSchema.parse(
    JSON.parse(
      gh(["pr", "view", String(options.pr), ...repoArgs, "--json", "number,body,headRefOid,files,labels,changedFiles"]),
    ),
  );
  if (pull.number !== options.pr) throw new Error("GitHub returned a different PR");
  if (pull.files.length !== pull.changedFiles) throw new Error("Incomplete PR file summary; human review required");
  const diff = gh(["pr", "diff", String(options.pr), ...repoArgs, "--color", "never"]);
  const directory = mkdtempSync(path.join(tmpdir(), "triage-material-"));
  try {
    const clipped = truncateDiff(diff, options.maxDiffBytes);
    // Bind the fetched diff to the initial head, even when the PR changes during acquisition.
    const head = JSON.parse(gh(["pr", "view", String(options.pr), ...repoArgs, "--json", "headRefOid"])) as {
      headRefOid?: string;
    };
    if (head.headRefOid !== pull.headRefOid) throw new Error("PR head changed while acquiring material");
    const metadata = TriageArtefactMetadataSchema.parse({
      pr: pull.number,
      head: pull.headRefOid,
      files: pull.files,
      diff: {
        truncated: clipped.truncated,
        originalBytes: Buffer.byteLength(diff),
        includedBytes: Buffer.byteLength(clipped.text),
      },
    });
    const changes = pull.files.filter((file) => /^\.changes\/[^/]+\.md$/.test(file.path)).map((file) => file.path);
    for (const [name, text] of Object.entries({
      "metadata.json": JSON.stringify(metadata),
      "body.md": pull.body,
      "change.md": `Change entries are included in the diff where available: ${changes.join(", ")}`,
      "diff.patch": clipped.text,
    }))
      writeFileSync(path.join(directory, name), text);
    const artefact = readArtefact(directory, options.maxDiffBytes);
    const prompt = buildPrompt(artefact.material);
    const harnesses: Harness[] = options.harness === "both" ? ["codex", "claude"] : [options.harness];
    const results = harnesses.map((harness) =>
      localJudge(harness, prompt, { model: options.model, runner, env: options.env }),
    );
    const decision = decide(results as [JudgeResult] | [JudgeResult, JudgeResult], prompt.canary, harnesses);
    if (options.post) {
      const fresh = JSON.parse(gh(["pr", "view", String(options.pr), ...repoArgs, "--json", "headRefOid,labels"])) as {
        headRefOid?: string;
        labels?: { name: string }[];
      };
      if (fresh.headRefOid !== pull.headRefOid)
        throw new Error("PR head changed after judging; no advisory result posted");
      gh(["pr", "comment", String(options.pr), ...repoArgs, "--body-file", "-"], decision.comment);
      const remove = (fresh.labels ?? [])
        .map((label) => label.name)
        .filter((label) => label.startsWith("triage:") && !decision.labels.includes(label));
      gh([
        "pr",
        "edit",
        String(options.pr),
        ...repoArgs,
        ...decision.labels.flatMap((label) => ["--add-label", label]),
        ...remove.flatMap((label) => ["--remove-label", label]),
      ]);
    }
    return {
      ...decision,
      pr: options.pr,
      headSha: pull.headRefOid,
      judges: harnesses,
      truncated: artefact.truncated,
      posted: options.post ?? false,
      subscriptionNote:
        "Uses the maintainer's harness authentication; subscription usage and limits are not API spend measurements.",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
