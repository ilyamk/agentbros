import { existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RenderIdentity } from "../../types/delivery";
import { RenderReceiptSchema } from "../../types/delivery";
import { hashFile } from "../assets/registry";
import { CliErrorObject, assertPathWithin } from "../cli";

/** Receipt binds bytes to the exact unchanged input snapshot, not creative/quality approval. */
export function publishRenderReceipt(
  outputFile: string,
  before: RenderIdentity,
  after: RenderIdentity,
  rootDir = process.cwd(),
  /** An excerpt (`render --frames`): recorded so delivery refuses it as a final output. */
  partial?: { startFrame: number; endFrame: number; totalFrames: number },
) {
  if (before.sourceSnapshotHash !== after.sourceSnapshotHash || before.propsHash !== after.propsHash)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Render inputs changed while Chromium was running; output needs a new render before delivery",
    });
  const output = path.resolve(rootDir, outputFile);
  assertPathWithin(path.resolve(rootDir, "out"), output);
  if (!existsSync(output))
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: "Renderer exited successfully without producing the requested output",
    });
  const receipt = RenderReceiptSchema.parse({
    version: 1,
    sourceSnapshotHash: before.sourceSnapshotHash,
    propsHash: before.propsHash,
    outputSha256: hashFile(output),
    format: before.format,
    captions: before.captions,
    createdAt: new Date().toISOString(),
    sources: before.sources,
    evidence: "renderer",
    ...(partial ? { partial } : {}),
  });
  const target = `${output}.receipt.json`,
    temporary = `${target}.${randomUUID()}.tmp`;
  assertPathWithin(path.resolve(rootDir, "out"), target);
  try {
    writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return target;
}
