/**
 * The console URL `pnpm review:ui` prints (RFC 0004 D2, WP13): the project's Timeline page; a campaign container shows
 * the campaign view there.
 */
import { sessionUrl } from "../urls";

/**
 * The console URL that opens `project`'s Timeline page, from a start result's session URL (`#token=…`). Throws when
 * the session URL carries no token.
 */
export function consoleReviewUrl(started: { url: string; baseUrl: string }, project: string): string {
  const token = new URLSearchParams(new URL(started.url).hash.slice(1)).get("token");
  if (!token) throw new Error("The console session URL has no token");
  return sessionUrl(started.baseUrl, token, project, "timeline");
}
