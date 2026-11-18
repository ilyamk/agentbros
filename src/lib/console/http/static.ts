/**
 * The three unauthenticated files of the console (`/`, `/app.js`, `/style.css`, RFC 0004 D15) from
 * `out/console/dist`. `index.html` gets a per-response nonce as `<meta name="csp-nonce">` and in the CSP's `style-src`
 * (Radix's style singleton reads it through get-nonce). While the bundle is missing, building or failed, `/` is a
 * plain error page and the API keeps working.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { contentSecurityPolicy, newNonce } from "../../local-server/security";
import { buildConsoleBundle, distState, readDist, type BuildResult } from "../bundle";

export type BundleState =
  | { kind: "ready"; html: string; js: Buffer; css: Buffer }
  | { kind: "building" }
  | { kind: "missing" }
  | { kind: "failed"; error: string };

export interface StaticBundleOptions {
  distDir: string;
  /** Hash of the UI sources the dist must be stamped with. */
  bundle: string;
  /** Build when missing or stale (default true); a test passes false and a prebuilt dist. */
  build?: boolean;
  /** Overrides the build (tests). */
  builder?: () => Promise<BuildResult>;
  log?: (line: string) => void;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Injects the nonce meta right after `<head>` (or at the top when there is none). */
export function injectNonce(html: string, nonce: string): string {
  const meta = `<meta name="csp-nonce" content="${nonce}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}\n    ${meta}`) : meta + html;
}

export class StaticBundle {
  state: BundleState = { kind: "missing" };
  /** Settles when the first load or build attempt is over. */
  readonly ready: Promise<void>;

  constructor(private readonly options: StaticBundleOptions) {
    this.ready = this.load();
  }

  private lastCheck = 0;

  private async load(): Promise<void> {
    try {
      await this.loadOnce();
    } catch (error) {
      // A build or read error never takes the server down: `/` explains it and re-checks the dist later.
      this.state = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      this.options.log?.(`console bundle unavailable: ${this.state.error}`);
    }
  }

  /** While failed or missing, a fresh dist built since (pnpm console:build) is picked up, at most once a second. */
  private recheck(): void {
    if (this.state.kind !== "failed" && this.state.kind !== "missing") return;
    const now = performance.now();
    if (now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    try {
      if (distState(this.options.distDir, this.options.bundle) !== "fresh") return;
      const files = readDist(this.options.distDir);
      if (files) this.state = { kind: "ready", ...files };
    } catch {
      // keep the current state
    }
  }

  private async loadOnce(): Promise<void> {
    const { distDir, bundle } = this.options;
    if (distState(distDir, bundle) !== "fresh" && this.options.build !== false) {
      this.state = { kind: "building" };
      this.options.log?.("console bundle missing or stale: building");
      const result = await (this.options.builder ?? (() => buildConsoleBundle({ distDir, log: this.options.log })))();
      if (!result.ok) {
        this.state = { kind: "failed", error: result.error ?? "The console bundle could not be built." };
        this.options.log?.(`console bundle build failed: ${result.error ?? "unknown error"}`);
        return;
      }
      this.options.log?.(`console bundle built in ${result.elapsedMs} ms`);
    }
    const files = readDist(distDir);
    this.state = files ? { kind: "ready", ...files } : { kind: "missing" };
  }

  /** Serves `/`, `/index.html`, `/app.js` or `/style.css`; false when `name` is none of them. */
  serve(req: IncomingMessage, res: ServerResponse, name: string): boolean {
    if (!["", "index.html", "app.js", "style.css"].includes(name)) return false;
    const head = req.method === "HEAD";
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...headers });
      res.end(head ? undefined : body);
    };
    this.recheck();
    const state = this.state;
    if (state.kind !== "ready") {
      if (name === "app.js" || name === "style.css") {
        send(503, "text/plain; charset=utf-8", "The console bundle is not available.\n");
        return true;
      }
      const message =
        state.kind === "building"
          ? "The console is being built. Reload this page in a few seconds."
          : state.kind === "failed"
            ? "The console bundle could not be built. The server and its API are running; run pnpm console:build to see the error."
            : "The console bundle is missing. Run pnpm console:build, then reload.";
      const detail = state.kind === "failed" ? `<pre>${escapeHtml(state.error.slice(0, 4000))}</pre>` : "";
      send(
        503,
        "text/html; charset=utf-8",
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Console unavailable</title></head><body><h1>Console unavailable</h1><p>${escapeHtml(message)}</p>${detail}</body></html>`,
      );
      return true;
    }
    if (name === "app.js") send(200, "text/javascript; charset=utf-8", state.js);
    else if (name === "style.css") send(200, "text/css; charset=utf-8", state.css);
    else {
      const nonce = newNonce();
      send(200, "text/html; charset=utf-8", injectNonce(state.html, nonce), {
        "Content-Security-Policy": contentSecurityPolicy({ styleNonce: nonce, fonts: true }),
      });
    }
    return true;
  }
}
