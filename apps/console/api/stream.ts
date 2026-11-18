/**
 * The console's event stream over `fetch` (RFC 0004 D6, D15): `EventSource` cannot send headers, and the stream needs
 * the `x-console-token` header (the cookie reads media only). Parses `text/event-stream` frames (`event:`, `data:`,
 * `retry:`, comments), reconnects after the server's `retry:` delay when the connection ends or fails, and stops for
 * good on a 4xx reply (401/403: no session; 429: too many streams is retried). No `Last-Event-ID`: the first frame
 * after connecting is always the current `view.changed`, so a reconnect refetches.
 */

export interface StreamOptions {
  url: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  /** One dispatched frame: its `event:` name (default `message`) and joined `data:` lines. */
  onMessage(event: string, data: string): void;
  onOpen?(): void;
  /** A status is supplied only when the rejection stops reconnection. */
  onError?(terminalStatus?: number): void;
  /** Default reconnect delay until the server sends `retry:` (ms). */
  retryMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_RETRY_MS = 2000;

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/** Incremental `text/event-stream` parser: feed text chunks, get frames. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  constructor(
    private readonly dispatch: (event: string, data: string) => void,
    private readonly onRetry: (ms: number) => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      // A lone trailing \r may be the first half of \r\n: wait for the next chunk.
      if (!match || (match[0] === "\r" && match.index === this.buffer.length - 1)) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.dispatch(this.event || "message", this.data.join("\n"));
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) this.onRetry(Number(value));
  }
}

/** Opens the stream and keeps it open until the returned function is called. */
export function openEventStream(options: StreamOptions): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  const sleep = options.sleep ?? abortableSleep;
  let retryMs = options.retryMs ?? DEFAULT_RETRY_MS;

  const connect = async (): Promise<number | undefined> => {
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: "GET",
        headers: { accept: "text/event-stream", ...options.headers },
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
    } catch {
      return;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return response.status;
      return;
    }
    if (signal.aborted) {
      void response.body.cancel().catch(() => {});
      return;
    }
    options.onOpen?.();
    const parser = new SseParser(options.onMessage, (ms) => (retryMs = ms));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // aborted or dropped: reconnect below
    }
  };

  void (async () => {
    while (!signal.aborted) {
      const terminalStatus = await connect();
      if (signal.aborted) return;
      options.onError?.(terminalStatus);
      if (terminalStatus !== undefined) return;
      await sleep(retryMs, signal);
    }
  })();
  return () => controller.abort();
}
