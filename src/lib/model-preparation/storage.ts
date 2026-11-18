import path from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { assertPathWithin, CliErrorObject } from "../cli";
import { immutableWrite } from "../jobs/model-artifacts";
import { canonicalJson } from "../providers/fal-openapi";
import {
  PreparationIdSchema,
  ModelPreparationReceiptSchema,
  type ModelPreparationReceipt,
} from "../../types/model-preparation";

export const preparationDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function preparationProject(projectId: string, rootDir = process.cwd()): string {
  PreparationIdSchema.parse(projectId);
  const root = path.resolve(rootDir),
    project = path.join(root, "public/projects", projectId);
  assertPathWithin(root, project);
  if (!existsSync(project))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  return project;
}
export function preparationDirectory(projectId: string, id: string, rootDir = process.cwd()): string {
  PreparationIdSchema.parse(id);
  const project = preparationProject(projectId, rootDir),
    directory = path.join(project, "pipeline/model-preparations", id);
  assertPathWithin(project, directory);
  return directory;
}
export function preparationFile(projectId: string, id: string, name: string, rootDir = process.cwd()): string {
  const directory = preparationDirectory(projectId, id, rootDir),
    file = path.join(directory, name);
  assertPathWithin(directory, file);
  return file;
}
export function immutablePreparationJson(file: string, value: unknown): void {
  immutableWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
export function readPreparation(
  projectId: string,
  id: string,
  rootDir = process.cwd(),
): { receipt: ModelPreparationReceipt; sha256: string } {
  const file = preparationFile(projectId, id, "receipt.json", rootDir);
  if (!existsSync(file))
    throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: `Prepare ${id} with pnpm model:prepare first.` });
  const receipt = ModelPreparationReceiptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (receipt.projectId !== projectId || receipt.id !== id || receipt.spec.id !== id)
    throw new CliErrorObject({ code: "VALIDATION", message: "Preparation identity mismatch." });
  return { receipt, sha256: preparationDigest(receipt) };
}
export function projectMediaFile(projectId: string, original: string, rootDir = process.cwd()): string {
  const project = preparationProject(projectId, rootDir),
    file = path.resolve(rootDir, "public", original);
  assertPathWithin(project, file);
  if (!existsSync(file))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Missing imported original: ${original}` });
  return realpathSync(file);
}
