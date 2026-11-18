/**
 * Generate ElevenLabs voiceover MP3s for all scenes (or a single scene) in a
 * pipeline project. Reads scene text from pipeline/storyboard.json when
 * present (using scene IDs as MP3 filenames) or falls back to pipeline/script.json
 * beat IDs and text.  Optionally consumes pipeline/narrator-direction.json for
 * directed text and refined voice settings.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id> --scene <sceneId>
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id> --voice drew --model v3
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id> --directed
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id> --no-directed
 *   pnpm tsx --env-file=.env scripts/generate-voiceover.ts --project <id> --force
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runFalVoiceover } from "../src/lib/speech/fal-run";
import { scopedStudioRequest } from "../src/lib/elevenlabs/cli";
import { executeStudioAudio, operationQuote } from "../src/lib/elevenlabs/operations";
import { directedBeatText } from "../src/lib/film/narration";

import {
  parseArgs,
  runScript,
  emitProgress,
  withRetry,
  requireEnv,
  requireProject,
  CliErrorObject,
  relativisePath,
} from "../src/lib/cli/index.js";

import {
  generateVoiceover,
  generateVoiceoverV3,
  VOICES,
  ELEVEN_LABS_MODELS,
  type ExtendedVoiceSettings,
} from "../src/lib/elevenlabs/tts.js";

import { stageArtefactPath } from "../src/lib/pipeline/paths.js";

import {
  ScriptSchema,
  StoryboardSchema,
  NarratorDirectionSchema,
  type NarratorVoice,
  type DirectedBeat,
} from "../src/types/pipeline.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  { name: "request", description: "Typed timestamped ElevenLabs TTS request; default offline plan" },
  { name: "scope-root", description: "Trusted workspace boundary for nested request paths" },
  {
    name: "provider",
    choices: ["elevenlabs", "fal"],
    default: "elevenlabs",
    description: "Speech provider (default: ElevenLabs)",
  },
  { name: "endpoint", description: "Verified fal text-to-speech endpoint ID" },
  { name: "language", description: "Speech language; defaults to the project brief language" },
  {
    name: "dry-run",
    type: "boolean",
    description: "Validate speech requests and quotes offline without writes or API calls",
  },
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
    description: "Generate voiceover for a single scene/beat ID only",
  },
  {
    name: "voice",
    description: "Override the narrator voice from script.json",
  },
  {
    name: "model",
    choices: ["v2", "v3", "v4"] as const,
    description: "ElevenLabs model (v2 = eleven_multilingual_v2, v3 = eleven_v3, v4 = eleven_v4)",
  },
  {
    name: "directed",
    type: "boolean" as const,
    default: false,
    description: "Require and use narrator-direction.json for directed text and voice settings",
  },
  {
    name: "no-directed",
    type: "boolean" as const,
    default: false,
    description: "Disable narrator-direction.json even if it exists",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite existing MP3 files",
  },
  {
    name: "take",
    type: "number",
    description: "Take number: 2+ writes voiceover/<beat>.take-<n>.mp3, a new immutable take beside a rejected one",
  },
] as const;

// ---------------------------------------------------------------------------
// Internal unit type — normalised target for TTS generation
// ---------------------------------------------------------------------------

type GenerationUnit = {
  /** The ID used as the MP3 filename (sceneId when storyboard exists, beatId otherwise). */
  unitId: string;
  /** The beat ID from script.json — used to look up narrator direction. */
  beatId: string;
  /** Raw voiceover text (from storyboard.voiceoverText or script.beat.text). */
  rawText: string;
};

type UnitResult = {
  unitId: string;
  status: "generated" | "skipped" | "failed";
  skipReason?: "existed" | "empty-text";
  sizeBytes?: number;
  elapsedMs?: number;
  error?: string;
  alignment?: unknown;
  nextAction?: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project!;
  if (args.request) {
    const raw = scopedStudioRequest({
      project: projectId,
      request: args.request,
      "scope-root": args["scope-root"],
      "operation-id": args["operation-id"],
      "max-cost-usd": args["max-cost-usd"],
    });
    if (raw.task !== "tts")
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "generate:voiceover --request accepts TTS only" });
    return executeStudioAudio(raw, { dryRun: args["dry-run"] !== false, scopeRoot: args["scope-root"] });
  }
  const fal = args.provider === "fal";
  if (fal && !args.endpoint)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--provider fal requires --endpoint." });
  if (!fal && (args.endpoint || args.language))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--endpoint and --language require --provider fal, or use a typed --request.",
    });
  if (fal && args.model)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Use --endpoint instead of --model for fal." });

  requireProject(projectId);

  // --- Load script.json (required) ---

  const scriptPath = stageArtefactPath(projectId, "script", "json");
  if (!existsSync(scriptPath)) {
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `pipeline/script.json not found for project "${projectId}". Run the script stage first.`,
      details: { path: scriptPath },
    });
  }

  const scriptParseResult = ScriptSchema.safeParse(loadJsonFile(scriptPath));
  if (!scriptParseResult.success) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `pipeline/script.json is invalid: ${scriptParseResult.error.message}`,
    });
  }
  const script = scriptParseResult.data;

  // --- voiceoverEnabled gate (before API key check) ---

  if (!script.voiceoverEnabled) {
    return {
      outputs: [],
      metadata: {
        voiceoverEnabled: false,
        generated: 0,
        skipped: 0,
        failed: 0,
        perUnit: [] as UnitResult[],
        totalElapsedMs: 0,
      },
    };
  }

  // --- Resolve narrator direction ---

  const noDirected = args["no-directed"] as boolean;
  const explicitDirected = args.directed as boolean;
  const directionPath = stageArtefactPath(projectId, "narrator-direction", "json");

  let direction: ReturnType<typeof NarratorDirectionSchema.parse> | null = null;

  if (!noDirected) {
    if (existsSync(directionPath)) {
      const dirParseResult = NarratorDirectionSchema.safeParse(loadJsonFile(directionPath));
      if (!dirParseResult.success) {
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `pipeline/narrator-direction.json is invalid: ${dirParseResult.error.message}`,
        });
      }
      direction = dirParseResult.data;
    } else if (explicitDirected) {
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: `--directed was set but pipeline/narrator-direction.json not found for project "${projectId}".`,
        details: { path: directionPath },
      });
    }
    // else: auto-detect mode — no direction file present, proceed without it
  }

  // --- Resolve voice ---

  const voiceRef = direction?.voiceRef ?? script.voiceRef;
  if (direction?.voiceRef && script.voiceRef && JSON.stringify(direction.voiceRef) !== JSON.stringify(script.voiceRef))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Script and direction disagree about the pinned voice reference",
    });
  if (voiceRef && (fal || args.voice))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Pinned voiceRef conflicts with a provider/voice override; change the approved voice reference explicitly",
    });
  const overrideModel =
    args.model === "v4"
      ? "eleven_v4"
      : args.model === "v2" || args.model === "v3"
        ? ELEVEN_LABS_MODELS[args.model]
        : undefined;
  if (voiceRef && overrideModel && overrideModel !== voiceRef.model)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Model override conflicts with the pinned voiceRef" });
  const voiceKey = (fal ? args.voice : (args.voice ?? script.narratorVoice)) as NarratorVoice | undefined;
  if (!fal && !voiceRef && (!voiceKey || !Object.hasOwn(VOICES, voiceKey))) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown voice key "${String(voiceKey)}". Allowed: ${Object.keys(VOICES).join(", ")}`,
    });
  }
  const voiceId = fal ? undefined : (voiceRef?.voiceId ?? VOICES[voiceKey as keyof typeof VOICES]);
  const modernModel = voiceRef?.model ?? overrideModel ?? direction?.modelId;
  const timestamped = !fal && (!!voiceRef || modernModel === "eleven_v4" || modernModel === "eleven_flash_v2_5");

  // --- Resolve model ---

  let resolvedModel: "v2" | "v3" = "v2";
  if (args.model === "v2" || args.model === "v3") {
    resolvedModel = args.model;
  } else if (direction?.modelId === ELEVEN_LABS_MODELS.v3) {
    resolvedModel = "v3";
  }

  const reportModel = timestamped ? (modernModel ?? ELEVEN_LABS_MODELS.v3) : resolvedModel;
  const reportVoice = voiceRef?.voiceId ?? voiceKey;

  // --- Resolve voice settings ---

  const voiceSettings: ExtendedVoiceSettings | undefined = direction?.voiceSettings ?? undefined;

  // --- API key (checked after voiceoverEnabled guard) ---

  if (!fal && !args["dry-run"]) requireEnv("ELEVENLABS_API_KEY");

  // --- Build generation units ---
  //
  // Prefer storyboard.json when present: scene IDs become the MP3 filename
  // and voiceoverText is the TTS source. Falls back to script.beats where
  // beat IDs become the filename and beat.text is the TTS source.
  //
  // --scene matches the unitId (sceneId or beatId depending on which source is active).

  const storyboardPath = stageArtefactPath(projectId, "storyboard", "json");
  let units: GenerationUnit[];

  if (existsSync(storyboardPath)) {
    const sbParseResult = StoryboardSchema.safeParse(loadJsonFile(storyboardPath));
    if (!sbParseResult.success) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `pipeline/storyboard.json is invalid: ${sbParseResult.error.message}`,
      });
    }
    units = sbParseResult.data.scenes.map((scene) => ({
      unitId: scene.id,
      beatId: scene.beatId,
      rawText: scene.voiceoverText,
    }));
  } else {
    units = script.beats.map((beat) => ({
      unitId: beat.id,
      beatId: beat.id,
      rawText: beat.text,
    }));
  }

  // --- Apply --scene filter ---

  if (args.scene) {
    const filterScene = args.scene as string;
    const filtered = units.filter((u) => u.unitId === filterScene);
    if (filtered.length === 0) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Scene/beat "${filterScene}" not found. Available: ${units.map((u) => u.unitId).join(", ")}`,
        details: { project: projectId },
      });
    }
    units = filtered;
  }

  // --- Build directed-beat lookup ---

  const directedBeatMap = new Map<string, DirectedBeat>();
  const scriptBeats = new Map(script.beats.map((beat) => [beat.id, beat]));
  if (direction) {
    for (const db of direction.beats) {
      directedBeatMap.set(db.beatId, db);
    }
  }
  const textByUnit = new Map(
    units.map((unit) => {
      const beat = directedBeatMap.get(unit.beatId);
      return [
        unit.unitId,
        beat ? directedBeatText(scriptBeats.get(unit.beatId)?.text ?? unit.rawText, beat) : unit.rawText,
      ];
    }),
  );

  // --- Take number: a retake gets its own immutable path, the provider never overwrites a take ---

  const takeNumber = args.take;
  if (takeNumber !== undefined && (!Number.isInteger(takeNumber) || takeNumber < 1 || takeNumber > 99))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--take must be an integer from 1 to 99" });
  const takeSuffix = takeNumber !== undefined && takeNumber > 1 ? `.take-${takeNumber}` : "";

  // --- Ensure voiceover directory ---

  const voiceoverDir = path.join("public", "projects", projectId, "voiceover");
  if (!args["dry-run"] && !existsSync(voiceoverDir)) {
    mkdirSync(voiceoverDir, { recursive: true });
  }

  // --- Process each unit ---

  const retryOpts = {
    attempts: 3,
    backoffMs: 5_000,
    factor: 2,
    retryOn: ["RATE_LIMIT", "NETWORK"] as const,
  };

  const totalStart = Date.now();
  const perUnit: UnitResult[] = [];
  const generatedPaths: string[] = [];
  const falPlans: Record<string, unknown>[] = [];
  const briefPath = stageArtefactPath(projectId, "brief", "json");
  const language =
    args.language ??
    (fal && existsSync(briefPath)
      ? (loadJsonFile<{ language?: string }>(briefPath).language ?? script.language)
      : script.language);

  let generatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const audioPath = path.join(voiceoverDir, `${unit.unitId}${takeSuffix}.mp3`);

    if (fal && args["dry-run"] && unit.rawText.trim()) {
      const planned = await runFalVoiceover({
        endpoint: args.endpoint!,
        output: audioPath,
        text: textByUnit.get(unit.unitId)!,
        voice: args.voice,
        language,
        projectId,
        operationId: args["operation-id"] ? `${args["operation-id"]}:${unit.unitId}` : undefined,
        maxCostUsd: args["max-cost-usd"],
        dryRun: true,
      });
      falPlans.push({ unitId: unit.unitId, ...planned.metadata });
      continue;
    }

    // Skip empty text
    if (!unit.rawText.trim()) {
      emitProgress(`[${unit.unitId}] (${i + 1}/${units.length}) skipping — empty text`);
      perUnit.push({ unitId: unit.unitId, status: "skipped", skipReason: "empty-text" });
      skippedCount++;
      continue;
    }

    // Skip existing unless --force
    if (existsSync(audioPath) && !args.force && !timestamped) {
      emitProgress(`[${unit.unitId}] (${i + 1}/${units.length}) skipping — already exists (--force to overwrite)`);
      perUnit.push({ unitId: unit.unitId, status: "skipped", skipReason: "existed" });
      skippedCount++;
      continue;
    }

    // Resolve text: directed overrides raw if direction is loaded
    const directedBeat = directedBeatMap.get(unit.beatId);
    const text = textByUnit.get(unit.unitId)!;
    const scriptBeat = scriptBeats.get(unit.beatId);
    const lineId = scriptBeat?.lineId;

    if (!fal && !timestamped && args["dry-run"]) {
      falPlans.push({
        unitId: unit.unitId,
        state: "planned",
        voiceId,
        model: resolvedModel,
        characters: text.length,
        quote: operationQuote(`elevenlabs:tts-${resolvedModel}`, args["max-cost-usd"], text.length / 1000),
      });
      continue;
    }

    emitProgress(`[${unit.unitId}] (${i + 1}/${units.length}) generating with model ${reportModel}…`);

    const unitStart = Date.now();
    let durableOperationId: string | undefined;
    try {
      let falResult: Awaited<ReturnType<typeof runFalVoiceover>> | undefined;
      if (timestamped) {
        const model = modernModel ?? ELEVEN_LABS_MODELS.v3;
        const settings =
          direction?.speechSettings ??
          (model === "eleven_v4"
            ? { stability: voiceSettings?.stability, similarity_boost: voiceSettings?.similarity_boost }
            : voiceSettings);
        const take = await executeStudioAudio(
          {
            version: 1,
            task: "tts",
            projectId,
            output: audioPath,
            text,
            ...(lineId ? { lineId } : {}),
            ...(lineId || directedBeat?.pronunciations ? { approvedText: scriptBeat?.text ?? unit.rawText } : {}),
            ...(directedBeat?.pronunciations ? { pronunciations: directedBeat.pronunciations } : {}),
            ...(scriptBeat?.speakerId ? { speaker: scriptBeat.speakerId, sceneId: unit.unitId } : {}),
            ...(directedBeat?.expectedSpokenText ? { expectedSpokenText: directedBeat.expectedSpokenText } : {}),
            ...direction?.speechOptions,
            voiceId,
            ...(voiceRef ? { voiceRef } : {}),
            model,
            language,
            settings,
            operationId: args["operation-id"] ? `${args["operation-id"]}:${unit.unitId}` : undefined,
            maxCostUsd: args["max-cost-usd"],
          },
          { dryRun: args["dry-run"] === true, scopeRoot: args["scope-root"] },
        );
        if (args["dry-run"]) {
          falPlans.push({ unitId: unit.unitId, ...take.metadata });
          continue;
        }
        generatedPaths.push(...take.outputs.filter((file) => !file.endsWith(".mp3")));
      } else if (fal) {
        falResult = await runFalVoiceover({
          endpoint: args.endpoint!,
          output: audioPath,
          text,
          voice: args.voice,
          language,
          projectId,
          operationId: args["operation-id"] ? `${args["operation-id"]}:${unit.unitId}` : undefined,
          maxCostUsd: args["max-cost-usd"],
          force: args.force,
        });
        generatedPaths.push(...falResult.outputs.filter((file) => !file.endsWith(".mp3")));
      } else
        await withRetry(async () => {
          durableOperationId = undefined;
          if (resolvedModel === "v3") {
            await generateVoiceoverV3({
              text,
              voiceId: voiceId!,
              outputPath: audioPath,
              voiceSettings,
              paid: {
                projectId,
                operationId: args["operation-id"] ? `${args["operation-id"]}:${unit.unitId}` : undefined,
                maxCostUsd: args["max-cost-usd"],
                onOperationId: (id: string) => (durableOperationId = id),
              },
            });
          } else {
            await generateVoiceover({
              text,
              voiceId: voiceId!,
              outputPath: audioPath,
              modelId: ELEVEN_LABS_MODELS.v2,
              voiceSettings,
              paid: {
                projectId,
                operationId: args["operation-id"] ? `${args["operation-id"]}:${unit.unitId}` : undefined,
                maxCostUsd: args["max-cost-usd"],
                onOperationId: (id: string) => (durableOperationId = id),
              },
            });
          }
        }, retryOpts);

      const { statSync } = await import("node:fs");
      const sizeBytes = statSync(audioPath).size;
      const elapsedMs = Date.now() - unitStart;

      emitProgress(`[${unit.unitId}] done — ${(sizeBytes / 1024).toFixed(1)} KB in ${elapsedMs}ms`);

      // Cost ledger entry — TTS is billed per 1k chars; use directed/raw text length.
      if (!fal && !timestamped)
        try {
          const { logCost } = await import("../src/lib/cli/cost-log.js");
          const charCount = text.length;
          logCost({
            projectId,
            stage: "voiceover",
            scriptId: "generate-voiceover.ts",
            assetId: unit.unitId,
            service: "ElevenLabs",
            provider: "elevenlabs",
            ...(durableOperationId ? { operationId: durableOperationId } : {}),
            model: resolvedModel === "v3" ? ("elevenlabs:tts-v3" as never) : ("elevenlabs:tts-v2" as never),
            units: charCount / 1000,
            unitName: "1k_chars",
            notes: `voice=${voiceKey} chars=${charCount}`,
          });
        } catch {
          /* non-fatal */
        }

      perUnit.push({
        unitId: unit.unitId,
        status: "generated",
        sizeBytes,
        elapsedMs,
        ...(falResult ? { alignment: falResult.metadata.alignment, nextAction: falResult.metadata.nextAction } : {}),
      });
      generatedPaths.push(relativisePath(path.resolve(audioPath)));
      generatedCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitProgress(`[${unit.unitId}] FAILED — ${message}`);
      perUnit.push({ unitId: unit.unitId, status: "failed", error: message });
      failedCount++;
    }
  }

  const totalElapsedMs = Date.now() - totalStart;

  // --- Result ---

  if (generatedCount === 0 && failedCount > 0) {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `All ${failedCount} unit(s) failed to generate. See metadata.perUnit for details.`,
      details: {
        perUnit,
        model: reportModel,
        voice: reportVoice,
      },
    });
  }

  return {
    outputs: generatedPaths,
    metadata: {
      model: fal ? args.endpoint : reportModel,
      ...(!fal && args["dry-run"] ? { provider: "elevenlabs", dryRun: true, plans: falPlans } : {}),
      ...(fal
        ? {
            provider: "fal",
            dryRun: !!args["dry-run"],
            plans: falPlans,
            ...(perUnit.some((unit) => unit.alignment === "needed")
              ? { alignment: "needed", nextAction: `pnpm align:captions --project ${projectId}` }
              : {}),
          }
        : {}),
      voice: reportVoice,
      voiceId,
      directed: direction !== null,
      voiceoverEnabled: true,
      generated: generatedCount,
      skipped: skippedCount,
      failed: failedCount,
      perUnit,
      totalElapsedMs,
    },
  };
});
