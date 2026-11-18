/**
 * Request admission for loopback servers (RFC 0004 D15; the review:ui parity checklist, security behaviours):
 * timing-safe token comparison, the Host check against DNS rebinding, exact Origin checks and the security headers.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Constant-time comparison of a supplied secret with the expected one; a length mismatch is false, never a throw. */
export function tokensEqual(supplied: string | undefined | null, expected: string): boolean {
  if (typeof supplied !== "string" || !expected) return false;
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Host values a loopback server on `port` accepts: `127.0.0.1:<port>`, plus `localhost:<port>` when allowed. */
export function allowedHosts(port: number, options: { localhost?: boolean } = {}): string[] {
  return options.localhost === false ? [`127.0.0.1:${port}`] : [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** True when the Host header names this server exactly (anti DNS rebinding). */
export function hostAllowed(host: string | undefined, port: number, options: { localhost?: boolean } = {}): boolean {
  return typeof host === "string" && allowedHosts(port, options).includes(host);
}

/** The exact origin of a request whose Host has been admitted: `http://<host>`. */
export const originOf = (host: string) => `http://${host}`;

/** A present Origin that differs from `origin` is refused; an absent one is acceptable (same-origin GETs omit it). */
export const originAcceptable = (req: IncomingMessage, origin: string) =>
  req.headers.origin === undefined || req.headers.origin === origin;

/** State-changing requests: the Origin must be present and exactly `origin`. */
export const originExact = (req: IncomingMessage, origin: string) => req.headers.origin === origin;

/** One header value as a string ('' when absent; the first value of a repeated header). */
export function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export interface CspOptions {
  /** Adds `'nonce-<nonce>'` to `style-src` (for runtime-injected style elements, e.g. Radix). */
  styleNonce?: string;
  /** Adds `font-src 'self'`. */
  fonts?: boolean;
}

/** The strict policy: same-origin scripts, styles, images, media and connections; no frames, base or forms. */
export function contentSecurityPolicy(options: CspOptions = {}): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    options.styleNonce ? `style-src 'self' 'nonce-${options.styleNonce}'` : "style-src 'self'",
    "img-src 'self'",
    "media-src 'self'",
    "connect-src 'self'",
    ...(options.fonts ? ["font-src 'self'"] : []),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The review server's historical policy string, kept byte for byte. */
export const REVIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Sets `Cache-Control: no-store`, `nosniff`, `no-referrer` and the CSP on every response. */
export function setSecurityHeaders(res: ServerResponse, csp: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", csp);
}

/** A fresh per-response nonce (128 bits, base64). */
export const newNonce = () => randomBytes(16).toString("base64");

/** 32 random bytes as lowercase hex. */
export const newToken = () => randomBytes(32).toString("hex");
