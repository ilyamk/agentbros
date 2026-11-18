/**
 * Transcribe an audio or video file via ElevenLabs Scribe into the engine-neutral
 * transcript (src/types/transcript.ts). The raw Scribe response is kept beside it
 * as `<output>.scribe.json`. Guide: docs/speech.md.
 *
 *   pnpm transcribe --project ID --input recording.mp4 --output public/projects/ID/pipeline/transcript.json \
 *     --diarize --speakers 2 --keyterms "Remotion,Scribe" --language en
 *
 * Output: one JSON line on stdout, progress on stderr.
 */

import path from "node:path";
import { runFalTranscribe } from "../src/lib/speech/fal-run";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  parseArgs,
  runScript,
  emitProgress,
  withRetry,
  requireEnv,
  requireFile,
  CliErrorObject,
  relativisePath,
} from "../src/lib/cli/index.js";
import { DEFAULT_SCRIBE_MODEL, SCRIBE_MODELS, transcribe } from "../src/lib/elevenlabs-scribe.js";
import { buildTranscript, scribeRawPath, scribeWords, type ScribeResponse } from "../src/lib/speech/transcript.js";
import { hashFile } from "../src/lib/assets/registry.js";
import { inspectAsset } from "../src/lib/assets/inspect.js";

// ---------------------------------------------------------------------------
// Argument spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "provider",
    choices: ["elevenlabs", "fal"],
    default: "elevenlabs",
    description: "Transcription provider (default: ElevenLabs Scribe)",
  },
  { name: "endpoint", description: "Verified fal speech-to-text endpoint ID" },
  {
    name: "dry-run",
    type: "boolean",
    description: "Validate fal request and quote offline without writes or API calls",
  },
  { name: "project", description: "Project ID for budget and resumable paid-operation tracking" },
  {
    name: "max-cost-usd",
    type: "number",
    description: "Explicit per-operation planning bound for unknown audio prices",
  },
  { name: "operation-id", description: "Stable paid operation ID (per-scene suffix where applicable)" },
  {
    name: "input",
    short: "i",
    required: true as const,
    description: "Audio or video file to transcribe",
  },
  {
    name: "output",
    short: "o",
    required: true as const,
    description: "Destination transcript (TranscriptSchema); the raw response goes to <output>.scribe.json",
  },
  {
    name: "language",
    short: "l",
    description: "Language code hint (ISO-639-1 or 639-3), e.g. en, ru, es",
  },
  {
    name: "model",
    short: "m",
    default: DEFAULT_SCRIBE_MODEL,
    choices: SCRIBE_MODELS,
    description: "Scribe model to use",
  },
  {
    name: "verbatim",
    type: "boolean" as const,
    default: true,
    description: "Keep fillers and false starts (default); --no-verbatim removes them (v2, v3)",
  },
  {
    name: "speakers",
    type: "number" as const,
    description: "Maximum number of speakers (1-32); implies --diarize",
  },
  {
    name: "keyterms",
    description: "Comma-separated terms to bias recognition towards (surcharge, see docs/speech.md)",
  },
  {
    name: "keyterms-file",
    description: "File with one keyterm per line",
  },
  {
    name: "multichannel",
    type: "boolean" as const,
    description: "One speaker per channel, each transcribed and billed separately (max 5 channels)",
  },
  {
    name: "secondary-languages",
    description: "Comma-separated extra language codes that may occur (scribe_v3)",
  },
  {
    name: "diarize",
    type: "boolean" as const,
    description: "Annotate which speaker is talking",
  },
  {
    name: "tag-events",
    type: "boolean" as const,
    description: "Tag non-speech audio events, e.g. (laughter)",
  },
  {
    name: "from-raw",
    description:
      "Rebuild the transcript from an existing raw provider response (<name>.scribe.json): no API call, no key, no cost",
  },
  {
    name: "force",
    short: "f",
    type: "boolean" as const,
    description: "Overwrite output if it already exists",
  },
] as const;

// ---------------------------------------------------------------------------
// Error classifier for elevenlabs-scribe sentinel throws
// ---------------------------------------------------------------------------

function classifyScribeError(err: unknown): CliErrorObject {
  const msg = err instanceof Error ? err.message : String(err);

  // Sentinel format: "RATE_LIMIT:<retryAfterMs>:<body>"
  if (msg.startsWith("RATE_LIMIT:")) {
    const parts = msg.split(":");
    const retryAfterMs = parts[1] !== undefined ? parseInt(parts[1], 10) : 30_000;
    const body = parts.slice(2).join(":");
    return new CliErrorObject({
      code: "RATE_LIMIT",
      message: `ElevenLabs rate limited. Retry after ${Math.round(retryAfterMs / 1000)}s. ${body}`.trim(),
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 30_000,
    });
  }

  // Sentinel format: "NETWORK:<message>"
  if (msg.startsWith("NETWORK:")) {
    return new CliErrorObject({
      code: "NETWORK",
      message: `Transcription network error: ${msg.slice(8)}`,
    });
  }

  // Sentinel format: "UPSTREAM:<message>"
  if (msg.startsWith("UPSTREAM:")) {
    return new CliErrorObject({
      code: "INTERNAL",
      message: `Transcription API error: ${msg.slice(9)}`,
    });
  }

  if (msg.startsWith("INVALID_INPUT:")) {
    return new CliErrorObject({ code: "INVALID_INPUT", message: msg.slice(14) });
  }

  if (msg.includes("ELEVENLABS_API_KEY")) {
    return new CliErrorObject({
      code: "MISSING_API_KEY",
      message: msg,
    });
  }

  return new CliErrorObject({ code: "INTERNAL", message: msg });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const inputPath = args.input!;
  const outputPath = args.output!;

  // 1. Guard: input must exist
  requireFile(inputPath);

  const fromRaw = args["from-raw"];
  if (fromRaw) requireFile(fromRaw);

  if (args.provider === "fal") {
    if (!args.endpoint)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--provider fal requires --endpoint." });
    if (args.multichannel || args.speakers !== undefined || args["secondary-languages"] || args.verbatim === false)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "fal does not support multichannel, speaker-count, secondary-language or verbatim controls here.",
      });
    const keyterms = [
      ...(args.keyterms ?? "").split(","),
      ...(args["keyterms-file"] ? readFileSync(args["keyterms-file"], "utf8").split(/\r?\n/) : []),
    ]
      .map((term) => term.trim())
      .filter(Boolean);
    return runFalTranscribe({
      endpoint: args.endpoint,
      inputPath,
      output: outputPath,
      projectId: args.project,
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"],
      force: args.force,
      fromRaw,
      language: args.language,
      diarize: args.diarize,
      keyterms,
      tagAudioEvents: args["tag-events"],
    });
  }
  if (args.endpoint || args["dry-run"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--endpoint and --dry-run require --provider fal." });

  // 2. Guard: do not overwrite without --force
  for (const file of fromRaw ? [outputPath] : [outputPath, scribeRawPath(outputPath)]) {
    if (!args.force && existsSync(file)) {
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `Output already exists: ${file}. Pass --force to overwrite.`,
      });
    }
  }

  const modelId = args.model ?? DEFAULT_SCRIBE_MODEL;
  const language = args.language;
  const numSpeakers = args.speakers;
  const multichannel = args.multichannel;
  const diarize = args.diarize || numSpeakers !== undefined ? true : undefined;
  const verbatim = args.verbatim !== false;
  const list = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const keyterms = [
    ...list(args.keyterms),
    ...(args["keyterms-file"]
      ? readFileSync(args["keyterms-file"], "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []),
  ];
  const secondaryLanguages = list(args["secondary-languages"]);

  // --tag-events: pass through only when explicitly set, preserving the API default otherwise.
  const tagAudioEvents = args["tag-events"] ? true : undefined;

  if (fromRaw) {
    let raw: ScribeResponse;
    try {
      raw = JSON.parse(readFileSync(fromRaw, "utf8")) as ScribeResponse;
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--from-raw is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!raw || (!Array.isArray(raw.words) && !Array.isArray(raw.transcripts)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--from-raw must be a raw Scribe response with words[] or transcripts[].",
      });
    const multi = !!multichannel || Array.isArray(raw.transcripts);
    const parsed = scribeWords(raw, { multichannel: multi });
    const diarized = !!diarize || multi || new Set(parsed.words.map((word) => word.speaker).filter(Boolean)).size > 1;
    emitProgress(`Rebuilding the transcript from ${fromRaw} (no API call).`);
    return writeTranscript({ raw, parsed, rawPath: fromRaw, diarized, languageProbability: undefined });
  }

  // 3. Require API key
  requireEnv("ELEVENLABS_API_KEY");

  emitProgress(`Transcribing ${inputPath} with ${modelId}${verbatim ? " (verbatim)" : ""}…`);
  if (language) emitProgress(`Language hint: ${language}`);
  if (diarize) emitProgress(`Speaker diarisation enabled${numSpeakers ? ` (up to ${numSpeakers})` : ""}.`);
  if (keyterms.length) emitProgress(`${keyterms.length} keyterms (surcharge applies).`);

  // 4. Transcribe (with retry on rate-limit and network errors)
  const result = await withRetry(
    async () => {
      try {
        return await transcribe({
          inputPath,
          language,
          modelId,
          diarize,
          tagAudioEvents,
          verbatim,
          numSpeakers,
          multichannel: multichannel || undefined,
          ...(keyterms.length ? { keyterms } : {}),
          ...(secondaryLanguages.length ? { secondaryLanguages } : {}),
          paid: { projectId: args.project, operationId: args["operation-id"], maxCostUsd: args["max-cost-usd"] },
        });
      } catch (err) {
        if (err instanceof CliErrorObject) throw err;
        throw classifyScribeError(err);
      }
    },
    { attempts: 3, backoffMs: 5_000, retryOn: ["RATE_LIMIT", "NETWORK"] },
  );

  emitProgress(`Transcription complete. ${result.words.length} word segments.`);

  // 5. Keep the paid response, then derive the transcript from it
  const rawPath = scribeRawPath(outputPath);
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(rawPath, JSON.stringify(result.raw, null, 2));
  return writeTranscript({
    raw: result.raw,
    parsed: scribeWords(result.raw, { multichannel }),
    rawPath,
    diarized: !!diarize || !!multichannel,
    languageProbability: result.languageProbability,
  });

  function writeTranscript({
    raw,
    parsed,
    rawPath,
    diarized,
    languageProbability,
  }: {
    raw: ScribeResponse;
    parsed: ReturnType<typeof scribeWords>;
    rawPath: string;
    diarized: boolean;
    languageProbability: number | undefined;
  }) {
    const first = (Array.isArray(raw.transcripts) ? raw.transcripts[0] : raw) as ScribeResponse | undefined;
    const probability =
      languageProbability ?? (typeof first?.language_probability === "number" ? first.language_probability : undefined);
    mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    const durationSec = inspectAsset(inputPath).media?.durationSec ?? parsed.durationSec ?? null;
    if (durationSec !== null && parsed.words.some((word) => word.endSec > durationSec + 0.05))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Transcript word timing exceeds the actual source duration.",
      });
    const transcript = buildTranscript({
      source: { file: relativisePath(path.resolve(inputPath)), sha256: hashFile(inputPath), durationSec },
      engine: { provider: "elevenlabs", model: modelId, verbatim, diarized, timing: "native" },
      language: language ?? parsed.language ?? "und",
      words: parsed.words,
      ...(parsed.untimed ? { notes: [`${parsed.untimed} recognised words had no timestamps and were left out.`] } : {}),
    });
    writeFileSync(outputPath, JSON.stringify(transcript, null, 2) + "\n");
    emitProgress(`Saved to ${outputPath}`);

    return {
      outputs: [relativisePath(path.resolve(outputPath)), relativisePath(path.resolve(rawPath))],
      metadata: {
        model: modelId,
        language: transcript.language,
        languageProbability: probability,
        wordCount: transcript.words.filter((word) => word.kind === "word").length,
        fillerCount: transcript.words.filter((word) => word.kind === "filler").length,
        eventCount: transcript.words.filter((word) => word.kind === "event").length,
        speakers: transcript.speakers.map((speaker) => speaker.id),
        sentenceCount: transcript.sentences.length,
        durationSec,
      },
    };
  }
});
