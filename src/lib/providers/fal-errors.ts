/**
 * The fal request error, shared by the validator, the guard plugins and fal-operations.ts
 * (which re-exports it) so that none of them imports another in a cycle.
 */
export type FalOperationErrorCode =
  "INVALID_INPUT" | "UNSUPPORTED_OPERATION" | "REGION_RESTRICTED" | "DRAFT_EXPIRED" | "SCHEMA_NOT_CACHED";
export class FalOperationError extends Error {
  constructor(
    public code: FalOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FalOperationError";
  }
}
export function fail(message: string): never {
  throw new FalOperationError("INVALID_INPUT", message);
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
