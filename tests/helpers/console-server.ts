/**
 * Fixtures for the console server suites (RFC 0004 WP2): a temporary checkout-like root with one project and a
 * prebuilt fake bundle, an in-process server on port 0, and raw HTTP requests (no URL normalisation, any Host).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUNDLE_VERSION_FILE } from "../../src/lib/console/bundle";
import { startConsoleServer, type ConsoleServer, type ConsoleServerOptions } from "../../src/lib/console/server";

export const TEST_BUNDLE = "test-bundle";
export const PROJECT = "demo-film";

/** A temporary root with `public/projects/demo-film/project.json` and a fake `out/console/dist`. */
export function makeRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-console-")));
  const project = path.join(root, "public/projects", PROJECT);
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), JSON.stringify({ title: "Demo film" }));
  const dist = path.join(root, "out/console/dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    path.join(dist, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>Console</title><script type="module" src="./app.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(path.join(dist, "app.js"), "console.log('app');\n");
  writeFileSync(path.join(dist, "style.css"), "body{margin:0}\n");
  writeFileSync(path.join(dist, BUNDLE_VERSION_FILE), TEST_BUNDLE + "\n");
  return root;
}

export const removeRoot = (root: string) => rmSync(root, { recursive: true, force: true });

export async function startTestServer(
  root: string,
  options: Partial<ConsoleServerOptions> = {},
): Promise<ConsoleServer> {
  return startConsoleServer({
    rootDir: root,
    port: 0,
    bundle: TEST_BUNDLE,
    build: false,
    version: "test-version",
    ...options,
  });
}

export interface RawResponse {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => any;
}

/** One request with a literal path and exact headers (Host defaults to 127.0.0.1:<port>). */
export function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { Host: `127.0.0.1:${port}`, ...options.headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Headers of an authenticated same-origin POST. */
export const postHeaders = (server: ConsoleServer, extra: Record<string, string> = {}) => ({
  "x-console-token": server.token,
  Origin: server.origin,
  "Content-Type": "application/json",
  ...extra,
});
