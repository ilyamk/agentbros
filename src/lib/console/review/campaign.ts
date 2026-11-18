/**
 * Campaign review on the console server (RFC 0004 WP13e, parity rows RU-CP01–06): the review of a campaign container,
 * mounted as the review host's campaign handler (`startConsoleServer({ review: { campaign: campaignReviewHandler } })`,
 * done by the daemon). Routes under `/api/review/<campaign>/`:
 *
 * - `GET campaign` — the campaign state (`campaignReviewState`): plan hash, review draft revision, members.
 * - `POST selection` — one member's review draft (strict body); a stale plan, revision or outputs → 409, an unknown
 *   member or a bad body → 400.
 * - `GET|HEAD file?path=` — a receipt-pinned `.mp4` of a complete render task, hash-verified on the open descriptor,
 *   with Range/416. `file` sits where the console accepts the media cookie (`<video>` sends no header).
 *
 * The console server has already checked Host, Origin, fetch metadata and the token (header for JSON and POST, the
 * cookie for `file` too). Every other path of a campaign container is a 404 that names the campaign view; a
 * campaign never gets a timeline `ReviewService` or realtime channels.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJsonBody } from "../../local-server/body";
import { HttpError, sendJson } from "../../local-server/errors";
import { serveOpenFile } from "../../local-server/range";
import {
  campaignReviewPin,
  campaignReviewState,
  CampaignSelectionSchema,
  openCampaignPin,
  saveCampaignSelection,
  warmCampaignReview,
} from "../../campaigns/production/review-service";
import type { CampaignReviewHandler } from "./host";

/** The campaign routes (sub-paths of `/api/review/<campaign>/`). */
export const CAMPAIGN_ROUTES = { state: "campaign", selection: "selection", file: "file" } as const;

/** Error code of a timeline review route asked of a campaign container (the console shows the campaign view). */
export const CAMPAIGN_PROJECT = "CAMPAIGN_PROJECT";

/**
 * Errors keep no absolute path: a file-system error (ENOENT, EACCES, …) becomes a generic message, and any message
 * naming the checkout root is made project-relative.
 */
function sanitize(error: unknown, rootDir: string): unknown {
  if (error instanceof HttpError) return error;
  const system = error as NodeJS.ErrnoException;
  if (typeof system?.syscall === "string" && typeof system.code === "string")
    return new HttpError(system.code === "ENOENT" ? 404 : 400, "FILE_NOT_FOUND", "A campaign file is not readable");
  if (error instanceof Error && error.message.includes(rootDir)) {
    const copy = new Error(error.message.split(`${rootDir}/`).join("").split(rootDir).join("."));
    copy.name = error.name;
    return copy;
  }
  return error;
}

export const campaignReviewHandler: CampaignReviewHandler = async (req, res, input) => {
  try {
    return await route(req, res, input);
  } catch (error) {
    throw sanitize(error, input.rootDir);
  }
};

const route: CampaignReviewHandler = async (req, res, { rootDir, project, rest, query }) => {
  const method = req.method ?? "GET";
  const path = rest.join("/");
  if (method === "GET" && path === CAMPAIGN_ROUTES.state) {
    // Renders are hashed asynchronously first; the synchronous state then re-verifies them by stat (memo).
    await warmCampaignReview(rootDir, project);
    sendJson(res, 200, campaignReviewState(rootDir, project));
    return true;
  }
  if (method === "POST" && path === CAMPAIGN_ROUTES.selection) {
    await saveSelection(req, res, rootDir, project);
    return true;
  }
  if ((method === "GET" || method === "HEAD") && path === CAMPAIGN_ROUTES.file) {
    const pin = campaignReviewPin(rootDir, project, query.get("path"));
    const { fd, size } = await openCampaignPin(rootDir, pin);
    serveOpenFile(req, res, { fd, size, contentType: "video/mp4" });
    return true;
  }
  throw new HttpError(
    404,
    CAMPAIGN_PROJECT,
    `${project} is a campaign container: its review is the campaign view (/api/review/${project}/${CAMPAIGN_ROUTES.state}).`,
  );
};

async function saveSelection(req: IncomingMessage, res: ServerResponse, rootDir: string, project: string) {
  const input = await parseJsonBody(req, CampaignSelectionSchema);
  const result = saveCampaignSelection(rootDir, project, input);
  if ("conflict" in result) throw new HttpError(409, "CONFLICT", result.conflict);
  sendJson(res, 200, result.saved);
}
