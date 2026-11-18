import path from "node:path";
import { assertPathWithin, parseArgs, runScript, CliErrorObject } from "../../cli";
import { requireUserWords } from "../../cli/user-words";
import { readWorkflowRequest } from "../../workflows/dispatch";
import { CampaignProductionRequestSchema, CampaignReviewPackageSchema } from "../../../types/campaign-production";
import { buildCampaignPlan } from "./plan";
import { initCampaign, loadCampaign, reviseCampaign, archiveCampaign } from "./store";
import { approveCampaignPackage, reviewPackage } from "./review";
import {
  campaignBrief,
  campaignNext,
  campaignStatus,
  recordCampaignDecision,
  recordCampaignOutcome,
  runCampaign,
} from "./service";
import { validateCampaignMember } from "./assurance";
import { repairCampaignMember } from "./repair";
import { refuse, productionDirectory, immutableJson, digest } from "./files";

export function campaignCli(mode: "production" | "next" | "brief" | "approve" | "execute") {
  return runScript(async () => {
    const args = parseArgs([
      { name: "project", required: true, description: "Campaign container ID" },
      {
        name: "action",
        choices: [
          "plan",
          "init",
          "status",
          "revise",
          "review",
          "outcomes",
          "run-local",
          "decision",
          "archive",
          "check",
          "repair",
        ],
        default: "plan",
        description: "Local campaign operation; never submits paid work",
      },
      { name: "request", description: "Production request JSON" },
      { name: "input", description: "Agent decision or reviewed outcome JSON" },
      { name: "task", description: "Agent task ID from campaign:next" },
      {
        name: "purpose",
        choices: ["creative-plan", "generation-requests", "child-gates", "final-outputs", "pilot-outputs"],
        default: "creative-plan",
        description: "Concrete review package purpose",
      },
      { name: "members", description: "Comma-separated member IDs to review" },
      { name: "package", description: "Exact review package JSON; approvals remain CLI-only" },
      { name: "expected-hash", description: "Reviewed package SHA-256" },
      { name: "answer", description: "User’s actual decision, verbatim" },
      { name: "reviewed-by", description: "Person who reviewed this exact package" },
      {
        name: "allow-paid",
        type: "boolean",
        description: "Explicit future paid execution authority; cannot override a no-spend campaign",
      },
      { name: "max-total-usd", type: "number", description: "Explicit aggregate high bound for authorised execution" },
      { name: "max-tasks", type: "number", description: "Maximum ready tasks to attempt in this invocation" },
      { name: "scope-root", description: "Trusted workspace boundary supplied by MCP" },
      { name: "reason", description: "Why campaign retention can end; archive is CLI-only" },
    ] as const);
    const root = path.resolve(process.cwd()),
      id = args.project!;
    const runOutput = async (paid = false) => {
      const { tasks, ...result } = await runCampaign(root, id, {
          paid,
          maxTotalUsd: args["max-total-usd"],
          maxTasks: args["max-tasks"],
        }),
        counts: Record<string, number> = {};
      for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
      const blockers = tasks
        .filter((task) => ["blocked", "failed"].includes(task.state))
        .slice(0, 20)
        .map((task) => ({ id: task.id, state: task.state, ...("message" in task ? { message: task.message } : {}) }));
      return {
        metadata: {
          ...result,
          taskCount: tasks.length,
          counts,
          blockers,
          nextCommand: `pnpm campaign:next --project ${id}`,
        },
      };
    };
    if (args["scope-root"]) assertPathWithin(path.resolve(args["scope-root"]), root);
    const read = (file: string | undefined) => {
      if (!file) refuse("This action requires an input JSON file");
      return readWorkflowRequest(path.resolve(root, file), root);
    };
    if (mode !== "execute" && args["allow-paid"]) refuse("Paid authority is accepted only by campaign:execute");
    if (args["max-tasks"] !== undefined && (!Number.isInteger(args["max-tasks"]) || args["max-tasks"] < 1))
      refuse("max-tasks must be a positive integer");
    if (mode === "next") return { metadata: campaignNext(root, id) };
    if (mode === "brief") {
      if (!args.task) refuse("Select an agent task");
      const result = campaignBrief(root, id, args.task);
      return { outputs: [result.file], metadata: result };
    }
    if (mode === "approve") {
      if (!args["expected-hash"] || !args.answer || !args["reviewed-by"])
        refuse("Supply expected-hash, answer and reviewed-by");
      requireUserWords(args.answer, "--answer");
      return {
        metadata: await approveCampaignPackage(
          root,
          loadCampaign(root, id),
          read(args.package),
          args["expected-hash"],
          args.answer,
          args["reviewed-by"],
        ),
      };
    }
    if (mode === "execute") {
      if (!args["allow-paid"])
        refuse("campaign:execute requires explicit --allow-paid; use run-local for no-spend work");
      return runOutput(true);
    }
    if (args.action === "plan" || args.action === "init" || args.action === "revise") {
      const request = CampaignProductionRequestSchema.parse(read(args.request));
      if (request.id !== id) refuse("Request campaign differs from --project");
      const plan =
        args.action === "plan"
          ? buildCampaignPlan(request, root)
          : args.action === "init"
            ? initCampaign(request, root)
            : reviseCampaign(request, root);
      const file = path.join(productionDirectory(root, id), "plans", `${plan.planHash}.json`);
      return {
        outputs: args.action === "plan" ? [] : [file],
        metadata: {
          planHash: plan.planHash,
          revision: plan.request.revision,
          scenario: plan.request.scenario,
          memberCount: plan.members.length,
          taskCount: plan.tasks.length,
          allocation: plan.allocation,
          members: plan.members.slice(0, 20),
          reusePlan: plan.reusePlan?.slice(0, 20),
          truncated: plan.members.length > 20,
          ...(args.action !== "plan" ? { planFile: file } : {}),
          generationRequests: 0,
          productionReady: false,
        },
      };
    }
    if (args.action === "run-local") return runOutput();
    if (args.action === "repair") {
      const result = repairCampaignMember(root, id, read(args.input));
      return { outputs: [result.file], metadata: result };
    }
    if (args.action === "check") {
      const plan = loadCampaign(root, id),
        selection = args.members?.split(","),
        selected = plan.members.filter((member) => !member.excluded && (!selection || selection.includes(member.id)));
      if (selection && (selected.length !== selection.length || new Set(selection).size !== selection.length))
        refuse("Check selection names missing or duplicate members");
      const reports = selected.map((member) => validateCampaignMember(root, plan, member));
      const file = path.join(productionDirectory(root, id), "validation", `campaign-${digest(reports)}.json`);
      immutableJson(file, { planHash: plan.planHash, reports });
      const metadata = {
        memberCount: reports.length,
        failedCount: reports.filter((report) => !report.passed).length,
        reports: reports.slice(0, 20).map((report) => ({ ...report, issues: report.issues.slice(0, 5) })),
        truncated: reports.length > 20,
        reportFile: file,
      };
      if (metadata.failedCount)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Campaign scenario checks failed; inspect the exact report",
          details: metadata,
        });
      return { outputs: [file], metadata };
    }
    if (args.action === "status") return { metadata: campaignStatus(root, id) };
    if (args.action === "archive") return { metadata: await archiveCampaign(root, id, args.reason ?? "") };
    if (args.action === "review") {
      const result = reviewPackage(
        root,
        loadCampaign(root, id),
        CampaignReviewPackageSchema.shape.purpose.parse(args.purpose),
        args.members?.split(","),
      );
      return { outputs: [result.file], metadata: result.pack };
    }
    const result =
      args.action === "decision"
        ? recordCampaignDecision(root, id, read(args.input))
        : recordCampaignOutcome(root, id, read(args.input));
    return { outputs: [result.file], metadata: result };
  });
}
