import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, relativisePath, requireFile } from "../cli";
import { inspectAsset } from "../assets/inspect";
import { hashFile } from "../assets/registry";
import { executeFalOperation, type ExecutionOptions } from "../jobs/execution";
import { OperationStore } from "../jobs/store";
import {
  buildFalOperation,
  requireExecutableFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
  FalOperationError,
} from "../providers/fal-operations";
import { quoteInputForPlan } from "../providers/fal-quote-input";
import { findCatalogEntry, readCachedApiModel } from "../models/fal-catalog";
import { openApiRoutes } from "../providers/fal-openapi";
import type { FalEndpointRequest } from "../../types/generation";
import { normaliseFalTranscript } from "./fal-transcript";
import { normaliseFalTtsAlignment } from "./fal-tts-alignment";

export type FalSpeechRun = Pick<
  ExecutionOptions,
  "endpoint" | "output" | "projectId" | "operationId" | "maxCostUsd" | "dryRun" | "force" | "provider" | "fetch"
> & { language?: string; pollMs?: number; timeoutMs?: number };

async function executeSpeech(
  run: FalSpeechRun,
  request: FalEndpointRequest,
  kind: "audio" | "json",
  category: string[],
) {
  let plan: ReturnType<typeof buildFalOperation>;
  try {
    plan = buildFalOperation(request);
  } catch (error) {
    if (error instanceof FalOperationError)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error.message,
        details: { providerCode: error.code },
      });
    throw error;
  }
  if (!category.includes(plan.category ?? ""))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Endpoint category must be ${category.join(" or ")}.` });
  if (!run.dryRun) requireExecutableFalOperation(plan);
  const snapshot = resolveFalSnapshotForPlan(plan);
  const entry = findCatalogEntry(plan.endpoint);
  const model = entry?.schema ? readCachedApiModel(entry.schema.sha256) : undefined;
  const execution: ExecutionOptions = {
    ...run,
    input: plan.input,
    model: plan.endpoint,
    mediaKind: kind,
    stage: kind === "audio" ? "voiceover" : "transcript",
    resultSchema: { schema: snapshot.output, components: snapshot.schemas },
    queuePath: model ? openApiRoutes(model)?.submitPath.replace(/^\//, "") : undefined,
    quoteInput: quoteInputForPlan(plan, plan.input, request.context),
    validateResult: (result) => {
      validateFalOperationResult(plan.endpoint, result);
    },
  };
  let result = await executeFalOperation(execution);
  if (run.dryRun)
    return {
      ...result,
      metadata: { ...result.metadata, plan, quoteInput: execution.quoteInput, queuePath: execution.queuePath },
      raw: undefined,
    };
  const deadline = Date.now() + (run.timeoutMs ?? 15 * 60_000);
  while (["queued", "running", "reserved"].includes(String(result.metadata.state))) {
    if (Date.now() >= deadline)
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: "fal speech is pending. Re-run the same arguments to resume the operation.",
      });
    await new Promise((resolve) => setTimeout(resolve, run.pollMs ?? 5000));
    result = await executeFalOperation({ ...execution, operationId: String(result.metadata.operationId) });
  }
  if (result.metadata.state !== "published")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `fal speech ended ${String(result.metadata.state)}. ${String(result.metadata.nextAction)} with the same arguments.`,
    });
  const raw = new OperationStore(run.projectId!).snapshot().jobs[String(result.metadata.operationId)]?.result;
  return { ...result, raw };
}

/** One durable transcription, with measured input duration and a replayable raw fal response. */
export async function runFalTranscribe(
  run: FalSpeechRun & {
    inputPath: string;
    fromRaw?: string;
    diarize?: boolean;
    keyterms?: string[];
    tagAudioEvents?: boolean;
  },
) {
  requireFile(run.inputPath);
  if (existsSync(run.output) && !run.force && !run.dryRun)
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Transcript exists; use --force to overwrite." });
  const rawPath = run.output.replace(/(?:\.json)?$/, ".fal.json");
  if (!run.fromRaw && existsSync(rawPath) && !run.force && !run.dryRun)
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Raw fal response exists; use --from-raw or --force." });
  const inspected = inspectAsset(run.inputPath);
  const durationSec = inspected.media?.durationSec;
  if (!inspected.media?.hasAudio)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Input must contain an audio stream." });
  if (durationSec === undefined || durationSec === null || durationSec <= 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "ffprobe must establish a positive input audio duration.",
    });
  let raw: unknown, result: { outputs: string[]; metadata: Record<string, unknown> };
  if (run.fromRaw) {
    requireFile(run.fromRaw);
    raw = JSON.parse(readFileSync(run.fromRaw, "utf8"));
    result = { outputs: [relativisePath(path.resolve(run.fromRaw))], metadata: { fromRaw: true } };
  } else {
    // Data references keep local input bytes and their duration bound to the exact submitted request.
    const mime = inspected.mime;
    const audioUrl = `data:${mime};base64,${readFileSync(run.inputPath).toString("base64")}`;
    if (!["fal-ai/elevenlabs/speech-to-text/scribe-v2", "fal-ai/wizper"].includes(run.endpoint))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Use a verified transcription endpoint from docs/fal-catalogue.md.",
      });
    const scribe = run.endpoint === "fal-ai/elevenlabs/speech-to-text/scribe-v2";
    if (!scribe && (run.diarize || run.keyterms?.length || run.tagAudioEvents))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Selected endpoint does not support Scribe diarisation, keyterms or event flags.",
      });
    const input = {
      audio_url: audioUrl,
      ...(scribe
        ? {
            diarize: run.diarize ?? false,
            ...(run.language ? { language_code: run.language } : {}),
            ...(run.keyterms?.length ? { keyterms: run.keyterms } : {}),
            ...(run.tagAudioEvents ? { tag_audio_events: true } : {}),
          }
        : { task: "transcribe", language: run.language ?? null }),
    };
    const completed = await executeSpeech(
      run,
      {
        endpoint: run.endpoint,
        input,
        context: { media: { [audioUrl]: { durationSec, bytes: readFileSync(run.inputPath).length } } },
      },
      "json",
      ["speech-to-text"],
    );
    if (run.dryRun) return { outputs: completed.outputs, metadata: completed.metadata };
    raw = completed.raw;
    result = completed;
  }
  let transcript;
  try {
    transcript = normaliseFalTranscript(raw, {
      source: { file: relativisePath(path.resolve(run.inputPath)), sha256: hashFile(run.inputPath), durationSec },
      endpoint: run.endpoint,
      language: run.language,
    });
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
  if (run.dryRun)
    return {
      outputs: [],
      metadata: {
        ...result.metadata,
        dryRun: true,
        wordCount: transcript.words.length,
        timing: transcript.engine.timing,
      },
    };
  mkdirSync(path.dirname(path.resolve(run.output)), { recursive: true });
  if (!run.fromRaw) writeFileSync(rawPath, JSON.stringify(raw, null, 2) + "\n");
  writeFileSync(run.output, JSON.stringify(transcript, null, 2) + "\n");
  return {
    outputs: [
      ...result.outputs,
      relativisePath(path.resolve(run.output)),
      ...(!run.fromRaw ? [relativisePath(path.resolve(rawPath))] : []),
    ],
    metadata: {
      ...result.metadata,
      endpoint: run.endpoint,
      wordCount: transcript.words.length,
      durationSec,
      timing: transcript.engine.timing,
    },
  };
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  ru: "Russian",
};

/** Generate one scene as MP3; only explicit provider word times produce a caption sidecar. */
export async function runFalVoiceover(run: FalSpeechRun & { text: string; voice?: string }) {
  if (!run.output.endsWith(".mp3"))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Voiceover output must end in .mp3." });
  const qwen = run.endpoint === "fal-ai/qwen-3-tts/text-to-speech/1.7b";
  if (!qwen && run.endpoint !== "elevenlabs/tts/eleven-v4")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Use a verified speech voiceover endpoint from docs/fal-catalogue.md.",
    });
  const language = run.language ? (LANGUAGE_NAMES[run.language] ?? run.language) : undefined;
  const input = {
    text: run.text,
    ...(run.voice ? { voice: run.voice } : {}),
    ...(qwen
      ? { ...(language ? { language } : {}) }
      : { timestamps: true, output_format: "mp3_44100_128", ...(run.language ? { language_code: run.language } : {}) }),
  };
  const wordsPath = run.output.replace(/\.mp3$/, ".words.json");
  if (
    !run.dryRun &&
    !run.force &&
    (existsSync(run.output) || existsSync(wordsPath) || existsSync(run.output.replace(/\.mp3$/, ".words.edited.json")))
  )
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Voiceover or word sidecar exists; use --force to overwrite.",
    });
  if (!run.dryRun) ensureFfmpeg();
  const completed = await executeSpeech(
    { ...run, output: run.output.replace(/\.mp3$/, ".fal.audio") },
    { endpoint: run.endpoint, input },
    "audio",
    ["text-to-speech"],
  );
  if (run.dryRun) return { outputs: completed.outputs, metadata: completed.metadata };
  const providerOutput = completed.outputs[0]!;
  const temporary = run.output.replace(/\.mp3$/, ".fal-tmp.mp3");
  const conversion = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", providerOutput, "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", temporary],
    { encoding: "utf8" },
  );
  try {
    if (conversion.error)
      throw new CliErrorObject({ code: "FFMPEG_MISSING", message: "Install ffmpeg with: brew install ffmpeg" });
    if (conversion.status !== 0)
      throw new CliErrorObject({
        code: "FFMPEG_FAILED",
        message: `Could not convert fal voiceover to MP3: ${conversion.stderr}`,
      });
    renameSync(temporary, run.output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const editedPath = run.output.replace(/\.mp3$/, ".words.edited.json");
  if (existsSync(editedPath)) unlinkSync(editedPath);
  const alignment = normaliseFalTtsAlignment(completed.raw ?? {});
  if (alignment) writeFileSync(wordsPath, JSON.stringify(alignment, null, 2) + "\n");
  else if (existsSync(wordsPath)) unlinkSync(wordsPath);
  return {
    outputs: [
      relativisePath(path.resolve(run.output)),
      ...(alignment ? [relativisePath(path.resolve(wordsPath))] : []),
    ],
    metadata: {
      ...completed.metadata,
      alignment: alignment ? "provider" : "needed",
      ...(!alignment ? { nextAction: `pnpm align:captions --project ${run.projectId}` } : {}),
    },
  };
}
