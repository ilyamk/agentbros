import { splitHiggsfieldKey } from "./credentials";
import { CliErrorObject, type ErrorCode } from "../../cli";
import { generationRequestBody, canonicalRequestBody } from "../../jobs/request-body";
import { publicUrl } from "../../media-fetch/http";
import { isMediaUrlKey } from "./media-fields";

export function assertHiggsfieldPublicInput(value: unknown, key = ""): void {
  if (typeof value === "string" && /\bdata:/i.test(value))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Higgsfield requires public media URLs; prepare and upload data URIs before estimating or submitting.",
    });
  if (typeof value === "string" && isMediaUrlKey(key)) {
    try {
      const url = publicUrl(value);
      if (url.hash) throw Error("fragment");
    } catch {
      throw new CliErrorObject({
        code: "VALIDATION",
        message:
          "Higgsfield media fields require public HTTP(S) file URLs without credentials or fragments; resolve page links with hf:media.",
      });
    }
  }
  if (Array.isArray(value)) value.forEach((item) => assertHiggsfieldPublicInput(item, key));
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([name, field]) => {
      assertHiggsfieldPublicInput(name);
      assertHiggsfieldPublicInput(field, name);
    });
}

const BASE = "https://api.higgsfield.ai";
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,200}$/;
export function parseHiggsfieldKey(value: string | undefined): { id: string; secret: string } {
  const credentials = splitHiggsfieldKey(value);
  if (!credentials)
    throw new CliErrorObject({
      code: "MISSING_API_KEY",
      message: "Set HIGGSFIELD_API_KEY to <id>:<secret> from https://open.higgsfield.ai/api-keys.",
    });
  return credentials;
}
export function redactHiggsfieldCredentials(value: unknown, credentials: string): unknown {
  const key = parseHiggsfieldKey(credentials);
  if (typeof value === "string")
    return [credentials, key.secret, key.id].reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  if (Array.isArray(value)) return value.map((field) => redactHiggsfieldCredentials(field, credentials));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [name, redactHiggsfieldCredentials(field, credentials)]),
    );
  return value;
}
export function validHiggsfieldRequestUrl(
  value: unknown,
  requestId: string,
  kind: "status" | "cancel",
): string | undefined {
  if (typeof value !== "string" || !REQUEST_ID.test(requestId)) return undefined;
  try {
    const url = new URL(value);
    return url.origin === BASE &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/requests/${requestId}/${kind}`
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function endpointPath(endpoint: string): string {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(endpoint) ||
    endpoint.split("/").some((part) => part === "." || part === "..")
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Higgsfield endpoint ID." });
  return endpoint;
}
function requestPath(value: string, kind: "status" | "cancel"): string {
  if (REQUEST_ID.test(value)) return `${BASE}/requests/${value}/${kind}`;
  const id = /^https:\/\/api\.higgsfield\.ai\/requests\/([a-zA-Z0-9_-]+)\/(status|cancel)$/.exec(value)?.[1];
  const valid = id && validHiggsfieldRequestUrl(value, id, kind);
  if (!valid)
    throw new CliErrorObject({ code: "VALIDATION", message: `Invalid Higgsfield ${kind} URL or request ID.` });
  return valid;
}
export interface HiggsfieldUpload {
  public_url: string;
  upload_url: string;
  upload_headers: Record<string, string>;
}
export type HiggsfieldUsageParams = {
  start?: string;
  end?: string;
  timeframe?: string;
  model?: string;
  expand?: string | boolean;
};
export function createHiggsfieldClient(options: { credentials: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const key = parseHiggsfieldKey(options.credentials),
    request = options.fetch ?? fetch;
  const redact = (value: unknown): unknown => redactHiggsfieldCredentials(value, options.credentials);
  async function send(
    url: string,
    method = "GET",
    body?: string,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await request(url, {
        method,
        headers: { Authorization: `Key ${key.id}:${key.secret}`, "Content-Type": "application/json", ...headers },
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
    } catch (error) {
      throw new CliErrorObject({
        code: error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "NETWORK",
        message: "Higgsfield request interrupted; resume the same operation and idempotency key.",
      });
    }
    let data: unknown;
    try {
      data = response.status === 204 ? {} : await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const detail = redact(data && typeof data === "object" && "detail" in data ? data.detail : undefined);
      const retry = response.headers.get("Retry-After");
      const retryAfterMs =
        retry === null
          ? undefined
          : /^\d+(?:\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now());
      const status = response.status;
      const code: ErrorCode =
        status === 401
          ? "MISSING_API_KEY"
          : status === 403
            ? "INSUFFICIENT_BALANCE"
            : [400, 422].includes(status)
              ? "VALIDATION"
              : status === 404
                ? "INVALID_INPUT"
                : [423, 429, 503].includes(status)
                  ? "RATE_LIMIT"
                  : status === 409
                    ? "INVALID_INPUT"
                    : "NETWORK";
      const message =
        status === 422 && /idempotency[-_ ]?key/i.test(JSON.stringify(detail) ?? "")
          ? "Higgsfield Idempotency-Key body mismatch; a new key must NOT be generated automatically."
          : status === 404
            ? "Higgsfield model is not available for this account."
            : [423, 503].includes(status)
              ? "Higgsfield model temporarily unavailable."
              : status === 401
                ? "Higgsfield credentials rejected; check https://open.higgsfield.ai/api-keys."
                : `Higgsfield returned HTTP ${status}.`;
      throw new CliErrorObject({
        code,
        message,
        details: { httpStatus: status, ...(detail !== undefined ? { detail } : {}) },
        ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      });
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new CliErrorObject({ code: "VALIDATION", message: "Higgsfield response must be an object." });
    const result = data as Record<string, unknown>;
    if (result.error !== undefined) result.error = redact(result.error);
    return result;
  }
  return {
    submit(
      endpoint: string,
      input: Record<string, unknown>,
      context: { idempotencyKey: string; expiresAfterSec?: number; body?: string },
    ) {
      assertHiggsfieldPublicInput(input);
      if (!context.idempotencyKey || /[\r\n]/.test(context.idempotencyKey))
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "A stable Higgsfield idempotency key is required.",
        });
      if (
        context.expiresAfterSec !== undefined &&
        (!Number.isSafeInteger(context.expiresAfterSec) || context.expiresAfterSec <= 0)
      )
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "expiresAfterSec must be a positive integer." });
      const body = context.body ?? generationRequestBody(input);
      if (canonicalRequestBody(JSON.parse(body)) !== canonicalRequestBody(input))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Frozen Higgsfield request differs from submit input.",
        });
      return send(`${BASE}/${endpointPath(endpoint)}`, "POST", body, {
        "Idempotency-Key": context.idempotencyKey,
        ...(context.expiresAfterSec ? { "X-Expires-After": String(context.expiresAfterSec) } : {}),
      });
    },
    status(value: string) {
      return send(requestPath(value, "status"));
    },
    cancel(value: string) {
      return send(requestPath(value, "cancel"), "POST");
    },
    deleteRequest(requestId: string) {
      if (!REQUEST_ID.test(requestId))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Higgsfield request ID." });
      return send(`${BASE}/requests/${requestId}`, "DELETE");
    },
    estimate(endpoint: string, input: Record<string, unknown>) {
      assertHiggsfieldPublicInput(input);
      return send(`${BASE}/estimate/${endpointPath(endpoint)}`, "POST", generationRequestBody(input));
    },
    usage(params: HiggsfieldUsageParams = {}) {
      const query = new URLSearchParams(
        Object.entries(params)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, String(value)]),
      );
      return send(`${BASE}/models/usage${query.size ? `?${query}` : ""}`);
    },
    // https://docs.higgsfield.ai/docs/models/soul-id/create-character.md does not document Idempotency-Key support.
    createCustomReference(input: Record<string, unknown>) {
      assertHiggsfieldPublicInput(input);
      return send(`${BASE}/v1/custom-references`, "POST", generationRequestBody(input));
    },
    customReference(id: string) {
      if (!REQUEST_ID.test(id))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Higgsfield custom reference ID." });
      return send(`${BASE}/v1/custom-references/${id}`);
    },
    restylePresets() {
      return send(`${BASE}/models/higgsfield/genjutsu/restyle/v1.0/presets`);
    },
    async createUpload(contentType: string): Promise<HiggsfieldUpload> {
      const data = await send(
        `${BASE}/files/generate-upload-url`,
        "POST",
        JSON.stringify({ content_type: contentType }),
      );
      if (
        typeof data.public_url !== "string" ||
        typeof data.upload_url !== "string" ||
        !data.upload_headers ||
        typeof data.upload_headers !== "object" ||
        Array.isArray(data.upload_headers) ||
        Object.values(data.upload_headers).some((value) => typeof value !== "string")
      )
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid Higgsfield upload response." });
      return {
        public_url: data.public_url,
        upload_url: data.upload_url,
        upload_headers: data.upload_headers as Record<string, string>,
      };
    },
    async putUpload(uploadUrl: string, headers: Record<string, string>, bytes: Uint8Array): Promise<void> {
      let url: URL;
      try {
        url = new URL(uploadUrl);
      } catch {
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid presigned upload URL." });
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        Object.keys(headers).some((name) => /^(authorization|cookie|proxy-authorization)$/i.test(name)) ||
        Object.values(headers).some((value) => value.includes(options.credentials) || value.includes(key.secret))
      )
        throw new CliErrorObject({ code: "VALIDATION", message: "Unsafe presigned upload URL or headers." });
      let response: Response;
      try {
        response = await request(url.href, {
          method: "PUT",
          headers,
          body: bytes as BodyInit,
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
        });
      } catch {
        throw new CliErrorObject({ code: "NETWORK", message: "Higgsfield upload interrupted." });
      }
      if (!response.ok)
        throw new CliErrorObject({ code: "NETWORK", message: `Higgsfield upload returned HTTP ${response.status}.` });
    },
  };
}
export type HiggsfieldClient = ReturnType<typeof createHiggsfieldClient>;
