/**
 * Measure voiceover MP3 durations for a project using ffprobe.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/measure-audio-durations.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/measure-audio-durations.ts --project <id> --scene <sceneId>
 *
 * Options:
 *   --project   Project ID (required)
 *   --scene     Measure a single scene only (optional)
 *
 * Requires: ffprobe (brew install ffmpeg)
 *
 * Output envelope:
 *   { ok: true, outputs: [], metadata: { projectId, measured, missing, durations, missingScenes, totalDurationSec }, elapsedMs }
 */

import { runScript, parseArgs, emitProgress, requireProject, ensureFfprobe, CliErrorObject } from "../src/lib/cli";
import { loadProject } from "../src/lib/project";
import { measureSceneDurations } from "../src/lib/audio/measure";

const SPECS = [
  {
    name: "project",
    type: "string" as const,
    required: true,
    description: "Project ID",
  },
  {
    name: "scene",
    type: "string" as const,
    required: false,
    description: "Measure a single scene only",
  },
] as const;

runScript(async () => {
  const args = parseArgs(SPECS);

  const projectId = args.project as string;

  // Validate project exists
  requireProject(projectId);

  // Validate ffprobe is available (throws structured FFMPEG_MISSING on miss)
  ensureFfprobe();

  const filterScene = typeof args.scene === "string" ? args.scene : undefined;

  // Load project to get scene list
  const project = loadProject(projectId);

  if (filterScene !== undefined && !project.scenes.find((s) => s.id === filterScene)) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Scene "${filterScene}" not found in project "${projectId}". Available: ${project.scenes.map((s) => s.id).join(", ")}`,
    });
  }

  const sceneIds = filterScene ? [filterScene] : project.scenes.map((s) => s.id);

  emitProgress(`Measuring durations for ${sceneIds.length} scene(s) in project "${projectId}"…`);

  const durations = measureSceneDurations(projectId, sceneIds);

  const measured = Object.keys(durations).length;
  const missingScenes = sceneIds.filter((id) => !(id in durations));
  const totalDurationSec = Object.values(durations).reduce((a, b) => a + b, 0);

  if (measured > 0) {
    emitProgress(`Measured ${measured} scene(s). Missing MP3s: ${missingScenes.length}`);
  } else {
    emitProgress(
      `No voiceover MP3s found for project "${projectId}". Expected at: public/projects/${projectId}/voiceover/{sceneId}.mp3`,
    );
  }

  return {
    outputs: [],
    metadata: {
      projectId,
      measured,
      missing: missingScenes.length,
      durations,
      missingScenes,
      totalDurationSec: Math.round(totalDurationSec * 100) / 100,
    },
  };
});
