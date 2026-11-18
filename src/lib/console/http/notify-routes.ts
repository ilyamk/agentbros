/**
 * Notification routes of the console server (RFC 0004 D23, WP14), after the session checks:
 *
 * - `GET /api/notify`: settings, the OS sender and whether `AGENTBROS_NOTIFY=off` holds them off.
 * - `POST /api/notify/settings`: change any switch (strict body); turning on starts from the present state.
 * - `POST /api/notify/presence`: a tab's heartbeat (focused, browser permission); returns the notices since its `seq`.
 *
 * Without a notifier (tests, `startConsoleServer` without `notify`) they answer 501 `NOT_IMPLEMENTED`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { parseJsonBody } from "../../local-server/body";
import { HttpError, sendJson } from "../../local-server/errors";
import type { Notifier } from "../notify";
import { NotifySettingsPatchSchema } from "../notify-state";

export const PresenceRequestSchema = z.strictObject({
  tab: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  focused: z.boolean(),
  browser: z.enum(["granted", "denied", "default", "unsupported"]),
  since: z.number().int().nonnegative().optional(),
  gone: z.boolean().optional(),
});

const isNotifyPath = (segments: string[]) => segments[0] === "api" && segments[1] === "notify";

/** Handles a notification route; false when `segments` is not one. */
export async function handleNotify(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  notifier: Notifier | undefined,
): Promise<boolean> {
  if (!isNotifyPath(segments) || segments.length > 3) return false;
  const method = req.method ?? "GET";
  const action = segments[2];
  if (query.size) throw new HttpError(400, "INVALID_INPUT", "Notification routes take no query");
  const known =
    (action === undefined && (method === "GET" || method === "HEAD")) ||
    ((action === "settings" || action === "presence") && method === "POST");
  if (!known) return false;
  if (!notifier) throw new HttpError(501, "NOT_IMPLEMENTED", "Notifications are not running in this server.");
  try {
    await route(req, res, action, notifier);
  } catch (error) {
    // Only our own messages reach the page: a file-system error would carry an absolute path.
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, "INTERNAL", "The notification settings could not be saved.");
  }
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, action: string | undefined, notifier: Notifier) {
  if (action === undefined) {
    sendJson(res, 200, { ok: true, ...notifier.status() });
    return;
  }
  if (action === "settings") {
    const patch = await parseJsonBody(req, NotifySettingsPatchSchema);
    sendJson(res, 200, { ok: true, ...(await notifier.update(patch)) });
    return;
  }
  const report = await parseJsonBody(req, PresenceRequestSchema);
  sendJson(res, 200, { ok: true, ...notifier.presence(report) });
}
