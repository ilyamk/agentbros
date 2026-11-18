/**
 * Loopback guard for Remotion Studio (RFC 0004 §17, D21 as amended 2026-11-18). Installed by the
 * preload `node --require scripts/studio/loopback.cjs <remotion-cli.js> studio ...` (and through NODE_OPTIONS for any Node
 * child), it keeps every TCP server of the process on the loopback interface and refuses browser requests that do not
 * come from it:
 *
 * 1. `net.Server#listen`: a wildcard host (`0.0.0.0`, `::`), no host, or any non-loopback address becomes
 *    `127.0.0.1`. Studio binds `::`/`0.0.0.0` (all interfaces) with no host option, and its server has
 *    unauthenticated endpoints that write files, so it must never be reachable from the LAN. IPv6 wildcards also
 *    become 127.0.0.1 (not ::1) so the one URL we hand out, http://127.0.0.1:<port>/, always reaches it. Unix
 *    sockets, handles and loopback hosts are left as they are.
 * 2. HTTP requests and upgrades: the Host header must name a loopback host (DNS rebinding); an `Origin` must be a
 *    loopback http page on a port this process listens on (any method: Studio answers CORS for any https origin, and
 *    another local dev server is not Studio); a `Sec-Fetch-Site: cross-site` request is refused unless it is a GET or
 *    HEAD top-level navigation (a link to Studio from elsewhere), so no other site can frame Studio, include its
 *    scripts or send it writes. Refused with 403. Every response carries `Content-Security-Policy: frame-ancestors
 *    'self'`, so not even a same-site page on another port can frame it (clickjacking).
 * 3. `GET /__agentbros/studio` answers `{ pid, key }` (key: AGENTBROS_STUDIO_KEY), so `studio:open` can tell its own
 *    Studio on a port from any other server before reusing or stopping it.
 *
 * CommonJS with no dependencies: it runs before anything else in the Studio process. `loopback.cjs` is the preload
 * (it only calls {@link install}); this file exports the pure helpers for tests (tests/studio-loopback.test.ts).
 */
"use strict";

const net = require("node:net");
const http = require("node:http");

const LOOPBACK_V4 = "127.0.0.1";

/** True for 127.0.0.0/8, ::1, ::ffff:127.x and `localhost`. */
function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const v4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** The host a server may bind: the given loopback host, else 127.0.0.1. */
function loopbackHost(host) {
  return isLoopbackHost(host) ? host : LOOPBACK_V4;
}

const isPortLike = (value) =>
  (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^\d+$/.test(value));

/**
 * The arguments `listen` is called with, rewritten to a loopback host. Unix paths, pipes and handles pass through.
 * Exported for tests; `args` is never mutated.
 */
function rewriteListenArgs(args) {
  const list = Array.from(args);
  const first = list[0];
  if (first === undefined || first === null || typeof first === "function") {
    // listen() / listen(cb): an ephemeral port on all interfaces.
    return [{ port: 0, host: LOOPBACK_V4 }, ...list.slice(first === undefined || first === null ? 1 : 0)];
  }
  if (isPortLike(first)) {
    // listen(port[, host][, backlog][, cb])
    const rest = list.slice(1);
    const options = { port: Number(first), host: LOOPBACK_V4 };
    if (typeof rest[0] === "string") options.host = loopbackHost(rest.shift());
    else if (rest[0] === undefined && rest.length > 1) rest.shift();
    if (typeof rest[0] === "number") options.backlog = rest.shift();
    return [options, ...rest];
  }
  if (typeof first === "object" && !Array.isArray(first)) {
    // A handle (`_handle`, `fd`) or a unix path keeps its own address.
    if ("path" in first && first.path !== undefined) return list;
    if ("_handle" in first || "fd" in first || typeof first.listen === "function") return list;
    return [{ ...first, host: loopbackHost(first.host), ipv6Only: false }, ...list.slice(1)];
  }
  // listen(path[, backlog][, cb]): a unix socket or Windows pipe.
  return list;
}

/** Hostname of a Host header (`[::1]:3000` → `::1`, `localhost:3000` → `localhost`). */
function hostnameOf(header) {
  if (typeof header !== "string" || !header) return undefined;
  const value = header.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end < 0 ? undefined : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
}

const IDENTITY_PATH = "/__agentbros/studio";

const NAVIGATION_METHODS = new Set(["GET", "HEAD"]);

/** The frame-ancestors policy every response carries. */
const FRAME_POLICY = "frame-ancestors 'self'";
const CSP_HEADER = "content-security-policy";

/**
 * Why a request must be refused, or undefined when it may pass. `headers` are Node's lower-cased request headers;
 * `ports`, when given, are the ports this process listens on: an Origin must name one of them. Exported for tests.
 */
function refusal(method, headers, ports) {
  if (!isLoopbackHost(hostnameOf(headers.host))) return "Host is not a loopback address";
  // Any method: an Origin that is not one of this Studio's own pages. Studio answers CORS for any https origin (its
  // "studio protocol" and remotion.dev's converter), so a page elsewhere could otherwise read it; its own page sends
  // no Origin on plain GETs and its own one on the rest. Webpack's lazy compilation runs on a second loopback port
  // of the same process, so every port this process listens on counts.
  const origin = headers.origin;
  if (origin === "null") return "opaque Origin";
  if (origin !== undefined) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      return "invalid Origin";
    }
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return "foreign Origin";
    if (ports && !ports.has(Number(url.port || 80))) return "Origin of another local server";
  }
  const upper = String(method).toUpperCase();
  if (headers["sec-fetch-site"] === "cross-site") {
    // Only a top-level navigation may come from another site; never a frame, a script, a fetch or a write.
    const navigation =
      NAVIGATION_METHODS.has(upper) &&
      headers["sec-fetch-mode"] === "navigate" &&
      headers["sec-fetch-dest"] === "document";
    if (!navigation) return "cross-site request";
  }
  return undefined;
}

/** A Content-Security-Policy value with our frame policy added (every CSP header is enforced, so it is a list). */
function withFramePolicy(value) {
  if (value === undefined || value === null) return FRAME_POLICY;
  const list = (Array.isArray(value) ? value : [value]).map(String);
  return list.some((item) => item.trim() === FRAME_POLICY) ? list : [...list, FRAME_POLICY];
}

/**
 * Makes `res` carry the frame policy whatever Studio does: set now, and kept when Studio sets its own CSP through
 * `setHeader` or `writeHead`. Exported for tests.
 */
function guardResponse(res) {
  const setHeader = res.setHeader;
  res.setHeader = function guardedSetHeader(name, value) {
    return setHeader.call(this, name, String(name).toLowerCase() === CSP_HEADER ? withFramePolicy(value) : value);
  };
  // `writeHead(status[, message], headers)`: Node merges object headers through `setHeader` (above) because ours is
  // already set. Raw `[name, value, ...]` headers may replace a same-named header (it depends on the Node version),
  // so their CSP values move out of the list into one guarded `setHeader`.
  const writeHead = res.writeHead;
  res.writeHead = function guardedWriteHead(status, ...rest) {
    const index = rest.findIndex(Array.isArray);
    const raw = index >= 0 ? rest[index] : [];
    const theirs = [];
    const others = [];
    for (let at = 0; at + 1 < raw.length; at += 2)
      if (String(raw[at]).toLowerCase() === CSP_HEADER) theirs.push(raw[at + 1]);
      else others.push(raw[at], raw[at + 1]);
    if (theirs.length && !this.headersSent) {
      this.setHeader(CSP_HEADER, theirs.flat());
      rest = [...rest.slice(0, index), others, ...rest.slice(index + 1)];
    }
    return writeHead.call(this, status, ...rest);
  };
  if (!res.headersSent) setHeader.call(res, CSP_HEADER, FRAME_POLICY);
  return res;
}

function install() {
  const marker = Symbol.for("agentbros.studio.loopback");
  if (net.Server.prototype[marker]) return;
  const listen = net.Server.prototype.listen;
  Object.defineProperty(net.Server.prototype, marker, { value: true });
  /** Every TCP port this process listens on: an Origin must name one of them. */
  const ports = new Set();
  net.Server.prototype.listen = function loopbackListen(...args) {
    this.once("listening", () => {
      const address = this.address();
      if (!address || typeof address !== "object") return;
      ports.add(address.port);
      this.once("close", () => ports.delete(address.port));
    });
    return listen.apply(this, rewriteListenArgs(args));
  };
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function guardedEmit(event, ...args) {
    if (event === "request" || event === "upgrade") {
      const [req, second] = args;
      if (event === "request") guardResponse(second);
      const why = refusal(req.method, req.headers || {}, ports);
      if (!why && event === "request" && req.method === "GET" && req.url === IDENTITY_PATH) {
        second.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        second.end(JSON.stringify({ pid: process.pid, key: process.env.AGENTBROS_STUDIO_KEY || null }));
        return true;
      }
      if (why) {
        if (event === "request") {
          second.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          second.end(`Forbidden: ${why}\n`);
        } else {
          second.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        }
        return true;
      }
    }
    return emit.call(this, event, ...args);
  };
}

module.exports = {
  IDENTITY_PATH,
  FRAME_POLICY,
  isLoopbackHost,
  loopbackHost,
  rewriteListenArgs,
  refusal,
  hostnameOf,
  withFramePolicy,
  guardResponse,
  install,
};
