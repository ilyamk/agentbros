/**
 * The console's UI bundle (RFC 0004 D4): built by Vite from `apps/console/` into `out/console/dist/` (one
 * `index.html`, `app.js` and `style.css`), stamped with the bundle version, the hash of the UI sources. The server
 * version adds the hash of the server sources; a running server with another version is replaced (D16).
 * Light on purpose: `ensureConsoleServer` (every `pnpm next`) hashes the sources but never loads Vite.
 * Every build is verified before it replaces the served folder ({@link verifyConsoleBundle}): exactly the three files,
 * no inline script or style, no `data:`/`blob:` URLs, no remote URLs or fonts (strict CSP, RU-H01/H04).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CONSOLE_DIST_DIR } from "../../types/console";

export const CONSOLE_APP_DIR = "apps/console";
export const CONSOLE_VITE_CONFIG = "apps/console/vite.config.mts";
/** Written into the dist folder after a successful build. */
export const BUNDLE_VERSION_FILE = ".bundle-version";
export const BUNDLE_FILES = ["index.html", "app.js", "style.css"] as const;

/** The checkout this module belongs to (sources, node_modules). */
export const codeRoot = () => path.resolve(import.meta.dirname, "../../..");

const SKIP_DIRS = new Set(["node_modules", "e2e", "dist", "test-results", "playwright-report", ".vite"]);

function walk(directory: string, root: string, files: string[]) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(file, root, files);
    } else if (entry.isFile() && !/\.test\.[cm]?tsx?$/.test(entry.name) && !entry.name.startsWith("."))
      files.push(path.relative(root, file).split(path.sep).join("/"));
  }
}

function hashFiles(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file + "\0");
    try {
      hash.update(readFileSync(path.join(root, file)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Files that make the UI bundle: `apps/console/` (no tests, e2e or build output), the contract, the tokens, the
 * server's URL shapes (the UI imports `urls.ts`) and the review:ui browser modules the timeline view imports.
 */
export function bundleSourceFiles(root = codeRoot()): string[] {
  const files: string[] = [];
  walk(path.join(root, CONSOLE_APP_DIR), root, files);
  for (const file of [
    "src/types/console.ts",
    "src/lib/design-tokens.ts",
    "src/lib/console/urls.ts",
    // The metrics page parses `/api/metrics` with this schema (WP12).
    "src/lib/console/metrics-schema.ts",
    // The timeline view imports these review:ui browser modules (`@review/*`, WP13).
    "src/lib/review-ui/pointer.ts",
    "src/lib/review-ui/realtime-channel-client.ts",
  ])
    if (existsSync(path.join(root, file))) files.push(file);
  return files;
}

/** Hash of the UI sources (hex). */
export const bundleHash = (root = codeRoot()) => hashFiles(root, bundleSourceFiles(root));

/** Hash of the server sources: `src/lib/console/`, `src/lib/local-server/` and the review services it hosts (hex). */
export function serverHash(root = codeRoot()): string {
  const files: string[] = [];
  walk(path.join(root, "src/lib/console"), root, files);
  walk(path.join(root, "src/lib/local-server"), root, files);
  walk(path.join(root, "src/lib/review-ui"), root, files);
  return hashFiles(root, files);
}

/** `<package version>+<bundle hash 12>.<server hash 8>`: the lock's `version` (D16). */
export function consoleVersion(root = codeRoot()): { version: string; bundle: string } {
  let pkg = "0.0.0";
  try {
    pkg = String((JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }).version);
  } catch {
    // keep the placeholder
  }
  const bundle = bundleHash(root);
  return { version: `${pkg}+${bundle.slice(0, 12)}.${serverHash(root).slice(0, 8)}`, bundle };
}

export const distDirOf = (rootDir: string) => path.join(rootDir, CONSOLE_DIST_DIR);

export type DistState = "fresh" | "missing" | "stale";

/** Whether `distDir` holds the three files stamped with `bundle`. */
export function distState(distDir: string, bundle: string): DistState {
  if (!BUNDLE_FILES.every((file) => existsSync(path.join(distDir, file)))) return "missing";
  try {
    return readFileSync(path.join(distDir, BUNDLE_VERSION_FILE), "utf8").trim() === bundle ? "fresh" : "stale";
  } catch {
    return "stale";
  }
}

export type BundleFinding = { file: string; problem: string };

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>/i;
const INLINE_STYLE = /<style\b/i;
const STYLE_ATTR = /\sstyle\s*=/i;
const EVENT_ATTR = /\son[a-z]+\s*=/i;
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+[;,]/i;
const BLOB_URI = /\bblob:/i;
const REMOTE_REF = /(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i;
const CSS_REMOTE = /@import|url\(\s*["']?(?:https?:)?\/\//i;
const FONT_FACE = /@font-face/i;

/**
 * Everything that stops the server from serving `dir` under the strict CSP; empty when it may. The version stamp
 * (`.bundle-version`) is allowed beside the three files; anything else (a split chunk, an asset) is a finding.
 */
export function verifyConsoleBundle(dir: string): BundleFinding[] {
  if (!existsSync(dir)) return [{ file: ".", problem: "bundle directory missing" }];
  const findings: BundleFinding[] = [];
  for (const name of readdirSync(dir))
    if (name !== BUNDLE_VERSION_FILE && !(BUNDLE_FILES as readonly string[]).includes(name))
      findings.push({ file: name, problem: "unexpected file" });
  for (const name of BUNDLE_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      findings.push({ file: name, problem: "missing" });
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (DATA_URI.test(text)) findings.push({ file: name, problem: "data: URL" });
    if (name !== "app.js" && BLOB_URI.test(text)) findings.push({ file: name, problem: "blob: URL" });
    if (name === "index.html") {
      if (INLINE_SCRIPT.test(text)) findings.push({ file: name, problem: "inline <script>" });
      if (INLINE_STYLE.test(text)) findings.push({ file: name, problem: "inline <style>" });
      if (STYLE_ATTR.test(text)) findings.push({ file: name, problem: "style attribute" });
      if (EVENT_ATTR.test(text)) findings.push({ file: name, problem: "inline event handler" });
      if (REMOTE_REF.test(text)) findings.push({ file: name, problem: "remote URL" });
      if (!/<script\b[^>]*\bsrc=["']?\.?\/?app\.js/i.test(text))
        findings.push({ file: name, problem: "does not load app.js" });
      if (!/<link\b[^>]*\bhref=["']?\.?\/?style\.css/i.test(text))
        findings.push({ file: name, problem: "does not load style.css" });
    }
    if (name === "style.css") {
      if (CSS_REMOTE.test(text)) findings.push({ file: name, problem: "remote @import or url()" });
      if (FONT_FACE.test(text)) findings.push({ file: name, problem: "@font-face (system fonts only)" });
    }
  }
  return findings;
}

export interface BuildResult {
  ok: boolean;
  bundle: string;
  distDir: string;
  built: boolean;
  elapsedMs: number;
  error?: string;
  /** Why a built bundle was refused (the served folder is left as it was). */
  findings?: BundleFinding[];
}

/**
 * Builds the bundle into a temporary folder next to `distDir`, checks the three files, stamps the version and swaps
 * it into place. Skips the build when the stamp matches (unless `force`). Never throws: failures come back as `error`.
 */
export async function buildConsoleBundle(options: {
  distDir: string;
  root?: string;
  force?: boolean;
  log?: (line: string) => void;
}): Promise<BuildResult> {
  try {
    return await buildOnce(options);
  } catch (error) {
    return {
      ok: false,
      built: false,
      bundle: "",
      distDir: options.distDir,
      elapsedMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildOnce(options: {
  distDir: string;
  root?: string;
  force?: boolean;
  log?: (line: string) => void;
}): Promise<BuildResult> {
  const started = performance.now();
  const root = options.root ?? codeRoot();
  const bundle = bundleHash(root);
  const done = (result: Omit<BuildResult, "bundle" | "distDir" | "elapsedMs">): BuildResult => ({
    ...result,
    bundle,
    distDir: options.distDir,
    elapsedMs: Math.round(performance.now() - started),
  });
  if (!options.force && distState(options.distDir, bundle) === "fresh") return done({ ok: true, built: false });
  let vite: string;
  try {
    vite = path.join(
      path.dirname(createRequire(path.join(root, "package.json")).resolve("vite/package.json")),
      "bin/vite.js",
    );
  } catch {
    return done({ ok: false, built: false, error: "Vite is not installed; run pnpm install." });
  }
  const staging = `${options.distDir}.build-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.dirname(staging), { recursive: true });
  const args = [
    vite,
    "build",
    "--config",
    path.join(root, CONSOLE_VITE_CONFIG),
    "--outDir",
    staging,
    "--emptyOutDir",
    "--logLevel",
    "warn",
  ];
  const output: string[] = [];
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output.push(text);
      options.log?.(text.trimEnd());
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  const missing = BUNDLE_FILES.filter((file) => !existsSync(path.join(staging, file)));
  if (code !== 0 || missing.length) {
    rmSync(staging, { recursive: true, force: true });
    const tail = output.join("").trim().split("\n").slice(-12).join("\n");
    return done({
      ok: false,
      built: false,
      error:
        code !== 0
          ? `Vite build failed (exit ${code}).${tail ? `\n${tail}` : ""}`
          : `The build did not produce ${missing.join(", ")} (one index.html, app.js and style.css are required).`,
    });
  }
  const findings = verifyConsoleBundle(staging);
  if (findings.length) {
    rmSync(staging, { recursive: true, force: true });
    return done({
      ok: false,
      built: false,
      findings,
      error: `The built bundle is not servable: ${findings.map((item) => `${item.file}: ${item.problem}`).join("; ")}.`,
    });
  }
  writeFileSync(path.join(staging, BUNDLE_VERSION_FILE), bundle + "\n");
  rmSync(options.distDir, { recursive: true, force: true });
  renameSync(staging, options.distDir);
  return done({ ok: true, built: true });
}

/** The three files of a fresh dist, read into memory, or undefined. */
export function readDist(distDir: string): { html: string; js: Buffer; css: Buffer; mtimeMs: number } | undefined {
  try {
    return {
      html: readFileSync(path.join(distDir, "index.html"), "utf8"),
      js: readFileSync(path.join(distDir, "app.js")),
      css: readFileSync(path.join(distDir, "style.css")),
      mtimeMs: statSync(path.join(distDir, "index.html")).mtimeMs,
    };
  } catch {
    return undefined;
  }
}
