/**
 * Measure voiceover durations for a project using ffprobe.
 *
 * Exported as a reusable library so both the CLI script and any
 * agent can import it directly.
 */

import { existsSync, readdirSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";

const PROJECTS_DIR = path.join("public", "projects");

/** Throws with a hint if ffprobe is not on PATH. */
export function ensureFfprobe(): void {
  const result = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" });
  if (result.error || result.status !== 0) {
    throw new Error("ffprobe not found. Install it with: brew install ffmpeg");
  }
}

/**
 * Probe one audio file and return its duration in seconds.
 * Throws if ffprobe fails or returns an unparseable value.
 */
export function probeAudioDuration(audioPath: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath],
    { encoding: "utf-8" },
  );

  if (result.error) {
    throw new Error(`ffprobe spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffprobe exited ${result.status ?? "null"} for "${audioPath}": ${result.stderr.trim()}`);
  }

  const raw = result.stdout.trim();
  const value = parseFloat(raw);
  if (isNaN(value)) {
    throw new Error(`ffprobe returned non-numeric duration "${raw}" for "${audioPath}"`);
  }
  return value;
}

/**
 * Measure voiceover durations for a project.
 *
 * @param projectId  - Project directory name under public/projects/
 * @param sceneIds   - Restrict to these scene IDs. If omitted, all scenes with
 *                     a matching MP3 are measured.
 * @returns  Object mapping sceneId → duration in seconds for every MP3 found.
 */
export function measureSceneDurations(projectId: string, sceneIds?: string[]): Record<string, number> {
  const voiceoverDir = path.join(PROJECTS_DIR, projectId, "voiceover");
  const results: Record<string, number> = {};

  const candidates = sceneIds ?? discoverSceneIds(voiceoverDir);

  for (const sceneId of candidates) {
    const audioPath = path.join(voiceoverDir, `${sceneId}.mp3`);
    if (!existsSync(audioPath)) continue;
    results[sceneId] = probeAudioDuration(audioPath);
  }

  return results;
}

/** Scan voiceoverDir for *.mp3 files and return the stems as scene IDs. */
function discoverSceneIds(voiceoverDir: string): string[] {
  if (!existsSync(voiceoverDir)) return [];
  return readdirSync(voiceoverDir)
    .filter((f) => f.endsWith(".mp3"))
    .map((f) => f.slice(0, -4));
}
