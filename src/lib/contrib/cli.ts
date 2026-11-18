import { runtimeStatus } from "../runtime";
import { CliErrorObject, emitResult, type CliResult } from "../cli";

/** Offline intake must never load credentials; runScript currently loads .env. */
export async function runOffline(
  fn: () => Promise<{ outputs?: string[]; metadata?: Record<string, unknown> }>,
): Promise<never> {
  const startedAt = Date.now();
  let result: CliResult;
  try {
    const runtime = runtimeStatus();
    if (runtime.role === "unsupported")
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Unsupported Node ${runtime.actual}; use ${runtime.primary} or ${runtime.fallback}`,
        details: runtime,
      });
    result = { ok: true, outputs: [], metadata: {}, ...(await fn()), elapsedMs: Date.now() - startedAt };
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof CliErrorObject ? error.code : "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CliErrorObject && error.details ? { metadata: error.details } : {}),
      elapsedMs: Date.now() - startedAt,
    };
  }
  return emitResult(result);
}
