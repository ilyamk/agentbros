/**
 * Write a self-contained, read-only HTML snapshot of a project's console view (RFC 0004 D18, WP15, US22):
 * `pnpm console:snapshot --project P` → `out/<id>/console-snapshot.html`.
 *
 * The page is the console bundle (built when stale) with its script and style inlined and the project's view embedded:
 * no token, no server, no live endpoint, no journal; media are named and linked by a path relative to the file, never
 * inlined. Every string is scrubbed (secret flags, `.env` secret values, the session token, the checkout and home
 * folders) and the page is capped in size. Publishing it (for example as a Claude Artifact) is the user's explicit
 * decision, never this command's: the data leaves the machine.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { buildConsoleBundle, distDirOf, readDist } from "../src/lib/console/bundle";
import {
  knownSecrets,
  renderSnapshot,
  scrubSnapshotData,
  snapshotScrubber,
  SnapshotTooLarge,
  SNAPSHOT_FILE,
  SNAPSHOT_MAX_BYTES,
} from "../src/lib/console/snapshot";
import { buildProjectView } from "../src/lib/console/view/build";
import { projectPaths } from "../src/lib/console/view/files";
import { projectSummary } from "../src/lib/console/view/summary";

/** MediaRef-like objects in the view (each becomes a "not included" note on the page). */
function mediaCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + mediaCount(item), 0);
  if (!value || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  const own = typeof object.path === "string" && typeof object.kind === "string" ? 1 : 0;
  return own + Object.values(object).reduce<number>((sum, item) => sum + mediaCount(item), 0);
}

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project to snapshot" },
    {
      name: "bundle-dir",
      description:
        "A prebuilt console bundle folder (index.html, app.js, style.css); default out/console/dist, rebuilt when stale",
    },
    {
      name: "max-bytes",
      type: "number",
      description: `Refuse a page larger than this (default ${SNAPSHOT_MAX_BYTES})`,
    },
  ] as const);
  const rootDir = process.cwd();
  const project = args.project!;
  validateProjectId(project);
  const maxBytes = args["max-bytes"] ?? SNAPSHOT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--max-bytes must be a positive integer" });

  const takenAt = new Date();
  const view = buildProjectView(rootDir, project, { now: takenAt.getTime() });
  if (!view) throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project ${project} not found` });
  const summary = projectSummary(view, projectPaths(rootDir, project));

  let distDir: string;
  if (args["bundle-dir"]) distDir = path.resolve(rootDir, args["bundle-dir"]);
  else {
    distDir = distDirOf(rootDir);
    emitProgress("console:snapshot: checking the console bundle");
    const built = await buildConsoleBundle({ distDir, log: (line) => emitProgress(line) });
    if (!built.ok)
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `The console bundle could not be built: ${built.error ?? "unknown error"}`,
      });
  }
  const dist = readDist(distDir);
  if (!dist)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No console bundle in ${path.relative(rootDir, distDir) || distDir} (index.html, app.js, style.css); run pnpm console:build.`,
    });

  const scrub = snapshotScrubber({ rootDir, secrets: knownSecrets(rootDir) });
  const data = scrubSnapshotData({ v: 1, takenAt: takenAt.toISOString(), view, summary }, scrub);
  let html: string;
  try {
    html = renderSnapshot({ data, js: dist.js.toString("utf8"), css: dist.css.toString("utf8"), maxBytes });
  } catch (error) {
    if (error instanceof SnapshotTooLarge)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: error.message,
        details: { bytes: error.bytes, maxBytes: error.maxBytes },
      });
    throw error;
  }

  const file = path.join(projectPaths(rootDir, project).outDir, SNAPSHOT_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, html, { mode: 0o600 });
  renameSync(temporary, file);
  return {
    outputs: [path.relative(rootDir, file)],
    metadata: {
      project,
      takenAt: data.takenAt,
      bytes: Buffer.byteLength(html),
      maxBytes,
      route: view.project.route,
      waiting: view.waiting.length,
      mediaOmitted: mediaCount(view),
      next: "Open the file in a browser. Share or publish it only when the user explicitly asks: the data leaves the machine (RFC 0004 D18).",
    },
  };
});
