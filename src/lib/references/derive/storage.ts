/** pipeline/reference-derivatives/<id>/{spec.json,receipt.json,board.html}: immutable, guarded like model-preparations. */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertPathWithin, CliErrorObject } from "../../cli";
import { canonicalJson } from "../../providers/fal-openapi";
import { preparationProject } from "../../model-preparation/storage";
import {
  DerivativeReceiptSchema,
  DerivativeSpecSchema,
  ReferencePackIdSchema,
  type DerivativeReceipt,
  type DerivativeSpec,
} from "../../../types/references";

export const DERIVATIVES_DIR = "pipeline/reference-derivatives";
export const derivativeDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The project directory (PROJECT_NOT_FOUND when absent). */
export const derivativeProject = (projectId: string, rootDir = process.cwd()): string =>
  preparationProject(projectId, rootDir);

export function derivativeDirectory(projectId: string, id: string, rootDir = process.cwd()): string {
  ReferencePackIdSchema.parse(id);
  const project = derivativeProject(projectId, rootDir),
    directory = path.join(project, DERIVATIVES_DIR, id);
  assertPathWithin(project, directory);
  return directory;
}
/** Project-relative receipt path, as the asset registry links it. */
export const receiptLink = (id: string): string => `${DERIVATIVES_DIR}/${id}/receipt.json`;

export function readDerivativeSpec(directory: string): DerivativeSpec | undefined {
  const file = path.join(directory, "spec.json");
  if (!existsSync(file)) return undefined;
  return DerivativeSpecSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The stored receipt and its sha256 (of the file bytes); STAGE_INCOMPLETE when the derivative has not run. */
export function readDerivative(
  projectId: string,
  id: string,
  rootDir = process.cwd(),
): { receipt: DerivativeReceipt; spec: DerivativeSpec; sha256: string; directory: string } {
  const directory = derivativeDirectory(projectId, id, rootDir),
    file = path.join(directory, "receipt.json");
  if (!existsSync(file))
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Derivative ${id} has no receipt; run pnpm refs:derive --project ${projectId} --action run --spec SPEC.json first.`,
    });
  const text = readFileSync(file, "utf8");
  let receipt: DerivativeReceipt;
  try {
    receipt = DerivativeReceiptSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid derivative receipt ${id}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const spec = readDerivativeSpec(directory);
  if (!spec || receipt.id !== id || spec.id !== id || derivativeDigest(spec) !== receipt.specSha256)
    throw new CliErrorObject({ code: "VALIDATION", message: `Derivative ${id}: spec and receipt disagree.` });
  return { receipt, spec, sha256: sha256Text(text), directory };
}

/** pending.json: a fal step submitted (or reserved) whose result is not published yet. No receipt exists meanwhile. */
export type DerivativePendingFile = {
  schemaVersion: 1;
  id: string;
  operationId: string;
  endpoint: string;
  requestSha256: string;
  createdAt: string;
};
export const PENDING_FILE = "pending.json";

export function readDerivativePending(directory: string): DerivativePendingFile | undefined {
  const file = path.join(directory, PENDING_FILE);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as DerivativePendingFile;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.endpoint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestSha256 ?? "")
  )
    throw new CliErrorObject({ code: "VALIDATION", message: `Invalid ${PENDING_FILE} in ${directory}.` });
  return value;
}
