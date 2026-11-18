import { CliErrorObject } from "../../cli";
export interface StreamLimits {
  totalBytes: number;
  eventBytes: number;
  events: number;
  timeoutMs: number;
  idleMs: number;
}
export const DEFAULT_STREAM_LIMITS: StreamLimits = {
  totalBytes: 64 * 1024 * 1024,
  eventBytes: 16 * 1024 * 1024,
  events: 1000,
  timeoutMs: 180000,
  idleMs: 30000,
};
export interface FalHttpStreamTransport {
  connect(endpoint: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}
export function createFalHttpStreamTransport(options: {
  credentials: string;
  fetch?: typeof fetch;
}): FalHttpStreamTransport {
  return {
    connect(endpoint, input, signal) {
      if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+\/stream$/.test(endpoint) || endpoint.includes(".."))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid exact stream endpoint." });
      return (options.fetch ?? fetch)(`https://fal.run/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${options.credentials}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal,
        redirect: "error",
      });
    },
  };
}
export function streamLimits(patch: Partial<StreamLimits> = {}): StreamLimits {
  const limits = { ...DEFAULT_STREAM_LIMITS, ...patch };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Invalid stream limit: ${key}` });
  if (
    limits.totalBytes > 128 * 1024 * 1024 ||
    limits.eventBytes > 32 * 1024 * 1024 ||
    limits.events > 10000 ||
    limits.timeoutMs > 1800000 ||
    limits.idleMs > 1800000
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stream limits exceed hard ceilings." });
  return limits;
}
export interface StreamReadResult {
  bytes: number;
  events: number;
  contentType: string;
  lastEvent?: Record<string, unknown>;
  binary: boolean;
}
/** SDK SSE contract: JSON data events, last event becomes result only after clean EOF. No reconnect/retry. */
export async function consumeFalHttpStream(
  response: Response,
  options: {
    limits: StreamLimits;
    controller: AbortController;
    signal: AbortSignal;
    onChunk: (chunk: Uint8Array) => Promise<void> | void;
    onEvent: (event: Record<string, unknown>, count: number) => Promise<void> | void;
  },
): Promise<StreamReadResult> {
  if (!response.ok)
    throw new CliErrorObject({
      code: "NETWORK",
      message: `Stream HTTP ${response.status}; charge outcome requires reconciliation.`,
    });
  if (!response.body) throw new CliErrorObject({ code: "VALIDATION", message: "Stream response body missing." });
  if (options.signal.aborted) {
    await response.body.cancel().catch(() => {});
    throw options.signal.reason ?? new Error("Stream cancelled");
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const sse = contentType === "text/event-stream";
  if (!sse && !["image/png", "image/jpeg", "image/webp"].includes(contentType))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Stream must be SSE JSON or supported binary image MIME.",
    });
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > options.limits.totalBytes))
    throw new CliErrorObject({ code: "VALIDATION", message: "Stream declared body exceeds limit." });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    events = 0,
    line = "",
    lineBytes = 0,
    data: string[] = [],
    dataBytes = 0,
    lastEvent: Record<string, unknown> | undefined,
    previousCR = false;
  async function finishLine() {
    const current = line;
    line = "";
    lineBytes = 0;
    if (current === "") {
      if (!data.length) return;
      const raw = data.join("\n");
      data = [];
      dataBytes = 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid JSON in SSE event." });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new CliErrorObject({ code: "VALIDATION", message: "SSE event must be a JSON object." });
      if (++events > options.limits.events)
        throw new CliErrorObject({ code: "VALIDATION", message: "Too many stream events." });
      lastEvent = parsed as Record<string, unknown>;
      if (lastEvent.error !== undefined || lastEvent.type === "error")
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Provider returned a stream error event; no refund assumed.",
        });
      await options.onEvent(lastEvent, events);
      return;
    }
    if (current.startsWith(":")) return;
    const colon = current.indexOf(":");
    const field = colon === -1 ? current : current.slice(0, colon);
    let value = colon === -1 ? "" : current.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataBytes += Buffer.byteLength(value) + 1;
      if (dataBytes > options.limits.eventBytes)
        throw new CliErrorObject({ code: "VALIDATION", message: "SSE event exceeds limit." });
      data.push(value);
    }
    // SSE id/event/retry metadata is deliberately not interpreted as replay authority.
  }
  async function feed(text: string) {
    for (const char of text) {
      if (char === "\n" && previousCR) {
        previousCR = false;
        continue;
      }
      previousCR = false;
      if (char === "\r" || char === "\n") {
        await finishLine();
        previousCR = char === "\r";
      } else {
        line += char;
        lineBytes += Buffer.byteLength(char);
        if (lineBytes > options.limits.eventBytes)
          throw new CliErrorObject({ code: "VALIDATION", message: "SSE line exceeds limit." });
      }
    }
  }
  const cancel = () => {
    void reader.cancel(options.signal.reason).catch(() => {});
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const timer = setTimeout(() => options.controller.abort(new Error("Stream idle timeout")), options.limits.idleMs);
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } finally {
        clearTimeout(timer);
      }
      if (options.signal.aborted) throw options.signal.reason ?? new Error("Stream cancelled");
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > options.limits.totalBytes)
        throw new CliErrorObject({ code: "VALIDATION", message: "Stream body exceeds limit." });
      await options.onChunk(next.value);
      if (sse) await feed(decoder.decode(next.value, { stream: true }));
    }
    if (sse) {
      await feed(decoder.decode());
      if (line || data.length)
        throw new CliErrorObject({ code: "VALIDATION", message: "SSE ended with an incomplete event." });
      if (!lastEvent) throw new CliErrorObject({ code: "VALIDATION", message: "SSE produced no result events." });
    }
    if (!bytes) throw new CliErrorObject({ code: "VALIDATION", message: "Empty stream response." });
    return { bytes, events, contentType, lastEvent, binary: !sse };
  } catch (error) {
    options.controller.abort(error);
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    options.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
