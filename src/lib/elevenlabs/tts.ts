/*
 * ElevenLabs v3 audio tag cheatsheet
 *
 * Inline tags are placed directly inside the `text` field — no wrapper element
 * needed. They work only with eleven_v3.
 *
 * Examples:
 *   "And then — [whispered] no one ever saw him again."
 *   "[laughs] You actually thought that would work?"
 *   "The alarm blared. [shouted] Get out now!"
 *   "She paused… and looked away. [sighs] Fine."
 *
 * Available tags: [whispered] [laughs] [shouted] [sighs] [excited] [sad]
 *   [curious] [surprised] [angry] [fearful] [disgusted] [soft] [fast] [slow]
 *
 * Pauses: v3 does not support SSML <break> tags. Use punctuation (comma, ellipsis,
 * em dash, a new sentence) or a [pause] tag.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { z } from "zod";

import {
  executeElevenLabsRequest,
  saveGeneratedAudio,
  audioFileIdentity,
  type AudioPaidContext,
} from "../jobs/elevenlabs-boundary";

const API_BASE = "https://api.elevenlabs.io/v1";

/** Available ElevenLabs TTS model identifiers. */
export const ELEVEN_LABS_MODELS = {
  v2: "eleven_multilingual_v2",
  v3: "eleven_v3",
} as const;

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
};

/** Extended voice settings supported by eleven_v3 (and accepted by v2). */
export type ExtendedVoiceSettings = VoiceSettings & {
  use_speaker_boost?: boolean;
};

export type GenerateVoiceoverOptions = {
  paid?: AudioPaidContext;
  text: string;
  voiceId: string;
  outputPath: string;
  modelId?: string;
  voiceSettings?: ExtendedVoiceSettings;
  /** Control text normalisation. Defaults to "auto". eleven_v3 only. */
  applyTextNormalization?: "auto" | "on" | "off";
  /** ISO 639-1 language code hint, e.g. "en", "fr". eleven_v3 only. */
  languageCode?: string;
};

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
};

// Popular ElevenLabs voice IDs
export const VOICES = {
  rachel: "21m00Tcm4TlvDq8ikWAM", // Female, calm, narration
  drew: "29vD33N1CtxCmqQRPOHJ", // Male, confident
  clyde: "2EiwWnXFnvU5JabPnv8n", // Male, deep
  domi: "AZnzlk1XvdvUeBnXmlld", // Female, energetic
  bella: "EXAVITQu4vr4xnSDxMaL", // Female, soft
  adam: "pNInz6obpgDQGcFmaJgB", // Male, deep narration
  custom: "TX3LPaxmHKxFdv7VOQHJ", // Custom voice
} as const;

/** Generate a single voiceover MP3 file using ElevenLabs TTS */
export async function generateVoiceover({
  text,
  voiceId,
  outputPath,
  paid,
  modelId = ELEVEN_LABS_MODELS.v2,
  voiceSettings = DEFAULT_VOICE_SETTINGS,
  applyTextNormalization,
  languageCode,
}: GenerateVoiceoverOptions): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Add it to your .env file.");
  }

  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  console.error(`Generating voiceover [${modelId}]: "${preview}"`);

  const requestBody: Record<string, unknown> = {
    text,
    model_id: modelId,
    voice_settings: voiceSettings,
  };

  if (applyTextNormalization !== undefined) {
    requestBody.apply_text_normalization = applyTextNormalization;
  }

  if (languageCode !== undefined) {
    requestBody.language_code = languageCode;
  }

  const response = await executeElevenLabsRequest({
    endpoint: `${API_BASE}/text-to-speech/${voiceId}`,
    model:
      modelId === ELEVEN_LABS_MODELS.v3
        ? "elevenlabs:tts-v3"
        : modelId === ELEVEN_LABS_MODELS.v2
          ? "elevenlabs:tts-v2"
          : `elevenlabs:${modelId}`,
    identity: requestBody,
    anchor: outputPath,
    units: text.length / 1000,
    paid,
    perform: () =>
      fetch(`${API_BASE}/text-to-speech/${voiceId}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60 * 1000),
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(requestBody),
      }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${error}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Ensure output directory exists
  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  saveGeneratedAudio(outputPath, audioBuffer);
  console.error(`Generated voiceover: ${outputPath} (${audioBuffer.length} bytes)`);
}

/**
 * Convenience wrapper for the eleven_v3 model with tuned defaults.
 * Supports inline audio tags (e.g. [whispered], [laughs]); no SSML breaks.
 */
export async function generateVoiceoverV3({
  text,
  voiceId,
  outputPath,
  paid,
  voiceSettings,
  applyTextNormalization,
  languageCode,
}: Omit<GenerateVoiceoverOptions, "modelId">): Promise<void> {
  const v3Defaults: ExtendedVoiceSettings = {
    stability: 0.4,
    similarity_boost: 0.75,
    style: 0.5,
    use_speaker_boost: true,
  };

  return generateVoiceover({
    text,
    voiceId,
    outputPath,
    modelId: ELEVEN_LABS_MODELS.v3,
    paid,
    voiceSettings: voiceSettings ?? v3Defaults,
    applyTextNormalization,
    languageCode,
  });
}

// --- Forced Alignment ---

export type CharacterAlignment = {
  text: string;
  start: number;
  end: number;
  loss: number;
};

export type WordAlignment = {
  text: string;
  start: number;
  end: number;
  loss: number;
};

export type ForcedAlignmentResult = {
  characters: CharacterAlignment[];
  words: WordAlignment[];
  loss: number;
};

/**
 * Align an audio file against its transcript, returning word- and
 * character-level timestamps (in seconds) via ElevenLabs Forced Alignment.
 */
export async function forcedAlignment({
  audioPath,
  text,
  paid,
}: {
  audioPath: string;
  text: string;
  paid?: AudioPaidContext;
}): Promise<ForcedAlignmentResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Add it to your .env file.");
  }

  const buf = readFileSync(audioPath);
  const ext = path.extname(audioPath).slice(1).toLowerCase();
  const mime = ext === "wav" ? "audio/wav" : ext === "m4a" ? "audio/mp4" : "audio/mpeg";

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), path.basename(audioPath));
  fd.append("text", text);

  const response = await executeElevenLabsRequest({
    endpoint: `${API_BASE}/forced-alignment`,
    model: "elevenlabs:forced-alignment",
    identity: { text, audioHash: audioFileIdentity(audioPath) },
    anchor: audioPath,
    units: 1,
    paid,
    perform: () =>
      fetch(`${API_BASE}/forced-alignment`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60 * 1000),
        headers: { "xi-api-key": apiKey },
        body: fd,
      }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs Forced Alignment error (${response.status}): ${error}`);
  }

  const alignment = z
    .object({ text: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative(), loss: z.number() })
    .refine((word) => word.end >= word.start, "Alignment end precedes start");
  return z
    .object({ characters: z.array(alignment), words: z.array(alignment), loss: z.number() })
    .parse(await response.json());
}

/**
 * Run forced alignment on an audio file and write the result JSON to disk,
 * creating parent directories as needed.
 */
export async function alignAndSave({
  audioPath,
  text,
  outputJsonPath,
  paid,
}: {
  audioPath: string;
  text: string;
  outputJsonPath: string;
  paid?: AudioPaidContext;
}): Promise<void> {
  const result = await forcedAlignment({ audioPath, text, paid });

  const dir = path.dirname(outputJsonPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outputJsonPath, JSON.stringify(result, null, 2));
  console.error(`Saved forced alignment: ${outputJsonPath} (${result.words.length} words)`);
}
