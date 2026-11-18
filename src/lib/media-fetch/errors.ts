import type { MediaIssue } from "../../types/media-fetch";
export class MediaFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action = "Inspect the media:fetch report.",
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export function issue(error: unknown): MediaIssue {
  if (error instanceof MediaFetchError)
    return {
      code: error.code,
      message: error.message,
      action: error.action,
      retryable: error.retryable,
      ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return {
      code: error.code,
      message: error instanceof Error ? error.message : "Acquisition policy rejected the operation.",
      action: "Inspect the saved job and budget policy.",
      retryable: false,
    };
  return {
    code: "INTERNAL_ERROR",
    message: "Media acquisition failed unexpectedly.",
    action: "Inspect the local error type and report a reproducible bug; do not repeat an ambiguous provider call.",
    retryable: false,
  };
}
