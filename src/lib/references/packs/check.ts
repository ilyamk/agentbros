/** refs:pack --action check: a stored pack is still exactly what was prepared, plus its rights and approval state. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../../cli";
import { hashFile, readAssetRegistry } from "../../assets/registry";
import type { AssetRecord } from "../../../types/assets";
import { PackApprovalSchema, ReferencePackReceiptSchema, type ReferencePackReceipt } from "../../../types/references";
import { profileByFamily } from "../profiles";
import { verifiedOriginal, assetAncestry } from "./media";
import { planPackRequest } from "./prepare";
import { verifyPackSpeech } from "./speech";
import { listPackIds, packDigest, packDirectory, packFile, readPack, type StoredPack } from "./storage";

const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
const GENERATED = new Set(["provider", "agent-harness", "derivative"]);

/**
 * Rights are required (RFC 0003 §11) when any attachment is a video (source, motion or performance clips are
 * someone's footage), or when any attachment, or any asset it was made from, is not generated: origin "manual" or
 * "stock", or an ancestor missing from the registry. Generated originals and derivatives of them need none.
 */
export function packRightsRequired(
  receipt: ReferencePackReceipt,
  registry: AssetRecord[],
): { required: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const byId = new Map(registry.map((asset) => [asset.id, asset]));
  for (const a of receipt.attachments) {
    if (a.media.contentType.startsWith("video/")) reasons.push(`${a.requirementKey} is a video.`);
    const ancestry = assetAncestry(a.media.assetId, registry);
    const missing = ancestry.flatMap((asset) => asset.provenance.referenceAssetIds).filter((id) => !byId.has(id));
    const supplied = ancestry.filter((asset) => !GENERATED.has(asset.provenance.origin));
    if (supplied.length || missing.length || !byId.has(a.media.assetId))
      reasons.push(
        `${a.requirementKey} comes from a supplied original (${[
          ...supplied.map((asset) => `${asset.provenance.origin} ${asset.id}`),
          ...missing.map((id) => `unregistered ${id}`),
        ].join(", ")}).`,
      );
  }
  return { required: reasons.length > 0, reasons };
}

export type ApprovalState = { approved: boolean; problems: string[] };
/** Whether approval.json binds this exact pack, its review attachments and (when present or required) its rights. */
export function approvalState(pack: StoredPack, rightsRequired: boolean): ApprovalState {
  const problems: string[] = [];
  const { approval, rights, packSha256, receipt } = pack;
  if (rightsRequired && !rights) problems.push("Rights are required and not recorded (refs:pack --action rights).");
  if (rights && rights.packSha256 !== packSha256) problems.push("rights.json is for another pack hash.");
  if (rights && packDigest(rights.assets) !== packDigest(rightsAssets(receipt)))
    problems.push("rights.json covers other assets.");
  if (!approval) problems.push("No approval recorded (refs:pack --action approve).");
  else {
    if (approval.packSha256 !== packSha256) problems.push("approval.json is for another pack hash.");
    if ((approval.rightsSha256 ?? null) !== (rights ? packDigest(rights) : null))
      problems.push("approval.json binds other rights than rights.json.");
    if (packDigest(reviewKeys(approval.review.attachments)) !== packDigest(reviewKeys(receiptReviewKeys(receipt))))
      problems.push("The approved visual review covers other attachments.");
  }
  return { approved: problems.length === 0, problems };
}
/** The (assetId, sha256) set rights cover: every distinct attachment asset, in receipt order. */
export function rightsAssets(receipt: ReferencePackReceipt): { assetId: string; sha256: string }[] {
  const seen = new Set<string>();
  return receipt.attachments
    .map((a) => ({ assetId: a.media.assetId, sha256: a.media.sha256 }))
    .filter((a) => !seen.has(a.assetId) && seen.add(a.assetId));
}
const reviewKeys = (rows: { sha256: string; requirementKey: string }[]) =>
  rows.map((row) => ({ sha256: row.sha256, requirementKey: row.requirementKey }));
export const receiptReviewKeys = (receipt: ReferencePackReceipt) =>
  receipt.attachments.map((a) => ({ sha256: a.media.sha256, requirementKey: a.requirementKey }));

export type PackCheck = StoredPack & {
  rightsRequired: boolean;
  rightsReasons: string[];
  approvalStatus: ApprovalState;
  schemaWarnings: string[];
};

/**
 * Re-verifies a stored pack: receipt and request bindings (readPack), the profile it was compiled with, every
 * attachment's bytes, registry identity and provenance, the board bytes, and the endpoint schema by planning the
 * exact request offline again. VALIDATION on any difference.
 */
export function checkPack(projectId: string, id: string, rootDir = process.cwd()): PackCheck {
  const pack = readPack(projectId, id, rootDir);
  const { receipt } = pack;
  verifyPackSpeech(projectId, receipt.spec, rootDir);
  const profile = profileByFamily(receipt.spec.profileFamily);
  if (!profile || packDigest(profile) !== receipt.profileSha256)
    throw invalid(`Pack ${id}: profile ${receipt.spec.profileFamily} changed since prepare; prepare a new pack.`);
  const registry = readAssetRegistry(projectId, rootDir).assets;
  for (const a of receipt.attachments) {
    const asset = registry.find((row) => row.id === a.media.assetId);
    if (
      !asset ||
      asset.hash !== a.media.sha256 ||
      asset.files.original !== a.media.original ||
      asset.files.bytes !== a.media.bytes
    )
      throw invalid(`Pack ${id}: attachment ${a.requirementKey} is no longer the registered asset it pinned.`);
    verifiedOriginal(projectId, asset, rootDir);
    if (packDigest(asset.provenance) !== a.provenanceSha256)
      throw invalid(`Pack ${id}: provenance of ${a.requirementKey} changed.`);
  }
  for (const review of receipt.reviewFiles) {
    const file = packFile(projectId, id, review.path, rootDir);
    if (!existsSync(file) || hashFile(file) !== review.sha256)
      throw invalid(`Pack ${id}: review file ${review.path} changed.`);
  }
  let plan;
  try {
    plan = planPackRequest(projectId, pack.request, rootDir);
  } catch (error) {
    throw invalid(`Pack ${id}: the request no longer validates: ${error instanceof Error ? error.message : error}`);
  }
  if (plan.schemaSha256 !== receipt.schemaSha256)
    throw invalid(`Pack ${id}: the endpoint schema changed since prepare; prepare a new pack.`);
  const rights = packRightsRequired(receipt, registry);
  return {
    ...pack,
    rightsRequired: rights.required,
    rightsReasons: rights.reasons,
    approvalStatus: approvalState(pack, rights.required),
    schemaWarnings: plan.warnings,
  };
}

export type PackStatus = "missing" | "prepared" | "approved";
export type PackState = { status: PackStatus; packSha256?: string; receipt?: ReferencePackReceipt };
export type PackStatusOptions = {
  /**
   * true (default): checkPack re-verifies every attachment's bytes, the board and the request, and the approval must
   * bind the current pack, its rights and review. false: the cheap read for chain checks: the receipt parses and names
   * this pack, and approval.json binds its digest; nothing is re-hashed and nothing throws (invalid reads as missing).
   */
  verify?: boolean;
};

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
}
function cheapPackState(projectId: string, id: string, rootDir: string): PackState {
  let directory: string;
  try {
    directory = packDirectory(projectId, id, rootDir);
  } catch {
    return { status: "missing" };
  }
  const receipt = ReferencePackReceiptSchema.safeParse(readJson(path.join(directory, "receipt.json")));
  if (!receipt.success || receipt.data.id !== id || receipt.data.projectId !== projectId) return { status: "missing" };
  const packSha256 = packDigest(receipt.data);
  const approval = PackApprovalSchema.safeParse(readJson(path.join(directory, "approval.json")));
  const approved = approval.success && approval.data.packSha256 === packSha256;
  return { status: approved ? "approved" : "prepared", packSha256, receipt: receipt.data };
}

/**
 * Status, digest and receipt of one pack. Verified (default): "missing" without a receipt; "approved" when checkPack
 * passes and approval.json binds the current pack (and its rights when required); otherwise "prepared"; a tampered or
 * stale pack throws checkPack's VALIDATION error. With { verify: false } see PackStatusOptions.
 */
export function packState(
  projectId: string,
  id: string,
  rootDir = process.cwd(),
  options: PackStatusOptions = {},
): PackState {
  if (options.verify === false) return cheapPackState(projectId, id, rootDir);
  if (!existsSync(path.join(packDirectory(projectId, id, rootDir), "receipt.json"))) return { status: "missing" };
  const pack = checkPack(projectId, id, rootDir);
  return {
    status: pack.approvalStatus.approved ? "approved" : "prepared",
    packSha256: pack.packSha256,
    receipt: pack.receipt,
  };
}
export function packStatus(
  projectId: string,
  id: string,
  rootDir = process.cwd(),
  options: PackStatusOptions = {},
): PackStatus {
  return packState(projectId, id, rootDir, options).status;
}

export type PackListing = {
  id: string;
  status: PackStatus | "incomplete" | "invalid";
  packSha256?: string;
  shotId?: string;
  endpoint?: string;
  error?: string;
};
/** Every pack directory with its status; a broken pack is listed as invalid with the reason, never hidden. */
export function listPacks(projectId: string, rootDir = process.cwd()): PackListing[] {
  return listPackIds(projectId, rootDir).map((id) => {
    if (!existsSync(path.join(packDirectory(projectId, id, rootDir), "receipt.json")))
      return { id, status: "incomplete" as const };
    try {
      const pack = checkPack(projectId, id, rootDir);
      return {
        id,
        status: pack.approvalStatus.approved ? ("approved" as const) : ("prepared" as const),
        packSha256: pack.packSha256,
        shotId: pack.spec.shotId,
        endpoint: pack.spec.endpoint,
      };
    } catch (error) {
      return { id, status: "invalid" as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
