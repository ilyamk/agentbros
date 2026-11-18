/**
 * The review routes of the console server (RFC 0004 D2, WP13): every route of `review:ui` under
 * `/api/review/<project>/…`, calling the unchanged services. Request rules carried over from review:ui
 * (the review:ui parity checklist, security behaviours): exact `application/json` bodies of at most 64 KiB,
 * parsed by the services' strict zod schemas; `RevisionConflict` / `RealtimeReviewConflict` → 409, any other error →
 * 400 with its message only; `/file` through the review allowlist (Range, HEAD, 416).
 *
 * Authentication (server.ts has already checked Host, Origin and fetch metadata; POSTs have the header and the exact
 * Origin): JSON reads need the `x-console-token` header; only `file` also accepts the media-read cookie (never the
 * token, http/auth.ts), as review:ui's cookie was valid for `/file` alone.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../../local-server/body";
import { forbidden, HttpError, notFound, sendJson } from "../../local-server/errors";
import { serveReviewFile } from "../../review-ui/file-route";
import { RealtimeReviewConflict } from "../../review-ui/realtime";
import { RevisionConflict } from "../../timeline-ir/store";
import type { Credentials } from "../http/auth";
import { requireProject } from "../http/routes";
import { REVIEW_SEGMENT, type ReviewHost, type ReviewProject } from "./host";

type Read = (entry: ReviewProject, query: URLSearchParams) => unknown;
type Action = (entry: ReviewProject, body: unknown, host: ReviewHost) => unknown;

const q = (query: URLSearchParams, name: string) => query.get(name) || "";

/** GET routes: console sub-path → service call (review:ui path in the comment). */
export const REVIEW_READS: Readonly<Record<string, Read>> = {
  /** GET /api/state */
  state: (e) => e.service.state(),
  /** GET /api/compare?left&right */
  compare: (e, query) => e.service.compare(q(query, "left"), q(query, "right")),
  /** GET /api/review-pack?path */
  "review-pack": (e, query) => e.service.reviewPack(q(query, "path")),
  /** GET /api/realtime[?editor] */
  realtime: (e, query) =>
    query.get("editor") ? e.service.realtime.view(q(query, "editor")) : e.service.realtime.list(),
  /** GET /api/realtime/channel-state?editor */
  "realtime/channel-state": (e, query) => e.channels.inspect(q(query, "editor")),
  /** GET /api/realtime/still-sources */
  "realtime/still-sources": (e) => e.service.realtime.stillSources(),
  /** GET /api/realtime/derive-source?editor&revision */
  "realtime/derive-source": (e, query) => e.service.realtime.deriveSource(q(query, "editor"), q(query, "revision")),
  /** GET /api/realtime/request?editor&revision */
  "realtime/request": (e, query) => e.service.realtime.request(q(query, "editor"), q(query, "revision")),
};

/** POST routes: console sub-path → service call. */
export const REVIEW_ACTIONS: Readonly<Record<string, Action>> = {
  "dry-run": (e, body) => e.service.dryRun(body),
  mutate: (e, body) => e.service.mutate(body),
  "authored-copy-proposal": (e, body) => e.service.authoredCopyProposal(body),
  "visual-reframe-proposal": (e, body) => e.service.visualReframeProposal(body),
  "chapter-inspection": (e, body) => e.service.chapterInspection(body),
  "visual-remove-proposal": (e, body) => e.service.visualRemoveProposal(body),
  "visual-slip-proposal": (e, body) => e.service.visualSlipProposal(body),
  "visual-split-proposal": (e, body) => e.service.visualSplitProposal(body),
  "audio-position-proposal": (e, body) => e.service.audioPositionProposal(body),
  "group-move-proposal": (e, body) => e.service.groupMoveProposal(body),
  realtime: (e, body) => e.service.realtime.mutate(body),
  "realtime/channel-ticket": (e, body, host) => host.issueTicket(e.project, body),
};

/** The review file route (GET and HEAD, `?path=`), the console's `/file`. */
export const REVIEW_FILE = "file";

/** True for `/api/review/…`. */
export const isReviewPath = (segments: string[]) => segments[0] === "api" && segments[1] === REVIEW_SEGMENT;

/** Review reads: the header, or (for `file` only) the cookie. */
export function assertReviewRead(segments: string[], found: Credentials): void {
  if (found.header) return;
  if (segments.length === 4 && segments[3] === REVIEW_FILE && found.cookie) return;
  throw forbidden(found.cookie ? "Review reads need the x-console-token header" : "Session token required");
}

const isConflict = (error: unknown) => error instanceof RevisionConflict || error instanceof RealtimeReviewConflict;

/** Handles `/api/review/<project>/…` (any method); false when the path is not a review path. */
export async function handleReview(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  host: ReviewHost,
): Promise<boolean> {
  if (!isReviewPath(segments)) return false;
  const project = requireProject(host.rootDir, segments[2]);
  const rest = segments.slice(3);
  const route = rest.join("/");
  if (host.isCampaign(project)) {
    if (await host.campaign(req, res, { rootDir: host.rootDir, project, rest, query })) return true;
    throw notFound("Unknown review route");
  }
  try {
    const method = req.method ?? "GET";
    if ((method === "GET" || method === "HEAD") && route === REVIEW_FILE) {
      serveReviewFile(req, res, host.get(project).service, q(query, "path"));
      return true;
    }
    if (method === "GET" && Object.hasOwn(REVIEW_READS, route)) {
      sendJson(res, 200, await REVIEW_READS[route]!(host.get(project), query));
      return true;
    }
    if (method === "POST" && Object.hasOwn(REVIEW_ACTIONS, route)) {
      const body = await readJsonBody(req);
      sendJson(res, 200, await REVIEW_ACTIONS[route]!(host.get(project), body, host));
      return true;
    }
  } catch (error) {
    if (isConflict(error)) throw new HttpError(409, "CONFLICT", (error as Error).message);
    throw error;
  }
  throw notFound("Unknown review route");
}
