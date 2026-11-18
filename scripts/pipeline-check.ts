import { localSuggestions } from "../src/lib/local-capabilities/suggestions";
/**
 * Stateless health probe of a project's pipeline artefacts and project.json.
 * Validates every pipeline artefact present on disk against its schema, checks file references, chart declarations,
 * creative, film and music-rights findings, and returns structured JSON. It keeps no stage state: the next step of
 * any project comes from `pnpm next` (a leftover legacy pipeline-state.json is ignored).
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/pipeline-check.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/pipeline-check.ts --project <id> --strict
 *   pnpm tsx --env-file=.env scripts/pipeline-check.ts --project <id> --json-only
 *
 * Options:
 *   --project    Project ID (required)
 *   --strict     Warnings become errors; exit non-zero on any issue
 *   --json-only  Suppress stderr progress output (for machine consumption)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { runScript, parseArgs, emitProgress, requireProject, CliErrorObject } from "../src/lib/cli/index.js";

import {
  BriefSchema,
  ScriptSchema,
  DesignSchema,
  CharacterBibleSchema,
  StoryboardSchema,
  AssetPlanSchema,
  NarratorDirectionSchema,
  CaptionEditSchema,
  RhythmSchema,
  AudioMixSchema,
  PIPELINE_STAGES,
} from "../src/types/pipeline.js";

import { pipelineDir, projectDir, STAGE_FILE } from "../src/lib/pipeline/paths.js";
import { CREATIVE_FINDING_CODES, runCreativeChecks } from "../src/lib/pipeline/creative-checks.js";
import { FILM_FINDING_CODES, filmFindings, isBespokeProject } from "../src/lib/film/state.js";
import { memoryFields, withPlaybook } from "../src/lib/pipeline/route.js";
import { checkProjectMusicRights, MUSIC_RIGHTS_CODES } from "../src/lib/music/rights-guard.js";
import { compileTimeline } from "../src/lib/timeline.js";
import { loadProject } from "../src/lib/project.js";
import { checkChartQuantities } from "../src/lib/chart-quantity.js";
import { inspectChartQuantitySources } from "../src/lib/chart-quantity-sources.js";
import { checkChartDomains } from "../src/lib/chart-domain.js";
import type { LeftPanel } from "../src/types/video.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "project",
    type: "string" as const,
    required: true,
    description: "Project ID",
  },
  {
    name: "strict",
    type: "boolean" as const,
    description: "Warnings become errors; exit non-zero on any issue",
  },
  {
    name: "json-only",
    type: "boolean" as const,
    description: "Suppress stderr progress output (for machine consumption)",
  },
] as const;

// ---------------------------------------------------------------------------
// Finding codes
// ---------------------------------------------------------------------------

export const FINDING_CODES = [
  "SCHEMA_VALIDATION_FAILED",
  "STORYBOARD_BEAT_REF_INVALID",
  "STORYBOARD_CHARACTER_REF_INVALID",
  "ASSET_ID_DUPLICATE",
  "ASSET_TARGET_PATH_DUPLICATE",
  "ASSET_FILE_MISSING",
  "PRESENTER_VIDEO_MISSING",
  "LEFT_PANEL_FILE_MISSING",
  "SCENE_COUNT_MISMATCH",
  // Added after BTC project lessons:
  "AUDIO_SOURCE_MISMATCH", // talkingHead.audioSource ≠ narrator-direction reality
  "MODE_A_VOICEOVER_LEAK", // voiceover/*.mp3 exists when audio is embedded
  "PANEL_MOOD_INCONSISTENT", // adjacent left panels can't share leftPanelCanvas
  "WORD_BUDGET_OVERFLOW", // beat text exceeds words/sec × durationSec
  "TRANSITION_MATH_INCONSISTENT", // sum-of-scene-durations vs composition-duration mismatch
  "CHART_ANNOTATION_TARGET_INVALID",
  "CHART_DOMAIN_BINDING_MISMATCH",
  "CHART_SEMANTICS_REVIEW_REQUIRED",
  "CHART_QUANTITY_MISMATCH",
  "CHART_QUANTITY_REVIEW_REQUIRED",
  "CHART_CALLOUT_TARGET_INVALID",
  "CHART_SOURCE_MISMATCH",
  "CHART_SOURCE_REVIEW_REQUIRED",
  ...CREATIVE_FINDING_CODES,
  ...FILM_FINDING_CODES,
  ...MUSIC_RIGHTS_CODES,
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

// ---------------------------------------------------------------------------
// Finding type
// ---------------------------------------------------------------------------

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
  severity: FindingSeverity;
  code: FindingCode;
  stage?: string;
  message: string;
  ref?: { file: string; jsonPath?: string };
}

// ---------------------------------------------------------------------------
// Schema lookup — only stages with structured JSON artefacts
// ---------------------------------------------------------------------------

const STAGE_SCHEMAS: Partial<Record<string, z.ZodTypeAny>> = {
  brief: BriefSchema,
  script: ScriptSchema,
  design: DesignSchema,
  characters: CharacterBibleSchema,
  storyboard: StoryboardSchema,
  "asset-plan": AssetPlanSchema,
  "narrator-direction": NarratorDirectionSchema,
  "caption-edit": CaptionEditSchema,
  rhythm: RhythmSchema,
  "audio-mix": AudioMixSchema,
};

// Stages where there is no structured JSON schema to validate
// (side-effect / status-file only stages)
const SIDE_EFFECT_STAGES = new Set(["assets", "voiceover", "talking-head", "compose", "render", "qa"]);

// ---------------------------------------------------------------------------
// Helper — safe JSON read
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Module-level flag so progress helpers can check it
let jsonOnly = false;

function progress(message: string): void {
  if (!jsonOnly) emitProgress(message);
}

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project as string;
  const strict = args.strict as boolean;
  jsonOnly = args["json-only"] as boolean;

  if (!isBespokeProject(projectDir(projectId))) requireProject(projectId);

  const findings: Finding[] = [];
  const schemaCoverage: Record<string, "ok" | "n/a" | "missing" | "failed"> = {};

  // Pre-populate schemaCoverage
  for (const stage of PIPELINE_STAGES) {
    schemaCoverage[stage] = SIDE_EFFECT_STAGES.has(stage) ? "n/a" : "missing";
  }

  // ── Stage 1: per-stage artefact validation ───────────────────────────────

  progress("Checking per-stage artefacts…");

  // Parsed artefacts keyed by stage, for cross-reference checks later
  const parsedArtefacts: Partial<Record<string, unknown>> = {};

  for (const stage of PIPELINE_STAGES) {
    const stem = STAGE_FILE[stage];
    if (!stem) continue;

    const jsonPath = path.join(pipelineDir(projectId), `${stem}.json`);
    const fileExists = existsSync(jsonPath);
    const hasSchema = !SIDE_EFFECT_STAGES.has(stage);

    if (fileExists && hasSchema) {
      const schema = STAGE_SCHEMAS[stage];
      if (!schema) {
        // Should not happen given SIDE_EFFECT_STAGES guard, but be safe
        schemaCoverage[stage] = "missing";
      } else {
        const raw = readJsonFile(jsonPath);
        const result = schema.safeParse(raw);
        if (!result.success) {
          schemaCoverage[stage] = "failed";
          findings.push({
            severity: "error",
            code: "SCHEMA_VALIDATION_FAILED",
            stage,
            message: `Schema validation failed for "${stage}": ${result.error.message}`,
            ref: { file: jsonPath },
          });
        } else {
          schemaCoverage[stage] = "ok";
          parsedArtefacts[stage] = result.data;
        }
      }
    }
  }

  // ── Stage 2: cross-references ────────────────────────────────────────────

  progress("Checking cross-references…");

  const script = parsedArtefacts["script"] as { beats: Array<{ id: string }> } | undefined;
  const storyboard = parsedArtefacts["storyboard"] as z.infer<typeof StoryboardSchema> | undefined;
  const characters = parsedArtefacts["characters"] as { characters: Array<{ id: string }> } | undefined;
  const assetPlan = parsedArtefacts["asset-plan"] as
    { assets: Array<{ id: string; targetPath: string; status: string }> } | undefined;

  if (storyboard && script) {
    const beatIds = new Set(script.beats.map((b) => b.id));
    for (const scene of storyboard.scenes) {
      if (scene.beatId && !beatIds.has(scene.beatId)) {
        findings.push({
          severity: "error",
          code: "STORYBOARD_BEAT_REF_INVALID",
          stage: "storyboard",
          message: `Storyboard scene "${scene.id}" references beatId "${scene.beatId}" which does not exist in script.beats.`,
          ref: {
            file: path.join(pipelineDir(projectId), "storyboard.json"),
            jsonPath: `scenes[id=${scene.id}].beatId`,
          },
        });
      }
    }
  }

  if (storyboard && characters) {
    const charIds = new Set(characters.characters.map((c) => c.id));
    for (const scene of storyboard.scenes) {
      for (const cid of scene.characterIds ?? []) {
        if (!charIds.has(cid)) {
          findings.push({
            severity: "error",
            code: "STORYBOARD_CHARACTER_REF_INVALID",
            stage: "storyboard",
            message: `Storyboard scene "${scene.id}" references characterId "${cid}" which does not exist in characters.json.`,
            ref: {
              file: path.join(pipelineDir(projectId), "storyboard.json"),
              jsonPath: `scenes[id=${scene.id}].characterIds`,
            },
          });
        }
      }
    }
  }

  if (assetPlan) {
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const asset of assetPlan.assets) {
      if (seenIds.has(asset.id)) {
        findings.push({
          severity: "error",
          code: "ASSET_ID_DUPLICATE",
          stage: "asset-plan",
          message: `Duplicate asset id "${asset.id}" in asset-plan.json.`,
          ref: { file: path.join(pipelineDir(projectId), "asset-plan.json"), jsonPath: `assets[id=${asset.id}]` },
        });
      }
      seenIds.add(asset.id);

      if (seenPaths.has(asset.targetPath)) {
        findings.push({
          severity: "error",
          code: "ASSET_TARGET_PATH_DUPLICATE",
          stage: "asset-plan",
          message: `Duplicate asset targetPath "${asset.targetPath}" in asset-plan.json.`,
          ref: {
            file: path.join(pipelineDir(projectId), "asset-plan.json"),
            jsonPath: `assets[id=${asset.id}].targetPath`,
          },
        });
      }
      seenPaths.add(asset.targetPath);
    }
  }

  // ── Stage 3: file references ─────────────────────────────────────────────

  progress("Checking file references…");

  const projectBase = path.join("public", "projects", projectId);

  // asset-plan: done assets must exist on disk
  if (assetPlan) {
    for (const asset of assetPlan.assets) {
      if (asset.status === "done") {
        const fullPath = path.join(projectBase, asset.targetPath);
        if (!existsSync(fullPath)) {
          findings.push({
            severity: "error",
            code: "ASSET_FILE_MISSING",
            stage: "asset-plan",
            message: `Asset "${asset.id}" is marked done but file not found: ${fullPath}`,
            ref: {
              file: path.join(pipelineDir(projectId), "asset-plan.json"),
              jsonPath: `assets[id=${asset.id}].targetPath`,
            },
          });
        }
      }
    }
  }

  // storyboard: left-panel image/video file refs
  if (storyboard) {
    for (const scene of storyboard.scenes) {
      const panel = scene.leftPanel as Record<string, unknown> | undefined;
      if (!panel) continue;

      const kind = panel["kind"] as string | undefined;
      let refField: string | null = null;

      if (kind === "screenshot" || kind === "meme" || kind === "aiImage") {
        refField = panel["imageUrl"] as string | null;
      } else if (kind === "archival") {
        refField = panel["videoUrl"] as string | null;
      }

      if (refField && refField.startsWith("projects/")) {
        const fullPath = path.join("public", refField);
        if (!existsSync(fullPath)) {
          findings.push({
            severity: "warning",
            code: "LEFT_PANEL_FILE_MISSING",
            stage: "storyboard",
            message: `Scene "${scene.id}" left panel (${kind}) references missing file: ${fullPath}`,
            ref: {
              file: path.join(pipelineDir(projectId), "storyboard.json"),
              jsonPath: `scenes[id=${scene.id}].leftPanel.${kind === "archival" ? "videoUrl" : "imageUrl"}`,
            },
          });
        }
      }
    }
  }

  // presenter video (from project.json)
  let projectConfig: Awaited<ReturnType<typeof loadProject>> | null = null;
  try {
    projectConfig = loadProject(projectId);
  } catch {
    // project.json may not yet be composed — not an error here
  }

  if (projectConfig?.talkingHead?.enabled && projectConfig.talkingHead.presenterVideo) {
    const presenterPath = path.join("public", projectConfig.talkingHead.presenterVideo);
    if (!existsSync(presenterPath)) {
      findings.push({
        severity: "warning",
        code: "PRESENTER_VIDEO_MISSING",
        stage: "talking-head",
        message: `talkingHead.presenterVideo points to a missing file: ${presenterPath}`,
        ref: { file: path.join(projectBase, "project.json"), jsonPath: "talkingHead.presenterVideo" },
      });
    }
  }

  // Use the renderer's resolver for both authored and composed chart data.
  // Consistent declarations do not establish source substantiation or human approval.
  const checkCharts = (scenes: readonly { leftPanel?: LeftPanel }[], file: string, stage: string) => {
    scenes.forEach((scene, sceneIndex) => {
      if (scene.leftPanel?.kind !== "chart") return;
      for (const finding of [...checkChartDomains(scene.leftPanel), ...checkChartQuantities(scene.leftPanel)]) {
        const suffix = finding.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("");
        findings.push({
          severity: finding.severity,
          code: finding.code,
          stage,
          message: finding.message,
          ref: { file, jsonPath: `scenes[${sceneIndex}].leftPanel${suffix}` },
        });
      }
    });
  };
  if (storyboard) checkCharts(storyboard.scenes, path.join(pipelineDir(projectId), "storyboard.json"), "storyboard");
  if (projectConfig) checkCharts(projectConfig.scenes, path.join(projectBase, "project.json"), "compose");
  if (projectConfig) {
    try {
      const chartSources = inspectChartQuantitySources(process.cwd(), projectId);
      for (const finding of chartSources.findings.filter(
        (f) => f.code === "CHART_SOURCE_MISMATCH" || f.code === "CHART_SOURCE_REVIEW_REQUIRED",
      )) {
        const chartPath = finding.path[0] === "scenes";
        const sceneIndex = chartPath ? projectConfig.scenes.findIndex((s) => s.id === finding.path[1]) : -1;
        const suffix = (chartPath ? finding.path.slice(2) : finding.path)
          .map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`))
          .join("");
        const jsonPath = chartPath && sceneIndex >= 0 ? `scenes[${sceneIndex}]${suffix}` : suffix.replace(/^\./, "");
        findings.push({
          code: finding.code,
          severity: finding.severity,
          stage: "compose",
          message: finding.message,
          ref: {
            file: path.join(projectBase, chartPath ? "project.json" : "pipeline/evidence/chart-quantity-bindings.json"),
            ...(jsonPath ? { jsonPath } : {}),
          },
        });
      }
    } catch (error) {
      findings.push({
        code: "CHART_SOURCE_MISMATCH",
        severity: "error",
        stage: "compose",
        message: error instanceof Error ? error.message : String(error),
        ref: { file: path.join(projectBase, "pipeline/evidence/chart-quantity-bindings.json") },
      });
    }
  }

  // ── Stage 4: project.json final consistency ──────────────────────────────

  progress("Checking project.json consistency…");

  if (projectConfig && storyboard) {
    const projectSceneCount = projectConfig.scenes.length;
    const storyboardSceneCount = storyboard.scenes.length;
    if (projectSceneCount !== storyboardSceneCount) {
      findings.push({
        severity: "warning",
        code: "SCENE_COUNT_MISMATCH",
        stage: "compose",
        message: `project.json has ${projectSceneCount} scene(s) but storyboard has ${storyboardSceneCount}. They may be out of sync.`,
        ref: { file: path.join(projectBase, "project.json"), jsonPath: "scenes" },
      });
    }
  }

  // ── Stage 5: Mode-A audio coherence + word-budget + visual continuity ────
  //
  // These are post-BTC-project guards. They surface issues that are not
  // schema-invalid but produce visibly broken video (double audio, scene
  // strobing, voiceover overflow, transition-math errors).

  progress("Checking Mode-A audio coherence…");

  const narratorPath = path.join(pipelineDir(projectId), "narrator-direction.json");
  const narrator = readJsonFile(narratorPath) as { nativeAudioDirection?: unknown; beats?: unknown[] } | null;
  const hasNativeAudio =
    narrator !== null &&
    typeof narrator === "object" &&
    "nativeAudioDirection" in narrator &&
    narrator.nativeAudioDirection != null;

  if (projectConfig && projectConfig.talkingHead && projectConfig.talkingHead.enabled) {
    const declaredAudioSource = (projectConfig.talkingHead as { audioSource?: string }).audioSource ?? "elevenlabs";
    const expectedAudioSource = hasNativeAudio ? "embedded" : "elevenlabs";
    if (declaredAudioSource !== expectedAudioSource) {
      findings.push({
        severity: "error",
        code: "AUDIO_SOURCE_MISMATCH",
        stage: "compose",
        message: `project.json.talkingHead.audioSource = "${declaredAudioSource}" but narrator-direction.json indicates audio source should be "${expectedAudioSource}". Composer must auto-derive this — see composer.md "Audio source — auto-derive" rule.`,
        ref: { file: path.join(projectBase, "project.json"), jsonPath: "talkingHead.audioSource" },
      });
    }

    if (declaredAudioSource === "embedded") {
      // Mode A — voiceover/*.mp3 should NOT exist for presenter beats.
      const voPath = path.join(projectBase, "voiceover");
      if (existsSync(voPath)) {
        const fs = require("node:fs") as typeof import("node:fs");
        const mp3s = fs.readdirSync(voPath).filter((f) => f.endsWith(".mp3"));
        if (mp3s.length > 0) {
          findings.push({
            severity: "warning",
            code: "MODE_A_VOICEOVER_LEAK",
            stage: "voiceover",
            message: `audioSource = "embedded" but ${mp3s.length} ElevenLabs MP3(s) exist in voiceover/. Either delete them or switch audioSource to "elevenlabs". Layering ElevenLabs over Seedance native audio = double-voice bug.`,
            ref: { file: voPath },
          });
        }
      }
    }
  }

  // Visual continuity: storyboard's adjacent scene panel kinds vs canvas mood.
  // Specifically flag if a `kind: "aiImage"` is followed by a kind that uses
  // the canvas (sketch/chart/text/tweet/meme) and there is NO transitionToNext fade,
  // OR if the canvas mood is "light" but a panel is intrinsically dark (aiImage of
  // near-black photo). We can't fully judge image content from JSON, but we can
  // flag the structural risk.
  if (storyboard) {
    type SbScene = { id: string; leftPanel?: { kind?: string } | null; transitionToNext?: string };
    const sbScenes = (storyboard as { scenes: SbScene[] }).scenes;
    for (let i = 0; i < sbScenes.length - 1; i++) {
      const a = sbScenes[i];
      const b = sbScenes[i + 1];
      const ka = a.leftPanel?.kind;
      const kb = b.leftPanel?.kind;
      const trans = (a.transitionToNext as string | undefined) ?? "fade";
      const mismatch = (ka === "aiImage" && kb && kb !== "aiImage") || (kb === "aiImage" && ka && ka !== "aiImage");
      if (mismatch && trans === "cut") {
        findings.push({
          severity: "warning",
          code: "PANEL_MOOD_INCONSISTENT",
          stage: "storyboard",
          message: `Hard cut between scene "${a.id}" (${ka}) and "${b.id}" (${kb}) — aiImage panels typically carry their own dark photo, while sketch/chart/text use the canvas base. Use transitionToNext: "fade" or move the aiImage to a non-adjacent slot.`,
          ref: { file: path.join(pipelineDir(projectId), "storyboard.json"), jsonPath: `scenes[${i}]` },
        });
      }
    }
  }

  // Word budget: each beat's text length should fit its durationSec at the
  // configured words/sec for the language. Conservative defaults: ru ≈ 2.3,
  // en ≈ 2.5, es ≈ 2.6. Flag overruns ≥ 0.5 s.
  if (storyboard) {
    const briefPath = path.join(pipelineDir(projectId), "brief.json");
    const brief = readJsonFile(briefPath) as { language?: string } | null;
    const lang = brief?.language ?? "en";
    const wordsPerSec = lang === "ru" ? 2.3 : lang === "es" ? 2.6 : 2.5;
    type SbBeat = { id: string; durationSec: number; voiceoverText?: string };
    const sbScenes = (storyboard as unknown as { scenes: SbBeat[] }).scenes;
    for (const s of sbScenes) {
      const t = s.voiceoverText ?? "";
      const wordCount = t.split(/\s+/).filter(Boolean).length;
      const expectedSec = wordCount / wordsPerSec;
      if (expectedSec > s.durationSec + 0.5) {
        findings.push({
          severity: "warning",
          code: "WORD_BUDGET_OVERFLOW",
          stage: "storyboard",
          message: `Scene "${s.id}" voiceover is ~${expectedSec.toFixed(1)}s of speech (${wordCount} words at ${wordsPerSec} w/s for ${lang}) but scene is ${s.durationSec}s. Trim text or extend the scene.`,
          ref: { file: path.join(pipelineDir(projectId), "storyboard.json"), jsonPath: s.id },
        });
      }
    }
  }

  // Transition-math: composition durationInFrames vs sum(scenes.durationInFrames)
  // minus sum(transition overhead) should match.
  if (projectConfig && projectConfig.talkingHead?.enabled) {
    try {
      compileTimeline(projectConfig.scenes, { talkingHead: true });
    } catch (error) {
      findings.push({
        severity: "error",
        code: "TRANSITION_MATH_INCONSISTENT",
        stage: "compose",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Creative checks (bespoke projects, or a concept or plan in the new format) ──

  progress("Running creative checks…");
  findings.push(...runCreativeChecks(projectDir(projectId)));
  findings.push(...filmFindings(projectDir(projectId)));
  findings.push(...checkProjectMusicRights(projectDir(projectId)));

  // ── Summary ──────────────────────────────────────────────────────────────

  progress("Compiling summary…");

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const infoCount = findings.filter((f) => f.severity === "info").length;
  const readyToProceed = errorCount === 0;

  const nextAction =
    errorCount > 0
      ? `Resolve ${errorCount} error(s); the project's next step: pnpm next --project ${projectId}`
      : `Run: pnpm next --project ${projectId}`;
  const playbook = withPlaybook(path.resolve(projectDir(projectId)));
  const summary = {
    errorCount,
    warningCount,
    infoCount,
    readyToProceed,
    nextAction,
    read: playbook.read,
  };

  // ── Strict mode exit ─────────────────────────────────────────────────────

  const strictViolations = strict
    ? findings.filter((f) => f.severity === "error" || f.severity === "warning")
    : findings.filter((f) => f.severity === "error");

  if (strict && strictViolations.length > 0) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pipeline check failed: ${errorCount} error(s), ${warningCount} warning(s).`,
      details: {
        projectId,
        summary,
        ...(await localSuggestions(projectId, summary.nextAction)),
        findings,
        schemaCoverage,
      },
    });
  }

  return {
    outputs: [],
    metadata: {
      projectId,
      playbook: playbook.playbook,
      ...(playbook.playbookHint ? { playbookHint: playbook.playbookHint } : {}),
      ...(playbook.playbookSuggest ? { playbookSuggest: playbook.playbookSuggest } : {}),
      ...memoryFields(path.resolve(projectDir(projectId)), undefined),
      summary,
      ...(await localSuggestions(projectId, summary.nextAction)),
      findings,
      schemaCoverage,
    },
  };
});
