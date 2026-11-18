/**
 * Local transcript with no paid APIs: Silero VAD speech mask, Parakeet TDT 0.6B v3 through MLX
 * (whisper.cpp fallback) and pyannote Community-1 speakers when HF_TOKEN is set. Guide: docs/speech.md.
 *
 *   pnpm speech:local --input recording.mp4 --output out/transcript.json --language en
 *   pnpm speech:local --project ID --input recording.mp4      # pipeline/transcript.json + pipeline/speech-mask.json
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CliErrorObject,
  emitProgress,
  parseArgs,
  relativisePath,
  requireFile,
  requireProject,
  runScript,
} from "../src/lib/cli/index.js";
import { localTranscript } from "../src/lib/speech/local.js";

const SPECS = [
  { name: "input", short: "i", required: true as const, description: "Audio or video file" },
  { name: "project", description: "Project ID: default outputs go to its pipeline/ directory" },
  {
    name: "output",
    short: "o",
    description: "Transcript path (TranscriptSchema); default pipeline/transcript.json of --project",
  },
  {
    name: "vad-output",
    description: "Speech mask path (SpeechMaskSchema); default speech-mask.json beside the transcript",
  },
  {
    name: "language",
    short: "l",
    description:
      "Language code written to the transcript (Parakeet detects speech language itself); passed to whisper.cpp",
  },
  {
    name: "engine",
    default: "auto",
    choices: ["auto", "parakeet", "whisper", "apple"] as const,
    description:
      "Recogniser: auto uses a qualified Apple task/language when available, otherwise Parakeet then whisper.cpp; explicit apple never changes backend",
  },
  {
    name: "require-word-timing",
    type: "boolean" as const,
    description: "Refuse phrase-distributed Apple timing for word-exact cuts or animated captions",
  },
  {
    name: "vad",
    type: "boolean" as const,
    default: true,
    description: "Run Silero VAD (default); --no-vad skips the mask and recognises the whole file",
  },
  {
    name: "diarize",
    type: "boolean" as const,
    default: true,
    description: "Label speakers with pyannote when HF_TOKEN is set (default); --no-diarize skips it",
  },
  { name: "speakers", type: "number" as const, description: "Exact number of speakers for diarisation" },
  { name: "force", short: "f", type: "boolean" as const, description: "Overwrite existing outputs" },
] as const;

runScript(async () => {
  const args = parseArgs(SPECS);
  const input = args.input!;
  requireFile(input);
  if (args.project) requireProject(args.project);
  const output =
    args.output ?? (args.project ? path.join("public/projects", args.project, "pipeline/transcript.json") : undefined);
  if (!output) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --output or --project." });
  const maskOutput = args["vad-output"] ?? path.join(path.dirname(output), "speech-mask.json");
  if (args.speakers !== undefined && (!Number.isInteger(args.speakers) || args.speakers < 1))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--speakers must be a positive integer." });
  for (const file of args.vad ? [output, maskOutput] : [output]) {
    if (!args.force && existsSync(file))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `Output already exists: ${file}. Pass --force to overwrite.`,
      });
  }

  const result = await localTranscript({
    mediaFile: relativisePath(path.resolve(input)),
    language: args.language,
    engine: args.engine as "auto" | "parakeet" | "whisper" | "apple",
    vad: args.vad,
    requireWordTiming: args["require-word-timing"],
    diarize: args.diarize,
    numSpeakers: args.speakers,
    onProgress: emitProgress,
  });

  const outputs: string[] = [];
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(result.transcript, null, 2) + "\n");
  outputs.push(relativisePath(path.resolve(output)));
  if (result.mask) {
    mkdirSync(path.dirname(path.resolve(maskOutput)), { recursive: true });
    writeFileSync(maskOutput, JSON.stringify(result.mask, null, 2) + "\n");
    outputs.push(relativisePath(path.resolve(maskOutput)));
  }
  for (const note of result.transcript.notes ?? []) emitProgress(`Note: ${note}`);
  const { transcript } = result;
  return {
    outputs,
    metadata: {
      engine: result.engine,
      model: transcript.engine.model,
      diarized: transcript.engine.diarized,
      language: transcript.language,
      wordCount: transcript.words.length,
      sentenceCount: transcript.sentences.length,
      speakers: transcript.speakers.map((speaker) => speaker.id),
      speechSec: result.mask?.speechSec ?? null,
      timings: result.timings,
      notes: transcript.notes ?? [],
    },
  };
});
