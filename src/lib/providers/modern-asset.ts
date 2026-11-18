import { prepareSeedanceForecast } from "../jobs/seedance-forecast";
import path from "node:path";
import { FalEndpointRequestSchema, FalOperationRequestSchema } from "../../types/generation";
import type { OutputKind } from "../../types/fal-catalog";
import type { AssetSpec } from "../../types/pipeline";
import { buildFalOperation, listFalOperationAdapters, requireExecutableFalOperation } from "./fal-operations";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { generationInputHash } from "../jobs/runner";
import { projectDir, pipelineDir } from "../pipeline/paths";
import { assertPathWithin, CliErrorObject } from "../cli";
import { resolveImportedReferences } from "../assets/provider-references";
import { primaryKind } from "./fal-results";
import { existsSync } from "node:fs";
import { OperationStore } from "../jobs/store";
import { jobSubmitted, referencePackGate } from "../references/packs/admission";
import { ReferencePackBindingSchema } from "../../types/reference-pack-binding";
/** Exact modern provider request, never mapped through legacy --model aliases. */
export function prepareModernAssetDispatch(
  asset: AssetSpec,
  projectId: string,
  target: string,
  force = false,
): string[] {
  const raw = asset.metadata?.operationRequest;
  const request =
    raw && typeof raw === "object" && "endpoint" in raw
      ? FalEndpointRequestSchema.parse(raw)
      : FalOperationRequestSchema.parse(raw);
  const compatible: Partial<Record<AssetSpec["kind"], OutputKind[]>> = {
    "ai-image": ["image"],
    meme: ["image"],
    "ai-video": ["video"],
    "talking-head-clip": ["video"],
    "ai-audio": ["audio"],
    "ai-3d": ["model3d"],
    "ai-upscale": ["image", "video"],
    "ai-cutout": ["image"],
  };
  const completion =
    "endpoint" in request
      ? listFalOperationAdapters().some(
          (item) =>
            item.endpoint === request.endpoint && item.family === "seedance-2.5" && item.operation === "complete",
        )
      : request.family === "seedance-2.5" && request.operation === "complete";
  // A material/asset-plan pack binding must be the request's own (RFC 0003 §6.5).
  const assetPack = asset.metadata?.referencePack;
  const requestPack = request.context?.referencePack;
  if (assetPack !== undefined) {
    const binding = ReferencePackBindingSchema.safeParse(assetPack);
    if (!binding.success)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "metadata.referencePack is not a {id, sha256} binding.",
      });
    if (!requestPack)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `metadata.referencePack ${binding.data.id} names a pack, but operationRequest has no context.referencePack: use refs:pack --action request --id ${binding.data.id}.`,
      });
    if (binding.data.id !== requestPack.id || binding.data.sha256 !== requestPack.sha256)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `metadata.referencePack ${binding.data.id} differs from operationRequest.context.referencePack ${requestPack.id}.`,
      });
  }
  let plannedForGate: { provider: ReturnType<typeof buildFalOperation>["provider"]; endpoint: string } | undefined;
  let outputKinds: OutputKind[];
  // Completion account/expiry validation belongs to CLI's durable lineage resolver.
  if (!completion) {
    const validated = resolveImportedReferences(request, projectId).request;
    const plan = buildFalOperation(validated);
    requireExecutableFalOperation(plan);
    plannedForGate = { provider: plan.provider, endpoint: plan.endpoint };
    if ("family" in request && "family" in validated) prepareSeedanceForecast(request, validated, plan);
    else if (validated.context?.videoForecast) {
      const routing = {
        family: plan.family,
        variant: plan.variant,
        operation: plan.operation,
        region: plan.region,
        transport: plan.transport,
      };
      prepareSeedanceForecast(
        FalOperationRequestSchema.parse({ ...routing, input: request.input, context: request.context }),
        FalOperationRequestSchema.parse({ ...routing, input: validated.input, context: validated.context }),
        plan,
      );
    }
    if (!["queue", "stream"].includes(plan.transport) || plan.family === "kling-voice")
      throw new Error("Nonmedia/session operations cannot be published as asset-plan media");
    outputKinds = plan.outputKinds ?? [];
  } else outputKinds = ["video"];
  const selectedKind = primaryKind(outputKinds);
  if (!selectedKind || !compatible[asset.kind]?.includes(selectedKind))
    throw new Error("Modern model primary output does not match asset media kind");
  const operationId =
    typeof asset.metadata?.operationId === "string"
      ? asset.metadata.operationId
      : `asset:${digest(`${projectId}:${asset.id}:${String(asset.metadata?.generationRevision ?? 0)}`)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId)) throw new Error("Invalid operation ID");
  if (plannedForGate) {
    // The same gate generate:model runs, before anything is written or spawned; resumes keep their identity.
    const store = new OperationStore(projectId);
    const resuming = existsSync(store.file) && jobSubmitted(store.snapshot().jobs[operationId]);
    referencePackGate({
      projectId,
      raw,
      ...plannedForGate,
      input: request.input,
      resuming,
      dryRun: false,
    });
  }
  const root = path.resolve(projectDir(projectId));
  assertPathWithin(root, path.resolve(target));
  const file = path.resolve(
    pipelineDir(projectId),
    "model-requests",
    `${digest(operationId)}-${generationInputHash(request.input)}.json`,
  );
  assertPathWithin(root, file);
  immutableWrite(file, JSON.stringify(request));
  const args = [
    "scripts/generate-model.ts",
    "--request",
    file,
    "--project",
    projectId,
    "--output",
    target,
    "--operation-id",
    operationId,
    "--asset-id",
    asset.id,
    "--stage",
    "assets",
  ];
  if (asset.metadata?.maxCostUsd !== undefined) {
    if (
      typeof asset.metadata.maxCostUsd !== "number" ||
      !Number.isFinite(asset.metadata.maxCostUsd) ||
      asset.metadata.maxCostUsd <= 0
    )
      throw new Error("maxCostUsd must be positive and finite");
    args.push("--max-cost-usd", String(asset.metadata.maxCostUsd));
  }
  if (force) args.push("--force");
  return args;
}
