/**
 * Errors and JSON replies of the loopback servers (RFC 0004 D2, D15). A handler throws {@link HttpError} with a status
 * and a code; anything else maps to 400 with its message only (no stack, no paths beyond what the message says).
 */
import type { ServerResponse } from "node:http";

/** Codes used by the local servers: CLI error codes where one fits, HTTP-style names otherwise. */
export type HttpErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "INVALID_INPUT"
  | "VALIDATION"
  | "CONFLICT"
  | "RANGE_NOT_SATISFIABLE"
  | "NOT_IMPLEMENTED"
  | "FFMPEG_MISSING"
  | "FFMPEG_FAILED"
  | "TIMEOUT"
  | "INTERNAL"
  | (string & {});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: HttpErrorCode,
    message: string,
    /** Extra JSON fields of the reply body (a 409's stored outcome); never secrets. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const forbidden = (message: string) => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message: string, code: HttpErrorCode = "NOT_FOUND") => new HttpError(404, code, message);
export const badRequest = (message: string, code: HttpErrorCode = "INVALID_INPUT") => new HttpError(400, code, message);

/** Writes one JSON body; headers set earlier on `res` (security headers) are kept. */
export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * Status and body of a thrown value: {@link HttpError} keeps its status and code; `conflict(error)` true gives 409;
 * everything else is 400 `INVALID_INPUT` (a ZodError is `VALIDATION`). Only the message is returned.
 */
export function errorReply(
  error: unknown,
  conflict: (error: unknown) => boolean = () => false,
): { status: number; body: { ok: false; error: string; message: string } & Record<string, unknown> } {
  const message = error instanceof Error ? error.message : "Request failed";
  if (error instanceof HttpError)
    return { status: error.status, body: { ...error.extra, ok: false, error: error.code, message } };
  if (conflict(error)) return { status: 409, body: { ok: false, error: "CONFLICT", message } };
  const code = error instanceof Error && error.name === "ZodError" ? "VALIDATION" : "INVALID_INPUT";
  return { status: 400, body: { ok: false, error: code, message } };
}
