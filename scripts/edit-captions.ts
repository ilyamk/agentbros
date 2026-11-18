/**
 * Apply filler-word removal and emphasis marking to per-scene .words.json
 * files, writing .words.edited.json alongside each one.
 *
 * Also writes pipeline/caption-edit.json aggregating all results.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/edit-captions.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/edit-captions.ts --project <id> --scene <sceneId>
 *   pnpm tsx --env-file=.env scripts/edit-captions.ts --project <id> --language ru
 *   pnpm tsx --env-file=.env scripts/edit-captions.ts --project <id> --force
 *
 * Options:
 *   --project    Project ID (required)
 *   --scene      Process a single scene only (optional)
 *   --language   Override language (en|ru|es); defaults to brief.json or "en"
 *   --force      Overwrite existing .words.edited.json files
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

import {
  parseArgs,
  runScript,
  emitProgress,
  requireProject,
  CliErrorObject,
  relativisePath,
} from "../src/lib/cli/index.js";

import { loadProject } from "../src/lib/project.js";
import { editSceneCaptions } from "../src/lib/audio/edit-captions.js";
import type { WordAlignment } from "../src/lib/elevenlabs/tts.js";
import { BriefSchema, StoryboardSchema, CaptionEditSchema, type SceneCaptionEdit } from "../src/types/pipeline.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "project",
    short: "p",
    required: true,
    description: "Project ID",
  },
  {
    name: "scene",
    description: "Process a single scene only",
  },
  {
    name: "language",
    choices: ["en", "ru", "es"] as const,
    description: "Override language for filler detection",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite existing .words.edited.json files",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load and parse a pipeline JSON artefact. Returns null if missing or unparseable. */
function loadPipelineJson<T>(projectId: string, stem: string): T | null {
  const filePath = path.join("public", "projects", projectId, "pipeline", `${stem}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-scene result shapes (for perScene metadata)
// ---------------------------------------------------------------------------

type PerSceneEdited = {
  sceneId: string;
  status: "edited";
  outputPath: string;
  wordCount: number;
  emphasisCount: number;
  droppedFillers: string[];
};

type PerSceneSkipped = {
  sceneId: string;
  status: "skipped";
  reason: "raw-words-missing" | "already-edited";
  wordCount?: number;
  emphasisCount?: number;
};

type PerSceneFailed = {
  sceneId: string;
  status: "failed";
  error: string;
};

type PerScene = PerSceneEdited | PerSceneSkipped | PerSceneFailed;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project!;

  requireProject(projectId);

  const filterScene = typeof args.scene === "string" ? args.scene : undefined;
  const force = args.force as boolean;
  const langOverride = typeof args.language === "string" ? args.language : undefined;

  const project = loadProject(projectId);

  // Validate --scene filter
  if (filterScene && !project.scenes.find((s) => s.id === filterScene)) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Scene "${filterScene}" not found in project "${projectId}". Available: ${project.scenes.map((s) => s.id).join(", ")}`,
      details: { availableScenes: project.scenes.map((s) => s.id) },
    });
  }

  // Resolve language: CLI arg (validated via choices) > brief.json > "en"
  let language = langOverride ?? "en";
  if (!langOverride) {
    const rawBrief = loadPipelineJson(projectId, "brief");
    if (rawBrief) {
      const brief = BriefSchema.safeParse(rawBrief);
      if (brief.success && brief.data.language) language = brief.data.language;
    }
  }

  // Resolve productName and storyboard voiceoverText in a single brief load
  let productName: string | undefined;
  {
    const rawBrief = loadPipelineJson(projectId, "brief");
    if (rawBrief) {
      const brief = BriefSchema.safeParse(rawBrief);
      if (brief.success) productName = brief.data.productName;
    }
  }

  // Load storyboard for voiceoverText (CAPITALISED word detection)
  const storyboardSceneMap = new Map<string, string>();
  {
    const rawStoryboard = loadPipelineJson(projectId, "storyboard");
    if (rawStoryboard) {
      const sb = StoryboardSchema.safeParse(rawStoryboard);
      if (sb.success) {
        for (const scene of sb.data.scenes) {
          storyboardSceneMap.set(scene.id, scene.voiceoverText);
        }
      }
    }
  }

  const voiceoverDir = path.join("public", "projects", projectId, "voiceover");
  const pipelineDir = path.join("public", "projects", projectId, "pipeline");

  const scenes = filterScene ? project.scenes.filter((s) => s.id === filterScene) : project.scenes;

  emitProgress(`Editing captions for project: ${projectId}`);
  emitProgress(`Language: ${language}${productName ? `, product: ${productName}` : ""}`);
  emitProgress(`Scenes: ${scenes.map((s) => s.id).join(", ")}`);

  let editedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const aggregated: SceneCaptionEdit[] = [];
  const perScene: PerScene[] = [];
  const newlyWrittenPaths: string[] = [];

  for (const scene of scenes) {
    const rawJsonPath = path.join(voiceoverDir, `${scene.id}.words.json`);
    const editedJsonPath = path.join(voiceoverDir, `${scene.id}.words.edited.json`);

    // Skip: raw words file absent
    if (!existsSync(rawJsonPath)) {
      emitProgress(`  [skip] ${scene.id} — .words.json not found`);
      perScene.push({ sceneId: scene.id, status: "skipped", reason: "raw-words-missing" });
      skippedCount++;
      continue;
    }

    // Skip: already edited and --force not set — but include in aggregate
    if (existsSync(editedJsonPath) && !force) {
      emitProgress(`  [skip] ${scene.id} — already edited (use --force to overwrite)`);

      let wordCount = 0;
      let emphasisCount = 0;

      try {
        const existing = JSON.parse(readFileSync(editedJsonPath, "utf-8")) as {
          words: Array<{ text: string; start: number; end: number; emphasis?: boolean }>;
          droppedFillers: string[];
        };
        wordCount = existing.words?.length ?? 0;
        emphasisCount = existing.words?.filter((w) => w.emphasis).length ?? 0;

        // Include in aggregate so caption-edit.json is complete
        aggregated.push({
          sceneId: scene.id,
          words: existing.words as SceneCaptionEdit["words"],
          droppedFillers: existing.droppedFillers ?? [],
        });
      } catch {
        // Best effort — still mark as skipped
      }

      perScene.push({
        sceneId: scene.id,
        status: "skipped",
        reason: "already-edited",
        wordCount,
        emphasisCount,
      });
      skippedCount++;
      continue;
    }

    // Process scene
    try {
      const rawFile = JSON.parse(readFileSync(rawJsonPath, "utf-8")) as {
        words: WordAlignment[];
      };
      const rawWords: WordAlignment[] = rawFile.words ?? [];

      // Build emphasis terms: productName + UPPER-CASE tokens from voiceoverText
      const emphasisTerms: string[] = [];
      if (productName) emphasisTerms.push(productName);

      const voiceoverText = storyboardSceneMap.get(scene.id) ?? scene.text ?? "";
      for (const token of voiceoverText.split(/\s+/)) {
        const stripped = token.replace(/[^\p{L}]/gu, "");
        if (stripped.length > 1 && stripped === stripped.toUpperCase()) {
          emphasisTerms.push(token);
        }
      }

      const { words, droppedFillers } = editSceneCaptions(rawWords, {
        language,
        emphasisTerms,
      });

      // Write .words.edited.json
      if (!existsSync(voiceoverDir)) mkdirSync(voiceoverDir, { recursive: true });
      writeFileSync(editedJsonPath, JSON.stringify({ words, droppedFillers }, null, 2), "utf-8");

      const emphasisCount = words.filter((w) => w.emphasis).length;
      const relPath = relativisePath(path.resolve(editedJsonPath));

      emitProgress(
        `  [ok] ${scene.id} — ${words.length} words, ${emphasisCount} emphasised` +
          (droppedFillers.length > 0 ? ` (dropped: ${droppedFillers.join(", ")})` : ""),
      );

      aggregated.push({ sceneId: scene.id, words, droppedFillers });
      newlyWrittenPaths.push(relPath);

      perScene.push({
        sceneId: scene.id,
        status: "edited",
        outputPath: relPath,
        wordCount: words.length,
        emphasisCount,
        droppedFillers,
      });

      editedCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitProgress(`  [error] ${scene.id} — ${message}`);
      perScene.push({ sceneId: scene.id, status: "failed", error: message });
      failedCount++;
    }
  }

  // All scenes failed — escalate
  if (editedCount === 0 && failedCount > 0 && skippedCount === 0) {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `All ${failedCount} scene(s) failed caption editing. See metadata.perScene for details.`,
      details: { perScene },
    });
  }

  // Write pipeline/caption-edit.json
  let captionEditPath: string | undefined;
  if (aggregated.length > 0) {
    if (!existsSync(pipelineDir)) mkdirSync(pipelineDir, { recursive: true });
    const captionEdit = CaptionEditSchema.parse({ scenes: aggregated, wordsInView: 3 });
    const captionEditAbsPath = path.join(pipelineDir, "caption-edit.json");
    writeFileSync(captionEditAbsPath, JSON.stringify(captionEdit, null, 2), "utf-8");
    captionEditPath = relativisePath(path.resolve(captionEditAbsPath));
    emitProgress(`Wrote pipeline/caption-edit.json (${aggregated.length} scenes).`);
  }

  emitProgress(`Done: ${editedCount} edited, ${skippedCount} skipped, ${failedCount} failed.`);

  const outputs: string[] = [...newlyWrittenPaths, ...(captionEditPath ? [captionEditPath] : [])];

  return {
    outputs,
    metadata: {
      projectId,
      language,
      wordsInView: 3,
      edited: editedCount,
      skipped: skippedCount,
      failed: failedCount,
      perScene,
      ...(captionEditPath ? { captionEditPath } : {}),
    },
  };
});
