import { ApiErrorSchema } from "@contract";

/** Error codes the client adds to the server's CLI error codes. */
export type ClientErrorCode = "NETWORK" | "INVALID_RESPONSE" | "UNAUTHORIZED" | "NOT_IMPLEMENTED" | "NOT_FOUND";

/** A failed API call: the server's `{ ok: false, error, message }` body, or a client-side failure. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }
}

/** Builds the failure for a non-2xx reply; the server's message is kept verbatim (shown to the user, D9). */
export function failureFromBody(status: number, body: unknown): ApiFailure {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) return new ApiFailure(parsed.data.error, parsed.data.message, status);
  const message =
    body && typeof body === "object" && "message" in body && typeof body.message === "string"
      ? body.message
      : `HTTP ${status}`;
  const code =
    status === 401 || status === 403
      ? "UNAUTHORIZED"
      : status === 404
        ? "NOT_FOUND"
        : status === 501
          ? "NOT_IMPLEMENTED"
          : "HTTP_ERROR";
  return new ApiFailure(code, message, status);
}

export function asFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  if (error instanceof Error) return new ApiFailure("NETWORK", error.message);
  return new ApiFailure("NETWORK", String(error));
}

/**
 * True when a failed write may still have been applied (the request may have reached the server): a network error, an
 * unreadable reply or a 5xx other than 501. The UI then shows the ambiguous state and lets the user re-check the view
 * instead of resubmitting blindly.
 */
export function isAmbiguous(failure: ApiFailure): boolean {
  if (failure.code === "NETWORK" || failure.code === "INVALID_RESPONSE") return true;
  return failure.status !== undefined && failure.status >= 500 && failure.status !== 501;
}
