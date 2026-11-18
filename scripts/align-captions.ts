/**
 * Run ElevenLabs forced alignment on per-scene voiceover files, writing
 * word-level timestamp JSON alongside each MP3.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/align-captions.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/align-captions.ts --project <id> --scene <sceneId>
 *   pnpm tsx --env-file=.env scripts/align-captions.ts --project <id> --force
 *
 * Options:
 *   --project   Project ID (required)
 *   --scene     Align a single scene only (optional)
 *   --force     Overwrite existing .words.json files
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractPresenterAudio } from "../src/lib/presenter-audio.js";
import { compileTimeline } from "../src/lib/timeline.js";

import {
  parseArgs,
  runScript,
  emitProgress,
  withRetry,
  requireEnv,
  requireProject,
  CliErrorObject,
  relativisePath,
  ensureFfmpeg,
} from "../src/lib/cli/index.js";

import { loadProject } from "../src/lib/project.js";
import { alignAndSave } from "../src/lib/elevenlabs/tts.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "max-cost-usd",
    type: "number",
    description: "Explicit per-operation planning bound for unknown audio prices",
  },
  { name: "operation-id", description: "Stable paid operation ID (per-scene suffix where applicable)" },
  {
    name: "project",
    short: "p",
    required: true,
    description: "Project ID",
  },
  {
    name: "scene",
    description: "Align a single scene only",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite existing .words.json files",
  },
] as const;

// ---------------------------------------------------------------------------
// Per-scene result type
// ---------------------------------------------------------------------------

type SceneResult = {
  sceneId: string;
  status: "aligned" | "skipped" | "failed";
  reason?: "voiceover-missing" | "empty-text" | "already-aligned";
  wordCount?: number;
  outputPath?: string;
  elapsedMs?: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project!;

  requireProject(projectId);

  const project = loadProject(projectId);

  // Apply --scene filter (validated before API key check so bad scene IDs
  // surface an INVALID_INPUT error rather than MISSING_API_KEY)
  const filterScene = typeof args.scene === "string" ? args.scene : undefined;
  const scenes = filterScene ? project.scenes.filter((s) => s.id === filterScene) : project.scenes;

  if (filterScene && scenes.length === 0) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Scene "${filterScene}" not found in project "${projectId}". Available: ${project.scenes.map((s) => s.id).join(", ")}`,
      details: { project: projectId, scene: filterScene },
    });
  }

  const embedded = project.talkingHead?.enabled && project.talkingHead.audioSource === "embedded";
  const timeline = embedded ? compileTimeline(project.scenes, { talkingHead: true }) : undefined;
  const presenterPath = embedded ? path.resolve("public", project.talkingHead!.presenterVideo) : undefined;
  if (presenterPath) {
    const relative = path.relative(path.resolve("public"), presenterPath);
    if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Presenter video must be inside public/" });
    }
  }
  if (presenterPath && !existsSync(presenterPath))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Presenter video not found: ${presenterPath}` });
  if (embedded) ensureFfmpeg();
  requireEnv("ELEVENLABS_API_KEY");

  emitProgress(`Aligning captions for project: ${projectId}`);
  emitProgress(`Scenes: ${scenes.map((s) => s.id).join(", ")}`);

  const force = args.force as boolean;
  const voiceoverDir = path.join("public", "projects", projectId, "voiceover");

  const perScene: SceneResult[] = [];
  const alignedPaths: string[] = [];

  let alignedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    let audioPath = path.join(voiceoverDir, `${scene.id}.mp3`);
    let temporaryAudioDir: string | undefined;
    const outputJsonPath = path.join(voiceoverDir, `${scene.id}.words.json`);

    // Skip: voiceover file absent
    if (!embedded && !existsSync(audioPath)) {
      emitProgress(`[${scene.id}] (${i + 1}/${scenes.length}) skipping — voiceover not found`);
      perScene.push({ sceneId: scene.id, status: "skipped", reason: "voiceover-missing" });
      skippedCount++;
      continue;
    }

    // Skip: no text in scene config
    if (!scene.text) {
      emitProgress(`[${scene.id}] (${i + 1}/${scenes.length}) skipping — no text in scene config`);
      perScene.push({ sceneId: scene.id, status: "skipped", reason: "empty-text" });
      skippedCount++;
      continue;
    }

    // Skip: already aligned and not forced
    const existing = existsSync(outputJsonPath)
      ? (JSON.parse(readFileSync(outputJsonPath, "utf8")) as { audioSource?: string })
      : undefined;
    if (existing && !force && (!embedded || existing.audioSource === "embedded")) {
      emitProgress(`[${scene.id}] (${i + 1}/${scenes.length}) skipping — already aligned (use --force to overwrite)`);
      perScene.push({ sceneId: scene.id, status: "skipped", reason: "already-aligned" });
      skippedCount++;
      continue;
    }

    emitProgress(`[${scene.id}] (${i + 1}/${scenes.length}) aligning…`);

    const unitStart = Date.now();
    try {
      const entry = timeline?.entries.find((e) => e.scene.id === scene.id);
      if (embedded && entry) {
        temporaryAudioDir = mkdtempSync(path.join(os.tmpdir(), "presenter-alignment-"));
        audioPath = path.join(temporaryAudioDir, "speech.wav");
        extractPresenterAudio(presenterPath!, audioPath, entry);
      }
      await withRetry(
        async () => {
          await alignAndSave({
            audioPath,
            text: scene.text!,
            outputJsonPath,
            paid: {
              projectId,
              operationId: args["operation-id"] ? `${args["operation-id"]}:${scene.id}` : undefined,
              maxCostUsd: args["max-cost-usd"],
            },
          });
        },
        {
          attempts: 3,
          backoffMs: 5_000,
          factor: 2,
          retryOn: ["RATE_LIMIT", "NETWORK"],
        },
      );

      const result = JSON.parse(readFileSync(outputJsonPath, "utf-8")) as { words: unknown[] };
      writeFileSync(
        outputJsonPath,
        JSON.stringify(
          {
            ...result,
            audioSource: embedded ? "embedded" : "elevenlabs",
            sourceStartSec: entry ? entry.sourceStartFrame / 30 : 0,
          },
          null,
          2,
        ) + "\n",
      );
      const wordCount = result.words.length;
      const elapsedMs = Date.now() - unitStart;
      const relPath = relativisePath(path.resolve(outputJsonPath));

      emitProgress(`[${scene.id}] done — ${wordCount} words in ${elapsedMs}ms`);

      perScene.push({
        sceneId: scene.id,
        status: "aligned",
        wordCount,
        outputPath: relPath,
        elapsedMs,
      });
      alignedPaths.push(relPath);
      alignedCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitProgress(`[${scene.id}] FAILED — ${message}`);
      perScene.push({ sceneId: scene.id, status: "failed", error: message });
      failedCount++;
    } finally {
      if (temporaryAudioDir) rmSync(temporaryAudioDir, { recursive: true, force: true });
    }
  }

  // If every scene that was attempted (not skipped) failed, surface a hard error
  if (alignedCount === 0 && failedCount > 0) {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `All ${failedCount} scene(s) failed alignment. See metadata.perScene for details.`,
      details: { perScene },
    });
  }

  return {
    outputs: alignedPaths,
    metadata: {
      projectId,
      audioSource: embedded ? "embedded" : "elevenlabs",
      aligned: alignedCount,
      skipped: skippedCount,
      failed: failedCount,
      perScene,
    },
  };
});
