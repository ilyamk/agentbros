import type { JobProvider } from "./runner";
import { QueueRouteSchema, type ProviderUrls } from "./types";
import { CliErrorObject } from "../cli";
/** Injectable queue contract; tests use this without keys/network. */
export interface FalQueueTransport {
  submit(
    endpoint: string,
    options: { input: Record<string, unknown> },
  ): Promise<{ request_id: string; status_url?: string; response_url?: string }>;
  /** `statusUrl`/`responseUrl` come from the submit; `route` is the OpenAPI submit path used when they are absent. */
  status(
    endpoint: string,
    options: { requestId: string; statusUrl?: string; route?: string },
  ): Promise<{ status: string; error?: string }>;
  result(
    endpoint: string,
    options: { requestId: string; responseUrl?: string; route?: string },
  ): Promise<{ data: Record<string, unknown> }>;
}
const QUEUE_HOST = "queue.fal.run";
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const endpointRoot = (endpoint: string) => {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(endpoint) ||
    endpoint.split("/").some((part) => part === "." || part === "..")
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid fal endpoint ID." });
  return endpoint.split("/").slice(0, 2).join("/");
};
/**
 * A queue URL the submit returned: https on queue.fal.run only, no credentials, query or fragment,
 * and a path that ends in `/requests/<requestId>` (response) or `/requests/<requestId>/status`.
 * The app route before `/requests/` is the internal one and may differ from the endpoint ID.
 */
export function validQueueUrl(value: unknown, requestId: string, kind: "status" | "response"): string | undefined {
  if (typeof value !== "string" || !REQUEST_ID.test(requestId)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== QUEUE_HOST ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  const parts = url.pathname.split("/").slice(1);
  if (parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..")) return undefined;
  const tail = kind === "status" ? ["requests", requestId, "status"] : ["requests", requestId];
  if (parts.length < tail.length + 1 || parts.slice(-tail.length).join("/") !== tail.join("/")) return undefined;
  return url.href;
}
/** An OpenAPI submit path (leading slash removed) usable as the queue route, or undefined. */
export function validQueueRoute(value: unknown): string | undefined {
  const parsed = QueueRouteSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** Both queue URLs of a submit response, or undefined when either is absent or invalid. */
export function queueUrlsFromSubmit(response: {
  request_id: string;
  status_url?: unknown;
  response_url?: unknown;
}): ProviderUrls | undefined {
  const status = validQueueUrl(response.status_url, response.request_id, "status");
  const result = validQueueUrl(response.response_url, response.request_id, "response");
  return status && result ? { status, response: result } : undefined;
}
/** The SDK's queue.submit hardcodes three retries even if config retry=0.
 * Use one HTTP attempt here: a lost POST response is an ambiguous paid submit. */
export function createFalRestQueue(options: {
  credentials: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): FalQueueTransport {
  const request = options.fetch ?? fetch;
  async function send(url: string, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await request(url, {
      method: input ? "POST" : "GET",
      headers: { Authorization: `Key ${options.credentials}`, "Content-Type": "application/json" },
      ...(input ? { body: JSON.stringify(input) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    });
    if (!response.ok)
      throw new CliErrorObject({
        code: response.status === 429 ? "RATE_LIMIT" : "NETWORK",
        message: `fal queue returned HTTP ${response.status}. Resume the same operation; do not create a replacement submit.`,
      });
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new CliErrorObject({ code: "VALIDATION", message: "fal queue response must be an object." });
    return data as Record<string, unknown>;
  }
  /**
   * Stored queue URL when the job has one (validated again: the store file is local state), else the
   * stored OpenAPI route, else the historical endpoint-root guess (jobs from before either was stored).
   */
  function requestUrl(
    endpoint: string,
    requestId: string,
    kind: "status" | "response",
    stored?: string,
    route?: string,
  ): string {
    const root = endpointRoot(endpoint);
    if (!REQUEST_ID.test(requestId))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid fal request ID." });
    if (stored !== undefined) {
      const url = validQueueUrl(stored, requestId, kind);
      if (!url)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Stored fal ${kind} URL is not a queue.fal.run URL for this request.`,
        });
      return url;
    }
    if (route !== undefined && !validQueueRoute(route))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Stored fal queue route is not a valid OpenAPI submit path.",
      });
    return `https://${QUEUE_HOST}/${route ?? root}/requests/${requestId}${kind === "status" ? "/status" : ""}`;
  }
  return {
    async submit(endpoint, { input }) {
      endpointRoot(endpoint);
      const result = await send(`https://${QUEUE_HOST}/${endpoint}`, input);
      const requestId = typeof result.request_id === "string" ? result.request_id : "";
      const urls = queueUrlsFromSubmit({
        request_id: requestId,
        status_url: result.status_url,
        response_url: result.response_url,
      });
      return { request_id: requestId, ...(urls ? { status_url: urls.status, response_url: urls.response } : {}) };
    },
    async status(endpoint, { requestId, statusUrl, route }) {
      const result = await send(requestUrl(endpoint, requestId, "status", statusUrl, route));
      return {
        status: String(result.status ?? ""),
        ...(typeof result.error === "string" ? { error: result.error } : {}),
      };
    },
    async result(endpoint, { requestId, responseUrl, route }) {
      return { data: await send(requestUrl(endpoint, requestId, "response", responseUrl, route)) };
    },
  };
}
export function createFalJobProvider(queue: FalQueueTransport): JobProvider {
  return {
    async submit(endpoint, input) {
      const result = await queue.submit(endpoint, { input });
      const providerUrls = result.request_id ? queueUrlsFromSubmit(result) : undefined;
      return { requestId: result.request_id, ...(providerUrls ? { providerUrls } : {}) };
    },
    async inspect(endpoint, requestId, context) {
      const urls = context?.providerUrls,
        route = context?.queueRoute;
      const result = await queue.status(endpoint, {
        requestId,
        ...(urls ? { statusUrl: urls.status } : {}),
        ...(route ? { route } : {}),
      });
      if (result.status === "IN_QUEUE") return { state: "queued" };
      if (result.status === "IN_PROGRESS") return { state: "running" };
      if (["FAILED", "CANCELLED"].includes(result.status) || result.error)
        return { state: "failed", message: result.error ?? result.status };
      if (result.status !== "COMPLETED")
        throw new CliErrorObject({ code: "VALIDATION", message: `Unknown fal queue status: ${result.status}` });
      const completed = await queue.result(endpoint, {
        requestId,
        ...(urls ? { responseUrl: urls.response } : {}),
        ...(route ? { route } : {}),
      });
      if (completed.data.error) return { state: "failed", message: String(completed.data.error) };
      return { state: "completed", result: completed.data };
    },
  };
}
