/**
 * JSON request bodies: `Content-Type` must be exactly `application/json` (a charset suffix is refused), the body is
 * capped (64 KiB by default) and parsed; {@link parseJsonBody} then applies a strict zod schema.
 */
import type { IncomingMessage } from "node:http";
import type { z } from "zod";
import { HttpError } from "./errors";

export const JSON_BODY_LIMIT = 64 * 1024;

/** Reads and parses the body. Throws a plain Error (mapped to 400) with the historical review-ui messages. */
export async function readJsonBody(req: IncomingMessage, limit = JSON_BODY_LIMIT): Promise<unknown> {
  if (req.headers["content-type"] !== "application/json") throw new Error("JSON content type required");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > limit) throw new Error(`Request body exceeds ${Math.round(limit / 1024)} KiB`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Reads the body and parses it with `schema`; every failure is a 400 with a short message. */
export async function parseJsonBody<S extends z.ZodType>(
  req: IncomingMessage,
  schema: S,
  limit = JSON_BODY_LIMIT,
): Promise<z.infer<S>> {
  let value: unknown;
  try {
    value = await readJsonBody(req, limit);
  } catch (error) {
    throw new HttpError(400, "INVALID_INPUT", error instanceof Error ? error.message : "Invalid JSON body");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      "VALIDATION",
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}
