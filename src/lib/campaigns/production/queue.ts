import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CampaignProductionPlan, CampaignTask, CampaignTaskReceipt } from "../../../types/campaign-production";
import {
  CampaignAllocationSchema,
  CampaignFileSchema,
  CampaignTaskReceiptSchema,
} from "../../../types/campaign-production";
import { withRenderIdentityReadCache } from "../../delivery/identity";
import { currentDecision } from "./decisions";
import { OperationStore } from "../../jobs/store";
import {
  acquireLock,
  atomicJson,
  digest,
  immutableJson,
  jsonFile,
  pinFile,
  productionDirectory,
  refuse,
  scopedFile,
  verifyPin,
} from "./files";

const ResourceSchema = z.enum(["generation", "process", "render", "qa"]);
const LimitsSchema = z
  .object({
    generation: z.number().int().min(1).max(32),
    process: z.number().int().min(1).max(32),
    render: z.number().int().min(1).max(8),
    qa: z.number().int().min(1).max(32),
  })
  .strict();
export const DEFAULT_CAMPAIGN_LIMITS = { generation: 2, process: 2, render: 1, qa: 2 };
const RecordSchema = z
  .object({
    state: z.enum(["running", "waiting", "capacity", "failed", "blocked", "complete"]),
    pid: z.number().int().positive(),
    token: z.string(),
    resource: ResourceSchema,
    resourceKey: z.string(),
    wakeAt: z.number().finite().nonnegative().optional(),
    message: z.string().optional(),
    reasonCode: z.string().optional(),
    operationId: z.string().optional(),
    inputHash: z.string().optional(),
    progressHash: z.string().optional(),
    evidence: z.array(CampaignFileSchema).max(32).optional(),
    attempts: z.number().int().nonnegative().optional(),
  })
  .strict();
const RuntimeSchema = z
  .object({ version: z.literal(1), limits: LimitsSchema, records: z.record(z.string(), RecordSchema) })
  .strict();
type Runtime = z.infer<typeof RuntimeSchema>;
export type CampaignTaskResult = {
  outputs: string[];
  metadata?: Record<string, unknown>;
  pending?: boolean;
  blocked?: boolean;
  message?: string;
  retryAfterMs?: number;
  reasonCode?: string;
};
export type CampaignExecutor = (
  task: CampaignTask,
  context: { plan: CampaignProductionPlan; inputHash: string; root: string; paid: boolean },
) => Promise<CampaignTaskResult>;
export type CampaignInputIdentity = (task: CampaignTask, plan: CampaignProductionPlan, root: string) => unknown;
const keyFor = (plan: CampaignProductionPlan, task: CampaignTask) => `${plan.request.id}.${plan.planHash}.${task.id}`;
const receiptFile = (root: string, plan: CampaignProductionPlan, task: CampaignTask) =>
  path.join(productionDirectory(root, plan.request.id), "receipts", plan.planHash, `${task.id}.json`);
const runtimeFile = (root: string) => scopedFile(root, ".cache/campaign-production/runtime.json");
const readRuntime = (file: string): Runtime =>
  existsSync(file) ? RuntimeSchema.parse(jsonFile(file)) : { version: 1, limits: DEFAULT_CAMPAIGN_LIMITS, records: {} };
let valueCache: Map<string, unknown> | undefined;
export function synchronousCampaignRead<T>(key: string, read: () => T): T {
  if (!valueCache) return read();
  if (valueCache.has(key)) return valueCache.get(key) as T;
  const value = read();
  valueCache.set(key, value);
  return value;
}
let sweepCache: Map<CampaignInputIdentity | undefined, Map<string, CampaignTaskReceipt | null>> | undefined;
/** Share DAG checks only within one synchronous scan; every async boundary gets fresh evidence. */
export function campaignReadScope<T>(scan: () => T): T {
  if (sweepCache) return scan();
  sweepCache = new Map();
  valueCache = new Map();
  try {
    return withRenderIdentityReadCache(scan);
  } finally {
    sweepCache = undefined;
    valueCache = undefined;
  }
}

export function taskInputHash(
  root: string,
  plan: CampaignProductionPlan,
  task: CampaignTask,
  identity?: CampaignInputIdentity,
): string {
  if (!sweepCache) return campaignReadScope(() => taskInputHash(root, plan, task, identity));
  const dependencies = task.dependsOn.map((id) => {
    const dependency = plan.tasks.find((item) => item.id === id)!;
    const receipt = taskReceipt(root, plan, dependency, identity);
    if (!receipt) refuse(`Campaign dependency is unfinished or stale: ${id}`);
    return { id, inputHash: receipt.inputHash, outputs: receipt.outputs };
  });
  return digest({ task, planHash: plan.planHash, dependencies, current: identity?.(task, plan, root) ?? null });
}
export function taskReceipt(
  root: string,
  plan: CampaignProductionPlan,
  task: CampaignTask,
  identity?: CampaignInputIdentity,
): CampaignTaskReceipt | null {
  if (!sweepCache) return campaignReadScope(() => taskReceipt(root, plan, task, identity));
  const key = JSON.stringify([root, plan.planHash, task.id]),
    cache = sweepCache?.get(identity) ?? new Map<string, CampaignTaskReceipt | null>();
  if (sweepCache && !sweepCache.has(identity)) sweepCache.set(identity, cache);
  if (cache.has(key)) return cache.get(key)!;
  const remember = (receipt: CampaignTaskReceipt | null) => {
    cache.set(key, receipt);
    return receipt;
  };
  const file = scopedFile(root, receiptFile(root, plan, task));
  if (!existsSync(file)) return remember(null);
  const receipt = CampaignTaskReceiptSchema.parse(jsonFile(file));
  if (task.kind === "anchors") {
    const member = plan.members.find((member) => member.id === task.memberId);
    if (member?.speech.length && receipt.metadata.alignmentFormat !== "words-object-v1") return remember(null);
    const expected =
      member?.speech.flatMap((speech) => [
        path.resolve(root, "public/projects", member.projectId, "voiceover", `${speech.sceneId}.mp3`),
        path.resolve(root, "public/projects", member.projectId, "voiceover", `${speech.sceneId}.words.json`),
      ]) ?? [];
    if (expected.some((file) => !receipt.outputs.some((pin) => path.resolve(root, pin.path) === file)))
      return remember(null);
  }
  if (receipt.taskId !== task.id || receipt.planHash !== plan.planHash) refuse("Campaign receipt identity differs");
  try {
    receipt.outputs.forEach((pin) => verifyPin(root, pin));
    return remember(receipt.inputHash === taskInputHash(root, plan, task, identity) ? receipt : null);
  } catch {
    return remember(null);
  }
}
export function campaignTaskStates(root: string, plan: CampaignProductionPlan, identity?: CampaignInputIdentity) {
  const runtime = readRuntime(runtimeFile(root));
  return campaignReadScope(() =>
    plan.tasks.map((task) => {
      const receipt = taskReceipt(root, plan, task, identity),
        record = runtime.records[keyFor(plan, task)];
      if (receipt) return { id: task.id, state: "complete" as const, receipt };
      if (
        task.dependsOn.some(
          (id) =>
            !taskReceipt(
              root,
              plan,
              plan.tasks.find((item) => item.id === id)!,
              identity,
            ),
        )
      )
        return { id: task.id, state: "dependency" as const };
      if (
        record?.progressHash &&
        task.kind === "agent" &&
        record.progressHash !== digest(currentDecision(root, plan, task)?.decision ?? null)
      )
        return { id: task.id, state: "stale" as const };
      if (record?.inputHash || record?.reasonCode === "SOURCE_INPUT_REQUIRED") {
        try {
          const current = taskInputHash(root, plan, task, identity);
          if (record.reasonCode === "SOURCE_INPUT_REQUIRED") return { id: task.id, state: "ready" as const };
          if (record.inputHash !== current) return { id: task.id, state: "stale" as const };
        } catch (error) {
          return {
            id: task.id,
            state: "blocked" as const,
            reasonCode: "SOURCE_INPUT_REQUIRED",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          };
        }
      }
      if (record && ["waiting", "capacity"].includes(record.state) && (record.wakeAt ?? 0) <= Date.now())
        return { id: task.id, state: "ready" as const };
      if (record?.state === "running") {
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return { id: task.id, state: "ready" as const };
        }
      }
      return {
        id: task.id,
        state: record?.state === "complete" ? ("stale" as const) : (record?.state ?? ("ready" as const)),
        ...(record?.message ? { message: record.message } : {}),
        ...(record?.reasonCode ? { reasonCode: record.reasonCode } : {}),
        ...(record?.evidence ? { evidence: record.evidence } : {}),
        ...(record?.attempts
          ? {
              attempts: record.attempts,
              attemptLimit: plan.request.policy?.maxTaskAttempts ?? 3,
              exhausted: record.attempts >= (plan.request.policy?.maxTaskAttempts ?? 3),
            }
          : {}),
        ...(record?.wakeAt ? { retryAfterMs: Math.max(0, record.wakeAt - Date.now()) } : {}),
      };
    }),
  );
}
async function runtimeWrite<T>(file: string, write: () => T): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const release = acquireLock(`${file}.lock`);
    if (release) {
      try {
        return write();
      } finally {
        release();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  refuse("Campaign runtime writer is busy; retry after the current owner finishes");
}
export async function retireCampaignRuntime(root: string, id: string) {
  const file = runtimeFile(root);
  if (!existsSync(file)) return;
  await runtimeWrite(file, () => {
    const state = readRuntime(file);
    for (const key of Object.keys(state.records)) if (key.startsWith(`${id}.`)) delete state.records[key];
    atomicJson(file, state);
  });
}
async function claim(
  root: string,
  plan: CampaignProductionPlan,
  task: CampaignTask,
  limits?: Partial<Runtime["limits"]>,
  inputHash?: string,
) {
  const file = runtimeFile(root),
    key = keyFor(plan, task);
  return runtimeWrite(file, () => {
    const state = readRuntime(file);
    if (limits) {
      const next = LimitsSchema.parse({ ...state.limits, ...limits });
      if (
        Object.values(state.records).some((record) => record.state === "running") &&
        digest(next) !== digest(state.limits)
      )
        refuse("Cannot change resource limits while campaign work is active");
      state.limits = next;
    }
    for (const record of Object.values(state.records))
      if (record.state === "running") {
        try {
          process.kill(record.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            record.state = record.resource === "generation" && record.operationId ? "waiting" : "failed";
            record.attempts = (record.attempts ?? 0) + 1;
            record.message = "Owner process exited before publishing; resume the same operation";
            record.wakeAt = 0;
          }
        }
      }
    for (const [recordKey, record] of Object.entries(state.records))
      if (record.state === "waiting" && record.resource === "generation" && record.operationId) {
        const campaignId = recordKey.split(".")[0],
          allocationFile = path.join(productionDirectory(root, campaignId), "allocation.json");
        if (!existsSync(allocationFile)) refuse("Cannot reconcile generation capacity without its owner allocation");
        const allocation = CampaignAllocationSchema.parse(jsonFile(allocationFile));
        const jobs = allocation.owners.flatMap((owner) => {
          const directory = path.join(root, "public/projects", owner.projectId, "pipeline");
          return existsSync(path.join(directory, "operations.json"))
            ? Object.values(new OperationStore(owner.projectId, { directory }).snapshot().jobs)
            : [];
        });
        const job = jobs.find((job) => job.operationId === record.operationId);
        if (!job || (["published", "cancelled", "failed"].includes(job.state) && job.reservedMicros === 0))
          record.state = "complete";
      }
    const previous = state.records[key],
      progressHash = task.kind === "agent" ? digest(currentDecision(root, plan, task)?.decision ?? null) : inputHash;
    const sameAttempt =
      previous?.inputHash === inputHash && (!previous.progressHash || previous.progressHash === progressHash);
    if (previous?.state === "running" || (previous?.state === "waiting" && (previous.wakeAt ?? 0) > Date.now())) {
      atomicJson(file, state);
      return null;
    }
    if (
      sameAttempt &&
      previous!.state === "failed" &&
      (previous.attempts ?? 0) >= (plan.request.policy?.maxTaskAttempts ?? 3)
    ) {
      atomicJson(file, state);
      return null;
    }
    const resourceKey = task.resource === "generation" ? String(task.payload.provider ?? "provider") : task.resource;
    const operationId = typeof task.payload.operationId === "string" ? task.payload.operationId : undefined;
    const occupied = new Set(
      Object.entries(state.records)
        .filter(
          ([id, record]) =>
            id !== key &&
            (!operationId || record.operationId !== operationId) &&
            record.resource === task.resource &&
            record.resourceKey === resourceKey &&
            (record.state === "running" || (task.resource === "generation" && record.state === "waiting")),
        )
        .map(([id, record]) => record.operationId ?? id),
    ).size;
    if (
      occupied >= state.limits[task.resource] &&
      !(previous?.state === "waiting" && operationId && previous.operationId === operationId)
    ) {
      state.records[key] = {
        ...previous,
        state: "capacity",
        pid: process.pid,
        token: randomUUID(),
        resource: task.resource,
        resourceKey,
        ...(operationId ? { operationId } : {}),
        wakeAt: Date.now() + 1000,
        reasonCode: "RESOURCE_CAPACITY",
        message: "The shared resource pool is occupied; resume after the bounded delay",
      };
      atomicJson(file, state);
      return null;
    }
    const token = randomUUID();
    state.records[key] = {
      state: "running",
      pid: process.pid,
      token,
      resource: task.resource,
      resourceKey,
      ...(operationId ? { operationId } : {}),
      inputHash,
      progressHash,
      attempts: sameAttempt ? (previous.attempts ?? 0) : 0,
    };
    atomicJson(file, state);
    return token;
  });
}
async function finish(
  root: string,
  plan: CampaignProductionPlan,
  task: CampaignTask,
  token: string,
  update: Partial<Runtime["records"][string]>,
  receipt?: CampaignTaskReceipt,
) {
  const file = runtimeFile(root),
    key = keyFor(plan, task);
  return runtimeWrite(file, () => {
    const state = readRuntime(file),
      record = state.records[key];
    if (!record || record.token !== token || record.state !== "running") refuse("Stale campaign worker cannot publish");
    if (receipt) {
      const file = scopedFile(root, receiptFile(root, plan, task));
      immutableJson(path.join(path.dirname(file), "history", `${task.id}-${digest(receipt)}.json`), receipt);
      atomicJson(file, receipt);
    }
    state.records[key] = {
      ...record,
      ...update,
      attempts: update.state === "failed" ? (record.attempts ?? 0) + 1 : (record.attempts ?? 0),
    };
    if (receipt && record.operationId)
      for (const [otherKey, other] of Object.entries(state.records))
        if (otherKey !== key && other.operationId === record.operationId && other.state === "waiting")
          other.state = "complete";
    atomicJson(file, state);
  });
}
/** Only schedules tasks. Existing generation jobs remain the authority for external work. */
export async function runCampaignQueue(
  root: string,
  plan: CampaignProductionPlan,
  executor: CampaignExecutor,
  options: {
    paid?: boolean;
    limits?: Partial<Runtime["limits"]>;
    identity?: CampaignInputIdentity;
    maxTasks?: number;
    allowedTaskIds?: Set<string>;
  } = {},
) {
  const release = acquireLock(path.join(productionDirectory(root, plan.request.id), "writer.lock"));
  if (!release) refuse("Campaign production or revision is already active");
  try {
    if (existsSync(path.join(productionDirectory(root, plan.request.id), "archive.json")))
      refuse("Campaign is archived; production is closed");
    const current = jsonFile(path.join(productionDirectory(root, plan.request.id), "current.json")) as {
      planHash: string;
    };
    if (current.planHash !== plan.planHash) refuse("Cannot execute a superseded campaign plan");
    const attempts = new Set<string>(),
      unavailable = new Set<string>(),
      maximum = options.maxTasks ?? plan.tasks.length;
    if (options.paid && plan.request.spend === "forbid") refuse("Campaign spending is forbidden");
    const initial = campaignTaskStates(root, plan, options.identity);
    const completed = new Set(initial.filter((state) => state.state === "complete").map((state) => state.id));
    const priority = new Map(
      initial.map((state) => [
        state.id,
        ["ready", "stale"].includes(state.state)
          ? 0
          : state.state === "dependency"
            ? 1
            : state.state === "blocked"
              ? 4
              : 3,
      ]),
    );
    for (;;) {
      const ready = plan.tasks
        .filter(
          (task) =>
            (!options.allowedTaskIds || options.allowedTaskIds.has(task.id)) &&
            !attempts.has(task.id) &&
            !unavailable.has(task.id) &&
            !completed.has(task.id) &&
            task.dependsOn.every((id) => completed.has(id)),
        )
        .sort((left, right) => (priority.get(left.id) ?? 0) - (priority.get(right.id) ?? 0));
      if (!ready.length || attempts.size >= maximum) break;
      const claimed: { task: CampaignTask; token: string }[] = [],
        remaining = maximum - attempts.size;
      for (const task of ready) {
        if (claimed.length >= remaining) break;
        let inputHash: string;
        try {
          inputHash = taskInputHash(root, plan, task, options.identity);
        } catch (error) {
          unavailable.add(task.id);
          const file = runtimeFile(root);
          await runtimeWrite(file, () => {
            const state = readRuntime(file);
            state.records[keyFor(plan, task)] = {
              state: "blocked",
              pid: process.pid,
              token: randomUUID(),
              resource: task.resource,
              resourceKey: String(task.payload.provider ?? task.resource),
              reasonCode: "SOURCE_INPUT_REQUIRED",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
            };
            atomicJson(file, state);
          });
          continue;
        }
        const token = await claim(root, plan, task, options.limits, inputHash);
        if (!token) continue;
        attempts.add(task.id);
        claimed.push({ task, token });
      }
      if (!claimed.length) break;
      await Promise.all(
        claimed.map(async ({ task, token }) => {
          try {
            const inputHash = taskInputHash(root, plan, task, options.identity);
            const result = await executor(task, { plan, inputHash, root, paid: Boolean(options.paid) });
            if (result.pending || result.blocked) {
              await finish(root, plan, task, token, {
                state: result.blocked ? "blocked" : "waiting",
                message: result.message,
                reasonCode: result.reasonCode,
                evidence: result.outputs.map((file) => pinFile(root, file)).slice(0, 32),
                wakeAt: Date.now() + Math.max(100, Math.min(result.retryAfterMs ?? 1000, 300000)),
              });
              return;
            }
            if (inputHash !== taskInputHash(root, plan, task, options.identity))
              refuse("Campaign task inputs changed during execution");
            const receipt = CampaignTaskReceiptSchema.parse({
              version: 1,
              taskId: task.id,
              planHash: plan.planHash,
              inputHash,
              outputs: result.outputs.map((file) => pinFile(root, file)),
              completedAt: new Date().toISOString(),
              metadata: result.metadata ?? {},
            });
            await finish(root, plan, task, token, { state: "complete" }, receipt);
            completed.add(task.id);
          } catch (error) {
            await finish(root, plan, task, token, {
              state: "failed",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
            });
          }
        }),
      );
    }
    return {
      attempted: attempts.size,
      tasks: campaignTaskStates(root, plan, options.identity),
      providerSpendAuthorised: Boolean(options.paid),
    };
  } finally {
    release();
  }
}
