import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { DeliverySnapshotSchema } from "../../types/delivery";
import { BenchBundleSchema, type BenchConfig, type BenchBundle } from "../../types/bench";
import { projectFootprint } from "../pipeline/paths";
import { OperationStore } from "../budget";
import { isBinary } from "../leak-scan";
import { command, contained, digest, fail, fileDigest, filesIn, loadBenchConfig, writeJson } from "./io";
import { loadTask } from "./tasks";
import { measure, transcriptCounts } from "./measure";

export interface RunOptions {
  root: string;
  task: string;
  harness: "claude-code" | "codex";
  model: string;
  runs: number;
  commit?: string;
  dryRun?: boolean;
  maxCostUsd?: number;
  suite?: string;
}

// Flags checked locally with `claude --help` and `codex exec --help`, 2026-11-15.
// Both accept a prompt on stdin. No bypass-permission flags or shell expansion.
export function harnessArgs(harness: RunOptions["harness"], model: string): string[] {
  return harness === "claude-code"
    ? [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--permission-mode",
        "acceptEdits",
        "--permission-prompts",
        "none",
      ]
    : ["exec", "--json", "--model", model, "--sandbox", "workspace-write", "--ignore-user-config", "--ephemeral", "-"];
}

export async function runHarness(
  bin: string,
  args: string[],
  cwd: string,
  prompt: string,
  limits: BenchConfig["limits"],
  harness: RunOptions["harness"],
  paid: boolean,
  extraEnv: NodeJS.ProcessEnv = {},
  signal?: AbortSignal,
  onUsage?: (tokens: { input: number; output: number }) => void,
) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SYSTEMROOT",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    ...(paid ? ["FAL_KEY", "ELEVENLABS_API_KEY", "PEXELS_API_KEY", "FREESOUND_API_KEY"] : []),
  ])
    if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, extraEnv);
  env.CI = "1";
  return await new Promise<{
    transcript: string;
    stderr: string;
    status: BenchBundle["status"];
    exitCode: number | null;
  }>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutDecoder = new StringDecoder("utf8"),
      stderrDecoder = new StringDecoder("utf8");
    let transcript = "",
      stderr = "",
      status: BenchBundle["status"] | undefined,
      bytes = 0;
    const stop = (reason: BenchBundle["status"]) => {
      status ??= reason;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const abort = () => stop("failed");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop("timeout"), limits.wallTimeSec * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxTranscriptBytes) {
        stop("output-limit");
        return;
      }
      transcript += stdoutDecoder.write(chunk);
      const complete = transcript.slice(0, transcript.lastIndexOf("\n") + 1);
      try {
        const counts = transcriptCounts(complete, harness);
        if (counts.tokens) onUsage?.(counts.tokens);
        if (counts.transcriptState === "invalid") stop("failed");
        if (counts.tokens && counts.tokens.input + counts.tokens.output > limits.tokens) stop("token-limit");
      } catch {
        stop("failed");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxTranscriptBytes) stop("output-limit");
      else stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("exit", () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Group finished. */
        }
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      transcript += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      try {
        const counts = transcriptCounts(transcript, harness);
        if (counts.transcriptState !== "complete") stop("failed");
        if (counts.tokens && counts.tokens.input + counts.tokens.output > limits.tokens) stop("token-limit");
        if (counts.tokens) onUsage?.(counts.tokens);
      } catch {
        stop("failed");
      }
      // Reap descendants even when the harness exits without waiting for them.
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Group finished. */
        }
      }
      resolve({ transcript, stderr, status: status ?? (code === 0 ? "completed" : "failed"), exitCode: code });
    });
    child.stdin.on("error", () => {
      /* A failed executable may close stdin early. */
    });
    child.stdin.end(prompt);
  });
}

export async function runBench(options: RunOptions) {
  const root = path.resolve(options.root),
    config = loadBenchConfig(root);
  if (!Number.isInteger(options.runs) || options.runs < config.minRuns)
    fail(`At least ${config.minRuns} runs are required`);
  if (!options.model.trim()) fail("A model is required");
  const { suite, task, taskSha256 } = loadTask(root, options.task, options.suite);
  if (task.tier === "paid" && (!(options.maxCostUsd! > 0) || options.maxCostUsd! > task.maxCostUsd!))
    fail("Paid runs require explicit positive --max-cost-usd at or below task.maxCostUsd (per run)");
  if (task.tier === "no-spend" && options.maxCostUsd !== undefined && options.maxCostUsd !== 0)
    fail("No-spend tasks cannot authorise spending");
  const commit = command("git", ["rev-parse", "--verify", `${options.commit ?? "HEAD"}^{commit}`], root);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) fail("Invalid commit");
  const bin =
    process.env[`BENCH_HARNESS_BIN_${options.harness.replaceAll("-", "_").toUpperCase()}`] ??
    (options.harness === "claude-code" ? "claude" : "codex");
  const args = harnessArgs(options.harness, options.model);
  const plan = {
    task: task.id,
    harness: options.harness,
    model: options.model,
    commit,
    runs: options.runs,
    tier: task.tier,
    maxCostUsdPerRun: options.maxCostUsd ?? 0,
    limits: config.limits,
    args,
    suiteVersion: suite.version,
    protocolVersion: suite.protocolVersion,
  };
  if (options.dryRun) return { outputs: [], metadata: { ...plan, dryRun: true } };
  const campaign = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const campaignDir = path.join(root, "out/bench", campaign);
  writeJson(path.join(campaignDir, "campaign.json"), { ...plan, config, taskSha256 });
  const harnessVersion = command(bin, ["--version"], root);
  const outputs: string[] = [];
  for (let run = 1; run <= options.runs; run++) {
    const cell = `${task.id}-${options.harness}-${digest(options.model).slice(0, 8)}-${commit.slice(0, 8)}-${run}`;
    const worktree = path.join(root, ".cache/bench/worktrees", campaign, cell),
      bundle = path.join(campaignDir, cell);
    mkdirSync(path.dirname(worktree), { recursive: true });
    command("git", ["worktree", "add", "--detach", worktree, commit], root);
    try {
      // Reuse installed dependencies; the source checkout itself remains clean.
      if (existsSync(path.join(root, "node_modules")))
        symlinkSync(path.join(root, "node_modules"), path.join(worktree, "node_modules"), "dir");
      for (const material of task.material) {
        const target = contained(worktree, material.path!);
        mkdirSync(path.dirname(target), { recursive: true });
        if (existsSync(target) && digest(readFileSync(target)) !== material.sha256)
          fail(`Material would overwrite a different committed file: ${material.path}`);
        if (!existsSync(target)) copyFileSync(contained(root, material.path!), target);
      }
      const projectId = `bench-${task.id}`;
      const budgetDirectory = path.join(worktree, ".cache/bench/budget", projectId);
      new OperationStore(projectId, { directory: budgetDirectory }).configure(
        { ceilingUsd: options.maxCostUsd ?? 0, maxJobUsd: options.maxCostUsd ?? 0 },
        { by: "bench", source: `bench --max-cost-usd ${options.maxCostUsd ?? 0}` },
      );
      const answers = readFileSync(contained(root, task.answers), "utf8");
      const prompt = [
        task.brief,
        `Project ID: ${projectId}. Playbook: ${task.playbook}.`,
        `Constraints: ${JSON.stringify(task.constraints)}. Tier: ${task.tier}. External media budget per run: USD ${options.maxCostUsd ?? 0}. After creating the project, install the supplied policy with pnpm budget --project ${projectId} --ceiling-usd ${options.maxCostUsd ?? 0} --max-job-usd ${options.maxCostUsd ?? 0} --answer "Benchmark operator bound: USD ${options.maxCostUsd ?? 0}" (the operator's own bound, passed verbatim; never raise it). Until then, paid admission must refuse as uninitialised. Reserve before any provider submission.`,
        `The following answers file contains the user's fixed decisions for simulated gates. They are benchmark decisions, not human production approvals. Use --proxy benchmark where supported; never invent approval or bypass a human-only gate. Stop and report blocked if a required human-only gate cannot accept them.\n${answers}`,
        `Material is already present at these repository-relative paths: ${task.material.map((item) => item.path).join(", ")}.`,
        `Write a brief outcome to bench-result.json. Use only project ${projectId}; do not access .env or credentials, commit, or send messages. Stop within ${config.limits.wallTimeSec} seconds and ${config.limits.tokens} observed tokens.`,
      ].join("\n\n");
      const started = performance.now();
      const result = await runHarness(
        bin,
        args,
        worktree,
        prompt,
        config.limits,
        options.harness,
        task.tier === "paid",
      );
      const wallTimeSec = (performance.now() - started) / 1000;
      mkdirSync(bundle, { recursive: true });
      writeFileSync(path.join(bundle, "transcript.jsonl"), result.transcript, { flag: "wx" });
      writeFileSync(path.join(bundle, "stderr.txt"), result.stderr, { flag: "wx" });
      writeJson(path.join(bundle, "protocol/task.json"), task);
      copyFileSync(path.join(budgetDirectory, "operations.json"), path.join(bundle, "protocol/budget.json"));
      writeFileSync(path.join(bundle, "protocol/prompt.txt"), prompt, { flag: "wx" });
      const candidates = new Set<string>();
      for (const footprint of projectFootprint(projectId)) {
        const file = contained(worktree, footprint);
        if (!existsSync(file)) continue;
        if (lstatSync(file).isDirectory()) filesIn(file).forEach((name) => candidates.add(`${footprint}/${name}`));
        else candidates.add(footprint);
      }
      const changed = command("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], worktree)
        .split("\0")
        .filter(Boolean);
      for (const name of changed)
        if (/^(src\/|tests\/|docs\/|bench-result\.json$)/.test(name) && !/(^|\/)\.env(?:\.|$)/.test(name))
          candidates.add(name);
      // Delivery identities hash unchanged harness code and shared media too.
      // Capture those exact sources as data; verifier never imports bundle code.
      for (const name of [...candidates].filter((name) => /\/pipeline\/delivery\/snapshots\/[^/]+\.json$/.test(name))) {
        const snapshot = DeliverySnapshotSchema.parse(JSON.parse(readFileSync(contained(worktree, name), "utf8")));
        for (const identity of snapshot.identities)
          for (const source of identity.sources) {
            if (
              !/^(src\/|public\/|package\.json$|pnpm-lock\.yaml$|remotion\.config\.ts$|\.cache\/font-contexts\/)/.test(
                source.path,
              ) ||
              /(^|\/)\.env(?:\.|$)/.test(source.path)
            )
              fail("Delivery source is outside the allowed benchmark evidence roots");
            candidates.add(source.path);
          }
      }
      const omitted: BenchBundle["omitted"] = [];
      let total = 0;
      for (const name of [...candidates].sort()) {
        const source = contained(worktree, name);
        if (!existsSync(source)) continue;
        const size = statSync(source).size;
        total += size;
        if (total > config.limits.maxBundleBytes) fail("Bundle exceeds configured size limit");
        if (size > config.limits.maxFileBytes) {
          const fd = openSync(source, "r"),
            sample = Buffer.alloc(Math.min(size, 8192));
          try {
            readSync(fd, sample, 0, sample.length, 0);
          } finally {
            closeSync(fd);
          }
          if (isBinary(sample)) {
            omitted.push({ path: name, sha256: await fileDigest(source), bytes: size });
            continue;
          }
          fail(`Text artefact exceeds configured file limit: ${name}`);
        }
        const target = contained(bundle, name);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      const claims = measure(bundle, task, root, result.transcript, options.harness);
      if (result.status === "completed" && claims.transcriptState !== "complete") result.status = "failed";
      if (
        result.status === "completed" &&
        claims.tokens &&
        claims.tokens.input + claims.tokens.output > config.limits.tokens
      )
        result.status = "token-limit";
      const manifest = BenchBundleSchema.parse({
        version: 1,
        visibility: "private",
        protocolVersion: 1,
        suiteVersion: suite.version,
        taskSha256,
        cell: { task: task.id, harness: options.harness, model: options.model, harnessCommit: commit, run },
        files: filesIn(bundle).map((name) => {
          const bytes = readFileSync(contained(bundle, name));
          return { path: name, sha256: digest(bytes), bytes: bytes.length };
        }),
        omitted,
        env: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version, harnessVersion },
        tokens: claims.tokens,
        toolCalls: claims.toolCalls,
        wallTimeSec,
        spendUsd: claims.spendUsd,
        transcript: "transcript.jsonl",
        status: result.status,
        exitCode: result.exitCode,
        claims,
      });
      writeJson(path.join(bundle, "manifest.json"), manifest);
      outputs.push(path.relative(root, bundle));
    } finally {
      command("git", ["worktree", "remove", "--force", worktree], root);
    }
  }
  return { outputs, metadata: { ...plan, campaign } };
}
