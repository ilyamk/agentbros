/**
 * The review host of the console server (RFC 0004 D2, WP13): one `ReviewService` and one `RealtimeReviewChannels` per
 * project, created on first use and closed with the server. The services are the unchanged review:ui ones.
 *
 * WebSocket: each project's `RealtimeReviewChannels` listens for `upgrade` on its own emitter (never the real server,
 * where every instance would refuse the others' sockets). The console's single `upgrade` listener checks Host, Origin
 * and fetch metadata, rewrites the path to the channel's own `/api/realtime/channel` and emits synchronously; the
 * channel then applies its unchanged admission rules (one-use ticket in the subprotocol, exact Host/Origin, loopback
 * peer, version 13, declined extension offer).
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { PROJECTS_DIR } from "../../../types/console";
import { isCampaignContainer } from "../../cli";
import { HttpError } from "../../local-server/errors";
import { splitRequestTarget } from "../../local-server/paths";
import { headerValue, hostAllowed, originOf } from "../../local-server/security";
import { LOCAL_REVIEW_CHANNEL_PATH, RealtimeReviewChannels } from "../../review-ui/realtime-channel";
import { ReviewService } from "../../review-ui/service";
import { campaignReviewHandler } from "./campaign";
import { requireProject } from "../http/routes";

/** Console path prefix of the review routes: `/api/review/<project>/…`. */
export const REVIEW_SEGMENT = "review";

/** Lifetime ticket budget of one `RealtimeReviewChannels` instance (its own constant). */
const CHANNEL_TICKETS_PER_INSTANCE = 64;
/** Per-project ticket rate that survives an instance swap: at most 64 tickets in any 10 minutes (parity item 14). */
export const CHANNEL_TICKET_RATE = { count: 64, windowMs: 10 * 60_000 } as const;
const SUBPROTOCOL_TICKET = /^t\.([a-f0-9]{64})$/;

export interface ReviewProject {
  project: string;
  service: ReviewService;
  channels: RealtimeReviewChannels;
}

/**
 * Serves a campaign container's review (RU-CP; default `campaignReviewHandler`, campaign.ts). `rest` is the path after
 * `/api/review/<project>/`; return false for an unknown route (404).
 */
export type CampaignReviewHandler = (
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  input: { rootDir: string; project: string; rest: string[]; query: URLSearchParams },
) => Promise<boolean>;

export interface ReviewHostOptions {
  /** Replaces the campaign review handler (tests). */
  campaign?: CampaignReviewHandler;
  log?: (line: string) => void;
  /** Clock for the ticket rate (tests). */
  now?: () => number;
}

interface Entry extends ReviewProject {
  /** Stand-in for the HTTP server: only `on`/`off("upgrade")` are used by the channels. */
  emitter: EventEmitter;
}

export class ReviewHost {
  private readonly entries = new Map<string, Entry>();
  /** The origin of the upgrade being dispatched; set only for the synchronous emit. */
  private dispatchOrigin = "";
  private closing: Promise<void> | undefined;
  /** Issue times per project (kept across instance swaps) for {@link CHANNEL_TICKET_RATE}. */
  private readonly issueTimes = new Map<string, number[]>();
  /** Tickets issued and not yet presented, per project, with their expiry. */
  private readonly outstanding = new Map<string, Map<string, number>>();
  /** Cleanup failures of swapped-out instances, rethrown by {@link close}. */
  private readonly swapErrors: unknown[] = [];

  constructor(
    readonly rootDir: string,
    readonly options: ReviewHostOptions = {},
  ) {}

  get closed(): boolean {
    return this.closing !== undefined;
  }

  /** The campaign containers' review routes (RU-CP). */
  get campaign(): CampaignReviewHandler {
    return this.options.campaign ?? campaignReviewHandler;
  }

  /** True when the project folder is a campaign container (RU-CP), served by {@link campaign}. */
  isCampaign(project: string): boolean {
    return isCampaignContainer(path.join(this.rootDir, PROJECTS_DIR, project));
  }

  /** True when the project's services exist (they are created by a review request, never by an upgrade). */
  loaded(project: string): boolean {
    return this.entries.has(project);
  }

  /** The project's services, created on first use. `project` must already be validated (`requireProject`). */
  get(project: string): ReviewProject {
    if (this.closing) throw new HttpError(503, "UNAVAILABLE", "The console server is closing");
    let entry = this.entries.get(project);
    if (!entry) {
      const service = new ReviewService(project, this.rootDir);
      const emitter = new EventEmitter();
      entry = { project, service, emitter, channels: this.channelsFor(project, emitter) };
      this.entries.set(project, entry);
    }
    return entry;
  }

  private channelsFor(project: string, emitter: EventEmitter): RealtimeReviewChannels {
    return new RealtimeReviewChannels(emitter as unknown as Server, this.rootDir, project, () => this.dispatchOrigin);
  }

  /**
   * Issues a channel ticket. The channels' 64-ticket budget is per instance (review:ui's per process); the console
   * lives for hours, so an exhausted instance with no socket and no outstanding ticket is closed and replaced. The
   * per-project rate ({@link CHANNEL_TICKET_RATE}) bounds issuance across replacements. A replaced instance's cleanup
   * failure is logged and rethrown by {@link close}; it does not fail this request.
   */
  async issueTicket(project: string, body: unknown) {
    const now = (this.options.now ?? Date.now)();
    const times = (this.issueTimes.get(project) ?? []).filter((t) => t > now - CHANNEL_TICKET_RATE.windowMs);
    this.issueTimes.set(project, times);
    if (times.length >= CHANNEL_TICKET_RATE.count)
      throw Error("Local channel ticket rate reached for this project; try again later");
    const entry = this.get(project) as Entry;
    const diagnostics = entry.channels.diagnostics();
    if (diagnostics.issued >= CHANNEL_TICKETS_PER_INSTANCE && diagnostics.sockets === 0 && diagnostics.tickets === 0) {
      const old = entry.channels;
      entry.channels = this.channelsFor(project, entry.emitter);
      try {
        await old.close();
      } catch (error) {
        this.swapErrors.push(error);
        this.options.log?.(
          `review channel swap cleanup (${project}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const ticket = entry.channels.issue(body);
    times.push(now);
    const pending = this.outstanding.get(project) ?? new Map<string, number>();
    for (const [key, expires] of pending) if (expires <= Date.now()) pending.delete(key);
    pending.set(ticket.ticket, ticket.expiresAt);
    this.outstanding.set(project, pending);
    return ticket;
  }

  /**
   * True when the subprotocol carries a live ticket this host issued for `project`. The channel itself consumes the
   * ticket (one use); this only keeps unticketed upgrades away from the project's services.
   */
  private hasTicket(project: string, req: IncomingMessage): boolean {
    const protocols = String(req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((value) => value.trim());
    const match = protocols.length === 2 ? SUBPROTOCOL_TICKET.exec(protocols[1]!) : null;
    const pending = this.outstanding.get(project);
    if (!match || !pending) return false;
    const expires = pending.get(match[1]!);
    if (expires !== undefined && expires <= Date.now()) pending.delete(match[1]!);
    return expires !== undefined && expires > Date.now();
  }

  /** The console server's `upgrade` listener: `/api/review/<project>/realtime/channel` only, everything else 403. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
    const deny = () => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    };
    try {
      if (this.closing || !hostAllowed(req.headers.host, port)) return deny();
      const origin = originOf(req.headers.host!);
      if (req.headers.origin !== origin) return deny();
      const site = headerValue(req, "sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") return deny();
      const { segments, query } = splitRequestTarget(req.url);
      const [api, review, project, realtime, channel, ...rest] = segments;
      if (
        query.size ||
        rest.length ||
        api !== "api" ||
        review !== REVIEW_SEGMENT ||
        realtime !== "realtime" ||
        channel !== "channel"
      )
        return deny();
      requireProject(this.rootDir, project);
      // No services are created here: only a live ticket issued for this project reaches its existing channels.
      const entry = this.entries.get(project!);
      if (!entry || !this.hasTicket(project!, req)) return deny();
      req.url = LOCAL_REVIEW_CHANNEL_PATH;
      this.dispatchOrigin = origin;
      try {
        if (!entry.emitter.emit("upgrade", req, socket, head)) deny();
      } finally {
        this.dispatchOrigin = "";
      }
    } catch {
      deny();
    }
  }

  async releaseProject(project: string): Promise<void> {
    this.outstanding.delete(project);
    this.issueTimes.delete(project);
    const entry = this.entries.get(project);
    if (!entry) return;
    try {
      await entry.channels.close();
    } finally {
      this.entries.delete(project);
    }
  }

  /**
   * Closes every project's channels (lease release, socket close, cleanup-error report) — the step `review:ui`'s
   * Ctrl+C skipped. Every instance is closed even when one fails; the first failure is rethrown.
   */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.entries.values()].map((entry) => entry.channels.close()));
      this.entries.clear();
      this.outstanding.clear();
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      if (this.swapErrors.length) throw this.swapErrors[0];
    })());
  }
}
