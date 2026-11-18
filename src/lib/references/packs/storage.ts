/**
 * Pack storage (RFC 0003 §6.5, §8): public/projects/<id>/pipeline/reference-packs/<packId>/ with spec.json, board.html,
 * request.json and receipt.json (written last: the commit marker), then rights.json, approval.json and
 * results/<outputSha256>/. packSha256 is the sha256 of the canonical JSON of the parsed receipt.
 */
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertPathWithin, CliErrorObject } from "../../cli";
import { immutableWrite } from "../../jobs/model-artifacts";
import { canonicalJson } from "../../providers/fal-openapi";
import { preparationProject } from "../../model-preparation/storage";
import { FalEndpointRequestSchema } from "../../../types/generation";
import {
  PackApprovalSchema,
  PackRightsSchema,
  ReferencePackIdSchema,
  ReferencePackReceiptSchema,
  ReferencePackSpecSchema,
  type PackApproval,
  type PackRights,
  type ReferencePackReceipt,
  type ReferencePackSpec,
} from "../../../types/references";
import type { z } from "zod";

export const PACKS_DIR = "pipeline/reference-packs";
export const packDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The exact generation request a pack emits (request.json). */
export type PackRequest = {
  provider: "fal" | "higgsfield";
  endpoint: string;
  input: Record<string, unknown>;
  context: { referencePack: { id: string; sha256: string } };
};
/** receipt.requestSha256 hashes the request without its context: the context names the pack hash, which the receipt fixes. */
export const requestDigest = (request: Pick<PackRequest, "provider" | "endpoint" | "input">): string =>
  packDigest({ provider: request.provider, endpoint: request.endpoint, input: request.input });

export function packDirectory(projectId: string, id: string, rootDir = process.cwd()): string {
  ReferencePackIdSchema.parse(id);
  const project = preparationProject(projectId, rootDir),
    directory = path.join(project, PACKS_DIR, id);
  assertPathWithin(project, directory);
  return directory;
}
export function packFile(projectId: string, id: string, name: string, rootDir = process.cwd()): string {
  const directory = packDirectory(projectId, id, rootDir),
    file = path.join(directory, name);
  assertPathWithin(directory, file);
  return file;
}
/** Immutable JSON write; a different existing file is FILE_EXISTS. */
export function immutablePackJson(file: string, value: unknown, what = "Pack file"): void {
  immutablePackText(file, `${JSON.stringify(value, null, 2)}\n`, what);
}
export function immutablePackText(file: string, text: string, what = "Pack file"): void {
  try {
    immutableWrite(file, text);
  } catch (error) {
    if (error instanceof Error && /Immutable artifact conflict/.test(error.message))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `${what} ${path.basename(file)} is immutable and differs; use a new pack id for changed inputs.`,
      });
    throw error;
  }
}

function parseFile<T>(schema: z.ZodType<T>, file: string, what: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Cannot read ${what}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid ${what}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    });
  return parsed.data;
}

export type StoredPack = {
  spec: ReferencePackSpec;
  receipt: ReferencePackReceipt;
  request: PackRequest;
  packSha256: string;
  rights?: PackRights;
  approval?: PackApproval;
  directory: string;
};

/**
 * The stored pack, parsed, with its digest. Checks identity and the spec/receipt/request bindings from the files
 * alone; media and board bytes are re-verified by checkPack. STAGE_INCOMPLETE when the receipt is missing.
 */
export function readPack(projectId: string, id: string, rootDir = process.cwd()): StoredPack {
  const directory = packDirectory(projectId, id, rootDir),
    receiptFile = path.join(directory, "receipt.json");
  if (!existsSync(receiptFile))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Pack ${id} has no receipt; run pnpm refs:pack --project ${projectId} --action prepare --spec SPEC.json first.`,
    });
  const receipt = parseFile(ReferencePackReceiptSchema, receiptFile, `pack receipt ${id}`);
  const spec = parseFile(ReferencePackSpecSchema, path.join(directory, "spec.json"), `pack spec ${id}`);
  if (receipt.projectId !== projectId || receipt.id !== id || spec.id !== id)
    throw new CliErrorObject({ code: "VALIDATION", message: `Pack ${id}: identity mismatch.` });
  if (packDigest(spec) !== packDigest(receipt.spec))
    throw new CliErrorObject({ code: "VALIDATION", message: `Pack ${id}: spec.json differs from the receipt.` });
  const packSha256 = packDigest(receipt);
  const requestFile = path.join(directory, "request.json");
  const request = parseFile(FalEndpointRequestSchema, requestFile, `pack request ${id}`);
  // The raw context, not the parsed one (parsing adds defaults): it must be exactly the pack binding.
  const rawContext = (JSON.parse(readFileSync(requestFile, "utf8")) as { context?: unknown }).context;
  const binding = { referencePack: { id, sha256: packSha256 } };
  if (
    !request.provider ||
    request.endpoint !== receipt.endpoint ||
    requestDigest({ provider: request.provider, endpoint: request.endpoint, input: request.input }) !==
      receipt.requestSha256 ||
    packDigest(rawContext ?? null) !== packDigest(binding)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pack ${id}: request.json no longer matches its receipt (request bytes or pack binding changed).`,
    });
  const rightsFile = path.join(directory, "rights.json"),
    approvalFile = path.join(directory, "approval.json");
  return {
    spec,
    receipt,
    request: { provider: request.provider, endpoint: request.endpoint, input: request.input, context: binding },
    packSha256,
    ...(existsSync(rightsFile) ? { rights: parseFile(PackRightsSchema, rightsFile, `pack rights ${id}`) } : {}),
    ...(existsSync(approvalFile)
      ? { approval: parseFile(PackApprovalSchema, approvalFile, `pack approval ${id}`) }
      : {}),
    directory,
  };
}

/** Pack ids with a directory under pipeline/reference-packs (complete or not), sorted. */
export function listPackIds(projectId: string, rootDir = process.cwd()): string[] {
  const project = preparationProject(projectId, rootDir),
    directory = path.join(project, PACKS_DIR);
  assertPathWithin(project, directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ReferencePackIdSchema.safeParse(entry.name).success)
    .map((entry) => entry.name)
    .sort();
}
