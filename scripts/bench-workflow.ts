import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { checkWorkflowEvidence, runWorkflowEvaluation } from "../src/lib/bench/workflow-run";
import { scoreWorkflowQuality } from "../src/lib/bench/workflow-quality";
import { workflowScenarios } from "../src/lib/bench/workflow-scenarios";

void runOffline(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["list", "run", "check", "quality"],
      default: "list",
      description: "List pinned contracts, run bounded evaluation, or check recorded bytes without executing them",
    },
    {
      name: "scenario",
      default: "all",
      description: "Scenario ID or all; acceptance fixes outcomes, not an argv sequence",
    },
    {
      name: "mode",
      choices: ["contract", "native", "agent"],
      default: "contract",
      description: "Deterministic fixtures, installed resources only, or explicitly authorised real harnesses",
    },
    { name: "suite", description: "Trusted local workflow suite (scenario protocols 2/3), relative to this checkout" },
    {
      name: "benchmark",
      description: "Pinned quality corpus manifest relative to this checkout; scoring launches no model",
    },
    { name: "directory", description: "Private evidence directory containing report.json, for check" },
    { name: "harness", choices: ["codex", "claude-code"], description: "Real harness for agent mode" },
    { name: "model", description: "Exact selected harness model for agent mode" },
    {
      name: "allow-agent",
      type: "boolean",
      description: "Explicitly authorise bounded harness use; subscription or API usage may be billed separately",
    },
    {
      name: "no-spend",
      type: "boolean",
      description: "Forbid harness launches, including version probes; native resources must already be installed",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Validate hashes and limits without workspaces, commands or harness calls",
    },
  ] as const);
  if (args.action === "quality") {
    if (!args.benchmark || !args.directory)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Quality scoring requires --benchmark and --directory",
      });
    const result = scoreWorkflowQuality(args.benchmark, process.cwd(), args.directory);
    if (!result.metadata.passed)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Quality corpus thresholds failed",
        details: result.metadata,
      });
    return result;
  }
  if (args.action === "check") {
    if (!args.directory)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--directory is required for check" });
    return checkWorkflowEvidence(args.directory);
  }
  if (args.action === "list")
    return {
      metadata: {
        scenarios: workflowScenarios(process.cwd(), args.suite).map(
          ({ scenario, sha256, profile, suiteVersion, noSpend }) => ({
            profile,
            suiteVersion,
            noSpend,
            oracle: scenario.oracle,
            modes: scenario.modes,
            quality: scenario.quality,
            id: scenario.id,
            kind: scenario.kind,
            task: scenario.task,
            sha256,
            outcomes: scenario.outcomes,
            limits: scenario.limits,
          }),
        ),
      },
    };
  if (args.mode === "agent" && (!args.harness || !args.model || !args["allow-agent"]))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Agent mode requires --allow-agent, --harness and --model; harness usage may be billed.",
    });
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runWorkflowEvaluation({
      root: process.cwd(),
      noSpend: args["no-spend"],
      mode: args.mode as "contract" | "native" | "agent",
      scenario: args.scenario,
      suite: args.suite,
      dryRun: args["dry-run"],
      signal: controller.signal,
      ...(args.mode === "agent"
        ? {
            agent: {
              harness: args.harness as "codex" | "claude-code",
              model: args.model!,
              allowAgent: args["allow-agent"],
            },
          }
        : {}),
    });
    if (!args["dry-run"] && "completed" in result.metadata && !result.metadata.completed)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Workflow evaluation has failures, inconclusive outcomes or cancellation; inspect its reports.",
        details: { ...result.metadata, outputs: result.outputs },
      });
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
});
