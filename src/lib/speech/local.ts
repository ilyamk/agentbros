import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { appleSpeechWords, ensureApple } from "../apple/tasks";
import { inspectCapabilities, readLocalPolicy } from "../local-capabilities";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { cacheRoot } from "../cache-dir";
import { hashFile } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { CliErrorObject } from "../cli";
import { localSpeechWords } from "../local-engines/speech-text";
import { INSTALL_UV } from "../reference/worker";
import { SpeechMaskSchema, type SpeechMask } from "../../types/speech-mask";
import type { Transcript } from "../../types/transcript";
import { buildTranscript, cleanAsrWords, inferLanguage, SENTENCE_END, type RawWord } from "./transcript";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/speech-local.py");
export const PARAKEET = {
  repo: "mlx-community/parakeet-tdt-0.6b-v3",
  revision: "ed2b7e8c15f9aaa0b5772e2efb986255eaef7e15",
  model: "parakeet-tdt-0.6b-v3",
} as const;
export const PYANNOTE = {
  repo: "pyannote/speaker-diarization-community-1",
  revision: "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee",
} as const;
export const VAD_SETTINGS = { threshold: 0.5, minSpeechMs: 250, minSilenceMs: 100 } as const;
/** ASR runs per speech region: one long pass drops whole sentences when the language switches. */
const REGION = { mergeGapSec: 1, maxSec: 30, padSec: 0.2 } as const;
const TIMEOUT_MS = 60 * 60 * 1000;

type Operation = "asr" | "vad" | "diarize";
export type Region = { startSec: number; endSec: number };

export const speechCacheDirectory = () => process.env.SPEECH_LOCAL_CACHE ?? path.join(cacheRoot(), "speech");
const uvx = () => pythonUv(process.env.SPEECH_LOCAL_UVX);

/** Runs one worker operation through locked uv profiles with pinned packages; packages and weights download once. */
function runWorker<T>(operation: Operation, wav: string, request: unknown, work: string): T {
  const file = path.join(work, `${operation}-request.json`);
  writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(
    uvx(),
    [
      ...(readLocalPolicy().downloads !== "task" ? ["--offline"] : []),
      ...pythonArgs(operation, [WORKER, operation, wav, file]),
    ],
    {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...pythonEnvironment(operation),
        HF_HUB_DISABLE_TELEMETRY: "1",
        TOKENIZERS_PARALLELISM: "false",
        ...(readLocalPolicy().downloads !== "task" ? { HF_HUB_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" } : {}),
      },
    },
  );
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(-800);
    throw new Error(
      /ENOENT/.test(detail) ? `${INSTALL_UV} (${detail})` : `speech-local ${operation} failed: ${detail}`,
    );
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as T;
}

/** VAD speech merged into ASR windows: gaps under a second join, windows stay under 30 s, 0.2 s padding each side. */
export function asrRegions(speech: Region[], durationSec: number): Region[] {
  const merged: Region[] = [];
  for (const span of speech) {
    const last = merged.at(-1);
    if (last && span.startSec - last.endSec < REGION.mergeGapSec && span.endSec - last.startSec <= REGION.maxSec)
      last.endSec = span.endSec;
    else merged.push({ ...span });
  }
  const padded: Region[] = [];
  merged.forEach((span, i) => {
    const before = padded.at(-1)?.endSec ?? 0;
    const after = merged[i + 1]?.startSec ?? Number.POSITIVE_INFINITY;
    padded.push({
      startSec: round(Math.max(before, span.startSec - REGION.padSec)),
      endSec: round(
        Math.min(durationSec, Math.max(span.endSec, Math.min(span.endSec + REGION.padSec, (span.endSec + after) / 2))),
      ),
    });
  });
  return padded;
}

type Turn = { start: number; end: number; speaker: string };
const TURN_TOLERANCE_SEC = 0.1;
const TURN_REACH_SEC = 0.5;
const STRAY_RUN_WORDS = 2;
const TURN_GAP_SEC = 0.3;

/**
 * Where a word was spoken: its part inside the VAD span it starts in, or the nearest span to its start.
 * Recognisers stretch a turn's last word across the following silence, so raw word ends mislead at turn edges.
 */
export function spokenInterval(word: Pick<RawWord, "startSec" | "endSec">, speech?: Region[]): Region {
  if (!speech?.length) return { startSec: word.startSec, endSec: word.endSec };
  const distance = (span: Region) =>
    word.startSec < span.startSec ? span.startSec - word.startSec : Math.max(0, word.startSec - span.endSec);
  const span = speech.reduce((best, item) => (distance(item) < distance(best) ? item : best));
  const startSec = Math.max(word.startSec, span.startSec),
    endSec = Math.min(word.endSec, span.endSec);
  if (endSec > startSec) return { startSec, endSec };
  return word.startSec >= span.endSec
    ? { startSec: Math.max(span.startSec, span.endSec - 0.05), endSec: span.endSec }
    : { startSec: span.startSec, endSec: Math.min(span.endSec, span.startSec + 0.05) };
}

function nearestTurn(interval: Region, turns: Turn[]): { speaker: string; coverage: number } | null {
  let best: { speaker: string; score: number; coverage: number } | undefined;
  const length = Math.max(interval.endSec - interval.startSec, 1e-6);
  for (const turn of turns) {
    const overlap =
      Math.min(interval.endSec, turn.end + TURN_TOLERANCE_SEC) -
      Math.max(interval.startSec, turn.start - TURN_TOLERANCE_SEC);
    const distance = overlap > 0 ? 0 : Math.max(turn.start - interval.endSec, interval.startSec - turn.end);
    const score = overlap > 0 ? overlap : -distance;
    const coverage =
      Math.max(0, Math.min(interval.endSec, turn.end) - Math.max(interval.startSec, turn.start)) / length;
    if (distance <= TURN_REACH_SEC && (!best || score > best.score)) best = { speaker: turn.speaker, score, coverage };
  }
  return best ? { speaker: best.speaker, coverage: best.coverage } : null;
}

/**
 * Speakers for words from diarisation turns. Each word takes the turn that best overlaps where it was spoken
 * (VAD-clipped, 0.1 s tolerance; the nearest turn within 0.5 s otherwise). Inside a punctuated sentence, a run
 * of at most two words labelled differently from the sentence's majority (or unlabelled) keeps its label only when
 * a pause of 0.3 s separates it from the rest and, if labelled, a turn covers most of it; otherwise it takes the
 * majority speaker.
 */
export function assignSpeakers(words: RawWord[], turns: Turn[], speech?: Region[]): RawWord[] {
  const spoken = words.map((word) => spokenInterval(word, speech));
  const labels = spoken.map((interval) => nearestTurn(interval, turns));
  const speakers = labels.map((label) => label?.speaker ?? null);
  const gap = (a: number, b: number) => spoken[b]!.startSec - spoken[a]!.endSec;
  for (let start = 0; start < words.length;) {
    let end = start;
    while (end < words.length - 1 && !SENTENCE_END.test(words[end]!.text)) end++;
    const weight = new Map<string, number>();
    for (let i = start; i <= end; i++)
      if (speakers[i])
        weight.set(speakers[i]!, (weight.get(speakers[i]!) ?? 0) + spoken[i]!.endSec - spoken[i]!.startSec);
    const majority = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (majority) {
      for (let i = start; i <= end;) {
        if (speakers[i] === majority) {
          i++;
          continue;
        }
        let j = i;
        while (j < end && speakers[j + 1] === speakers[i]) j++;
        const covered = labels.slice(i, j + 1).every((label) => label && label.coverage >= 0.5);
        const separated =
          (i === start || gap(i - 1, i) >= TURN_GAP_SEC) && (j === end || gap(j, j + 1) >= TURN_GAP_SEC);
        if (j - i + 1 <= STRAY_RUN_WORDS && !(separated && (covered || speakers[i] === null)))
          for (let k = i; k <= j; k++) speakers[k] = majority;
        i = j + 1;
      }
    }
    start = end + 1;
  }
  return words.map((word, i) => ({ ...word, speaker: speakers[i]! }));
}

function normaliseAudio(mediaFile: string, wav: string) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-loglevel",
      "error",
      "-i",
      mediaFile,
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      "aresample=16000:async=1:first_pts=0",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-bitexact",
      wav,
    ],
    { encoding: "utf8", timeout: 600000, killSignal: "SIGKILL" },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: result.error && /ENOENT/.test(result.error.message) ? "FFMPEG_MISSING" : "INTERNAL",
      message: `ffmpeg could not decode the audio: ${result.error?.message ?? result.stderr.slice(-400)}`,
    });
}

const GATED = /GatedRepoError|gated repo|\b40[13]\b|Unauthorized|Forbidden|Access to model .* is restricted/i;

/**
 * A readable note for a failed diarisation. A refused gated download names the page to accept and the token
 * permission; anything else keeps only the last exception line. Tokens never appear in the note.
 */
export function diarisationNote(detail: string, token = process.env.HF_TOKEN): string {
  if (GATED.test(detail))
    return `Diarisation skipped, speakers are null: Hugging Face refused the gated model. Open https://huggingface.co/${PYANNOTE.repo} while signed in to the account that owns HF_TOKEN and accept its conditions; a fine-grained token also needs the "Read access to contents of all public gated repos you can access" permission. Then rerun speech:local.`;
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last =
    [...lines].reverse().find((line) => /^[\w.]+(Error|Exception)\b/.test(line)) ?? lines.at(-1) ?? "unknown error";
  const scrubbed = (token ? last.split(token).join("[token]") : last).replace(/hf_[A-Za-z0-9]{8,}/g, "[token]");
  return `Diarisation failed, speakers are null: ${scrubbed.slice(0, 300)}`;
}

export type LocalSpeechRequest = {
  mediaFile: string;
  language?: string;
  engine?: "auto" | "parakeet" | "whisper" | "apple";
  vad?: boolean;
  requireWordTiming?: boolean;
  diarize?: boolean;
  numSpeakers?: number;
  onProgress?: (text: string) => void;
};

export type LocalSpeechResult = {
  transcript: Transcript;
  mask: SpeechMask | null;
  timings: Record<string, number>;
  engine: "parakeet" | "whisper.cpp" | "apple";
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const seconds = (since: number) => Math.round((performance.now() - since) / 10) / 100;
const parakeetSupported = () => platform() === "darwin" && arch() === "arm64";

/**
 * Transcript of a local file with no paid APIs: Silero VAD mask, Parakeet TDT (MLX, Apple Silicon) per speech
 * region with whisper.cpp as fallback, and pyannote Community-1 speakers only when HF_TOKEN is set.
 * A missing optional layer becomes a note in the transcript, never an error.
 */
export async function localTranscript(request: LocalSpeechRequest): Promise<LocalSpeechResult> {
  const automaticApple =
    request.engine !== "parakeet" &&
    request.engine !== "whisper" &&
    request.engine !== "apple" &&
    request.language &&
    (await inspectCapabilities([{ task: "speech.transcribe", language: request.language, purpose: "production" }]))[0]
      ?.state === "ready";
  const wantApple = request.engine === "apple" || !!automaticApple;
  if (wantApple) {
    if (!request.language)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Apple Speech needs an explicit supported --language.",
      });
    await ensureApple("speech.transcribe", request.language);
  }
  const mediaFile = path.resolve(request.mediaFile);
  const inspected = inspectAsset(mediaFile);
  if (inspected.kind === "image" || !inspected.media.hasAudio)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Local speech needs a file with an audio stream." });
  const progress = request.onProgress ?? (() => {});
  const sha256 = hashFile(mediaFile);
  const notes: string[] = [];
  const timings: Record<string, number> = {};
  const work = mkdtempSync(path.join(tmpdir(), "speech-local-"));
  const cacheDir = path.join(speechCacheDirectory(), "hf");
  mkdirSync(cacheDir, { recursive: true });
  try {
    const wav = path.join(work, "audio.wav");
    normaliseAudio(mediaFile, wav);
    const durationSec = inspectAsset(wav).media.durationSec ?? inspected.media.durationSec ?? 0;
    const source = { file: request.mediaFile, sha256, durationSec };

    let mask: SpeechMask | null = null;
    if (request.vad !== false) {
      progress("Voice activity (Silero VAD)…");
      const started = performance.now();
      try {
        const raw = runWorker<{ version: string; speech: { start: number; end: number }[] }>(
          "vad",
          wav,
          VAD_SETTINGS,
          work,
        );
        const speech = raw.speech
          .map((span) => ({ startSec: round(span.start), endSec: round(Math.min(span.end, durationSec)) }))
          .filter((span) => span.endSec > span.startSec);
        mask = SpeechMaskSchema.parse({
          version: 1,
          source,
          engine: { provider: "silero-vad", version: raw.version, sampleRate: 16000, ...VAD_SETTINGS, padMs: 0 },
          speech,
          speechSec: round(speech.reduce((sum, span) => sum + span.endSec - span.startSec, 0)),
        });
      } catch (error) {
        notes.push(
          `Voice activity detection failed, so no speech mask was written and recognition ran over the whole file: ${message(error)}`,
        );
      }
      timings.vadSec = seconds(started);
    }

    let words: RawWord[] = [];
    let engine: LocalSpeechResult["engine"] = wantApple ? "apple" : "parakeet";
    let model: string = wantApple ? "apple-speech-transcriber" : PARAKEET.model;
    let timing: "native" | "estimated" = "native";
    const wantParakeet = request.engine !== "whisper" && parakeetSupported();
    if (request.engine === "parakeet" && !parakeetSupported())
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Parakeet through MLX needs Apple Silicon; use --engine whisper or auto.",
      });
    if (mask && mask.speech.length === 0) {
      notes.push("No speech detected.");
    } else if (wantApple) {
      const started = performance.now();
      const raw = await appleSpeechWords(wav, request.language!);
      engine = "apple";
      model = "apple-speech-transcriber";
      timing = raw.timing;
      words = raw.words.map((w) => ({ ...w, kind: "word" as const, speaker: null, channel: null }));
      timings.asrSec = seconds(started);
    } else if (wantParakeet) {
      progress("Recognising speech (Parakeet TDT 0.6B v3, MLX)…");
      const started = performance.now();
      try {
        const regions = mask ? asrRegions(mask.speech, durationSec) : undefined;
        const raw = runWorker<{
          words: { text: string; start: number; end: number; confidence: number }[];
          downloadSec: number;
          inferenceSec: number;
        }>(
          "asr",
          wav,
          {
            repo: PARAKEET.repo,
            revision: PARAKEET.revision,
            cacheDir,
            chunkSec: 120,
            overlapSec: 15,
            ...(regions ? { regions } : {}),
          },
          work,
        );
        words = raw.words.map((word) => ({
          text: word.text,
          startSec: word.start,
          endSec: Math.min(word.end, durationSec),
          kind: "word",
          speaker: null,
          channel: null,
          confidence: word.confidence,
        }));
        timings.modelLoadSec = raw.downloadSec;
        timings.asrInferenceSec = raw.inferenceSec;
      } catch (error) {
        if (request.engine === "parakeet") throw new CliErrorObject({ code: "INTERNAL", message: message(error) });
        notes.push(`Parakeet was unavailable (${message(error).slice(0, 300)}); fell back to whisper.cpp.`);
        engine = "whisper.cpp";
      }
      timings.asrSec = seconds(started);
    } else {
      engine = "whisper.cpp";
      if (request.engine !== "whisper") notes.push("Parakeet through MLX needs Apple Silicon; used whisper.cpp.");
    }
    if (engine === "whisper.cpp" && !(mask && mask.speech.length === 0)) {
      progress("Recognising speech (whisper.cpp)…");
      const started = performance.now();
      const speech = await localSpeechWords({ mediaFile, language: request.language, hasAudio: true });
      if (!speech.available)
        throw new CliErrorObject({
          code: "INTERNAL",
          message: `No local speech engine: ${speech.unavailableReason}${speech.fix ? `. Fix: ${speech.fix}` : ""}`,
        });
      if (speech.unavailableReason) notes.push(speech.unavailableReason);
      model = speech.engine;
      words = speech.words.map((word) => ({
        text: word.text,
        startSec: word.startSec,
        endSec: word.endSec,
        kind: "word",
        speaker: null,
        channel: null,
        confidence: word.confidence ?? null,
      }));
      timings.asrSec = seconds(started);
    }

    if (request.requireWordTiming && timing !== "native")
      throw new CliErrorObject({
        code: "VALIDATION",
        message:
          "Apple returned phrase-level timing. Word-exact editing requires another backend; rerun explicitly with --engine parakeet or a suitable approved transcriber.",
      });
    words = cleanAsrWords(words);
    let diarized = false;
    if (request.diarize === false) notes.push("Diarisation was turned off: speakers are null.");
    else if (!process.env.HF_TOKEN)
      notes.push(
        "Diarisation skipped: set HF_TOKEN (a Hugging Face token that has accepted the pyannote/speaker-diarization-community-1 conditions) to label speakers. Speakers are null.",
      );
    else if (words.length) {
      progress("Labelling speakers (pyannote Community-1)…");
      const started = performance.now();
      try {
        const raw = runWorker<{ turns: { start: number; end: number; speaker: string }[] }>(
          "diarize",
          wav,
          {
            repo: PYANNOTE.repo,
            revision: PYANNOTE.revision,
            cacheDir,
            ...(request.numSpeakers ? { numSpeakers: request.numSpeakers } : {}),
          },
          work,
        );
        words = assignSpeakers(words, raw.turns, mask?.speech);
        diarized = true;
      } catch (error) {
        notes.push(diarisationNote(message(error)));
      }
      timings.diarizeSec = seconds(started);
    }

    const inferred = request.language ? null : inferLanguage(words);
    if (inferred && inferred !== "und")
      notes.push(`No --language given: "${inferred}" was inferred from the recognised text (mostly Cyrillic letters).`);
    const transcript = buildTranscript({
      source,
      engine: { provider: "local", model, verbatim: false, diarized, timing },
      language: request.language ?? inferred ?? "und",
      words,
      notes,
    });
    return { transcript, mask, timings, engine };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;
