/**
 * Search and download Lottie animations from LottieFiles.
 * NO API KEY REQUIRED — uses public GraphQL endpoint.
 *
 * stdout: one JSON line — { ok, outputs, metadata, elapsedMs }
 * stderr: free-form progress visible when running interactively
 *
 * Usage:
 *   pnpm tsx scripts/fetch-lottie.ts --query "confetti"
 *   pnpm tsx scripts/fetch-lottie.ts --query "loading spinner" --download 2
 *   pnpm tsx scripts/fetch-lottie.ts --query "checkmark" --download 1 --target-path public/projects/my-proj/assets/lottie/check.json
 *
 * Options:
 *   --query        Search query (required)
 *   --download     Number of animations to download (default: 1)
 *   --target-path  Write the first downloaded file to this exact path (requires --download 1)
 *   --output-dir   Override default output directory
 *   --force        Overwrite existing files
 */

import path from "node:path";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { parseArgs, runScript, emitProgress, withRetry, CliErrorObject, relativisePath } from "../src/lib/cli/index.js";
import { searchAnimations, downloadAnimation, type LottieAnimation } from "../src/lib/apis/lottiefiles.js";

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
    name: "download",
    type: "number" as const,
    default: 1,
    description: "Number of animations to download",
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

type LottieResult = {
  name: string;
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
  const query = args["query"] as string;
  const force = args["force"] as boolean;

  const outputDir = (args["output-dir"] as string | undefined) ?? path.join("public", "shared", "lottie");

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

  emitProgress(`LottieFiles search: "${query}"`);

  const data = await withRetry(() => searchAnimations(query, { limit: Math.max(downloadCount, 10) }), {
    attempts: 3,
    backoffMs: 5_000,
  });

  emitProgress(`Found ${data.total} animations`);

  const toDownload = data.animations.slice(0, downloadCount).filter((a) => a.lottieUrl);
  const resultItems: LottieResult[] = [];
  const absPaths: string[] = [];

  for (let i = 0; i < toDownload.length; i++) {
    const anim: LottieAnimation = toDownload[i];
    const safeName = anim.name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    const filename = `${safeName}-${anim.id}.json`;
    const absPath = path.resolve(outputDir, filename);

    emitProgress(`Downloading ${i + 1}/${toDownload.length}: "${anim.name}"`);

    await withRetry(() => downloadAnimation(anim, absPath), { attempts: 3, backoffMs: 5_000 });

    const sizeBytes = statSync(absPath).size;
    const localPath = relativisePath(absPath);

    absPaths.push(absPath);
    resultItems.push({
      name: anim.name,
      url: anim.lottieUrl,
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
      source: "lottiefiles",
      query,
      downloaded: resultItems.length,
      results: resultItems,
    },
  };
});
