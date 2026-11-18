/**
 * Fetch sound effects from Freesound.org for video production.
 *
 * stdout: one JSON line — { ok, outputs, metadata, elapsedMs }
 * stderr: free-form progress visible when running interactively
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/fetch-sound-effects.ts --query "whoosh"
 *   pnpm tsx --env-file=.env scripts/fetch-sound-effects.ts --query "click" --commercial --max-duration 3
 *   pnpm tsx --env-file=.env scripts/fetch-sound-effects.ts --query "ambient office" --download 3
 *   pnpm tsx --env-file=.env scripts/fetch-sound-effects.ts --query "whoosh" --download 1 --target-path public/projects/my-proj/assets/sfx/whoosh.mp3
 *
 * Options:
 *   --query          Search query (required)
 *   --commercial     Only CC0 licensed (safe for commercial use)
 *   --max-duration   Maximum duration in seconds
 *   --download       Number of results to download (default: 1)
 *   --target-path    Write the first downloaded file to this exact path (requires --download 1)
 *   --output-dir     Override default output directory
 *   --force          Overwrite existing files
 */

import path from "node:path";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import {
  parseArgs,
  runScript,
  emitProgress,
  withRetry,
  requireEnv,
  CliErrorObject,
  relativisePath,
} from "../src/lib/cli/index.js";
import { searchSounds, downloadPreview, type FreesoundResult } from "../src/lib/apis/freesound.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "query",
    required: true as const,
    description: "Search query",
  },
  {
    name: "commercial",
    type: "boolean" as const,
    default: false,
    description: "Only CC0 licensed sounds (safe for commercial use)",
  },
  {
    name: "max-duration",
    type: "number" as const,
    description: "Maximum duration in seconds",
  },
  {
    name: "download",
    type: "number" as const,
    default: 1,
    description: "Number of results to download",
  },
  {
    name: "target-path",
    description: "Exact destination path for the first downloaded file (requires --download 1)",
  },
  {
    name: "output-dir",
    description: "Override default output directory",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite existing files",
  },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SfxResult = {
  id: number;
  name: string;
  license: string;
  duration: number;
  url: string;
  localPath: string;
  sizeBytes: number;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const downloadCount = args["download"] as number;
  const targetPath = args["target-path"] as string | undefined;
  const commercial = args["commercial"] as boolean;
  const maxDuration = args["max-duration"] as number | undefined;
  const query = args["query"] as string;
  const force = args["force"] as boolean;

  const outputDir = (args["output-dir"] as string | undefined) ?? path.join("public", "shared", "sfx");

  // Pre-flight: --target-path requires --download 1
  if (targetPath !== undefined && downloadCount > 1) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--target-path is only valid with --download 1 (ambiguous with multiple files)",
    });
  }

  // Pre-flight: --target-path + existing file without --force
  if (targetPath !== undefined && !force && existsSync(targetPath)) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Target path already exists: ${targetPath}. Pass --force to overwrite.`,
    });
  }

  // API key check after pre-flight arg validation
  requireEnv("FREESOUND_API_KEY");

  emitProgress(`Freesound search: "${query}"${commercial ? " (CC0 only)" : ""}`);

  const data = await withRetry(
    () =>
      searchSounds(query, {
        perPage: Math.max(downloadCount, 10),
        commercialOnly: commercial,
        maxDuration: maxDuration,
      }),
    { attempts: 3, backoffMs: 5_000 },
  );

  emitProgress(`Found ${data.count} sounds`);

  const toDownload = data.results.slice(0, downloadCount);
  const resultItems: SfxResult[] = [];
  const absPaths: string[] = [];

  for (let i = 0; i < toDownload.length; i++) {
    const s: FreesoundResult = toDownload[i];
    const safeName = s.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    const filename = `freesound-${s.id}-${safeName}.mp3`;
    const absPath = path.resolve(outputDir, filename);

    emitProgress(`Downloading ${i + 1}/${toDownload.length}: "${s.name}" (${s.duration.toFixed(1)}s)`);

    await withRetry(() => downloadPreview(s, absPath), { attempts: 3, backoffMs: 5_000 });

    const sizeBytes = statSync(absPath).size;
    const localPath = relativisePath(absPath);
    const licenceShort = s.license.includes("zero")
      ? "CC0"
      : (s.license.split("/").filter(Boolean).slice(-2, -1)[0] ?? s.license);

    absPaths.push(absPath);
    resultItems.push({
      id: s.id,
      name: s.name,
      license: licenceShort,
      duration: s.duration,
      url: s.url,
      localPath,
      sizeBytes,
    });

    emitProgress(`Saved: ${localPath} (${(sizeBytes / 1024).toFixed(1)} KB)`);
  }

  // Handle --target-path: rename the first downloaded file
  if (targetPath !== undefined && absPaths.length > 0) {
    const absTarget = path.resolve(targetPath);
    mkdirSync(path.dirname(absTarget), { recursive: true });
    renameSync(absPaths[0], absTarget);
    const relTarget = relativisePath(absTarget);
    resultItems[0].localPath = relTarget;
    absPaths[0] = absTarget;
    emitProgress(`Moved to target path: ${relTarget}`);
  }

  const outputs = resultItems.map((r) => r.localPath);

  return {
    outputs,
    metadata: {
      source: "freesound",
      query,
      downloaded: resultItems.length,
      results: resultItems,
    },
  };
});
