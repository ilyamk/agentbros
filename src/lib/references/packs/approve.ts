/** refs:pack --action rights | approve: the user's statements, bound to the exact pack hash (CLI only, RFC 0003 D12). */
import { existsSync, readFileSync } from "node:fs";
import type { z } from "zod";
import { CliErrorObject } from "../../cli";
import {
  PackApprovalSchema,
  PackRightsSchema,
  PackVisualReviewSchema,
  type PackApproval,
  type PackRights,
} from "../../../types/references";
import { checkPack, receiptReviewKeys, rightsAssets } from "./check";
import { immutablePackJson, packDigest, packFile } from "./storage";

const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw invalid(
      `${what} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

export type PackRightsStatement = Omit<PackRights, "schemaVersion" | "packSha256" | "recordedAt" | "assets">;

/**
 * Records rights.json for the current pack: the user's statement and evidence, covering every attachment asset.
 * Audio that reaches the model or the result (audioPolicy native or reference-driven with an audio attachment or a
 * video with sound) cannot be "muted". Immutable: the same statement is returned, a different one is FILE_EXISTS.
 */
export function writePackRights(
  projectId: string,
  id: string,
  statement: PackRightsStatement,
  rootDir = process.cwd(),
): { file: string; rights: PackRights; required: boolean; reasons: string[] } {
  const pack = checkPack(projectId, id, rootDir);
  if (pack.approval && !existsSync(packFile(projectId, id, "rights.json", rootDir)))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message:
        "The pack is already approved without rights; record rights on a new pack id so the approval binds them.",
    });
  const rights = parseWith(
    PackRightsSchema,
    {
      ...statement,
      schemaVersion: 1,
      packSha256: pack.packSha256,
      recordedAt: new Date().toISOString(),
      assets: rightsAssets(pack.receipt),
    },
    "Pack rights",
  );
  const carriesAudio = pack.receipt.attachments.some(
    (a) => a.media.contentType.startsWith("audio/") || (a.media.contentType.startsWith("video/") && a.media.hasAudio),
  );
  if (carriesAudio && pack.spec.audioPolicy === "reference-driven" && rights.audioRights === "muted")
    throw invalid("Reference-driven audio from supplied sound needs owned or licensed audio rights, not muted.");
  const file = packFile(projectId, id, "rights.json", rootDir);
  if (existsSync(file)) {
    const existing = parseWith(PackRightsSchema, JSON.parse(readFileSync(file, "utf8")), "Stored pack rights");
    if (packDigest({ ...rights, recordedAt: existing.recordedAt }) !== packDigest(existing))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Pack rights are immutable; prepare a new pack id for changed permissions.",
      });
    return { file, rights: existing, required: pack.rightsRequired, reasons: pack.rightsReasons };
  }
  immutablePackJson(file, rights, "Pack rights");
  return { file, rights, required: pack.rightsRequired, reasons: pack.rightsReasons };
}

/**
 * Records approval.json: the user's words verbatim (the caller refuses agent-written text with requireUserWords) and
 * the reviewer's PackVisualReview of the board, bound to packSha256 and, when rights exist, rightsSha256. Rights must
 * exist when packRightsRequired says so. Immutable like rights.
 */
export function approvePack(
  projectId: string,
  id: string,
  userStatement: string,
  reviewInput: unknown,
  rootDir = process.cwd(),
): { file: string; approval: PackApproval } {
  const pack = checkPack(projectId, id, rootDir);
  if (pack.rightsRequired && !pack.rights)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Record the user's rights first (refs:pack --action rights): ${pack.rightsReasons.join(" ")}`,
    });
  if (
    pack.rights &&
    (pack.rights.packSha256 !== pack.packSha256 ||
      packDigest(pack.rights.assets) !== packDigest(rightsAssets(pack.receipt)))
  )
    throw invalid("rights.json belongs to another pack revision.");
  const review = parseWith(PackVisualReviewSchema, reviewInput, "Pack visual review");
  if (review.packSha256 !== pack.packSha256) throw invalid("The visual review is for another pack hash.");
  const reviewed = review.attachments.map((a) => ({ sha256: a.sha256, requirementKey: a.requirementKey }));
  if (packDigest(reviewed) !== packDigest(receiptReviewKeys(pack.receipt)))
    throw invalid("The visual review must cover every attachment, in the pack's order, with its exact hash.");
  const approval = parseWith(
    PackApprovalSchema,
    {
      schemaVersion: 1,
      packSha256: pack.packSha256,
      ...(pack.rights ? { rightsSha256: packDigest(pack.rights) } : {}),
      userStatement,
      approvedAt: new Date().toISOString(),
      review,
    },
    "Pack approval",
  );
  const file = packFile(projectId, id, "approval.json", rootDir);
  if (existsSync(file)) {
    const existing = parseWith(PackApprovalSchema, JSON.parse(readFileSync(file, "utf8")), "Stored pack approval");
    if (packDigest({ ...approval, approvedAt: existing.approvedAt }) !== packDigest(existing))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Pack approval is immutable; prepare a new pack id for a changed review or approval.",
      });
    return { file, approval: existing };
  }
  immutablePackJson(file, approval, "Pack approval");
  return { file, approval };
}
