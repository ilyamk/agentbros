import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FalOperationPlan, FalOperationRequest } from "../../types/generation";
import { OperationStore } from "./store";
import { paidInputIdentity } from "./identity";
import { digest, immutableWrite } from "./model-artifacts";
import { pipelineDir, projectDir } from "../pipeline/paths";
import { assertPathWithin } from "../cli";
import { validateFalOperationResult } from "../providers/fal-operations";
import { SEEDANCE_25_DRAFT_TTL_MS } from "../providers/fal-guards/seedance";
const Intent = z
  .object({
    version: z.literal(1),
    operationId: z.string(),
    endpoint: z.string(),
    region: z.enum(["global", "us"]),
    inputHash: z.string(),
    callerIdentity: z.string().regex(/^fal-credential:[a-f0-9]{64}$/),
  })
  .strict();
/** Conservative identity: key rotation requires explicit account reconciliation; no raw key stored. */
export function falCallerIdentity(credential: string): string {
  if (!credential.trim()) throw new Error("Missing fal account credential");
  return `fal-credential:${digest(`fal-account-v1:${credential}`)}`;
}
export function recordSeedanceDraftIntent(
  projectId: string,
  operationId: string,
  plan: FalOperationPlan,
  callerIdentity: string,
): void {
  if (plan.family !== "seedance-2.5" || plan.input.draft !== true) return;
  const store = new OperationStore(projectId);
  const identity = paidInputIdentity(
    plan.input,
    existsSync(store.file) ? store.snapshot().jobs[operationId] : undefined,
  );
  const intent = Intent.parse({
    version: 1,
    operationId,
    endpoint: plan.endpoint,
    region: plan.region,
    inputHash: identity.inputHash,
    callerIdentity,
  });
  const file = path.resolve(pipelineDir(projectId), "seedance-drafts", `${digest(operationId)}.json`);
  assertPathWithin(path.resolve(projectDir(projectId)), file);
  immutableWrite(file, JSON.stringify(intent));
}
/** Provider result in the transactional job is authoritative, even if preview download failed. */
export function deriveSeedanceCompletion(
  projectId: string,
  request: FalOperationRequest,
  callerIdentity: string,
  now = new Date().toISOString(),
): FalOperationRequest {
  if (request.family !== "seedance-2.5" || request.operation !== "complete") return request;
  const id = request.input.draft_id;
  if (typeof id !== "string" || !id) throw new Error("Completion requires a draft_id");
  const directory = path.resolve(pipelineDir(projectId), "seedance-drafts");
  const store = new OperationStore(projectId);
  if (!existsSync(directory) || !existsSync(store.file)) throw new Error("Draft has no verified local lineage");
  const jobs = store.snapshot().jobs;
  const matching: { intent: z.infer<typeof Intent>; createdAt: string }[] = [];
  for (const filename of readdirSync(directory).filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
    const file = path.join(directory, filename);
    assertPathWithin(path.resolve(projectDir(projectId)), file);
    const intent = Intent.parse(JSON.parse(readFileSync(file, "utf8")));
    const job = jobs[intent.operationId];
    if (!job?.result || job.result.draft_id !== id) continue;
    if (job.endpoint !== intent.endpoint || job.inputHash !== intent.inputHash || !job.providerRequestId)
      throw new Error("Draft lineage does not match its provider operation");
    validateFalOperationResult(job.endpoint, job.result);
    matching.push({ intent, createdAt: job.createdAt });
  }
  if (matching.length !== 1) throw new Error("Draft requires exactly one verified local provider operation");
  const { intent, createdAt } = matching[0]!;
  if (callerIdentity !== intent.callerIdentity)
    throw new Error("Draft account mismatch; original fal credential required");
  // Only the global completion endpoint is documented; US drafts are not silently rerouted.
  if ((request.region ?? "global") !== intent.region) throw new Error("Draft region mismatch");
  const age = Date.parse(now) - Date.parse(createdAt);
  if (!Number.isFinite(age) || age < 0 || age >= SEEDANCE_25_DRAFT_TTL_MS)
    throw new Error("Draft expired or creation time invalid");
  return {
    ...request,
    region: intent.region,
    context: { ...request.context, callerId: callerIdentity, draft: { id, callerId: callerIdentity, createdAt }, now },
  };
}
