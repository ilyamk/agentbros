/**
 * Console session rules (RFC 0004 D15). The page reads `#token=` once (or, after a reload, from its own tab's
 * sessionStorage) and calls `POST /api/session` with the `x-console-token` header, which sets an
 * `HttpOnly; SameSite=Strict; Path=/` cookie. The cookie never holds the token: it holds a derived read-only value
 * ({@link mediaReadValue}) that authenticates only the GET/HEAD routes `<img>` and `<video>` load without headers
 * ({@link cookieReadable}). Every JSON read, the stream and every POST need the header; POSTs also the exact Origin
 * (CSRF). No route ever returns the token.
 */
import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CONSOLE_TOKEN_HEADER } from "../../../types/console";
import { readCookie } from "../../local-server/cookies";
import { forbidden } from "../../local-server/errors";
import { headerValue, originExact, tokensEqual } from "../../local-server/security";

/**
 * Cookie name: `agentbros_console_<first 12 hex of sha256(token)>`. Cookies on 127.0.0.1 are shared by every port, so
 * each checkout (each token) needs its own name, or opening one checkout's console would log another one out. Stable
 * across restarts because the token is; distinct from review:ui's `review_session_*`.
 */
export const consoleCookieName = (token: string) =>
  `agentbros_console_${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

/**
 * Domain label of the media cookie's HMAC. Not hex and not the health proof's `agentbros-console-health:` prefix, so no
 * nonce sent to the unauthenticated `/api/health` can make its proof equal the cookie.
 */
export const MEDIA_READ_LABEL = "agentbros-console/media-read/v1";

/** The cookie's value: HMAC-SHA256(token, {@link MEDIA_READ_LABEL}) as hex. It reads media; it is not the token. */
export const mediaReadValue = (token: string) => createHmac("sha256", token).update(MEDIA_READ_LABEL).digest("hex");

export interface Credentials {
  /** The `x-console-token` header carries the token. */
  header: boolean;
  /** The cookie carries the media-read value. */
  cookie: boolean;
}

/** `mediaRead` defaults to {@link mediaReadValue}(token) (the server passes it precomputed). */
export function credentials(req: IncomingMessage, token: string, mediaRead = mediaReadValue(token)): Credentials {
  return {
    header: tokensEqual(headerValue(req, CONSOLE_TOKEN_HEADER), token),
    cookie: tokensEqual(readCookie(req.headers.cookie, consoleCookieName(token)), mediaRead),
  };
}

/**
 * The only routes the cookie authenticates: GET and HEAD of `/media/<project>/…`, `/thumb/<project>/…`,
 * `/library/preview/<block>` and `/api/review/<project>/file` (review and campaign renders).
 */
export function cookieReadable(method: string, segments: readonly string[]): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const [first, second, , fourth] = segments;
  if (first === "media" || first === "thumb") return segments.length >= 3;
  if (first === "library") return second === "preview" && segments.length === 3;
  return first === "api" && second === "review" && segments.length === 4 && fourth === "file";
}

/**
 * Fetch metadata (any request): a page on another port of 127.0.0.1 is same-site, so the browser sends it our cookie
 * on `<img>`, `<video>` and no-cors fetches without an Origin. Only `same-origin` and `none` (the user's own
 * navigation) are admitted when the header is present.
 */
export function assertFetchSite(req: IncomingMessage): void {
  const site = headerValue(req, "sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Cross-site request refused");
}

/** GET and HEAD: the header, or the cookie on a {@link cookieReadable} route. */
export function assertRead(req: IncomingMessage, found: Credentials, segments: readonly string[]): void {
  if (found.header) return;
  if (found.cookie && cookieReadable(req.method ?? "GET", segments)) return;
  throw forbidden(found.cookie ? `The ${CONSOLE_TOKEN_HEADER} header is required` : "Session token required");
}

/** POST: the header and the exact Origin (so a POST without an Origin is refused), whatever the cookie says. */
export function assertWrite(req: IncomingMessage, found: Credentials, origin: string): void {
  if (!found.header) throw forbidden(`The ${CONSOLE_TOKEN_HEADER} header is required`);
  if (!originExact(req, origin)) throw forbidden("Same-origin request required");
}
