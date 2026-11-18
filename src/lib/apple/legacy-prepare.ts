import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { atomicJson, fileHash } from "./runtime";
import { LocalVisualConfigSchema, probeLocalVisual } from "../ingest/local-visual";
import { LocalCategoryConfigSchema, probeLocalCategory } from "../ingest/local-category";
export async function prepareLegacyVision(engine: "visual" | "category", root: string, dryRun = false) {
  const source = path.resolve(import.meta.dirname, `../../../scripts/workers/frame-${engine}.swift`),
    directory = path.join(root, engine),
    executable = path.join(directory, `bin/frame-${engine}`),
    workerSource = path.join(directory, `workers/frame-${engine}.swift`),
    configFile = path.join(directory, "config.json");
  if (process.platform !== "darwin") return { available: false, reason: "Apple Vision requires macOS" };
  if (dryRun)
    return {
      available: existsSync(configFile),
      configFile,
      plan: {
        downloads: [],
        steps: [`Compile frame-${engine}.swift`, "Probe the pinned executable and write its configuration"],
      },
    };
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(path.dirname(workerSource), { recursive: true });
  copyFileSync(source, workerSource);
  const temporary = executable + ".tmp";
  try {
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-O", workerSource, "-o", temporary], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    if (build.status !== 0)
      throw new Error(`Swift preparation failed: ${build.error?.message ?? build.stderr.slice(-2000)}`);
    renameSync(temporary, executable);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const base = {
    executable: realpathSync(executable),
    executableHash: fileHash(executable),
    workerSource: realpathSync(workerSource),
    workerSourceHash: fileHash(workerSource),
    revision: 2 as const,
    maxFrames: 32,
    timeoutMs: 120000,
  };
  const config =
    engine === "visual"
      ? LocalVisualConfigSchema.parse({ ...base, engine: "apple-vision-feature-print" })
      : LocalCategoryConfigSchema.parse({ ...base, engine: "apple-vision-classification" });
  const status =
    engine === "visual"
      ? await probeLocalVisual(LocalVisualConfigSchema.parse(config))
      : await probeLocalCategory(LocalCategoryConfigSchema.parse(config));
  if (!status.available) return status;
  atomicJson(configFile, config);
  return { available: true, configFile, identityHash: status.identityHash };
}
