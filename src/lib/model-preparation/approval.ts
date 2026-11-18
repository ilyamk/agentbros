import { existsSync, readFileSync } from "node:fs";
import { hashFile, readAssetRegistry } from "../assets/registry";
import { getEntityVersion, resolveEntityReferences } from "../entities/service";
import { resolveImportedReferences } from "../assets/provider-references";
import { buildFalOperation } from "../providers/fal-operations";
import { generationInputHash } from "../jobs/runner";
import { CliErrorObject } from "../cli";
import { FalEndpointRequestSchema } from "../../types/generation";
import {
  PreparationApprovalSchema,
  PreparationRightsSchema,
  PreparationVisualReviewSchema,
  type ModelPreparationBinding,
  type PreparationRights,
} from "../../types/model-preparation";
import {
  immutablePreparationJson,
  preparationDigest,
  preparationFile,
  projectMediaFile,
  readPreparation,
} from "./storage";

export function validatePreparation(projectId: string, binding: ModelPreparationBinding, rootDir = process.cwd()) {
  const data = readPreparation(projectId, binding.id, rootDir),
    { receipt } = data;
  if (data.sha256 !== binding.sha256)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Preparation hash changed; create and approve a new preparation.",
    });
  for (const media of [receipt.source, receipt.preparedSource, ...receipt.references.map((ref) => ref.media)]) {
    if (hashFile(projectMediaFile(projectId, media.original, rootDir)) !== media.sha256)
      throw new CliErrorObject({ code: "VALIDATION", message: "Prepared input original changed." });
  }
  const registry = readAssetRegistry(projectId, rootDir);
  for (const pin of receipt.inputProvenance) {
    const asset = registry.assets.find((row) => row.id === pin.assetId);
    if (
      !asset ||
      asset.hash !== pin.sha256 ||
      preparationDigest(asset.provenance) !== pin.provenanceSha256 ||
      hashFile(projectMediaFile(projectId, asset.files.original, rootDir)) !== pin.sha256
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Frozen upstream input provenance changed or disappeared.",
      });
  }
  for (const media of [receipt.preparedSource, ...receipt.references.map((ref) => ref.media)]) {
    const asset = registry.assets.find((row) => row.id === media.assetId);
    if (
      !asset ||
      asset.hash !== media.sha256 ||
      asset.files.original !== media.original ||
      asset.files.bytes !== media.bytes ||
      asset.files.mime !== media.contentType ||
      asset.media.width !== media.width ||
      asset.media.height !== media.height ||
      (media.durationSec !== undefined && asset.media.durationSec !== media.durationSec)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Prepared provider media measurements or registry identity changed; remeasure before quoting.",
      });
    if (media.fps !== undefined) {
      const [numerator, denominator = 1] = (asset.media.frameRate ?? "").split("/").map(Number);
      if (numerator! / denominator! !== media.fps)
        throw new CliErrorObject({ code: "VALIDATION", message: "Prepared provider frame rate changed." });
    }
  }
  for (const ref of receipt.references) {
    const { version } = getEntityVersion(projectId, ref.kind, ref.entityId, {
      revision: ref.revision,
      rootDir,
      requireApproved: true,
    });
    const resolved = resolveEntityReferences(projectId, ref, rootDir);
    if (
      version.contentHash !== ref.versionHash ||
      resolved.references.find((item) => item.role === ref.role)?.hash !== ref.media.sha256
    )
      throw new CliErrorObject({ code: "VALIDATION", message: "Pinned entity reference changed." });
  }
  for (const review of receipt.reviewFiles) {
    if (hashFile(preparationFile(projectId, binding.id, review.path, rootDir)) !== review.sha256)
      throw new CliErrorObject({ code: "VALIDATION", message: "Preparation review board changed." });
  }
  const request = FalEndpointRequestSchema.parse(
    JSON.parse(readFileSync(preparationFile(projectId, binding.id, "request.json", rootDir), "utf8")),
  );
  if (
    preparationDigest(request.context?.remoteMedia ?? []) !==
    preparationDigest(receipt.spec.remoteSource ? [receipt.spec.remoteSource] : [])
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Remote source binding differs from the approved preparation.",
    });
  if (
    request.provider !== "higgsfield" ||
    request.endpoint !== receipt.endpoint ||
    preparationDigest({ provider: request.provider, endpoint: request.endpoint, input: request.input }) !==
      receipt.requestSha256 ||
    preparationDigest(request.context?.modelPreparation) !== preparationDigest(binding)
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Prepared request no longer matches its receipt." });
  const resolved = resolveImportedReferences(request, projectId, rootDir).request;
  const plan = buildFalOperation(resolved);
  if (plan.schemaSha256 !== receipt.schemaSha256 || generationInputHash(plan.input) !== receipt.resolvedInputSha256)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Prepared schema or resolved input changed; prepare a new revision.",
    });
  return { ...data, request, plan };
}
export function writePreparationRights(
  projectId: string,
  id: string,
  input: Omit<PreparationRights, "schemaVersion" | "preparationSha256" | "recordedAt" | "assets">,
  rootDir = process.cwd(),
) {
  const data = readPreparation(projectId, id, rootDir);
  validatePreparation(projectId, { id, sha256: data.sha256 }, rootDir);
  const rights = PreparationRightsSchema.parse({
    ...input,
    schemaVersion: 1,
    preparationSha256: data.sha256,
    recordedAt: new Date().toISOString(),
    assets: [data.receipt.source, ...data.receipt.references.map((ref) => ref.media)].map((media) => ({
      assetId: media.assetId,
      sha256: media.sha256,
    })),
  });
  if (
    data.receipt.spec.audioPolicy === "preserve-source" &&
    data.receipt.source.hasAudio &&
    rights.audioRights === "muted"
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Preserved source audio needs owned or licensed audio rights.",
    });
  const file = preparationFile(projectId, id, "rights.json", rootDir);
  if (existsSync(file)) {
    const existing = PreparationRightsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (preparationDigest({ ...rights, recordedAt: existing.recordedAt }) !== preparationDigest(existing))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Source-use rights are immutable; use a new preparation for changed permissions.",
      });
    return { file, rights: existing };
  }
  immutablePreparationJson(file, rights);
  return { file, rights };
}
export function approvePreparation(
  projectId: string,
  id: string,
  userStatement: string,
  reviewInput: unknown,
  rootDir = process.cwd(),
) {
  const data = readPreparation(projectId, id, rootDir),
    binding = { id, sha256: data.sha256 };
  validatePreparation(projectId, binding, rootDir);
  const rightsFile = preparationFile(projectId, id, "rights.json", rootDir);
  if (!existsSync(rightsFile))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "Record source-use rights with film:rights --preparation before input approval.",
    });
  const rights = PreparationRightsSchema.parse(JSON.parse(readFileSync(rightsFile, "utf8")));
  const review = PreparationVisualReviewSchema.parse(reviewInput);
  if (
    rights.preparationSha256 !== data.sha256 ||
    review.preparationSha256 !== data.sha256 ||
    preparationDigest(review.references.map((ref) => ref.sha256)) !==
      preparationDigest(data.receipt.references.map((ref) => ref.media.sha256))
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Rights or visual review refer to different preparation inputs or image order.",
    });
  const approval = PreparationApprovalSchema.parse({
    schemaVersion: 1,
    preparationSha256: data.sha256,
    rightsSha256: preparationDigest(rights),
    userStatement,
    approvedAt: new Date().toISOString(),
    review,
  });
  const file = preparationFile(projectId, id, "approval.json", rootDir);
  if (existsSync(file)) {
    const existing = PreparationApprovalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (preparationDigest({ ...approval, approvedAt: existing.approvedAt }) !== preparationDigest(existing))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Input approval is immutable; use a new preparation for changed approval or review.",
      });
    return { file, approval: existing };
  }
  immutablePreparationJson(file, approval);
  return { file, approval };
}
export function preparationAdmission(
  projectId: string | undefined,
  binding: ModelPreparationBinding | undefined,
  endpoint: string,
  input: Record<string, unknown>,
  rootDir = process.cwd(),
) {
  const blockers: string[] = [];
  if (!projectId || !binding)
    return {
      ready: false,
      blockers: ["Genjutsu needs --project and an approved model:prepare request with context.modelPreparation."],
    };
  try {
    const data = validatePreparation(projectId, binding, rootDir);
    if (data.receipt.endpoint !== endpoint || generationInputHash(input) !== data.receipt.resolvedInputSha256)
      throw new Error("Execution endpoint or input differs from the approved preparation.");
    const approvalFile = preparationFile(projectId, binding.id, "approval.json", rootDir);
    if (!existsSync(approvalFile))
      throw new Error("Approve the visual review and exact prepared request with model:prepare --action approve.");
    const approval = PreparationApprovalSchema.parse(JSON.parse(readFileSync(approvalFile, "utf8")));
    const rights = PreparationRightsSchema.parse(
      JSON.parse(readFileSync(preparationFile(projectId, binding.id, "rights.json", rootDir), "utf8")),
    );
    const expectedAssets = [data.receipt.source, ...data.receipt.references.map((ref) => ref.media)].map((media) => ({
      assetId: media.assetId,
      sha256: media.sha256,
    }));
    if (
      approval.preparationSha256 !== binding.sha256 ||
      approval.review.preparationSha256 !== binding.sha256 ||
      rights.preparationSha256 !== binding.sha256 ||
      approval.rightsSha256 !== preparationDigest(rights) ||
      preparationDigest(rights.assets) !== preparationDigest(expectedAssets) ||
      preparationDigest(approval.review.references.map((ref) => ref.sha256)) !==
        preparationDigest(data.receipt.references.map((ref) => ref.media.sha256))
    )
      throw new Error("Approval, review or rights are stale.");
    const referenceAssetIds = [
      ...new Set([
        data.receipt.source.assetId,
        data.receipt.preparedSource.assetId,
        ...data.receipt.references.map((ref) => ref.media.assetId),
      ]),
    ].sort();
    return {
      ready: true,
      blockers,
      binding,
      rights,
      referenceAssetIds,
      remoteMedia: data.request.context?.remoteMedia,
    };
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
    return { ready: false, blockers };
  }
}
