/**
 * ElevenLabs Music Generation API — dedicated client module.
 *
 * ─── Confirmed via WebFetch (2026-04-29) ────────────────────────────────────
 *
 * Endpoint:   POST https://api.elevenlabs.io/v1/music
 * Auth:       xi-api-key header
 * Response:   200 → binary audio (audio/mpeg by default)
 *             422 → JSON validation error
 *
 * Prompt mode body:
 *   {
 *     prompt: string,                 // text description — mutually exclusive with composition_plan
 *     music_length_ms?: number,       // 3000–600000 ms (default: model decides); prompt mode only
 *     model_id?: string,              // default "music_v1"
 *     seed?: number | null,           // reproducibility hint (not guaranteed)
 *     force_instrumental?: boolean,   // default false — guarantees no vocals
 *     respect_sections_durations?: boolean, // default true
 *   }
 *
 * Composition-plan mode body:
 *   {
 *     composition_plan: CompositionPlan,  // mutually exclusive with prompt
 *     model_id?: string,
 *     seed?: number | null,
 *     force_instrumental?: boolean,
 *   }
 *
 * CompositionPlan shape (MusicPrompt in the OpenAPI schema):
 *   {
 *     positive_global_styles?: string[],
 *     negative_global_styles?: string[],
 *     sections: SongSection[],
 *   }
 *
 * SongSection shape:
 *   {
 *     section_name: string,             // 1–100 chars
 *     positive_local_styles?: string[],
 *     negative_local_styles?: string[],
 *     duration_ms?: number,             // 3000–120000 ms
 *     lines?: string[],                 // max 200 chars each
 *   }
 *
 * Rate limits: not documented.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { executeElevenLabsRequest, saveGeneratedAudio, type AudioPaidContext } from "./jobs/elevenlabs-boundary";

export const MUSIC_API_BASE = "https://api.elevenlabs.io/v1/music";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SongSection = {
  /** Section identifier, e.g. "verse", "chorus". 1–100 chars. */
  section_name: string;
  positive_local_styles?: string[];
  negative_local_styles?: string[];
  /** Duration in milliseconds. 3000–120000. */
  duration_ms?: number;
  /** Lyric lines. Each max 200 chars. */
  lines?: string[];
};

/** Structured composition plan — mutually exclusive with `prompt`. */
export type CompositionPlan = {
  positive_global_styles?: string[];
  negative_global_styles?: string[];
  sections: SongSection[];
};

export type GenerateMusicOptions = {
  paid?: AudioPaidContext;
  /** Text prompt. Mutually exclusive with `compositionPlan`. */
  prompt?: string;
  /** Structured plan. Mutually exclusive with `prompt`. */
  compositionPlan?: CompositionPlan;
  /**
   * Requested duration in seconds. Converted to music_length_ms.
   * Only applied in prompt mode (3–600s range).
   */
  durationSec?: number;
  /** Output file path. Parent directories are created automatically. */
  outputPath: string;
  /** ElevenLabs model ID. Defaults to "music_v1". */
  modelId?: string;
  /** When true the output is guaranteed instrumental (no vocals). */
  forceInstrumental?: boolean;
  /** Seed for reproducibility (not guaranteed). */
  seed?: number;
};

export type GenerateMusicResult = {
  sizeBytes: number;
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Generate a music track via the ElevenLabs Music API and save it to disk.
 *
 * Throws on non-OK HTTP responses, including the error body text.
 * Caller is responsible for providing a valid ELEVENLABS_API_KEY via
 * `process.env.ELEVENLABS_API_KEY`.
 */
export async function generateMusic(opts: GenerateMusicOptions): Promise<GenerateMusicResult> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Add it to your .env file.");
  }

  if (!opts.prompt && !opts.compositionPlan) {
    throw new Error("Either prompt or compositionPlan must be provided.");
  }

  if (opts.prompt && opts.compositionPlan) {
    throw new Error("prompt and compositionPlan are mutually exclusive — use one or the other.");
  }

  if (
    opts.durationSec !== undefined &&
    (!Number.isFinite(opts.durationSec) || opts.durationSec < 3 || opts.durationSec > 600)
  )
    throw new Error("Music duration must be 3–600 seconds");
  // Build request body
  const body: Record<string, unknown> = {
    model_id: opts.modelId ?? "music_v1",
  };

  if (opts.forceInstrumental !== undefined) {
    body["force_instrumental"] = opts.forceInstrumental;
  }
  if (opts.seed !== undefined) {
    body["seed"] = opts.seed;
  }

  if (opts.prompt) {
    body["prompt"] = opts.prompt;
    if (opts.durationSec !== undefined) {
      body["music_length_ms"] = Math.round(opts.durationSec * 1000);
    }
  } else if (opts.compositionPlan) {
    body["composition_plan"] = opts.compositionPlan;
    // music_length_ms is not used in composition-plan mode
  }

  const durationSec =
    opts.durationSec ??
    opts.compositionPlan?.sections.reduce((sum, section) => sum + (section.duration_ms ?? 120000) / 1000, 0) ??
    600;
  const response = await executeElevenLabsRequest({
    endpoint: MUSIC_API_BASE,
    model: (opts.modelId ?? "music_v1") === "music_v1" ? "elevenlabs:music" : `elevenlabs:${opts.modelId}`,
    identity: body,
    anchor: opts.outputPath,
    units: durationSec,
    paid: opts.paid,
    perform: () =>
      fetch(MUSIC_API_BASE, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60 * 1000),
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
      }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs Music API error (${response.status}): ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Ensure output directory exists
  const dir = path.dirname(opts.outputPath);
  mkdirSync(dir, { recursive: true });

  saveGeneratedAudio(opts.outputPath, audioBuffer);

  return { sizeBytes: audioBuffer.length };
}
