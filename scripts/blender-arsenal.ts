import path from "node:path";
import { assertPathWithin, CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { arsenalPaths, ASSET_KINDS, ensureArsenalLayout } from "../src/lib/blender-arsenal/paths";
import { arsenalCandidates, arsenalStatus, auditArsenal } from "../src/lib/blender-arsenal/overview";
import { rescoreExecutableEval } from "../src/lib/blender-arsenal/eval-rescore";
import { evaluateArsenal } from "../src/lib/blender-arsenal/eval";

void runScript(async () => {
  const tokens = process.argv.slice(2);
  if (tokens[0] === "--") tokens.shift();
  const actions = tokens.filter((token) => token === "--action" || token.startsWith("--action="));
  if (actions.length > 1) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose one action" });
  if (tokens[0] && !tokens[0].startsWith("-")) {
    if (actions.length)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose positional action or --action, not both" });
    tokens.unshift("--action");
  }
  const args = parseArgs(
    [
      {
        name: "action",
        choices: ["status", "audit", "init", "candidates", "eval", "rescore"],
        default: "status",
        description: "Arsenal action",
      },
      { name: "capability", description: "Candidate capability tag, including approved generators" },
      { name: "report", description: "Saved v2 report.json to rescore without model calls" },
      {
        name: "capability",
        description:
          "Filter candidates by exact capability tag (approved tools included) and unresolved improvement gaps",
      },
      { name: "proof", description: "Recipe proof index.json for measured status" },
      { name: "capability", description: "Filter candidates by capability tag, including approved entries" },
      { name: "harness", choices: ["codex", "claude"], description: "Fresh read-only agent per evaluation task" },
      { name: "repo", description: "Read-only evaluation checkout; defaults to current worktree" },
      { name: "tasks", description: "Comma-separated task ids; omitted means all ten" },
      { name: "tasks-file", description: "Alternate strict task manifest" },
      { name: "out", description: "New directory for evaluation reports and raw responses" },
      { name: "model", description: "Harness model; Codex defaults to gpt-6.1-sol, Claude to sonnet" },
      { name: "samples", type: "number", default: 1, description: "Independent samples per task (1–10)" },
      { name: "concurrency", type: "number", default: 1, description: "Concurrent read-only agents (1–4)" },
      { name: "timeout", type: "number", default: 360, description: "Per-agent timeout, seconds" },
    ] as const,
    tokens,
  );
  if (
    !["eval", "rescore"].includes(args.action!) &&
    [args.harness, args.repo, args.tasks, args["tasks-file"], args.out, args.model].some((v) => v !== undefined)
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Evaluation flags require --action eval" });
  if (args.action === "rescore" && [args.harness, args.repo, args.tasks, args.model].some((v) => v !== undefined))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Harness/repo/task selection flags require eval" });
  if (args.capability && args.action !== "candidates")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--capability requires candidates" });
  if (args.report && args.action !== "rescore")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--report requires rescore" });
  if (args.capability && args.action !== "candidates")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--capability requires candidates" });
  if (args.proof && args.action !== "status")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--proof requires status" });
  if (args.capability && args.action !== "candidates")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--capability requires candidates" });
  try {
    switch (args.action) {
      case "init": {
        const p = arsenalPaths();
        for (const target of [
          p.blenderUser,
          p.downloads,
          p.bakes,
          p.trials,
          ...ASSET_KINDS.map((kind) => path.join(p.library, kind)),
        ])
          assertPathWithin(process.cwd(), target);
        return { metadata: { paths: ensureArsenalLayout() } };
      }
      case "status":
        return { metadata: arsenalStatus(process.cwd(), args.proof) };
      case "candidates":
        return { metadata: { candidates: arsenalCandidates(process.cwd(), args.capability) } };
      case "audit": {
        const audit = auditArsenal();
        if (!audit.pass)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `${audit.problems.length} arsenal audit problem(s)`,
            details: audit,
          });
        return { metadata: audit };
      }
      case "rescore": {
        if (!args.report || !args.out)
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "rescore requires --report and a new --out" });
        assertPathWithin(process.cwd(), path.resolve(args.out));
        const result = rescoreExecutableEval(args.report, args.out, args["tasks-file"]);
        return {
          outputs: [result.reportFile, result.markdownFile],
          metadata: {
            mean: result.report.overall.mean,
            sd: result.report.overall.sd,
            failures: result.report.failures,
          },
        };
      }
      case "eval": {
        if (!args.harness)
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "eval requires --harness codex|claude" });
        if (!Number.isFinite(args.timeout) || args.timeout! <= 0 || args.timeout! > 3600)
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "--timeout must be within 0–3600 seconds" });
        if (args.out) assertPathWithin(process.cwd(), path.resolve(args.out));
        const result = await evaluateArsenal({
          harness: args.harness as "codex" | "claude",
          repository: args.repo ?? process.cwd(),
          output: args.out ?? path.join("out/qa/arsenal-eval", new Date().toISOString().replace(/[:.]/g, "-")),
          tasks: args.tasks?.split(",").map((s) => s.trim()),
          tasksFile: args["tasks-file"],
          model: args.model,
          timeoutMs: args.timeout! * 1000,
          samples: args.samples,
          concurrency: args.concurrency,
        });
        if (result.report.failures)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `${result.report.failures} evaluation harness/schema failures`,
            details: {
              report: result.reportFile,
              markdown: result.markdownFile,
              total: result.report.total,
              maximum: result.report.maximum,
            },
          });
        return {
          outputs: [result.reportFile, result.markdownFile],
          metadata: { total: result.report.total, maximum: result.report.maximum, percent: result.report.percent },
        };
      }
      default:
        throw new Error("Unknown action");
    }
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: String(error) });
  }
});
