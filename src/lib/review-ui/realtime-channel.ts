import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { LocalEditorChannel, type LocalEditorTransport } from "../realtime/channel";
import { LocalChannelIdSchema, DEFAULT_LOCAL_EDITOR_LIMITS } from "../realtime/channel-types";
import { RealtimeEditorStore } from "../realtime/editor";
import { inspectLocalEditorHistory } from "../realtime/channel-journal";
export const LOCAL_REVIEW_PROTOCOL = "avc-local-editor-v1";
export const LOCAL_REVIEW_CHANNEL_PATH = "/api/realtime/channel";
/** Decline the single bounded browser offer; no extension is negotiated or enabled. */
function declinedExtensionOffer(req: IncomingMessage) {
  const value = req.headers["sec-websocket-extensions"];
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === "sec-websocket-extensions") count++;
  return value === undefined
    ? count === 0
    : count === 1 &&
        typeof value === "string" &&
        value.length <= 64 &&
        value === "permessage-deflate; client_max_window_bits";
}
const ticketInput = z.object({ editorId: LocalChannelIdSchema, localSessionId: LocalChannelIdSchema }).strict();
/** Browser cannot supply x-review-token on upgrades: a five-second, one-use local capability bridges existing POST auth. */
export class RealtimeReviewChannels {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16384,
    perMessageDeflate: false,
    handleProtocols: () => LOCAL_REVIEW_PROTOCOL,
  });
  private readonly tickets = new Map<
    string,
    {
      input: z.infer<typeof ticketInput>;
      expires: number;
      inspection: ReturnType<typeof inspectLocalEditorHistory>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly owned = new Map<WebSocket, { channel: LocalEditorChannel; editorId: string }>();
  private readonly cleanupErrors: string[] = [];
  private issued = 0;
  private dead = false;
  private closePromise?: Promise<void>;
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    this.admit(request, socket, head);
  constructor(
    private readonly server: Server,
    private readonly root: string,
    private readonly projectId: string,
    private readonly origin: () => string,
  ) {
    server.on("upgrade", this.upgrade);
  }
  inspect(editorId: string) {
    LocalChannelIdSchema.parse(editorId);
    const value = inspectLocalEditorHistory(new RealtimeEditorStore(this.root, this.projectId, editorId));
    return {
      sequence: value.sequence,
      stateSha256: value.stateSha256,
      unresolved: value.unresolved,
      unresolvedCount: value.unresolvedCount,
      leasePresent: value.leasePresent,
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    };
  }
  issue(raw: unknown) {
    if (this.dead) throw Error("Local channel server is closing");
    const input = ticketInput.parse(raw);
    if (
      this.issued >= 64 ||
      this.tickets.size >= 8 ||
      this.owned.size >= 4 ||
      [...this.owned.values()].some((v) => v.editorId === input.editorId)
    )
      throw Error("Local channel process/editor capacity reached");
    const inspection = inspectLocalEditorHistory(new RealtimeEditorStore(this.root, this.projectId, input.editorId));
    if (!inspection.mayAcquire()) throw Error("Local editor channel lease is owned; close/inspect without replay");
    const ticket = randomBytes(32).toString("hex"),
      expires = Date.now() + 5000,
      timer = setTimeout(() => this.tickets.delete(ticket), 5000);
    this.issued++;
    this.tickets.set(ticket, { input, expires, inspection, timer });
    return {
      version: 1,
      ticket,
      expiresAt: expires,
      path: LOCAL_REVIEW_CHANNEL_PATH,
      protocol: LOCAL_REVIEW_PROTOCOL,
      ...input,
      sequence: inspection.sequence,
      stateSha256: inspection.stateSha256,
      unresolved: inspection.unresolved,
      unresolvedCount: inspection.unresolvedCount,
      limits: DEFAULT_LOCAL_EDITOR_LIMITS,
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    };
  }
  private admit(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const deny = () => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    };
    try {
      const origin = this.origin(),
        protocols = String(req.headers["sec-websocket-protocol"] || "")
          .split(",")
          .map((x) => x.trim());
      const key = String(req.headers["sec-websocket-key"] || "");
      if (
        this.dead ||
        req.method !== "GET" ||
        req.url !== LOCAL_REVIEW_CHANNEL_PATH ||
        req.headers.host !== new URL(origin).host ||
        req.headers.origin !== origin ||
        req.socket.remoteAddress !== "127.0.0.1" ||
        String(req.headers.upgrade).toLowerCase() !== "websocket" ||
        !String(req.headers.connection)
          .toLowerCase()
          .split(",")
          .map((v) => v.trim())
          .includes("upgrade") ||
        req.headers["sec-websocket-version"] !== "13" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
        Buffer.from(key, "base64").length !== 16 ||
        Buffer.from(key, "base64").toString("base64") !== key ||
        !declinedExtensionOffer(req) ||
        protocols.length !== 2 ||
        protocols[0] !== LOCAL_REVIEW_PROTOCOL ||
        !/^t\.[a-f0-9]{64}$/.test(protocols[1])
      )
        return deny();
      const token = protocols[1].slice(2),
        ticket = this.tickets.get(token);
      if (
        !ticket ||
        ticket.expires <= Date.now() ||
        this.owned.size >= 4 ||
        [...this.owned.values()].some((v) => v.editorId === ticket.input.editorId)
      )
        return deny();
      ticket.inspection.recheck();
      if (!ticket.inspection.mayAcquire()) return deny();
      clearTimeout(ticket.timer);
      this.tickets.delete(token);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        let channel: LocalEditorChannel | undefined;
        try {
          ticket.inspection.recheck();
          if (!ticket.inspection.mayAcquire()) throw Error("Local lease liveness changed");
          channel = new LocalEditorChannel(
            this.root,
            this.projectId,
            ticket.input.editorId,
            ticket.input.localSessionId,
          );
          this.owned.set(ws, { channel, editorId: ticket.input.editorId });
          ws.on("error", () => {
            channel!.close("Local socket error");
          });
          ws.once("close", () => {
            channel!.close("Local socket closed");
            if (channel!.diagnostics().reason?.includes("release refused") && this.cleanupErrors.length < 64)
              this.cleanupErrors.push("Owned local lease cleanup refused");
            this.owned.delete(ws);
          });
          channel.attach(socketTransport(ws));
        } catch {
          channel?.close("Local channel admission failed");
          ws.terminate();
          this.owned.delete(ws);
        }
      });
    } catch {
      deny();
    }
  }
  diagnostics() {
    return { sockets: this.owned.size, tickets: this.tickets.size, issued: this.issued, closed: this.dead };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.dead = true;
    this.server.off("upgrade", this.upgrade);
    for (const t of this.tickets.values()) clearTimeout(t.timer);
    this.tickets.clear();
    this.closePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const ws of this.owned.keys()) ws.terminate();
      }, 250);
      for (const [ws, value] of this.owned) {
        value.channel.close("Review server closing");
        ws.close(1001, "Local review closing");
      }
      this.wss.close((error) => {
        clearTimeout(timer);
        this.owned.clear();
        error ? reject(error) : this.cleanupErrors.length ? reject(Error(this.cleanupErrors.join("; "))) : resolve();
      });
    });
    return this.closePromise;
  }
}
/** Transport preserves exact text bytes and never queues concurrent commands. */
export function socketTransport(socket: WebSocket): LocalEditorTransport {
  return {
    onMessage(listener) {
      const message = (raw: RawData, binary: boolean) => {
        if (binary) {
          socket.terminate();
          return;
        }
        const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
        try {
          new TextDecoder("utf8", { fatal: true }).decode(bytes);
        } catch {
          socket.terminate();
          return;
        }
        listener(bytes);
      };
      socket.on("message", message);
      return () => socket.off("message", message);
    },
    onClose(listener) {
      socket.on("close", listener);
      return () => socket.off("close", listener);
    },
    send(bytes, signal) {
      return new Promise<void>((resolve, reject) => {
        if (
          signal.aborted ||
          socket.readyState !== WebSocket.OPEN ||
          socket.bufferedAmount + bytes.byteLength > 65536
        ) {
          reject(Error("Local socket closed/backpressure"));
          return;
        }
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const abort = () => finish(Error("Local send aborted"));
        const timer = setTimeout(() => finish(Error("Local socket settlement deadline")), 2000);
        signal.addEventListener("abort", abort, { once: true });
        try {
          socket.send(bytes, { binary: false, compress: false }, (error) => finish(error));
        } catch (error) {
          finish(error instanceof Error ? error : Error(String(error)));
        }
        if (signal.aborted) abort();
      });
    },
    close() {
      socket.terminate();
    },
  };
}
