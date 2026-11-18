/**
 * ElevenLabs Scribe speech-to-text (scribe_v1, scribe_v2, scribe_v3).
 *
 * Endpoint: POST https://api.elevenlabs.io/v1/speech-to-text (multipart/form-data)
 * Reference, verified 2026-11-13: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * List parameters (keyterms, secondary_language_codes) are repeated form fields, as in the official
 * JS SDK. Parameters, response shapes and prices: docs/speech.md.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { executeElevenLabsRequest, audioFileIdentity, type AudioPaidContext } from "./jobs/elevenlabs-boundary";
import { inspectAsset } from "./assets/inspect";
import type { ScribeResponse } from "./speech/transcript";

const API_BASE = "https://api.elevenlabs.io/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScribeWord = {
  text: string;
  start: number | null;
  end: number | null;
  type?: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
  logprob?: number | null;
  channel_index?: number | null;
};

export type ScribeResult = {
  text: string;
  words: ScribeWord[];
  languageCode?: string;
  languageProbability?: number;
  audioDurationSecs?: number | null;
  /** The response exactly as received, single or multichannel. */
  raw: ScribeResponse;
};

export const SCRIBE_MODELS = ["scribe_v1", "scribe_v2", "scribe_v3"] as const;
export type ScribeModel = (typeof SCRIBE_MODELS)[number];
export const DEFAULT_SCRIBE_MODEL: ScribeModel = "scribe_v3";
const PRICE_KEY: Record<string, string> = {
  scribe_v1: "elevenlabs:scribe-v1",
  scribe_v2: "elevenlabs:scribe-v2",
  scribe_v3: "elevenlabs:scribe-v3",
};
/** The API reference says +20% for keyterms; the pricing page lists $0.05/h on $0.20/h (+25%). Budget the higher. */
export const KEYTERM_SURCHARGE = 1.25;
export const MAX_SCRIBE_CHANNELS = 5;
export const MAX_SCRIBE_SPEAKERS = 32;

export type TranscribeOptions = {
  paid?: AudioPaidContext;
  inputPath: string;
  language?: string;
  modelId?: string;
  diarize?: boolean;
  tagAudioEvents?: boolean;
  /** false sends no_verbatim=true: fillers and false starts removed (v2, v3). */
  verbatim?: boolean;
  numSpeakers?: number;
  keyterms?: string[];
  multichannel?: boolean;
  /** scribe_v3 only. */
  secondaryLanguages?: string[];
  timestampsGranularity?: "word" | "character";
};

/** Throws on keyterms the API would reject: at most 1000, each ≤ 50 characters and ≤ 5 words, no <>{}[]\\. */
export function validateKeyterms(keyterms: string[]): string[] {
  const terms = keyterms.map((term) => term.trim()).filter(Boolean);
  if (terms.length > 1000) throw new Error("INVALID_INPUT:At most 1000 keyterms are allowed.");
  for (const term of terms) {
    if (term.length > 50) throw new Error(`INVALID_INPUT:Keyterm longer than 50 characters: ${term}`);
    if (term.split(/\s+/).length > 5) throw new Error(`INVALID_INPUT:Keyterm has more than 5 words: ${term}`);
    if (/[<>{}[\]\\]/.test(term))
      throw new Error(`INVALID_INPUT:Keyterm contains an unsupported character (<>{}[]\\): ${term}`);
  }
  return terms;
}

/** Billable minutes for the budget: each channel at full duration, keyterm surcharge, 20 s minimum over 100 keyterms. */
export function billableMinutes(durationSec: number, options: { channels?: number; keyterms?: number }): number {
  const keyterms = options.keyterms ?? 0;
  const seconds = keyterms > 100 ? Math.max(20, durationSec) : durationSec;
  return (seconds / 60) * Math.max(1, options.channels ?? 1) * (keyterms > 0 ? KEYTERM_SURCHARGE : 1);
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Core transcription function
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio or video file via ElevenLabs Scribe.
 *
 * Reads ELEVENLABS_API_KEY from the environment. Throws on network errors or
 * non-2xx responses so the caller (withRetry or runScript) can classify them.
 */
export async function transcribe({
  inputPath,
  language,
  modelId = DEFAULT_SCRIBE_MODEL,
  diarize,
  tagAudioEvents,
  verbatim,
  numSpeakers,
  keyterms,
  multichannel,
  secondaryLanguages,
  timestampsGranularity,
  paid,
}: TranscribeOptions): Promise<ScribeResult> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Add it to your .env file.");
  }
  if (!(SCRIBE_MODELS as readonly string[]).includes(modelId))
    throw new Error(`INVALID_INPUT:Unknown Scribe model ${modelId}; use one of ${SCRIBE_MODELS.join(", ")}.`);
  if (verbatim === false && modelId === "scribe_v1")
    throw new Error("INVALID_INPUT:scribe_v1 has no no_verbatim mode; use scribe_v2 or scribe_v3.");
  if (secondaryLanguages?.length && modelId !== "scribe_v3")
    throw new Error("INVALID_INPUT:Secondary languages need scribe_v3.");
  if (
    numSpeakers !== undefined &&
    (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > MAX_SCRIBE_SPEAKERS)
  )
    throw new Error(`INVALID_INPUT:Speaker count must be an integer from 1 to ${MAX_SCRIBE_SPEAKERS}.`);
  const terms = keyterms ? validateKeyterms(keyterms) : [];

  const inspected = inspectAsset(inputPath);
  const duration = inspected.media?.durationSec;
  const channels = multichannel ? (inspected.media?.channels ?? 1) : 1;
  if (multichannel && channels > MAX_SCRIBE_CHANNELS)
    throw new Error(
      `INVALID_INPUT:Multichannel transcription allows at most ${MAX_SCRIBE_CHANNELS} channels; this file has ${channels}.`,
    );

  const buf = readFileSync(inputPath);
  const mime = mimeForPath(inputPath);
  const filename = path.basename(inputPath);

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), filename);
  fd.append("model_id", modelId);

  if (language !== undefined) fd.append("language_code", language);
  if (diarize !== undefined) fd.append("diarize", String(diarize));
  if (tagAudioEvents !== undefined) fd.append("tag_audio_events", String(tagAudioEvents));
  if (verbatim === false) fd.append("no_verbatim", "true");
  if (numSpeakers !== undefined) fd.append("num_speakers", String(numSpeakers));
  if (multichannel) fd.append("use_multi_channel", "true");
  if (timestampsGranularity !== undefined) fd.append("timestamps_granularity", timestampsGranularity);
  for (const term of terms) fd.append("keyterms", term);
  for (const code of secondaryLanguages ?? []) fd.append("secondary_language_codes", code);

  let response: Response;
  try {
    if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
      throw new Error("Cannot budget transcription without a valid media duration");
    const identity = {
      audioHash: audioFileIdentity(inputPath),
      modelId,
      ...(language !== undefined ? { language } : {}),
      ...(diarize !== undefined ? { diarize } : {}),
      ...(tagAudioEvents !== undefined ? { tagAudioEvents } : {}),
      ...(verbatim === false ? { noVerbatim: true } : {}),
      ...(numSpeakers !== undefined ? { numSpeakers } : {}),
      ...(multichannel ? { multichannel: true } : {}),
      ...(timestampsGranularity !== undefined ? { timestampsGranularity } : {}),
      ...(terms.length ? { keyterms: terms } : {}),
      ...(secondaryLanguages?.length ? { secondaryLanguages } : {}),
    };
    response = await executeElevenLabsRequest({
      endpoint: `${API_BASE}/speech-to-text`,
      model: PRICE_KEY[modelId]!,
      identity,
      anchor: inputPath,
      units: billableMinutes(duration, { channels, keyterms: terms.length }),
      paid,
      perform: () =>
        fetch(`${API_BASE}/speech-to-text`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10 * 60 * 1000),
          headers: { "xi-api-key": apiKey },
          body: fd,
        }),
    });
  } catch (err) {
    // Preserve the journal error: reclassifying ambiguous POSTs as NETWORK enables unsafe outer retries.
    throw err;
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30_000;
    throw new Error(`RATE_LIMIT:${retryAfterMs}:${await response.text()}`);
  }

  if (response.status >= 500) {
    throw new Error(`NETWORK:Scribe API server error (${response.status}): ${await response.text()}`);
  }

  if (!response.ok) {
    throw new Error(`UPSTREAM:Scribe API error (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as ScribeResponse & {
    text?: string;
    language_code?: string;
    language_probability?: number;
    audio_duration_secs?: number | null;
  };
  const chunks = (Array.isArray(data.transcripts) ? data.transcripts : [data]) as Array<{
    text?: string;
    words?: ScribeWord[];
    language_code?: string;
    language_probability?: number;
  }>;
  const words: ScribeWord[] = chunks.flatMap((chunk) =>
    (chunk.words ?? []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      type: w.type,
      ...(w.speaker_id !== undefined ? { speaker_id: w.speaker_id } : {}),
      ...(w.logprob !== undefined ? { logprob: w.logprob } : {}),
      ...(w.channel_index !== undefined ? { channel_index: w.channel_index } : {}),
    })),
  );

  return {
    text: chunks.map((chunk) => chunk.text ?? "").join("\n"),
    words,
    languageCode: chunks[0]?.language_code,
    languageProbability: chunks[0]?.language_probability,
    audioDurationSecs: data.audio_duration_secs,
    raw: data,
  };
}
