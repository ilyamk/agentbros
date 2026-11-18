/**
 * Server-sent events (RFC 0004 D6, §9.1 `/api/stream?project=`): `view.changed {revision}` and `event {…}` messages,
 * each with `id: <revision>`, and a comment heartbeat. The first message after connecting is the current
 * `view.changed`, so a client that reconnects (or sees a revision that is not the next one) simply refetches the view.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleStreamMessage } from "../../types/console";
import { HttpError } from "../local-server/errors";
import type { ConsoleChange, ConsoleDataSource } from "./data";

export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 2_000;
/** A client whose unsent output exceeds this is dropped (it reconnects and refetches). */
export const SSE_MAX_BUFFERED = 1024 * 1024;
/** Open streams per project (the all-projects stream counts as one more key): past it, 429 `RATE_LIMIT`. */
export const SSE_MAX_CLIENTS_PER_PROJECT = 16;

/** One SSE frame: `event:`, `id:` and a single `data:` line of JSON. */
export function sseFrame(change: ConsoleChange): string {
  const message: ConsoleStreamMessage =
    change.type === "view.changed"
      ? { type: "view.changed", ...(change.project ? { project: change.project } : {}), revision: change.revision }
      : { type: "event", event: change.event };
  return `event: ${change.type}\nid: ${change.revision}\ndata: ${JSON.stringify(message)}\n\n`;
}

export class SseHub {
  private readonly clients = new Set<{ res: ServerResponse; key: string; stop: () => void }>();

  constructor(
    private readonly source: ConsoleDataSource,
    private readonly options: { heartbeatMs?: number; maxBuffered?: number; maxPerProject?: number } = {},
  ) {}

  get size() {
    return this.clients.size;
  }

  /** Takes over `res` for the life of the connection. */
  open(req: IncomingMessage, res: ServerResponse, project: string | undefined): void {
    const key = project ?? "";
    let open = 0;
    for (const client of this.clients) if (client.key === key) open++;
    if (open >= (this.options.maxPerProject ?? SSE_MAX_CLIENTS_PER_PROJECT))
      throw new HttpError(429, "RATE_LIMIT", "Too many open console streams for this project", {
        retryAfterMs: 5000,
      });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const cap = this.options.maxBuffered ?? SSE_MAX_BUFFERED;
    // A slow or stalled reader must not grow the server's memory: past the cap the connection is dropped.
    const send = (frame: string) => {
      if (res.writableEnded || res.destroyed) return;
      if (res.writableLength > cap) {
        res.destroy();
        return;
      }
      res.write(frame);
    };
    send(`retry: ${SSE_RETRY_MS}\n\n`);
    send(sseFrame({ type: "view.changed", project, revision: this.source.revision(project) }));
    const unsubscribe = this.source.watch(project, (change) => send(sseFrame(change)));
    const heartbeat = setInterval(() => send(": heartbeat\n\n"), this.options.heartbeatMs ?? SSE_HEARTBEAT_MS);
    heartbeat.unref();
    const client = {
      res,
      key,
      stop: () => {
        clearInterval(heartbeat);
        unsubscribe();
      },
    };
    this.clients.add(client);
    const drop = () => {
      client.stop();
      this.clients.delete(client);
    };
    res.on("close", drop);
    if (res.destroyed) drop();
  }

  /** Ends a removed project's streams, or every stream on server shutdown. */
  close(project?: string): void {
    for (const client of [...this.clients]) {
      if (project !== undefined && client.key !== project) continue;
      client.stop();
      client.res.end();
      this.clients.delete(client);
    }
  }
}
