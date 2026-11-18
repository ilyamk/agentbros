import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The explicit cache override, if any: `AGENTBROS_MODEL_CACHE`, then the deprecated `AI_VIDEO_CREATOR_MODEL_CACHE`. */
export function modelCacheOverride(): string | undefined {
  return process.env.AGENTBROS_MODEL_CACHE ?? process.env.AI_VIDEO_CREATOR_MODEL_CACHE;
}

/** Shared cache, with an explicit override and an atomic migration of the legacy directory. */
export function cacheRoot(home = homedir()): string {
  const override = modelCacheOverride();
  if (override !== undefined) return override;
  const directory = path.join(home, ".cache", "agentbros");
  const legacy = path.join(home, ".cache", "ai-video-creator");
  if (existsSync(directory) || !existsSync(legacy)) return directory;
  try {
    renameSync(legacy, directory);
    return directory;
  } catch (error) {
    // Another process may have completed the migration while this one was starting.
    if (existsSync(directory)) return directory;
    if (!existsSync(legacy)) return directory;
    console.warn(
      `[warning] Could not migrate cache ${legacy} to ${directory}; continuing to use ${legacy}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return legacy;
  }
}
