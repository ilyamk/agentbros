import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CampaignDecisionSchema,
  CampaignFileSchema,
  CampaignHash,
  CampaignProductionPlanSchema,
  CampaignTaskReceiptSchema,
  type CampaignProductionPlan,
  type CampaignTask,
} from "../../../types/campaign-production";
import { OutcomeSchema } from "../../../types/campaigns";
import { nextAction, openFilmProject } from "../../film/state";
import { isBespokeDelivery } from "../../delivery/bespoke";
import { memoryFields, withPlaybook } from "../../pipeline/route";
import { executeCampaignTask, campaignInputIdentity } from "./execute";
import {
  acquireLock,
  atomicJson,
  digest,
  immutableJson,
  jsonFile,
  pinFile,
  productionDirectory,
  projectDirectory,
  refuse,
  scopedFile,
  verifyPin,
} from "./files";
import { campaignCosts, loadCampaign, assertCampaignActive, campaignArchive } from "./store";
import { packageApproved } from "./review";
import { campaignReadScope, campaignTaskStates, runCampaignQueue, taskInputHash, taskReceipt } from "./queue";
import { campaignCommand } from "./command";
import { currentDecision, decisionAttempts, saveDecision, repairRounds } from "./decisions";
import { assertLocalizationReady } from "../localization";
import { pilotTaskIds } from "./pilot";
import { COMMAND_REGISTRY } from "../../cli/commands";
import { pickModel } from "../../models/model-slots";
import { PriceQuoteSchema } from "../../jobs/types";
import { reservationUsd } from "../../jobs/store";

export async function runCampaign(
  root: string,
  id: string,
  options: {
    paid?: boolean;
    maxTotalUsd?: number;
    limits?: { generation?: number; process?: number; render?: number; qa?: number };
    maxTasks?: number;
  } = {},
) {
  assertCampaignActive(root, id);
  const plan = loadCampaign(root, id);
  if (options.paid) {
    if (plan.request.spend === "forbid") refuse("Campaign spending is forbidden");
    if (!packageApproved(root, plan, "generation-requests"))
      refuse("Approve the exact generation request package first");
    if (options.maxTotalUsd === undefined || !Number.isFinite(options.maxTotalUsd) || options.maxTotalUsd < 0)
      refuse("Paid execution needs an explicit aggregate high bound");
    let high = 0;
    for (const material of plan.request.materials)
      if (material.source.kind === "generate") {
        const owner =
          material.owner === "shared" ? id : plan.members.find((member) => member.id === material.owner)!.projectId;
        const result = await campaignCommand(root, "generate-model.ts", [
          "--project",
          owner,
          "--request",
          verifyPin(root, material.source.request),
          "--output",
          scopedFile(root, material.source.output),
          "--operation-id",
          `campaign.${id}.${material.id}.${digest(material.source).slice(0, 16)}`,
          "--dry-run",
          ...(material.source.maxCostUsd ? ["--max-cost-usd", String(material.source.maxCostUsd)] : []),
        ]);
        const quote = PriceQuoteSchema.safeParse(result.metadata.quote);
        if (result.metadata.executable === false || !quote.success || !quote.data.bounded)
          refuse("Every campaign request needs an executable bounded dry-run quote");
        high += Math.ceil(reservationUsd(quote.data) * 1e6 - 1e-7);
      }
    if (high > Math.floor(options.maxTotalUsd * 1e6 + 1e-7))
      refuse("Aggregate request quote exceeds the explicit execution bound");
  }
  if (!packageApproved(root, plan, "creative-plan"))
    return {
      attempted: 0,
      action: "ask",
      why: "Approve the concrete creative plan before production",
      tasks: campaignTaskStates(root, plan, campaignInputIdentity),
    };
  return runCampaignQueue(root, plan, executeCampaignTask, {
    ...options,
    identity: campaignInputIdentity,
    allowedTaskIds: pilotTaskIds(root, plan),
  });
}
export function campaignStatus(root: string, id: string) {
  return campaignReadScope(() => campaignStatusRead(root, id));
}
function campaignStatusRead(root: string, id: string) {
  const plan = loadCampaign(root, id),
    tasks = campaignTaskStates(root, plan, campaignInputIdentity);
  const selected = plan.members.filter((member) => !member.excluded),
    allowed = pilotTaskIds(root, plan);
  return {
    pilotPending: Boolean(allowed),
    heldMemberIds: allowed
      ? selected
          .filter((member) => !plan.tasks.some((task) => task.memberId === member.id && allowed.has(task.id)))
          .map((member) => member.id)
      : [],
    campaignId: id,
    planHash: plan.planHash,
    revision: plan.request.revision,
    scenario: plan.request.scenario,
    spend: plan.request.spend,
    archived: campaignArchive(root, id),
    tasks,
    costs: campaignCosts(root, id),
    selectedMemberCount: selected.length,
    rejectedMemberIds: plan.members.filter((member) => member.excluded).map((member) => member.id),
    complete: tasks.every((task) => task.state === "complete"),
    productionReady:
      selected.length > 0 &&
      selected.every(
        (member) =>
          Boolean(member.delivery) && tasks.find((task) => task.id === `delivery-${member.id}`)?.state === "complete",
      ),
  };
}
const ReviewDraftSchema = z
  .object({
    planHash: CampaignHash,
    revision: z.number().int().nonnegative(),
    choices: z.array(
      z
        .object({
          planHash: CampaignHash,
          memberId: z.string(),
          choice: z.enum(["keep", "fix", "reject"]),
          note: z.string(),
          outputs: z.array(CampaignFileSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function reviewRepair(root: string, plan: CampaignProductionPlan) {
  const file = path.join(productionDirectory(root, plan.request.id), "selection.json");
  if (!existsSync(file)) return null;
  const selection = ReviewDraftSchema.parse(jsonFile(file));
  if (selection.planHash !== plan.planHash) return null;
  const latest = new Map(
    selection.choices.filter((choice) => choice.planHash === plan.planHash).map((choice) => [choice.memberId, choice]),
  );
  const changes = [...latest.values()].filter((choice) => {
    const member = plan.members.find((member) => member.id === choice.memberId);
    return (
      member &&
      (choice.choice === "fix" ||
        (choice.choice === "reject" && !member.excluded) ||
        (choice.choice === "keep" && member.excluded))
    );
  });
  if (!changes.length) return null;
  for (const change of changes) change.outputs.forEach((pin) => verifyPin(root, pin));
  const pin = pinFile(root, file),
    stem = `${plan.planHash}-${pin.sha256}`;
  const output = path.join(productionDirectory(root, plan.request.id), "revision-drafts", `${stem}.json`);
  return {
    pin,
    changes,
    output,
    members: plan.members.filter((member) => changes.some((choice) => choice.memberId === member.id)),
  };
}
export function campaignNext(root: string, id: string) {
  return campaignReadScope(() => campaignNextRead(root, id));
}
function campaignNextRead(root: string, id: string) {
  const plan = loadCampaign(root, id),
    directory = projectDirectory(root, id);
  const common = {
    reasonCode: "CHILD_WORK_REQUIRED",
    ...withPlaybook(directory, ["docs/campaign-production.md"]),
    ...memoryFields(directory, "campaign"),
    planHash: plan.planHash,
  };
  if (campaignArchive(root, id))
    return {
      ...common,
      action: "stop",
      reasonCode: "ARCHIVED",
      why: "Campaign archived; retained owner assets remain protected until its children are removed",
    };
  if (!packageApproved(root, plan, "creative-plan"))
    return {
      ...common,
      action: "ask",
      reasonCode: "PLAN_APPROVAL_REQUIRED",
      why: "The exact campaign plan needs the user’s decision",
      show: [path.relative(root, path.join(productionDirectory(root, id), "plans", `${plan.planHash}.json`))],
      commands: [`pnpm campaign:production --project ${id} --action review --purpose creative-plan`],
    };
  const repair = reviewRepair(root, plan);
  if (repair)
    return existsSync(repair.output)
      ? {
          ...common,
          action: "run",
          why: "Bind the targeted revision draft, then obtain approval of its exact new plan",
          commands: [
            `pnpm campaign:production --project ${id} --action revise --request ${path.relative(root, repair.output)}`,
          ],
        }
      : {
          ...common,
          action: "dispatch",
          agent: "campaign-producer",
          fresh: true,
          taskId: "review-repair",
          why: "Prepare a targeted revision from the user’s exact review draft; no production or approval is granted",
          briefCommand: `pnpm campaign:brief --project ${id} --task review-repair`,
        };
  const states = campaignTaskStates(root, plan, campaignInputIdentity);
  const allowed = pilotTaskIds(root, plan),
    eligible = plan.tasks.filter((task) => !allowed || allowed.has(task.id));
  for (const member of plan.members)
    if (
      !member.excluded &&
      eligible.some((task) => task.memberId === member.id) &&
      isBespokeDelivery(root, member.projectId)
    ) {
      const next = nextAction(openFilmProject(projectDirectory(root, member.projectId), { rootDir: root }));
      if (
        ["measure", "replica-compare"].includes(next.step ?? "") &&
        plan.tasks.some(
          (task) =>
            task.memberId === member.id &&
            task.kind === "render" &&
            states.find((state) => state.id === task.id)?.state !== "complete",
        )
      )
        continue;
      if (next.action !== "stop") return { ...common, ...next, childProjectId: member.projectId, campaignId: id };
    }
  const counts: Record<string, number> = {};
  for (const state of states) counts[state.state] = (counts[state.state] ?? 0) + 1;
  const selectedMembers = plan.members.filter((member) => !member.excluded);
  const status = {
    taskCount: states.length,
    counts,
    selectedMemberCount: selectedMembers.length,
    productionReady:
      selectedMembers.length > 0 &&
      selectedMembers.every(
        (member) =>
          Boolean(member.delivery) &&
          states.find((state) => state.id === `delivery-${member.id}`)?.state === "complete",
      ),
    heldTaskCount: allowed ? plan.tasks.length - allowed.size : 0,
  };
  const next = <T extends { action: string }>(value: T) => ({ ...common, status, ...value });
  for (const member of plan.members.filter(
    (member) =>
      !member.excluded && member.adapter.kind === "localise" && eligible.some((task) => task.memberId === member.id),
  )) {
    if (states.find((state) => state.id === `anchors-${member.id}`)?.state !== "complete") continue;
    try {
      assertLocalizationReady(projectDirectory(root, member.projectId));
    } catch {
      return next({
        action: "ask",
        reasonCode: "LANGUAGE_REVIEW_REQUIRED",
        childProjectId: member.projectId,
        commands: [
          `pnpm campaign:production --project ${id} --action review --purpose child-gates --members ${member.id}`,
        ],
      });
    }
  }
  const readyAgents = eligible.filter(
    (task) =>
      task.kind === "agent" &&
      !["complete", "running", "waiting"].includes(states.find((state) => state.id === task.id)?.state ?? "") &&
      task.dependsOn.every((dep) => states.find((state) => state.id === dep)?.state === "complete"),
  );
  for (const task of readyAgents) {
    const inputHash = taskInputHash(root, plan, task, campaignInputIdentity),
      current = currentDecision(root, plan, task);
    if (current?.decision.inputHash === inputHash) {
      if (current.decision.verdict === "accept") {
        try {
          [...current.decision.evidence, ...current.decision.outputs].forEach((pin) => verifyPin(root, pin));
        } catch {
          if (decisionAttempts(root, plan, task, inputHash).length >= (plan.request.policy?.maxAgentAttempts ?? 3))
            return next({
              action: "ask",
              reasonCode: "ATTEMPT_LIMIT",
              taskId: task.id,
              why: "Stale evidence and exhausted decision attempts require new inputs or a reviewed revision",
            });
          return next({
            action: "dispatch",
            reasonCode: "DECISION_EVIDENCE_STALE",
            taskId: task.id,
            agent: current.decision.agent,
            fresh: true,
            briefCommand: `pnpm campaign:brief --project ${id} --task ${task.id}`,
            why: "Restore the declared outputs or submit a fresh CAS replacement with actual evidence",
          });
        }
        const state = states.find((state) => state.id === task.id);
        if (state && "exhausted" in state && state.exhausted)
          return next({
            action: "ask",
            reasonCode: "ATTEMPT_LIMIT",
            taskId: task.id,
            why: "The accepted task failed repeatedly; provide corrected evidence and a fresh CAS decision",
          });
        return next({
          action: "run",
          reasonCode: "DECISION_READY",
          commands: [`pnpm campaign:production --project ${id} --action run-local`],
        });
      }
      if (decisionAttempts(root, plan, task, inputHash).length >= (plan.request.policy?.maxAgentAttempts ?? 3))
        return next({
          action: "ask",
          reasonCode: "ATTEMPT_LIMIT",
          taskId: task.id,
          why: "Agent attempts are exhausted; change inputs or revise the plan",
        });
      if (
        current.decision.verdict === "reject" ||
        !current.decision.issues?.length ||
        current.decision.issues.some((issue) => !["presentation", "timing"].includes(issue.category))
      )
        return next({
          action: "ask",
          reasonCode: "PLAN_CHANGE_REQUIRED",
          taskId: task.id,
          issues: current.decision.issues,
          why: current.decision.rationale,
        });
      const member = plan.members.find((member) => member.id === task.memberId);
      if (
        !member ||
        task.id !== `critique-${member.id}` ||
        !["template", "recipe", "localise"].includes(member.adapter.kind)
      )
        return next({
          action: "ask",
          reasonCode: "REVIEWED_ROUTE_REQUIRED",
          taskId: task.id,
          why: "Use the child route or revise the plan; this feedback is outside scoped presentation repair",
        });
      if (repairRounds(root, plan, member.id) >= (plan.request.policy?.maxAgentAttempts ?? 3))
        return next({
          action: "ask",
          reasonCode: "ATTEMPT_LIMIT",
          taskId: task.id,
          why: "Presentation repair rounds are exhausted; revise the plan or provide new direction",
        });
      return next({
        action: "dispatch",
        reasonCode: "REPAIR_REQUIRED",
        taskId: `repair-${task.id}`,
        agent: "fixer",
        fresh: true,
        briefCommand: `pnpm campaign:brief --project ${id} --task repair-${task.id}`,
        why: current.decision.rationale,
      });
    }
    const spec = task.payload.agentTask as { agent: string; purpose: string };
    return next({
      action: "dispatch",
      reasonCode: "SPECIALIST_REQUIRED",
      taskId: task.id,
      agent: spec.agent,
      fresh: true,
      why: spec.purpose,
      briefCommand: `pnpm campaign:brief --project ${id} --task ${task.id}`,
    });
  }
  const runnable = eligible.some((task) => {
    const state = states.find((state) => state.id === task.id)!;
    return (
      task.kind !== "agent" &&
      (["ready", "stale"].includes(state.state) ||
        (state.state === "failed" && !("exhausted" in state && state.exhausted)) ||
        (state.state === "blocked" &&
          "reasonCode" in state &&
          state.reasonCode === "FINAL_REVIEW_REQUIRED" &&
          task.kind === "delivery" &&
          packageApproved(root, plan, "final-outputs")))
    );
  });
  if (runnable)
    return next({
      action: "run",
      reasonCode: "LOCAL_WORK_READY",
      commands: [`pnpm campaign:production --project ${id} --action run-local`],
    });
  if (allowed && eligible.every((task) => states.find((state) => state.id === task.id)?.state === "complete"))
    return next({
      action: "ask",
      reasonCode: "PILOT_REVIEW_REQUIRED",
      why: "Review the exact pilot outputs before releasing the remaining members",
      commands: [`pnpm campaign:production --project ${id} --action review --purpose pilot-outputs`],
    });
  const blocked = states.filter(
    (state) => eligible.some((task) => task.id === state.id) && ["blocked", "failed"].includes(state.state),
  );
  if (blocked.length)
    return next({
      action: "ask",
      reasonCode: blocked.some((state) => "exhausted" in state && state.exhausted)
        ? "ATTEMPT_LIMIT"
        : (blocked.flatMap((state) => ("reasonCode" in state && state.reasonCode ? [state.reasonCode] : []))[0] ??
          "INPUT_OR_APPROVAL_REQUIRED"),
      blockers: blocked.slice(0, 20),
      blockerCount: blocked.length,
      why: "Resolve the exact blocker; do not repeat unchanged work",
      read: [
        ...common.read,
        ...blocked
          .slice(0, 20)
          .flatMap((state) => ("evidence" in state ? (state.evidence?.slice(0, 2).map((pin) => pin.path) ?? []) : [])),
      ],
      commands: blocked.some((state) => "reasonCode" in state && state.reasonCode === "FINAL_REVIEW_REQUIRED")
        ? [`pnpm campaign:production --project ${id} --action review --purpose final-outputs`]
        : [`pnpm campaign:production --project ${id} --action status`],
    });
  const complete = states.every((state) => state.state === "complete"),
    selected = plan.members.filter((member) => !member.excluded);
  return next({
    action: complete ? "stop" : "wait",
    reasonCode: complete
      ? "COMPLETE"
      : states.some((state) => state.state === "capacity")
        ? "RESOURCE_CAPACITY"
        : "WORK_PENDING",
    why: complete
      ? "Selected campaign tasks are complete; inspect delivery readiness"
      : "Work is running or waiting on dependencies",
    retryAfterMs: complete
      ? undefined
      : Math.max(
          1000,
          Math.min(
            300000,
            ...states
              .filter((state) => ["waiting", "capacity"].includes(state.state))
              .map((state) => ("retryAfterMs" in state ? (state.retryAfterMs ?? 5000) : 5000)),
            5000,
          ),
        ),
    productionReady:
      selected.length > 0 &&
      selected.every(
        (member) =>
          Boolean(member.delivery) &&
          states.find((state) => state.id === `delivery-${member.id}`)?.state === "complete",
      ),
    commands: [`pnpm campaign:production --project ${id} --action status`],
  });
}
export function campaignBrief(root: string, id: string, taskId: string) {
  assertCampaignActive(root, id);
  const plan = loadCampaign(root, id),
    task = plan.tasks.find((task) => task.id === taskId);
  if (!task && taskId === "review-repair") {
    const repair = reviewRepair(root, plan);
    if (!repair) refuse("No current review draft requests repairs");
    const manifestFile = path.join(
      productionDirectory(root, id),
      "briefs",
      `review-${plan.planHash}-${repair.pin.sha256}.json`,
    );
    const inputs = {
      plan: pinFile(root, path.join(productionDirectory(root, id), "plans", `${plan.planHash}.json`)),
      selection: repair.pin,
      changes: repair.changes,
      members: repair.members,
      output: path.relative(root, repair.output),
    };
    immutableJson(manifestFile, inputs);
    const prompt = `You are campaign-producer. Leaf agent: do not spawn agents. Read .agents/agents/campaign-producer.md and docs/campaign-production.md, then inspect ${path.relative(root, manifestFile)}. Verify its pinned plan, review draft and output evidence. A change of kind user-feedback carries the user's words verbatim in its note: the revision answers them, for that member only. Write the exact revision request at ${inputs.output}. Preserve all allocation owners and their order. For keep, clear excluded without changing sources. For fix, set excluded:false and change only the affected member and pin expectedProject before template/recipe edits. For reject, keep the member with excluded:true; remove generation requests used only by excluded members and clear their removed material IDs. Preserve other products and shared assets. Increase revision, keep spending policy and allocations unchanged, and retain explicit catalogue factors when expanding members. This creates a proposal, not human approval. Do not generate, spend, edit child artefacts or record a CampaignDecision. campaign:next will bind the draft and request a new plan decision.`;
    return {
      agent: "campaign-producer",
      taskId,
      planHash: plan.planHash,
      inputHash: digest(inputs),
      prompt,
      file: manifestFile,
      manifest: pinFile(root, manifestFile),
      output: inputs.output,
    };
  }
  if (!task && taskId.startsWith("repair-")) {
    const source = plan.tasks.find((task) => task.id === taskId.slice(7)),
      current = source && currentDecision(root, plan, source);
    if (
      !source ||
      !current ||
      current.decision.verdict !== "revise" ||
      current.decision.inputHash !== taskInputHash(root, plan, source, campaignInputIdentity)
    )
      refuse("Repair feedback is absent or stale");
    const member = plan.members.find((member) => member.id === source.memberId);
    if (!member) refuse("Repair needs an exact child member");
    const project = pinFile(root, path.join(projectDirectory(root, member.projectId), "project.json"));
    const inputs = {
      campaignId: id,
      decision: pinFile(root, current.file),
      decisionHash: current.hash,
      member,
      project,
      issues: current.decision.issues,
    };
    const file = path.join(productionDirectory(root, id), "briefs", `${taskId}-${digest(inputs)}.json`);
    const prompt = `You are fixer, a leaf agent. Campaign: ${id}. Read .agents/agents/fixer.md and docs/campaign-production.md. Inspect this exact manifest and its evidence. Apply only named presentation/timing changes using CampaignRepairSchema and pnpm campaign:production --project ${id} --action repair --input FILE. Expected project: ${JSON.stringify(project)}; decisionHash: ${current.hash}. Do not change facts, words, media, identities, budgets or approvals. Other changes require a reviewed plan revision. Never grade your own repair; campaign:next returns it to the independent critic after fresh render and QA.`;
    immutableJson(file, { inputs, prompt });
    return {
      agent: "fixer",
      taskId,
      planHash: plan.planHash,
      inputHash: digest(inputs),
      prompt,
      file,
      manifest: pinFile(root, file),
    };
  }
  if (!task || task.kind !== "agent") refuse("Select an agent task from campaign:next");
  const spec = task.payload.agentTask as {
    requirements?: { commands: string[]; modelUseCases: string[]; acceptance: string[] };
    agent: string;
    purpose: string;
    inputs: { path: string; sha256: string }[];
    outputs: string[];
  };
  const inputHash = taskInputHash(root, plan, task, campaignInputIdentity),
    member = plan.members.find((member) => member.id === task.memberId);
  const requirements = spec.requirements;
  if (requirements?.commands.some((command) => !COMMAND_REGISTRY.some((entry) => entry.alias === command)))
    refuse("Specialist requires an unregistered command");
  const capabilities =
    requirements?.modelUseCases.map((useCase) => ({ useCase, selection: pickModel({ useCase }) })) ?? [];
  const previous = currentDecision(root, plan, task);
  const inputs = {
    campaignId: id,
    requirements,
    capabilities,
    previousDecision: previous ? { hash: previous.hash, decision: previous.decision } : null,
    brief: plan.request.brief,
    purpose: spec.purpose,
    member: member ?? null,
    declaredInputs: spec.inputs,
    declaredOutputs: spec.outputs,
    reference: plan.request.reference,
    entityPins: plan.request.entityPins,
    materials: plan.request.materials.filter((material) => member?.materials.includes(material.id)),
    dependencies: task.dependsOn.map((id) =>
      taskReceipt(
        root,
        plan,
        plan.tasks.find((task) => task.id === id)!,
        campaignInputIdentity,
      ),
    ),
  };
  if (Buffer.byteLength(JSON.stringify(inputs)) > 16 * 1024 * 1024)
    refuse("Agent handoff exceeds 16 MiB; split the task into bounded member groups");
  const stem = `${task.id}-${digest({ planHash: plan.planHash, inputHash, inputs })}`,
    inputsFile = scopedFile(root, path.join(productionDirectory(root, id), "briefs", `${stem}.inputs.json`));
  immutableJson(inputsFile, inputs);
  const manifest = pinFile(root, inputsFile);
  const prompt = [
    `You are ${spec.agent}. Leaf agent: do not spawn agents.`,
    `Read .agents/agents/${spec.agent}.md and playbooks/${plan.request.scenario}/AGENTS.md.`,
    `Campaign: ${id}; task: ${task.id}; planHash: ${plan.planHash}; inputHash: ${inputHash}.`,
    `Purpose excerpt: ${spec.purpose.slice(0, 2000)}`,
    `Brief excerpt: ${plan.request.brief.slice(0, 2000)}`,
    `Spending: ${plan.request.spend}. Never submit paid work from this brief; return exact operation plans through existing model slots and request dry-runs.`,
    `Read and verify this exact handoff manifest: ${JSON.stringify(manifest)}. It contains the full brief and purpose, member, pinned sources, dependency receipts and ${spec.outputs.length} exact required output paths. Inspect the relevant source files; excerpts are not the complete contract.`,
    "Write a CampaignDecision (src/types/campaign-production.ts): taskId, planHash, inputHash, agent, verdict, rationale, evidence and outputs with actual SHA-256 pins. Inspect actual evidence; missing quality evidence is not acceptance. Sound needs a human listening decision.",
    `When replacing a decision, include supersedes:${previous?.hash ?? "none"}. Non-acceptance feedback should include structured issues with scene, instruction, acceptance and actual evidence.`,
    `Register the decision with pnpm campaign:production --project ${id} --action decision --input FILE. Never record a human approval or fabricate provider results, invoices or rights.`,
  ].join("\n\n");
  const file = path.join(productionDirectory(root, id), "briefs", `${stem}.json`);
  immutableJson(file, { agent: spec.agent, taskId, planHash: plan.planHash, inputHash, prompt });
  return { agent: spec.agent, taskId, planHash: plan.planHash, inputHash, prompt, file, manifest };
}
export function recordCampaignDecision(root: string, id: string, raw: unknown) {
  assertCampaignActive(root, id);
  const release = acquireLock(path.join(productionDirectory(root, id), "writer.lock"));
  if (!release) refuse("Campaign production or revision is already active");
  try {
    const plan = loadCampaign(root, id),
      decision = CampaignDecisionSchema.parse(raw),
      task = plan.tasks.find((task) => task.id === decision.taskId);
    if (
      !task ||
      task.kind !== "agent" ||
      decision.planHash !== plan.planHash ||
      decision.inputHash !== taskInputHash(root, plan, task, campaignInputIdentity)
    )
      refuse("Decision inputs or campaign revision changed");
    const spec = task.payload.agentTask as { agent: string; outputs: string[] };
    if (
      spec.agent !== decision.agent ||
      (decision.verdict === "accept" &&
        digest(spec.outputs.map((file) => path.relative(root, scopedFile(root, file))).sort()) !==
          digest(decision.outputs.map((pin) => path.relative(root, scopedFile(root, pin.path))).sort()))
    )
      refuse("Decision agent or output contract differs");
    return saveDecision(root, plan, task, decision, decision.inputHash);
  } finally {
    release();
  }
}
export function recordCampaignOutcome(root: string, id: string, raw: unknown) {
  const current = loadCampaign(root, id, { verifyInputs: false }),
    outcome = OutcomeSchema.extend({
      planHash: CampaignHash.optional(),
      outputHashes: z.array(CampaignHash).min(1).max(16).optional(),
    }).parse(raw);
  const plan = outcome.planHash
    ? CampaignProductionPlanSchema.parse(
        jsonFile(scopedFile(root, path.join(productionDirectory(root, id), "plans", `${outcome.planHash}.json`))),
      )
    : current;
  const { planHash, ...content } = plan;
  if (
    digest(content) !== planHash ||
    plan.request.id !== id ||
    plan.allocationHash !== current.allocationHash ||
    (outcome.planHash && outcome.planHash !== planHash)
  )
    refuse("Outcome plan identity or frozen allocation differs");
  const member = plan.members.find((member) => member.id === outcome.episodeId);
  if (outcome.campaignId !== id || !member) refuse("Outcome does not name a campaign member");
  const directory = path.join(productionDirectory(root, id), "receipts", plan.planHash),
    history = path.join(directory, "history");
  const candidates = plan.tasks
    .filter((task) => task.memberId === member.id && task.kind === "render")
    .flatMap((task) => {
      const files = [
        path.join(directory, `${task.id}.json`),
        ...(existsSync(history)
          ? readdirSync(history)
              .filter(
                (file) => file.startsWith(`${task.id}-`) && /^[a-f0-9]{64}\.json$/.test(file.slice(task.id.length + 1)),
              )
              .map((file) => path.join(history, file))
          : []),
      ];
      return files.filter(existsSync).flatMap((file) => {
        const receipt = CampaignTaskReceiptSchema.parse(jsonFile(scopedFile(root, file)));
        if (receipt.planHash !== plan.planHash || receipt.taskId !== task.id) refuse("Outcome render receipt differs");
        return receipt.outputs.filter((pin) => pin.path.endsWith(".mp4"));
      });
    });
  if (outcome.outputHashes?.some((hash) => !candidates.some((pin) => pin.sha256 === hash)))
    refuse("Outcome output hash is not recorded for this plan and member");
  const outputs = [
    ...new Map(
      candidates
        .filter((pin) => !outcome.outputHashes || outcome.outputHashes.includes(pin.sha256))
        .map((pin) => [`${pin.path}:${pin.sha256}`, pin]),
    ).values(),
  ];
  const outputAvailability = outputs.map((pin) => {
    try {
      verifyPin(root, pin);
      return { sha256: pin.sha256, bytesPresent: true };
    } catch {
      return { sha256: pin.sha256, bytesPresent: false };
    }
  });
  const bound = {
    ...outcome,
    planHash: plan.planHash,
    factors: member.factors,
    outputs,
    outputAvailability,
    attributionScope: outcome.outputHashes ? "exact-outputs" : "member-variants",
    causalAttribution: "not-inferred",
  };
  const file = path.join(productionDirectory(root, id), "outcomes", `${digest(bound)}.json`);
  immutableJson(file, bound);
  return { file, outcome: bound };
}
