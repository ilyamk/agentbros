/**
 * Pack → output link (RFC 0003 §6.5; WP6): pipeline/reference-packs/<id>/outputs.json, an append-only list of the
 * outputs generate:model published from a request bound to this pack. result-board warns and review-result refuses
 * (unless explicitly allowed) a result that is not on it. Leaf module: execution.ts imports it directly.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../../cli";
import { hashFile } from "../../assets/registry";
import type { ReferencePackBinding } from "../../../types/reference-pack-binding";
import { ReferencePackReceiptSchema } from "../../../types/references";
import { packDigest, packFile } from "./storage";

const HASH = z.string().regex(/^[a-f0-9]{64}$/);
export const PackOutputSchema = z
  .object({
    operationId: z.string().min(1),
    outputSha256: HASH,
    assetId: z.string().min(1),
    /** Relative to the workspace root. */
    path: z.string().min(1),
    at: z.iso.datetime(),
  })
  .strict();
export const PackOutputsSchema = z
  .object({ schemaVersion: z.literal(1), packSha256: HASH, outputs: z.array(PackOutputSchema) })
  .strict();
export type PackOutput = z.infer<typeof PackOutputSchema>;
export type PackOutputs = z.infer<typeof PackOutputsSchema>;

/** The recorded outputs of a pack; an empty list when none were published. VALIDATION when the file is broken. */
export function readPackOutputs(projectId: string, id: string, rootDir = process.cwd()): PackOutputs | undefined {
  const file = packFile(projectId, id, "outputs.json", rootDir);
  if (!existsSync(file)) return undefined;
  const parsed = PackOutputsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new CliErrorObject({ code: "VALIDATION", message: `Pack ${id}: outputs.json is invalid.` });
  return parsed.data;
}

/** Whether these output bytes were published from this pack revision. */
export function packProducedOutput(
  projectId: string,
  binding: ReferencePackBinding,
  outputSha256: string,
  rootDir = process.cwd(),
): boolean {
  const outputs = readPackOutputs(projectId, binding.id, rootDir);
  return outputs?.packSha256 === binding.sha256 && outputs.outputs.some((entry) => entry.outputSha256 === outputSha256);
}

/**
 * Appends one published output (idempotent per operation and output hash); written atomically. Refuses (VALIDATION)
 * when the pack on disk is no longer the bound revision or outputs.json belongs to another one: the caller
 * (executeFalOperation) records best-effort and skips with a warning, so a published output is never lost.
 */
export function recordPackOutput(
  projectId: string,
  binding: ReferencePackBinding,
  operationId: string,
  output: string,
  assetId: string,
  rootDir = process.cwd(),
): PackOutput {
  const file = packFile(projectId, binding.id, "outputs.json", rootDir);
  if (!existsSync(path.join(path.dirname(file), "receipt.json")))
    throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: `Pack ${binding.id} has no receipt.` });
  const receipt = ReferencePackReceiptSchema.safeParse(
    JSON.parse(readFileSync(path.join(path.dirname(file), "receipt.json"), "utf8")),
  );
  const onDisk = receipt.success ? packDigest(receipt.data) : "unreadable";
  if (onDisk !== binding.sha256)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pack ${binding.id} is now revision ${onDisk.slice(0, 12)}, not the bound ${binding.sha256.slice(0, 12)}.`,
    });
  const current = readPackOutputs(projectId, binding.id, rootDir) ?? {
    schemaVersion: 1 as const,
    packSha256: binding.sha256,
    outputs: [],
  };
  if (current.packSha256 !== binding.sha256)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pack ${binding.id}: outputs.json belongs to another pack hash.`,
    });
  const entry = PackOutputSchema.parse({
    operationId,
    outputSha256: hashFile(output),
    assetId,
    path: path.relative(path.resolve(rootDir), path.resolve(rootDir, output)).split(path.sep).join("/"),
    at: new Date().toISOString(),
  });
  const known = current.outputs.find(
    (row) => row.operationId === entry.operationId && row.outputSha256 === entry.outputSha256,
  );
  if (known) return known;
  const next: PackOutputs = { ...current, outputs: [...current.outputs, entry] };
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return entry;
}
