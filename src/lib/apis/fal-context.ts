import { readFileSync, statSync } from "node:fs";
import { inspectAsset } from "../assets/inspect";
import { CliErrorObject, requireFile } from "../cli";
import type { ExecutionOptions } from "../jobs/execution";
export type FalGenerationContext = Omit<ExecutionOptions, "endpoint" | "model" | "input" | "mediaKind">;
/** Pending is a resumable state, never a fabricated successful media result. */
export class PendingFalOperationError extends Error {
  constructor(public readonly metadata: Record<string, unknown>) {
    super(
      `fal operation ${String(metadata.operationId)} is ${String(metadata.state ?? "planned")}; resume the same operation.`,
    );
    this.name = "PendingFalOperationError";
  }
}
/** Deterministic input bytes keep request identity stable across process restarts. */
export function localMediaDataUri(
  file: string,
  expectedKind?: "image" | "video" | "audio",
  maxBytes = 32 * 1024 * 1024,
): string {
  requireFile(file);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Local media must be a nonempty file of at most ${maxBytes} bytes. Supply a provider-accessible URL for larger references.`,
    });
  const inspected = inspectAsset(file);
  if (expectedKind && inspected.kind !== expectedKind)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Expected ${expectedKind} input, received ${inspected.kind}.`,
    });
  const buffer = readFileSync(file);
  if (buffer.length !== stat.size)
    throw new CliErrorObject({ code: "VALIDATION", message: "Input changed while being read." });
  return `data:${inspected.mime};base64,${buffer.toString("base64")}`;
}
