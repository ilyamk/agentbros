/**
 * The studio console's local server (RFC 0004 §9, D6, D15, D16): `node:http`, 127.0.0.1 only, one server for every
 * project. Admission order: Host (anti DNS rebinding), a present Origin must be exact, then the three static files
 * (the only unauthenticated paths), then the session: the `x-console-token` header for every JSON read, the stream and
 * every POST (with the exact Origin); the media-read cookie only for media, thumbnails, library previews and review
 * files (http/auth.ts). Data and actions are injected (`data.ts`).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { DEFAULT_CONSOLE_PORT } from "../../types/console";
import { sessionCookie } from "../local-server/cookies";
import { z } from "zod";
import { badRequest, errorReply, forbidden, HttpError, sendJson } from "../local-server/errors";
import { splitRequestTarget } from "../local-server/paths";
import { parseJsonBody } from "../local-server/body";
import {
  contentSecurityPolicy,
  headerValue,
  hostAllowed,
  originAcceptable,
  originExact,
  originOf,
  setSecurityHeaders,
} from "../local-server/security";
import { applyTimeouts, closeServer, listenLoopback, REQUEST_TIMEOUT_MS } from "../local-server/server";
import { openConsoleBrowser } from "./browser";
import { credentialBrowserUrl } from "./credential-session";
import { bundleHash, distDirOf, type BuildResult } from "./bundle";
import { cardAnswerer } from "./cards";
import { notImplementedActions, type ConsoleActions, type ConsoleDataSource } from "./data";
import { createProjectorDataSource } from "./view/source";
import { projectSettings } from "./project-settings";
import { assertFetchSite, assertRead, assertWrite, consoleCookieName, credentials, mediaReadValue } from "./http/auth";
import { healthProof } from "./lock";
import { handleAction, handleRead, type RouteContext } from "./http/routes";
import { handleNotify } from "./http/notify-routes";
import { handleCredentials } from "./http/credential-routes";
import { handleLibrary, isLibraryPath } from "./http/library-routes";
import { LibraryReader } from "./library";
import { Notifier, type NotifierOptions } from "./notify";
import { StaticBundle } from "./http/static";
import { loadOrCreateSessionToken } from "./session";
import { browserFamily, PAIR_CODE, pairedBrowsers, redeemPairingCode } from "./pairing";
import { SseHub } from "./sse";
import { ThumbnailService } from "./thumbs";
import { ReviewHost, type ReviewHostOptions } from "./review/host";
import { assertReviewRead, handleReview, isReviewPath } from "./review/routes";
import { sessionUrl } from "./urls";

export interface ConsoleServerOptions {
  /** Checkout root holding `public/projects/` and `out/` (real-pathed at start). */
  rootDir: string;
  /** Default 4317; 0 picks a free port. */
  port?: number;
  /** A busy port falls back to a random free one (default true). */
  portFallback?: boolean;
  /** Default: the per-machine token of `out/console/session.json`. */
  token?: string;
  /** Default: the projector, `createProjectorDataSource(rootDir)` (WP3). */
  dataSource?: ConsoleDataSource;
  /** Default: agent cards are answered (WP11); the other actions answer 501 `NOT_IMPLEMENTED` until they land. */
  actions?: ConsoleActions;
  /** Reported by `/api/health` and written to the lock. */
  version?: string;
  /** Default `out/console/dist` under rootDir. */
  distDir?: string;
  /** Hash the dist must be stamped with (default: the current UI sources' hash). */
  bundle?: string;
  /** Build a missing or stale bundle after listening (default true). */
  build?: boolean;
  builder?: () => Promise<BuildResult>;
  /** OS browser handoff (default: the local browser launcher). */
  openBrowser?: (url: string) => Promise<void>;
  ffmpeg?: string;
  heartbeatMs?: number;
  requestTimeoutMs?: number;
  /** Calls `onIdle` after this long without a request (default: never; the daemon passes 12 h). */
  idleMs?: number;
  onIdle?: () => void;
  log?: (line: string) => void;
  /** Checkout whose `docs/library/catalogue.json` the library page reads (default rootDir; WP15). */
  libraryRoot?: string;
  /** The review host (`/api/review/<project>/…`, WP13); e.g. a campaign review handler. */
  review?: ReviewHostOptions;
  /**
   * Notifications (WP14, D23): the daemon passes `{}`; omitted, none run and `/api/notify*` answers 501. The server
   * supplies the root, its origin, the projector's waiting decisions and its change feed.
   */
  notify?: Omit<NotifierOptions, "rootDir" | "origin" | "waiting" | "watch">;
}

export interface ConsoleServer {
  server: import("node:http").Server;
  port: number;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** The session URL with `#token=` (keep it private). */
  url: string;
  token: string;
  /** The requested port was busy and a random one was used. */
  fellBack: boolean;
  version: string;
  startedAt: string;
  bundle: StaticBundle;
  rootDir: string;
  /** Review services per project (closed by `close()`). */
  review: ReviewHost;
  /** Session URL that opens a project. */
  urlFor(project?: string): string;
  /** Present when started with `notify`. */
  notifier?: Notifier;
  close(): Promise<void>;
}

const PairRequestSchema = z.strictObject({ code: z.string().regex(PAIR_CODE) });

const realOrSame = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  const rootDir = realpathSync(options.rootDir);
  const token = options.token ?? loadOrCreateSessionToken(rootDir);
  const source = options.dataSource ?? createProjectorDataSource(rootDir);
  const actions = options.actions ?? { ...notImplementedActions, answerCard: cardAnswerer(rootDir) };
  const version = options.version ?? "dev";
  const startedAt = new Date().toISOString();
  const sse = new SseHub(source, { heartbeatMs: options.heartbeatMs });
  const thumbs = new ThumbnailService({ rootDir, ffmpeg: options.ffmpeg });
  const review = new ReviewHost(rootDir, { log: options.log, ...options.review });
  const settings = projectSettings(rootDir, (project) => review.releaseProject(project));
  const context: RouteContext = { rootDir, source, actions, sse, thumbs, settings };
  // Real-pathed so the preview route can refuse a symlink anywhere below it (library-routes.ts).
  const library = new LibraryReader(realOrSame(options.libraryRoot ?? rootDir));
  const mediaRead = mediaReadValue(token);
  const csp = contentSecurityPolicy({ fonts: true });
  let port = 0;
  let lastRequest = performance.now();
  let bundle: StaticBundle | undefined;
  let notifier: Notifier | undefined;

  let lastEditorOpen = -Infinity;
  const openEditor = async () => {
    const now = performance.now();
    if (now - lastEditorOpen < 3000) throw new HttpError(429, "RATE_LIMIT", "The key editor is opening.");
    lastEditorOpen = now;
    try {
      const url = credentialBrowserUrl(rootDir, sessionUrl(`http://127.0.0.1:${port}`, token), true);
      await (options.openBrowser ?? openConsoleBrowser)(url);
    } catch {
      lastEditorOpen = -Infinity;
      throw new HttpError(503, "BROWSER_UNAVAILABLE", "Could not open the default browser.");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res, csp);
    lastRequest = performance.now();
    try {
      const host = req.headers.host;
      if (!hostAllowed(host, port)) throw forbidden("Invalid host");
      const origin = originOf(host!);
      if (!originAcceptable(req, origin)) throw forbidden("Invalid origin");
      assertFetchSite(req);
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD" && method !== "POST")
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
      const { segments, query } = splitRequestTarget(req.url);
      if (method !== "POST" && segments.length <= 1 && bundle?.serve(req, res, segments[0] ?? "")) return;
      if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "health") {
        // Unauthenticated by design: the caller sends a nonce and checks the HMAC proof, so the token never travels.
        const nonce = query.get("nonce") ?? "";
        if (!/^[a-f0-9]{32}$/.test(nonce) || query.size !== 1) throw badRequest("A 32-hex nonce is required");
        sendJson(res, 200, { ok: true, version, pid: process.pid, port, startedAt, proof: healthProof(token, nonce) });
        return;
      }
      const found = credentials(req, token, mediaRead);
      if (method === "POST" && segments.length === 3 && segments.join("/") === "api/session/pair") {
        // A one-use pairing code (pairing.ts) stands in for the header: same-origin page only, exact Origin.
        if (!originExact(req, origin) || !["", "same-origin"].includes(headerValue(req, "sec-fetch-site")))
          throw forbidden("Same-origin request required");
        const { code } = await parseJsonBody(req, PairRequestSchema);
        const agent = browserFamily(headerValue(req, "user-agent"));
        if (!redeemPairingCode(rootDir, code, { userAgent: headerValue(req, "user-agent"), token }))
          throw forbidden(
            "This pairing link is used or expired: ask for a new one (pnpm next, or pnpm console --open).",
          );
        options.log?.(`A browser paired with the console (${agent}).`);
        sendJson(
          res,
          200,
          { ok: true, token },
          { "Set-Cookie": sessionCookie(consoleCookieName(token), mediaRead, "/") },
        );
        return;
      }
      if (method === "POST") {
        assertWrite(req, found, origin);
        if (await handleCredentials(req, res, segments, query, rootDir, openEditor)) return;
        if (segments.length === 2 && segments[0] === "api" && segments[1] === "session") {
          sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(consoleCookieName(token), mediaRead, "/") });
          return;
        }
        const write = async () =>
          (await handleReview(req, res, segments, query, review)) ||
          (await handleNotify(req, res, segments, query, notifier)) ||
          (await handleAction(req, res, segments, context, query));
        const project =
          segments[0] === "api" && ["projects", "review"].includes(segments[1] ?? "") ? segments[2] : undefined;
        const removal = segments[1] === "projects" && segments[3] === "remove" && segments.length === 4;
        if (await (project && !removal ? settings.write(project, write) : write())) return;
        throw new HttpError(404, "NOT_FOUND", "Unknown console route");
      }
      if (isReviewPath(segments)) {
        assertReviewRead(segments, found);
        if (await handleReview(req, res, segments, query, review)) return;
      }
      assertRead(req, found, segments);
      if (await handleCredentials(req, res, segments, query, rootDir, openEditor)) return;
      if (isLibraryPath(segments) && handleLibrary(req, res, segments, query, library)) return;
      // A probe for header clients; it never returns the token (D15).
      if (method === "GET" && segments.length === 2 && segments[0] === "api" && segments[1] === "session") {
        if (query.size) throw badRequest("The session takes no query");
        sendJson(res, 200, { ok: true });
        return;
      }
      // The browsers paired through one-use links (Settings, and the toast in open tabs).
      if (method === "GET" && segments.join("/") === "api/session/pairings") {
        if (query.size) throw badRequest("Pairings take no query");
        sendJson(res, 200, { ok: true, paired: pairedBrowsers(rootDir) });
        return;
      }
      if (await handleNotify(req, res, segments, query, notifier)) return;
      if (await handleRead(req, res, segments, query, context)) return;
      throw new HttpError(404, "NOT_FOUND", "Unknown console route");
    } catch (error) {
      const reply = errorReply(error);
      if (reply.status >= 500 && reply.body.error !== "NOT_IMPLEMENTED")
        options.log?.(`${req.method} ${String(req.url).split("?")[0]} → ${reply.status} ${reply.body.error}`);
      sendJson(res, reply.status, reply.body);
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  // WebSocket: the review realtime channel only (`/api/review/<project>/realtime/channel`); anything else is 403.
  server.on("upgrade", (req, socket, head) => {
    lastRequest = performance.now();
    review.upgrade(req, socket, head, port);
  });
  applyTimeouts(server, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  const listened = await listenLoopback(server, options.port ?? DEFAULT_CONSOLE_PORT, {
    fallback: options.portFallback !== false,
  });
  port = listened.port;
  const origin = `http://127.0.0.1:${port}`;
  // The bundle loads (or builds) after listening: the API answers at once, `/` shows a page until the build is over.
  bundle = new StaticBundle({
    distDir: options.distDir ?? distDirOf(rootDir),
    bundle: options.bundle ?? bundleHash(),
    build: options.build,
    builder: options.builder,
    log: options.log,
  });

  if (options.notify)
    notifier = new Notifier({
      log: options.log,
      ...options.notify,
      rootDir,
      origin,
      waiting: async (project) => (await source.view(project))?.waiting ?? [],
      watch: (onChange) => source.watch(undefined, onChange),
    }).start();

  let idle: NodeJS.Timeout | undefined;
  if (options.idleMs && options.onIdle) {
    const idleMs = options.idleMs;
    idle = setInterval(
      () => {
        if (performance.now() - lastRequest >= idleMs) options.onIdle?.();
      },
      Math.max(50, Math.min(60_000, Math.floor(idleMs / 4))),
    );
    idle.unref();
  }

  let closing: Promise<void> | undefined;
  return {
    server,
    port,
    origin,
    url: sessionUrl(origin, token),
    token,
    fellBack: listened.fellBack,
    version,
    startedAt,
    bundle,
    rootDir,
    review,
    urlFor: (project?: string) => sessionUrl(origin, token, project),
    notifier,
    close: () =>
      (closing ??= (async () => {
        if (idle) clearInterval(idle);
        notifier?.close();
        // Review channels first: upgraded sockets are not closed by the HTTP server, and leases must be released.
        let failure: unknown;
        try {
          await review.close();
        } catch (error) {
          failure = error;
          options.log?.(`review channel cleanup: ${error instanceof Error ? error.message : String(error)}`);
        }
        sse.close();
        if (!options.dataSource) (source as { close?: () => void }).close?.();
        await closeServer(server);
        if (failure) throw failure;
      })()),
  };
}
