import { CliErrorObject, emitError, emitSuccess } from "../cli";

/** The shared runScript loads .env; privileged triage uses exported keys only. */
export async function runTriageScript(
  fn: () => Promise<{ outputs?: string[]; metadata?: Record<string, unknown> }>,
): Promise<never> {
  const startedAt = Date.now();
  try {
    return emitSuccess({ ...(await fn()), startedAt });
  } catch (error) {
    if (error instanceof CliErrorObject)
      return emitError({
        error: error.code,
        message: error.message,
        details: error.details,
        retryAfterMs: error.retryAfterMs,
        startedAt,
      });
    return emitError({
      error: "VALIDATION",
      message: error instanceof Error ? error.message : "Triage failed.",
      startedAt,
    });
  }
}
