/**
 * The review services' standalone HTTP API (no page): the same routes the console serves under
 * `/api/review/<project>/` (src/lib/console/review/), on a per-process token, loopback port and `x-review-token`
 * header. It is the harness of the review service tests; `pnpm review:ui` opens the console (RFC 0004 D2, WP13).
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { ReviewService } from "./service";
import { RealtimeReviewChannels } from "./realtime-channel";
import { RealtimeReviewConflict } from "./realtime";
import { RevisionConflict } from "../timeline-ir/store";
import { serveReviewFile } from "./file-route";
import {
  applyTimeouts,
  readCookie,
  readJsonBody as body,
  REVIEW_CSP,
  sessionCookie,
  setSecurityHeaders,
  tokensEqual,
} from "../local-server";
export async function startReviewServer(options: { projectId: string; rootDir?: string; port?: number }) {
  const service = new ReviewService(options.projectId, options.rootDir);
  service.state(); // validate confinement before listening; no writes on launch
  const token = randomBytes(32).toString("hex");
  const cookieName = "review_session_" + token.slice(0, 12);
  let origin = "";
  let channels: RealtimeReviewChannels;
  const server = createServer(async (req, res) => {
    setSecurityHeaders(res, REVIEW_CSP);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(origin).host) {
        send(403, {
          message: "Invalid host",
        });
        return;
      }
      const url = new URL(req.url || "/", origin);
      if (req.headers.origin && req.headers.origin !== origin) {
        send(403, {
          message: "Invalid origin",
        });
        return;
      }
      const supplied = String(req.headers["x-review-token"] || "");
      const validToken = (value: string) => tokensEqual(value, token);
      const cookie = readCookie(req.headers.cookie, cookieName);
      const mediaRequest = (req.method === "GET" || req.method === "HEAD") && url.pathname === "/file";
      if (!validToken(supplied) && !(mediaRequest && validToken(cookie))) {
        send(403, {
          message: "Session token required",
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/realtime/channel-ticket") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin channel ticket required" });
          return;
        }
        send(200, channels.issue(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        if (req.headers.origin !== origin) {
          send(403, {
            message: "Same-origin session required",
          });
          return;
        }
        res.setHeader("Set-Cookie", sessionCookie(cookieName, token, "/file"));
        send(200, {
          ok: true,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/authored-copy-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin authored copy proposal required" });
          return;
        }
        send(200, service.authoredCopyProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/visual-reframe-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin reframe proposal required" });
          return;
        }
        send(200, service.visualReframeProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/chapter-inspection") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin chapter inspection required" });
          return;
        }
        send(200, service.chapterInspection(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/visual-remove-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin visual remove proposal required" });
          return;
        }
        send(200, service.visualRemoveProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/visual-slip-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin source slip proposal required" });
          return;
        }
        send(200, service.visualSlipProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/visual-split-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin visual split proposal required" });
          return;
        }
        send(200, service.visualSplitProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/audio-position-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin audio proposal required" });
          return;
        }
        send(200, service.audioPositionProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/group-move-proposal") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin group proposal required" });
          return;
        }
        send(200, service.groupMoveProposal(await body(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/dry-run") {
        if (req.headers.origin !== origin) {
          send(403, {
            message: "Same-origin dry run required",
          });
          return;
        }
        send(200, service.dryRun(await body(req)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/realtime/channel-state") {
        send(200, channels.inspect(url.searchParams.get("editor") || ""));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/realtime") {
        const editor = url.searchParams.get("editor");
        send(200, editor ? service.realtime.view(editor) : service.realtime.list());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/realtime/still-sources") {
        send(200, service.realtime.stillSources());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/realtime/derive-source") {
        send(
          200,
          service.realtime.deriveSource(url.searchParams.get("editor") || "", url.searchParams.get("revision") || ""),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/realtime/request") {
        send(
          200,
          service.realtime.request(url.searchParams.get("editor") || "", url.searchParams.get("revision") || ""),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/realtime") {
        if (req.headers.origin !== origin) {
          send(403, { message: "Same-origin realtime mutation required" });
          return;
        }
        send(200, service.realtime.mutate(await body(req)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        send(200, service.state());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/review-pack") {
        send(200, service.reviewPack(url.searchParams.get("path") || ""));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/mutate") {
        if (req.headers.origin !== origin) {
          send(403, {
            message: "Same-origin mutation required",
          });
          return;
        }
        send(200, service.mutate(await body(req)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/compare") {
        send(200, service.compare(url.searchParams.get("left") || "", url.searchParams.get("right") || ""));
        return;
      }
      if (mediaRequest) {
        serveReviewFile(req, res, service, url.searchParams.get("path") || "");
        return;
      }
      send(404, {
        message: "Unknown review route",
      });
    } catch (error) {
      send(error instanceof RevisionConflict || error instanceof RealtimeReviewConflict ? 409 : 400, {
        message: error instanceof Error ? error.message : "Review request failed",
      });
    }
  });
  channels = new RealtimeReviewChannels(server, service.rootDir, options.projectId, () => origin);
  applyTimeouts(server, 10000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  origin = `http://127.0.0.1:${address.port}`;
  let closePromise: Promise<void> | undefined;
  return {
    server,
    service,
    token,
    origin,
    url: `${origin}/#token=${token}`,
    channels,
    close: () =>
      (closePromise ??= (async () => {
        let failure: unknown;
        try {
          await channels.close();
        } catch (error) {
          failure = error;
        }
        await new Promise<void>((resolve, reject) => {
          const force = setTimeout(() => server.closeAllConnections(), 250),
            deadline = setTimeout(() => reject(Error("Owned HTTP shutdown deadline")), 1500);
          server.close((error) => {
            clearTimeout(force);
            clearTimeout(deadline);
            error ? reject(error) : resolve();
          });
        });
        if (failure) throw failure;
      })()),
  };
}
