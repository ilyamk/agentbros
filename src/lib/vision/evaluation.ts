import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { emitProgress } from "../cli";
import { harnessEnvironment } from "../triage/local";
import { reviewHash } from "./review-pack";

export const VisionJudgementSchema = z
  .object({
    status: z.enum(["defect", "clear", "insufficient"]),
    evidenceIds: z.array(z.string()).min(1),
    note: z.string().min(1),
    nextAction: z.string().min(1),
  })
  .strict();
export type VisionJudgement = z.infer<typeof VisionJudgementSchema>;
export type EvaluationCase = {
  id: string;
  category: string;
  expected: VisionJudgement["status"];
  packets: { baseline: string; candidate: string };
};
export function visionHarnessArguments(
  harness: "codex" | "claude",
  model: string,
  directory: string,
  config: string,
  schema: string,
  output: string,
  effort?: string,
): string[] {
  return harness === "codex"
    ? [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--model",
        model,
        ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
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
        "-c",
        `mcp_servers.vision_review.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.vision_review.args=${JSON.stringify(JSON.parse(readFileSync(config, "utf8")).mcpServers.vision_review.args)}`,
        "-C",
        directory,
        "--json",
        "--output-schema",
        schema,
        "--output-last-message",
        output,
        "-",
      ]
    : [
        "-p",
        "--model",
        model,
        ...(effort ? ["--effort", effort] : []),
        "--permission-mode",
        "plan",
        "--permission-prompts",
        "none",
        "--tools",
        "",
        "--restricted",
        "--strict-mcp-config",
        "--mcp-config",
        config,
        "--allowedTools",
        "mcp__vision_review__read_manifest,mcp__vision_review__read_image",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        readFileSync(schema, "utf8"),
      ];
}
function configuredModel(harness: "codex" | "claude") {
  const home = process.env.HOME!;
  const model =
    harness === "codex"
      ? readFileSync(path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"), "utf8").match(
          /^model\s*=\s*"([^"]+)"/m,
        )?.[1]
      : JSON.parse(
          readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "settings.json"), "utf8"),
        ).model;
  if (typeof model !== "string" || !model)
    throw new Error(`No configured ${harness} model; refusing an implicit model change.`);
  return model;
}
function configuredEffort(harness: "codex" | "claude"): string | undefined {
  const home = process.env.HOME!;
  return harness === "codex"
    ? readFileSync(path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"), "utf8").match(
        /^model_reasoning_effort\s*=\s*"([^"]+)"/m,
      )?.[1]
    : JSON.parse(
        readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "settings.json"), "utf8"),
      ).effortLevel;
}
async function runHarness(harness: "codex" | "claude", args: string[], directory: string) {
  const env = harnessEnvironment(process.env);
  return await new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>(
    (resolve, reject) => {
      const started = performance.now(),
        child = spawn(harness, args, {
          cwd: directory,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      let stdout = "",
        stderr = "";
      const stop = () => {
        try {
          if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      };
      const timeout = setTimeout(stop, 240000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length + stderr.length > 8 * 1024 * 1024) stop();
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        stop();
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        stop();
        resolve({ code, stdout, stderr, elapsedMs: performance.now() - started });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        "Use read_manifest first, then open the images needed with read_image. Review only this packet. Do not infer unavailable measurements, sound or unseen frames. Return the required JSON status, actual image evidence IDs, a concise concrete observation and a useful next action. State insufficient when the supplied evidence cannot answer the question.",
      );
    },
  );
}
export type VisionEvalResult = {
  harness: string;
  model: string;
  caseId: string;
  category: string;
  variant: string;
  expected: string;
  judgement?: VisionJudgement;
  error?: string;
  imagesDelivered: number;
  citationsValid: boolean;
  elapsedMs: number;
};
export function summarizeVisionResults(results: VisionEvalResult[]) {
  return [...new Set(results.map((r) => r.harness))].flatMap((harness) =>
    ["baseline", "candidate"].map((variant) => {
      const rows = results.filter((r) => r.harness === harness && r.variant === variant),
        positives = rows.filter((r) => r.expected === "defect"),
        tp = positives.filter((r) => r.judgement?.status === "defect" && r.citationsValid).length,
        predicted = rows.filter((r) => r.judgement?.status === "defect").length;
      return {
        harness,
        variant,
        n: rows.length,
        failures: rows.filter((r) => r.error).length,
        precision: predicted ? tp / predicted : 0,
        recall: positives.length ? tp / positives.length : 0,
        correct: rows.filter((r) => r.judgement?.status === r.expected && r.citationsValid).length,
        insufficientCorrect: rows.filter(
          (r) => r.expected === "insufficient" && r.judgement?.status === "insufficient" && r.citationsValid,
        ).length,
        citationsValid: rows.every((r) => r.citationsValid),
      };
    }),
  );
}
export function visionAcceptancePassed(summary: ReturnType<typeof summarizeVisionResults>) {
  return (
    summary.length > 0 &&
    summary.filter((s) => s.variant === "candidate").length > 0 &&
    summary
      .filter((s) => s.variant === "candidate")
      .every(
        (s) =>
          s.n === 24 &&
          s.failures === 0 &&
          s.precision >= 0.9 &&
          s.recall >= 0.9 &&
          s.correct >= 22 &&
          s.insufficientCorrect === 6 &&
          s.citationsValid &&
          (() => {
            const old = summary.find((o) => o.harness === s.harness && o.variant === "baseline");
            return !!old && s.recall >= old.recall && (old.recall >= 0.9 || s.recall >= old.recall + 0.1);
          })(),
      )
  );
}
export async function evaluateVision(options: {
  casesFile: string;
  output: string;
  harnesses?: Array<"codex" | "claude">;
  limit?: number;
}) {
  options = { ...options, output: path.resolve(options.output), casesFile: path.resolve(options.casesFile) };
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 24))
    throw new Error("Smoke limit must be 1..24.");
  if (existsSync(options.output))
    throw new Error("Evaluation output exists; keep previous results and choose a new directory.");
  const cases = z
    .array(
      z.object({
        id: z.string().regex(/^q[a-f0-9]{12}$/),
        category: z.string(),
        expected: z.enum(["defect", "clear", "insufficient"]),
        packets: z.object({ baseline: z.string(), candidate: z.string() }),
      }),
    )
    .min(1)
    .parse(JSON.parse(readFileSync(options.casesFile, "utf8")));
  if (new Set(cases.map((task) => task.id)).size !== cases.length)
    throw new Error("Evaluation case IDs must be unique.");
  const fingerprint = () =>
    createHash("sha256")
      .update(
        [
          "review-pack.ts",
          "review-view.ts",
          "review-render-worker.ts",
          "evaluation.ts",
          "eval-reader.ts",
          "eval-fixtures.ts",
        ]
          .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"))
          .join("\n"),
      )
      .digest("hex");
  const implementationSha256 = fingerprint();
  const models = Object.fromEntries(
    (options.harnesses ?? ["codex", "claude"]).map((harness) => [harness, configuredModel(harness)]),
  );
  const efforts = Object.fromEntries(
    (options.harnesses ?? ["codex", "claude"]).map((harness) => [harness, configuredEffort(harness)]),
  );
  const harnessVersions = Object.fromEntries(
    (options.harnesses ?? ["codex", "claude"]).map((name) => [
      name,
      spawnSync(name, ["--version"], { encoding: "utf8" }).stdout.trim(),
    ]),
  );
  mkdirSync(options.output, { recursive: true });
  const schemaFile = path.join(options.output, "judgement.schema.json");
  writeFileSync(schemaFile, JSON.stringify(z.toJSONSchema(VisionJudgementSchema, { target: "draft-07" })));
  const jobs = cases
    .slice(0, options.limit ?? cases.length)
    .flatMap((task) =>
      (["baseline", "candidate"] as const).flatMap((variant) =>
        (options.harnesses ?? ["codex", "claude"]).map((harness) => ({ harness, task, variant })),
      ),
    );
  const results: VisionEvalResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const { harness, task, variant } = jobs[next++]!;
        const model = models[harness]!,
          key = `${task.id}-${harness}-${variant}`,
          directory = path.join(options.output, key);
        mkdirSync(directory);
        const packet = path.resolve(task.packets[variant]),
          imageLog = path.join(directory, "images.jsonl"),
          response = path.join(directory, "response.json"),
          config = path.join(directory, "mcp.json");
        const reader = fileURLToPath(new URL("./eval-reader.ts", import.meta.url));
        const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
        writeFileSync(
          config,
          JSON.stringify({
            mcpServers: { vision_review: { command: process.execPath, args: [tsx, reader, packet, imageLog] } },
          }),
        );
        emitProgress(`Vision evaluation ${key} (${model})`);
        const run = await runHarness(
          harness,
          visionHarnessArguments(harness, model, directory, config, schemaFile, response, efforts[harness]),
          directory,
        );
        writeFileSync(path.join(directory, "events.jsonl"), run.stdout);
        writeFileSync(path.join(directory, "stderr.txt"), run.stderr);
        const reads = existsSync(imageLog)
          ? readFileSync(imageLog, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { id?: string; status: string })
          : [];
        let judgement: VisionJudgement | undefined, error: string | undefined;
        try {
          if (run.code !== 0) throw new Error(`Harness exit ${run.code}`);
          const envelope =
            harness === "claude"
              ? run.stdout
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line) as Record<string, unknown>)
                  .reverse()
                  .find((event) => event.type === "result")
              : undefined;
          judgement = VisionJudgementSchema.parse(
            harness === "codex"
              ? JSON.parse(readFileSync(response, "utf8"))
              : (envelope?.structured_output ??
                  JSON.parse(typeof envelope?.result === "string" ? envelope.result : "null")),
          );
        } catch (caught) {
          error = String(caught);
        }
        const delivered = new Set(
          reads.filter((read) => read.status === "delivered" && read.id).map((read) => read.id),
        );
        const failedIntegrity = new Set(reads.filter((read) => read.status === "hash-mismatch").map((read) => read.id));
        results.push({
          harness,
          model,
          caseId: task.id,
          category: task.category,
          variant,
          expected: task.expected,
          ...(judgement ? { judgement } : {}),
          ...(error ? { error } : {}),
          imagesDelivered: delivered.size,
          citationsValid:
            !!judgement &&
            judgement.evidenceIds.every((id) => delivered.has(id) || failedIntegrity.has(id)) &&
            (delivered.size > 0 || failedIntegrity.size > 0),
          elapsedMs: run.elapsedMs,
        });
        writeFileSync(
          path.join(options.output, "results.json"),
          JSON.stringify({ casesSha256: reviewHash(options.casesFile), results }, null, 2),
        );
      }
    }),
  );
  const summary = summarizeVisionResults(results);
  const passed = fingerprint() === implementationSha256 && visionAcceptancePassed(summary);
  const report = {
    version: 1,
    implementationSha256,
    harnessVersions,
    models,
    efforts,
    casesSha256: reviewHash(options.casesFile),
    passed,
    summary,
    results,
    limitation:
      "Image delivery and classification are observed; semantic observations and executable repair decisions require the separate repair gate. Harness subscription billing is not inferred.",
  };
  writeFileSync(path.join(options.output, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
