import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import { CliErrorObject } from "../cli";
import { recogniseLocalOcrFrames, type LocalOcrConfig } from "../ingest/local-ocr";
import { runLocalWorker, type LocalWorkerConfig } from "../ingest/local-worker";
import { stableHash } from "../longform/plans";
import { OcrObservationSchema } from "../../types/ocr";
import { nativeWords, NativeWordEvidenceSchema } from "../../types/native-word-timing";
import { asrStatus, defaultEngineDirectory, engineFiles, ocrStatus } from "./prepare";

export const OCR_SAMPLE_FPS = 2;
const OCR_BATCH_FRAMES = 16;
const MAX_OCR_FRAMES = 7200;
const MAX_FRAME_PIXELS = 3686400;

export type SpeechWord = { text: string; startSec: number; endSec: number; confidence?: number };
export type ScreenTextItem = {
  text: string;
  startSec: number;
  endSec: number;
  confidence?: number;
  box?: { x: number; y: number; width: number; height: number };
};
type Unavailable = { available: false; engine?: string; unavailableReason: string; fix?: string };
export type LocalSpeech =
  | {
      available: true;
      engine: string;
      language?: string;
      words: SpeechWord[];
      unavailableReason?: string;
      fix?: string;
    }
  | (Unavailable & { words: [] });
export type LocalScreenText =
  { available: true; engine: string; items: ScreenTextItem[] } | (Unavailable & { items: [] });
type Observation = z.infer<typeof OcrObservationSchema>;
export type SampledFrame = { timeSec: number; observations: Observation[] };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const round = (value: number) => Math.round(value * 1000) / 1000;
const MAX_SOUND_LABEL_WORDS = 8;
const MAX_REPEATED_WORDS = 5;

/** Engine rows that describe sound rather than speech are not words: [BLANK_AUDIO], ♪, and labels split across rows such as "(upbeat", "music)". */
export function speechWordsFromRows(raw: unknown, durationSec: number): SpeechWord[] {
  const rows = nativeWords(raw, durationSec).words;
  const words: SpeechWord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { text, startSec, endSec } = rows[i]!;
    if (/^[[(]/u.test(text)) {
      const label = rows.slice(i, i + MAX_SOUND_LABEL_WORDS).findIndex((row) => /[\])][.,!?…]*$/u.test(row.text));
      if (label >= 0) {
        i += label;
        continue;
      }
    }
    if (/[\p{L}\p{N}]/u.test(text)) words.push({ text, startSec, endSec });
  }
  return words;
}

/** Over music whisper can loop one token dozens of times. Nobody says the same word five times running. */
export function dropRepeatedWords(words: SpeechWord[]): { kept: SpeechWord[]; dropped: number } {
  const key = (word: SpeechWord) => word.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const kept: SpeechWord[] = [];
  for (let start = 0; start < words.length;) {
    let end = start + 1;
    while (end < words.length && key(words[end]!) === key(words[start]!)) end++;
    if (end - start < MAX_REPEATED_WORDS) kept.push(...words.slice(start, end));
    start = end;
  }
  return { kept, dropped: words.length - kept.length };
}

// Mixed ru+en recognition swaps lookalike letters between samples (ОДНА, then Latin-O ОДНА).
const LOOKALIKES: Record<string, string> = {
  a: "а",
  b: "в",
  c: "с",
  e: "е",
  h: "н",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
  y: "у",
};
const textKey = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[abcehkmoptxy]/g, (letter) => LOOKALIKES[letter]!);

/**
 * Merges consecutive samples with identical text (case, spacing and lookalike letters aside) into one span.
 * Each sample stands for its own interval, so a span runs half an interval either side of the
 * samples showing the text, clamped to the duration: an estimate within about 0.25 s at 2 per second.
 * Vision's bottom-left boxes become top-left origin here.
 */
export function mergeScreenText(
  frames: SampledFrame[],
  durationSec: number,
  sampleFps = OCR_SAMPLE_FPS,
): ScreenTextItem[] {
  type Open = { best: Observation; confidences: number[]; startSec: number; order: number };
  const half = 0.5 / sampleFps;
  const open = new Map<string, Open>();
  const items: (ScreenTextItem & { order: number })[] = [];
  const close = (span: Open, endSec: number) => {
    const { x, y, width, height } = span.best.box;
    items.push({
      text: span.best.text,
      startSec: round(span.startSec),
      endSec: round(endSec),
      confidence: round(span.confidences.reduce((sum, value) => sum + value, 0) / span.confidences.length),
      box: { x: round(x), y: round(1 - y - height), width: round(width), height: round(height) },
      order: span.order,
    });
  };
  let order = 0;
  for (const frame of frames) {
    const seen = new Map<string, Observation>();
    for (const row of frame.observations) {
      const key = textKey(row.text);
      const earlier = seen.get(key);
      if (/[\p{L}\p{N}]/u.test(key) && (!earlier || row.confidence > earlier.confidence)) seen.set(key, row);
    }
    for (const [key, span] of open)
      if (!seen.has(key)) {
        close(span, frame.timeSec - half);
        open.delete(key);
      }
    for (const [key, row] of seen) {
      const span = open.get(key);
      if (!span)
        open.set(key, {
          best: row,
          confidences: [row.confidence],
          startSec: frame === frames[0] ? 0 : frame.timeSec - half,
          order: order++,
        });
      else {
        span.confidences.push(row.confidence);
        if (row.confidence > span.best.confidence) span.best = row;
      }
    }
  }
  const last = frames.at(-1);
  if (last)
    for (const span of open.values()) close(span, Math.max(last.timeSec, Math.min(last.timeSec + half, durationSec)));
  return items
    .filter((item) => item.endSec > item.startSec)
    .sort((a, b) => a.startSec - b.startSec || a.order - b.order)
    .map(({ order: _order, ...item }) => item);
}

function ffmpeg(args: string[], timeoutMs: number) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`ffmpeg failed: ${result.error?.message ?? result.stderr.slice(-500)}`);
  return result.stderr;
}

/**
 * Decoded frames at the middle of each sampling interval, with their actual presentation times.
 * Edits often land on whole seconds, where text is mid-fade and Vision misses it, so samples avoid them.
 */
export function sampleVideoFrames(mediaFile: string, directory: string, sampleFps = OCR_SAMPLE_FPS) {
  const log = ffmpeg(
    [
      "-loglevel",
      "info",
      "-i",
      mediaFile,
      "-map",
      "0:v:0",
      "-vf",
      `select='gte(t,(selected_n+0.5)/${sampleFps})',showinfo,scale='trunc(iw*min(1,sqrt(${MAX_FRAME_PIXELS}/(iw*ih)))/2)*2':-2`,
      "-fps_mode",
      "vfr",
      "-frames:v",
      String(MAX_OCR_FRAMES + 1),
      "-q:v",
      "2",
      path.join(directory, "frame-%06d.jpg"),
    ],
    600000,
  );
  const times = [...log.matchAll(/Parsed_showinfo[^\n]*pts_time:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const files = readdirSync(directory)
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort();
  if (!files.length || files.length !== times.length)
    throw new Error(`Frame sampling mismatch: ${files.length} images, ${times.length} timestamps`);
  if (files.length > MAX_OCR_FRAMES) throw new Error(`OCR sampling is limited to ${MAX_OCR_FRAMES} frames`);
  return files.map((name, i) => {
    const file = path.join(directory, name);
    return { file, hash: hashFile(file), timeSec: Math.max(0, times[i]!) };
  });
}

/**
 * ASR needs a contiguous zero-origin clock, which real downloads often lack. Rendering one 16 kHz mono
 * WAV with gaps filled keeps word times on the source clock and is the only normalisation applied.
 */
function renderNormalisedAudio(mediaFile: string, file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  ffmpeg(
    [
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
      file,
    ],
    600000,
  );
}

export async function localSpeechWords(request: {
  mediaFile: string;
  engineDir?: string;
  language?: string;
  hasAudio?: boolean;
}): Promise<LocalSpeech> {
  const root = request.engineDir ?? defaultEngineDirectory();
  const status = asrStatus(root);
  if (!status.available) return { available: false, unavailableReason: status.reason, fix: status.fix, words: [] };
  const engine = status.engine;
  if (request.hasAudio === false)
    return { available: false, engine, unavailableReason: "Source has no audio stream", words: [] };
  const config: LocalWorkerConfig = { ...status.config, ...(request.language ? { language: request.language } : {}) };
  const cacheDirectory = engineFiles(root).asrCache;
  let wav: string | undefined;
  try {
    // The worker's cache key includes this path, so it must not change between runs.
    wav = path.join(cacheDirectory, "audio", `${hashFile(request.mediaFile)}.wav`);
    renderNormalisedAudio(request.mediaFile, wav);
    const durationSec = inspectAsset(wav).media.durationSec!;
    const { output } = await runLocalWorker(
      config,
      { operation: "asr", sourceFile: wav, sourceHash: hashFile(wav), durationSec },
      { cacheDirectory },
    );
    const evidence = NativeWordEvidenceSchema.parse((output as { wordTimings?: unknown }).wordTimings);
    if (evidence.status !== "available")
      return { available: false, engine, unavailableReason: `Word timing unavailable: ${evidence.reason}`, words: [] };
    const language = config.language === "auto" ? undefined : config.language;
    const { kept, dropped } = dropRepeatedWords(speechWordsFromRows(evidence, durationSec));
    const looped = dropped
      ? {
          unavailableReason: `Dropped ${dropped} looped words: recognition failed over part of this audio, so speech may be missing.`,
          fix: "Rerun with the language set, for example --language en.",
        }
      : {};
    return { available: true, engine, ...(language ? { language } : {}), words: kept, ...looped };
  } catch (error) {
    return {
      available: false,
      engine,
      unavailableReason: `Local speech recognition failed: ${message(error)}`,
      words: [],
    };
  } finally {
    if (wav) rmSync(wav, { force: true });
  }
}

const OcrBatchCacheSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    frames: z.array(z.object({ hash: z.string(), observations: z.array(OcrObservationSchema) }).strict()),
    outputHash: z.string(),
  })
  .strict();

async function recogniseBatches(
  frames: { file: string; hash: string }[],
  root: string,
  config: LocalOcrConfig,
  identityHash: string,
  runtime: Parameters<typeof recogniseLocalOcrFrames>[2],
  onProgress?: (text: string) => void,
) {
  // Static screens repeat exactly, so each distinct image is recognised once.
  const unique = [...new Map(frames.map((frame) => [frame.hash, frame])).values()];
  const results = new Map<string, Observation[]>();
  const directory = engineFiles(root).ocrCache;
  mkdirSync(directory, { recursive: true });
  const size = Math.min(OCR_BATCH_FRAMES, config.maxFrames ?? OCR_BATCH_FRAMES);
  for (let start = 0; start < unique.length; start += size) {
    const batch = unique.slice(start, start + size);
    const key = stableHash({ version: 1, identityHash, frames: batch.map((frame) => frame.hash) });
    const file = path.join(directory, `${key}.json`);
    let recognised: { hash: string; observations: Observation[] }[];
    if (existsSync(file)) {
      const cached = OcrBatchCacheSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (cached.key !== key || stableHash(cached.frames) !== cached.outputHash)
        throw new CliErrorObject({ code: "VALIDATION", message: "Local OCR cache checksum changed" });
      recognised = cached.frames;
    } else {
      onProgress?.(`OCR ${start + batch.length}/${unique.length} distinct frames`);
      try {
        recognised = (await recogniseLocalOcrFrames(config, identityHash, runtime, batch)).map(
          ({ hash, observations }) => ({ hash, observations }),
        );
      } catch (error) {
        // A dense table over the engine's observation limit must not cost the whole film. Other failures still count.
        if (!/too many observations/.test(message(error))) throw error;
        if (batch.length === 1) {
          onProgress?.(`OCR skipped one frame: ${message(error)}`);
          continue;
        }
        recognised = [];
        for (const frame of batch) {
          try {
            recognised.push(
              ...(await recogniseLocalOcrFrames(config, identityHash, runtime, [frame])).map(
                ({ hash, observations }) => ({ hash, observations }),
              ),
            );
          } catch (frameError) {
            if (!/too many observations/.test(message(frameError))) throw frameError;
            onProgress?.(`OCR skipped one frame: ${message(frameError)}`);
          }
        }
      }
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, key, frames: recognised, outputHash: stableHash(recognised) }) + "\n",
      );
      renameSync(temporary, file);
    }
    for (const row of recognised) results.set(row.hash, row.observations);
  }
  return results;
}

export async function localScreenText(request: {
  mediaFile: string;
  engineDir?: string;
  durationSec?: number;
  hasVideo?: boolean;
  onProgress?: (text: string) => void;
}): Promise<LocalScreenText> {
  const root = request.engineDir ?? defaultEngineDirectory();
  const status = await ocrStatus(root);
  if (!status.available) return { available: false, unavailableReason: status.reason, fix: status.fix, items: [] };
  const engine = status.engine;
  if (request.hasVideo === false)
    return { available: false, engine, unavailableReason: "Source has no video stream", items: [] };
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "local-screen-text-")));
  try {
    const frames = sampleVideoFrames(request.mediaFile, work);
    const results = await recogniseBatches(
      frames,
      root,
      status.config,
      status.identityHash,
      status.runtime,
      request.onProgress,
    );
    const durationSec = request.durationSec ?? inspectAsset(request.mediaFile).media.durationSec!;
    return {
      available: true,
      engine,
      items: mergeScreenText(
        frames.map((frame) => ({ timeSec: frame.timeSec, observations: results.get(frame.hash) ?? [] })),
        durationSec,
      ),
    };
  } catch (error) {
    return {
      available: false,
      engine,
      unavailableReason: `Local screen-text recognition failed: ${message(error)}`,
      items: [],
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Word-level speech and screen text from one media file, at no cost and with no network use. Each layer
 * reports `{available:false, unavailableReason, fix}` on its own, shaped for ReferenceSpeechTextSchema; `fix`
 * is the command to run. Word times are whisper.cpp native estimates, without confidence (the
 * engine's JSON has none). Both layers share the file's clock.
 */
export async function analyseSpeechAndText(request: {
  mediaFile: string;
  engineDir?: string;
  language?: string;
  onProgress?: (text: string) => void;
}) {
  const mediaFile = path.resolve(request.mediaFile);
  if (!existsSync(mediaFile) || !statSync(mediaFile).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Media not found: ${mediaFile}` });
  const inspected = inspectAsset(mediaFile);
  if (inspected.kind === "image")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Speech and screen-text analysis needs audio or video",
    });
  const speech = await localSpeechWords({
    mediaFile,
    engineDir: request.engineDir,
    language: request.language,
    hasAudio: inspected.media.hasAudio,
  });
  const screenText = await localScreenText({
    mediaFile,
    engineDir: request.engineDir,
    durationSec: inspected.media.durationSec,
    hasVideo: inspected.kind === "video",
    onProgress: request.onProgress,
  });
  return { speech, screenText, sampleFps: OCR_SAMPLE_FPS, sourceHash: hashFile(mediaFile) };
}
