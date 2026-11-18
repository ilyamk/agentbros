import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  CampaignAllocationSchema,
  CampaignProductionPlanSchema,
  ProductionBindingSchema,
  type CampaignProductionPlan,
  type CampaignProductionRequest,
} from "../../../types/campaign-production";
import { OperationStore } from "../../jobs/store";
import { writeProjectPlaybook } from "../../playbooks/project";
import {
  acquireLock,
  atomicJson,
  digest,
  immutableJson,
  isCampaignOwner,
  jsonFile,
  locked,
  productionDirectory,
  projectDirectory,
  refuse,
  scopedFile,
} from "./files";
import { buildCampaignPlan, verifyPlan } from "./plan";
import { retireCampaignRuntime } from "./queue";

export function loadCampaign(
  root: string,
  id: string,
  options: { verifyInputs?: boolean } = {},
): CampaignProductionPlan {
  const directory = productionDirectory(root, id);
  if (!isCampaignOwner(projectDirectory(root, id))) refuse(`Campaign not found: ${id}`);
  const current = jsonFile(scopedFile(root, path.join(directory, "current.json"))) as { planHash: string };
  if (!/^[a-f0-9]{64}$/.test(current.planHash)) refuse("Invalid current campaign revision");
  const plan = CampaignProductionPlanSchema.parse(
    jsonFile(scopedFile(root, path.join(directory, "plans", `${current.planHash}.json`))),
  );
  if (plan.request.id !== id || plan.planHash !== current.planHash) refuse("Campaign identity differs");
  if (options.verifyInputs !== false && !campaignArchive(root, id)) verifyPlan(plan, root);
  else {
    const { planHash, ...content } = plan;
    if (digest(content) !== planHash) refuse("Campaign plan identity differs");
  }
  assertAllocation(root, id, plan.allocationHash);
  return plan;
}
export function assertAllocation(root: string, id: string, expected: string) {
  const allocation = CampaignAllocationSchema.parse(
    jsonFile(scopedFile(root, path.join(productionDirectory(root, id), "allocation.json"))),
  );
  if (allocation.campaignId !== id || digest(allocation) !== expected) refuse("Campaign allocation changed");
  const micro = allocation.owners.reduce((sum, owner) => sum + Math.ceil(owner.quotaUsd * 1e6 - 1e-7), 0);
  if (micro > Math.floor(allocation.capUsd * 1e6 + 1e-7)) refuse("Campaign allocations exceed ceiling");
  return allocation;
}
export function campaignBinding(plan: CampaignProductionPlan, projectId: string) {
  const owner = plan.allocation.owners.find((item) => item.projectId === projectId);
  if (!owner) refuse("Project is outside campaign allocation");
  return ProductionBindingSchema.parse({
    version: 2,
    campaignId: plan.request.id,
    ownerProjectId: plan.request.id,
    projectId,
    episodeId: owner.episodeId,
    role: projectId === plan.request.id ? "shared" : "member",
    manifestHash: plan.allocationHash,
    quotaUsd: owner.quotaUsd,
  });
}
function preflightBinding(root: string, plan: CampaignProductionPlan, projectId: string) {
  const directory = projectDirectory(root, projectId),
    binding = campaignBinding(plan, projectId);
  const file = path.join(directory, "pipeline/campaign-binding.json");
  if (existsSync(file) && digest(jsonFile(file)) !== digest(binding))
    refuse("Child already belongs to a different campaign allocation");
  const operationFile = path.join(directory, "pipeline/operations.json");
  if (existsSync(operationFile)) {
    const before = new OperationStore(projectId, { directory: path.dirname(operationFile) }).snapshot();
    if (before.policy.ceilingUsd > binding.quotaUsd)
      refuse("Adopting an existing project cannot silently reduce its budget; assign its existing ceiling explicitly");
  }
  return { directory, binding };
}
export function bindCampaignChild(root: string, plan: CampaignProductionPlan, projectId: string) {
  const { directory, binding } = preflightBinding(root, plan, projectId);
  immutableJson(scopedFile(root, path.join(directory, "pipeline/campaign-binding.json")), binding);
  new OperationStore(projectId, {
    directory: path.join(directory, "pipeline"),
    responseCacheDirectory: path.join(root, ".cache/paid-responses", projectId),
  }).configure(
    { ceilingUsd: binding.quotaUsd, maxJobUsd: binding.quotaUsd },
    { by: "campaign", source: `campaign ${binding.campaignId ?? "binding"} quota USD ${binding.quotaUsd}` },
  );
}
export function initCampaign(raw: CampaignProductionRequest, root = process.cwd()) {
  const plan = buildCampaignPlan(raw, root),
    target = projectDirectory(root, plan.request.id);
  if (existsSync(target)) refuse(`Campaign destination already exists: ${plan.request.id}`);
  for (const member of plan.members)
    if (member.adapter.kind !== "existing" && existsSync(projectDirectory(root, member.projectId)))
      refuse(`Campaign child destination already exists: ${member.projectId}`);
  for (const member of plan.members)
    if (member.adapter.kind === "existing") preflightBinding(root, plan, member.projectId);
  mkdirSync(path.dirname(target), { recursive: true });
  mkdirSync(target);
  let published = false;
  try {
    const directory = productionDirectory(root, plan.request.id);
    immutableJson(path.join(directory, "allocation.json"), plan.allocation);
    immutableJson(path.join(directory, "plans", `${plan.planHash}.json`), plan);
    atomicJson(path.join(directory, "current.json"), { planHash: plan.planHash });
    immutableJson(path.join(directory, "owner.json"), { version: 1, campaignId: plan.request.id });
    bindCampaignChild(root, plan, plan.request.id);
    writeProjectPlaybook(target, plan.request.scenario, "agent");
    published = true;
    for (const member of plan.members)
      if (member.adapter.kind === "existing") bindCampaignChild(root, plan, member.projectId);
    return plan;
  } catch (error) {
    if (!published) rmSync(target, { recursive: true, force: true });
    else
      refuse(
        `Campaign ownership was published; continue campaign:next to recover child binding. ${error instanceof Error ? error.message : String(error)}`,
      );
    throw error;
  }
}
export function reviseCampaign(raw: CampaignProductionRequest, root = process.cwd()) {
  const next = buildCampaignPlan(raw, root),
    directory = productionDirectory(root, next.request.id);
  return locked(path.join(directory, "writer.lock"), () => {
    assertCampaignActive(root, next.request.id);
    const old = loadCampaign(root, next.request.id, { verifyInputs: false });
    if (next.request.revision <= old.request.revision) refuse("Campaign revision must increase");
    if (next.allocationHash !== old.allocationHash) refuse("New allocation or member set requires a new campaign");
    const retainedOperations = new Set(
      next.tasks.flatMap((task) => (typeof task.payload.operationId === "string" ? [task.payload.operationId] : [])),
    );
    for (const owner of old.allocation.owners) {
      const directory = path.join(projectDirectory(root, owner.projectId), "pipeline");
      if (!existsSync(path.join(directory, "operations.json"))) continue;
      const unresolved = Object.values(new OperationStore(owner.projectId, { directory }).snapshot().jobs).filter(
        (job) => !["published", "cancelled", "failed"].includes(job.state) || job.reservedMicros > 0,
      );
      if (unresolved.some((job) => !retainedOperations.has(job.operationId)))
        refuse(
          "Reconcile outstanding operations before replacing their material requests; retained operations can be adopted into the new plan",
        );
    }
    if (old.request.spend === "forbid" && next.request.spend !== "forbid")
      refuse("A no-spend campaign cannot authorise itself by revision");
    immutableJson(path.join(directory, "plans", `${next.planHash}.json`), next);
    atomicJson(path.join(directory, "current.json"), { planHash: next.planHash });
    return next;
  });
}
export function campaignArchive(root: string, id: string) {
  const file = path.join(productionDirectory(root, id), "archive.json");
  return existsSync(file) ? (jsonFile(file) as { planHash: string; reason: string; archivedAt: string }) : null;
}
export function assertCampaignActive(root: string, id: string) {
  if (campaignArchive(root, id)) refuse("Campaign is archived; its production and approvals are closed");
}
export async function archiveCampaign(root: string, id: string, reason: string) {
  if (!reason.trim()) refuse("Archiving requires a retention/release reason");
  const release = acquireLock(path.join(productionDirectory(root, id), "writer.lock"));
  if (!release) refuse("Campaign writer is busy");
  try {
    const plan = loadCampaign(root, id, { verifyInputs: false }),
      before = campaignArchive(root, id);
    if (before) {
      await retireCampaignRuntime(root, id);
      return before;
    }
    for (const owner of plan.allocation.owners) {
      const directory = path.join(projectDirectory(root, owner.projectId), "pipeline");
      if (!existsSync(path.join(directory, "operations.json"))) continue;
      if (
        Object.values(new OperationStore(owner.projectId, { directory }).snapshot().jobs).some(
          (job) => job.reservedMicros > 0 || !["published", "failed", "cancelled"].includes(job.state),
        )
      )
        refuse("Reconcile outstanding operations before archiving");
    }
    const record = { planHash: plan.planHash, reason: reason.trim(), archivedAt: new Date().toISOString() };
    await retireCampaignRuntime(root, id);
    immutableJson(path.join(productionDirectory(root, id), "archive.json"), record);
    return record;
  } finally {
    release();
  }
}
export function campaignCosts(root: string, id: string) {
  const plan = loadCampaign(root, id);
  const owners = plan.allocation.owners.map((owner) => {
    const directory = projectDirectory(root, owner.projectId),
      file = path.join(directory, "pipeline/operations.json");
    const jobs = existsSync(file)
      ? Object.values(new OperationStore(owner.projectId, { directory: path.dirname(file) }).snapshot().jobs)
      : [];
    return {
      ...owner,
      reservedUsd: jobs.reduce((sum, job) => sum + job.reservedMicros / 1e6, 0),
      actualUsd: jobs.some((job) => !job.receipt && job.paidAttempts > 0)
        ? null
        : jobs.reduce(
            (sum, job) =>
              sum + (job.receipt?.actualUsd ?? 0) - job.refunds.reduce((total, refund) => total + refund.refundUsd, 0),
            0,
          ),
      paidAttempts: jobs.reduce((sum, job) => sum + job.paidAttempts, 0),
    };
  });
  return {
    campaignId: id,
    capUsd: plan.request.capUsd,
    allocationIsSpend: false,
    owners,
    reservedUsd: owners.reduce((sum, owner) => sum + owner.reservedUsd, 0),
    actualUsd: owners.some((owner) => owner.actualUsd === null)
      ? null
      : owners.reduce((sum, owner) => sum + owner.actualUsd!, 0),
  };
}
/** Derive dependency blockers from authoritative manifests rather than a mutable reference count. */
export function campaignRemovalBlockers(root: string, projectId: string): string[] {
  const projects = path.join(root, "public/projects");
  if (!existsSync(projects)) return [];
  const blockers: string[] = [];
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === projectId) continue;
    const directory = path.join(projects, entry.name),
      snapshot = path.join(directory, "pipeline/campaign-snapshot.json");
    if (existsSync(snapshot)) {
      try {
        const pins =
          (jsonFile(snapshot) as { manifest?: { world?: { pins?: { sourceProjectId: string }[] } } }).manifest?.world
            ?.pins ?? [];
        if (pins.some((pin) => pin.sourceProjectId === projectId))
          blockers.push(`campaign ${entry.name} pins source project ${projectId}`);
      } catch {
        blockers.push(`cannot verify campaign references in ${entry.name}`);
      }
    }
    if (isCampaignOwner(directory) && !campaignArchive(root, entry.name)) {
      try {
        const plan = loadCampaign(root, entry.name);
        if (
          plan.members.some((member) => member.projectId === projectId) ||
          plan.request.entityPins.some((pin) => pin.sourceProjectId === projectId) ||
          plan.request.sourceCampaign === projectId ||
          plan.inputPins.some((pin) => pin.path.startsWith(`public/projects/${projectId}/`))
        )
          blockers.push(`active campaign ${entry.name} depends on project ${projectId}`);
      } catch {
        blockers.push(`cannot verify production campaign ${entry.name}`);
      }
    }
    const binding = path.join(directory, "pipeline/campaign-binding.json");
    if (existsSync(binding)) {
      const value = jsonFile(binding) as { version?: number; ownerProjectId?: string };
      if (value.version === 2 && value.ownerProjectId === projectId)
        blockers.push(`campaign member ${entry.name} retains owner ${projectId}`);
    }
  }
  return blockers;
}
