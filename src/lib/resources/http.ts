import { CliErrorObject } from "../cli";

export class ResourceHttpError extends CliErrorObject {
  constructor(
    readonly status: number,
    retryAfter: string | null,
    readonly headers?: Headers,
  ) {
    const seconds =
      retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : retryAfter
          ? Date.parse(retryAfter) - Date.now()
          : undefined;
    super({
      code: status === 429 ? "RATE_LIMIT" : status >= 500 ? "NETWORK" : "VALIDATION",
      message: `Resource request failed (${status}).`,
      ...(Number.isFinite(seconds) ? { retryAfterMs: Math.max(0, Math.ceil(seconds!)) } : {}),
      details: { httpStatus: status },
    });
  }
}

/** A finite request/body allocation, including transports that ignore AbortSignal. */
export function validateResourceReadBounds(maxBytes: number, timeoutMs: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024)
    throw Error("Invalid resource response byte bound.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw Error("Invalid resource response deadline.");
}

export async function readResourceResponse(
  request: typeof fetch,
  url: string,
  options: { maxBytes: number; timeoutMs: number; headers?: Record<string, string> },
): Promise<Buffer> {
  return (await readResourceResponseWithHeaders(request, url, options)).body;
}

/** The same bounded read, also returning response headers (rate-limit accounting). */
export async function readResourceResponseWithHeaders(
  request: typeof fetch,
  url: string,
  options: { maxBytes: number; timeoutMs: number; headers?: Record<string, string> },
): Promise<{ body: Buffer; headers: Headers }> {
  validateResourceReadBounds(options.maxBytes, options.timeoutMs);
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error("Resource URL must use HTTP(S) without embedded credentials.");
  const controller = new AbortController(),
    end = Date.now() + options.timeoutMs;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  let rejectDeadline!: (reason: Error) => void;
  const expired = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(Error("Resource request deadline exceeded."));
  }, options.timeoutMs);
  const wait = <T>(operation: Promise<T>) => Promise.race([operation, expired]);
  const cancel = (
    body: Pick<ReadableStream<Uint8Array>, "cancel"> | Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel">,
  ) => {
    // A broken transport's cancellation promise must not extend the allocation.
    try {
      void body.cancel().catch(() => {});
    } catch {
      /* Preserve the first failure. */
    }
  };
  try {
    const response = await wait(
      request(parsed.toString(), {
        method: "GET",
        headers: options.headers,
        redirect: "error",
        signal: controller.signal,
      }).then((response) => {
        if (controller.signal.aborted) {
          if (response.body) cancel(response.body);
          throw Error("Resource request deadline exceeded.");
        }
        return response;
      }),
    );
    if (!response.ok || response.redirected || !response.body) {
      if (response.body) cancel(response.body);
      throw new ResourceHttpError(response.status, response.headers.get("retry-after"), response.headers);
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > options.maxBytes)
    ) {
      cancel(response.body);
      throw Error("Resource exceeds response size limit.");
    }
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0,
      reads = 0;
    while (true) {
      if (Date.now() >= end) throw Error("Resource request deadline exceeded.");
      if (++reads > 131_072) throw Error("Resource response chunk count exceeds limit.");
      const next = await wait(reader.read());
      if (Date.now() >= end) throw Error("Resource request deadline exceeded.");
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw Error("Invalid resource response chunk.");
      total += next.value.byteLength;
      if (total > options.maxBytes) throw Error("Resource exceeds response size limit.");
      if (next.value.byteLength) chunks.push(Buffer.from(next.value));
    }
    completed = true;
    return { body: Buffer.concat(chunks, total), headers: response.headers };
  } finally {
    clearTimeout(timer);
    if (!completed) controller.abort();
    if (reader) {
      if (!completed) cancel(reader);
      try {
        reader.releaseLock();
      } catch {
        /* Pending noncooperative read; cancellation was requested. */
      }
    }
  }
}

export function resourceJson(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
