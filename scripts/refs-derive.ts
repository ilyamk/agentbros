/**
 * Immutable reference derivatives (RFC 0003 §6.4): plan (dry run), run, show. Local ffmpeg/matte steps and Blender
 * passes are free; a leading fal step (depth-video, pose-video, mask-video, audio-clean with engine fal) is a paid
 * durable job: run needs the user's --confirm-spend, and --max-cost-usd when the price is unknown.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import {
  advanceDerivative,
  pendingDerivative,
  planDerivativeSpend,
  showDerivative,
} from "../src/lib/references/derive";

void runScript(async () => {
  try {
    const args = parseArgs([
      {
        name: "action",
        required: true,
        choices: ["plan", "run", "show"],
        description:
          "plan: dry run of steps, engines and, for a fal step, the generation request and quote; writes nothing. run: execute (a fal step submits or resumes one durable job). show: read a receipt or a pending job",
      },
      { name: "project", required: true, description: "Existing project ID" },
      { name: "spec", description: "DerivativeSpec JSON file (plan, run)" },
      { name: "id", description: "Derivative ID (show)" },
      {
        name: "confirm-spend",
        type: "boolean",
        description:
          "run: the user approved this paid fal step after seeing the plan's quote. Agents pass it only after the user's explicit yes; never on their own judgement",
      },
      {
        name: "max-cost-usd",
        type: "number",
        description:
          "run: the user's planning bound for a fal step whose price is unknown (required then); it does not cap provider billing",
      },
      { name: "dry-run", type: "boolean", description: "Treat run as plan: no writes, no spend (MCP forces it)" },
    ] as const);
    const required = (value: string | undefined, flag: string): string => {
      if (!value?.trim())
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} is required for ${args.action}.` });
      return value;
    };
    const project = required(args.project, "project");
    requireProject(project);
    const spec = (): unknown => {
      const file = required(args.spec, "spec");
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `Cannot read spec ${file}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };
    const maxCostUsd = args["max-cost-usd"];
    if (args.action === "plan" || (args.action === "run" && args["dry-run"])) {
      const plan = await planDerivativeSpend(project, spec(), process.cwd(), { maxCostUsd });
      const run = `pnpm refs:derive --project ${project} --action run --spec ${args.spec}`;
      const nextActions = !plan.runnable
        ? ["Remove or replace the steps that are not-implemented."]
        : plan.fal?.schema === "not-cached"
          ? [plan.fal.nextAction!]
          : plan.fal
            ? [
                "Show the user the endpoint and quote; ask for approval of the spend.",
                `After their yes: ${run} --confirm-spend${plan.fal.pricing === "unknown" ? " --max-cost-usd <the bound they authorised>" : ""}`,
              ]
            : [run];
      return { metadata: { ...plan, ...(args["dry-run"] ? { dryRun: true } : {}), nextActions } };
    }
    if (args.action === "run") {
      const data = await advanceDerivative(project, spec(), process.cwd(), {
        confirmSpend: args["confirm-spend"] === true,
        maxCostUsd,
      });
      if (data.status === "pending")
        return {
          outputs: [],
          metadata: {
            status: "pending",
            id: data.id,
            operationId: data.operationId,
            endpoint: data.endpoint,
            state: data.state,
            pending: path.join(data.directory, "pending.json"),
            nextAction: data.nextAction,
          },
        };
      return {
        outputs: ["spec.json", "receipt.json", "board.html"].map((name) => path.join(data.directory, name)),
        metadata: {
          status: "ready",
          id: data.receipt.id,
          sha256: data.sha256,
          reused: data.reused,
          output: data.receipt.output,
          assetId: data.asset.id,
          engine: data.receipt.engine,
          costUsd: data.receipt.costUsd,
          measurements: data.receipt.measurements,
          warnings: data.receipt.warnings,
        },
      };
    }
    const id = required(args.id, "id");
    const pending = pendingDerivative(project, id);
    if (pending) return { outputs: pending.files, metadata: { status: "pending", ...pending } };
    const shown = showDerivative(project, id);
    return {
      outputs: shown.files,
      metadata: {
        status: "ready",
        sha256: shown.sha256,
        spec: shown.spec,
        receipt: shown.receipt,
        sequence: shown.sequence,
      },
    };
  } catch (error) {
    if (error instanceof ZodError) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
