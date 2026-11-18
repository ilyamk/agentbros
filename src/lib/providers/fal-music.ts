/**
 * Music generation through fal's queue: a fixed allowlist of endpoints, each with
 * its own input builder pinned to the provider OpenAPI schema
 * (https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>, read 2026-11-11).
 * Prices live in src/lib/pricing.ts under the `model` key.
 */
import type { CompositionPlan } from "../elevenlabs-music";
import type { ModelKey } from "../pricing";

export type FalMusicRequest = {
  prompt?: string;
  compositionPlan?: CompositionPlan;
  durationSec?: number;
  instrumental?: boolean;
  seed?: number;
  negativePrompt?: string;
};

export type FalMusicDuration = "exact" | "upper-bound" | "fixed-30s" | "uncontrolled";

export type FalMusicModel = {
  endpoint: string;
  model: ModelKey;
  label: string;
  duration: FalMusicDuration;
  durationRange?: [number, number];
  /** Container the provider returns; a different requested extension is transcoded locally. */
  container: "mp3" | "wav";
  compositionPlan: boolean;
  seed: boolean;
  negativePrompt: boolean;
  promptLength: [number, number];
  build(request: FalMusicRequest): Record<string, unknown>;
  /** Billing quantity in the unit of the model's PRICING entry. */
  units(request: FalMusicRequest): number;
};

export class FalMusicError extends Error {}

function planSeconds(plan: CompositionPlan): number {
  return plan.sections.reduce((sum, section) => sum + (section.duration_ms ?? 0), 0) / 1000;
}

const elevenlabs: FalMusicModel = {
  endpoint: "fal-ai/elevenlabs/music",
  model: "fal:elevenlabs-music",
  label: "ElevenLabs Music (via fal)",
  duration: "exact",
  durationRange: [3, 600],
  container: "mp3",
  compositionPlan: true,
  seed: false,
  negativePrompt: false,
  promptLength: [1, 4100],
  build(request) {
    const input: Record<string, unknown> = { output_format: "mp3_44100_192" };
    if (request.compositionPlan) {
      const plan = request.compositionPlan;
      for (const section of plan.sections) {
        if (
          section.duration_ms === undefined ||
          !Number.isInteger(section.duration_ms) ||
          section.duration_ms < 3000 ||
          section.duration_ms > 120000
        ) {
          throw new FalMusicError(
            `Section "${section.section_name}" needs an integer duration_ms between 3000 and 120000.`,
          );
        }
      }
      input.composition_plan = {
        positive_global_styles: plan.positive_global_styles ?? [],
        negative_global_styles: plan.negative_global_styles ?? [],
        sections: plan.sections.map((section) => ({
          positive_local_styles: [],
          negative_local_styles: [],
          lines: [],
          ...section,
        })),
      };
      input.respect_sections_durations = true;
      return input;
    }
    input.prompt = request.prompt;
    if (request.durationSec !== undefined) input.music_length_ms = Math.round(request.durationSec * 1000);
    if (request.instrumental) input.force_instrumental = true;
    return input;
  },
  units(request) {
    const seconds = request.compositionPlan ? planSeconds(request.compositionPlan) : request.durationSec;
    if (seconds === undefined)
      throw new FalMusicError("ElevenLabs via fal needs --duration so the per-minute price can be bounded.");
    // Billed per minute; proration is not published, so the bound rounds up to whole minutes.
    return Math.ceil(seconds / 60);
  },
};

const lyria2: FalMusicModel = {
  endpoint: "fal-ai/lyria2",
  model: "fal:lyria2",
  label: "Google Lyria 2",
  duration: "fixed-30s",
  container: "wav",
  compositionPlan: false,
  seed: true,
  negativePrompt: true,
  promptLength: [1, 2000],
  build(request) {
    return {
      prompt: request.prompt,
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };
  },
  units: () => 1,
};

const minimax26: FalMusicModel = {
  endpoint: "fal-ai/minimax-music/v2.6",
  model: "fal:minimax-music-v2.6",
  label: "MiniMax Music 2.6",
  duration: "uncontrolled",
  container: "mp3",
  compositionPlan: false,
  seed: false,
  negativePrompt: false,
  promptLength: [10, 2000],
  build(request) {
    return {
      prompt: request.prompt,
      is_instrumental: request.instrumental === true,
      audio_setting: { format: "mp3", sample_rate: 44100, bitrate: 256000 },
    };
  },
  units: () => 1,
};

const minimax3: FalMusicModel = {
  endpoint: "minimax/music-3",
  model: "fal:minimax-music-3",
  label: "MiniMax Music 3",
  duration: "upper-bound",
  durationRange: [1, 300],
  container: "wav",
  compositionPlan: false,
  seed: true,
  negativePrompt: false,
  promptLength: [1, 4100],
  build(request) {
    if (!request.instrumental)
      throw new FalMusicError("minimax/music-3 requires lyrics; this CLI supports it for --instrumental tracks only.");
    if (request.durationSec === undefined)
      throw new FalMusicError("minimax/music-3 needs --duration (an upper bound on length, and the billed quantity).");
    return {
      prompt: request.prompt,
      lyrics: "[instrumental]",
      duration: request.durationSec,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };
  },
  units(request) {
    if (request.durationSec === undefined) throw new FalMusicError("minimax/music-3 needs --duration.");
    return request.durationSec;
  },
};

const stableAudio3: FalMusicModel = {
  endpoint: "fal-ai/stable-audio-3/small/music/text-to-audio",
  model: "fal:stable-audio-3-small-music",
  label: "Stable Audio 3 Small (music)",
  duration: "exact",
  durationRange: [1, 120],
  container: "mp3",
  compositionPlan: false,
  seed: true,
  negativePrompt: true,
  promptLength: [1, 4100],
  build(request) {
    return {
      prompt: request.prompt,
      output_format: "mp3",
      bitrate: "320k",
      ...(request.durationSec !== undefined ? { duration: request.durationSec } : {}),
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    };
  },
  units: () => 1,
};

export const FAL_MUSIC_MODELS: Readonly<Record<string, FalMusicModel>> = Object.freeze(
  Object.fromEntries([elevenlabs, lyria2, minimax26, minimax3, stableAudio3].map((model) => [model.endpoint, model])),
);

export type FalMusicOperation = {
  endpoint: string;
  model: ModelKey;
  input: Record<string, unknown>;
  units: number;
  container: "mp3" | "wav";
  definition: FalMusicModel;
};

/** Validates a request against the endpoint's capabilities and returns the exact provider input. */
export function buildFalMusicOperation(endpoint: string, request: FalMusicRequest): FalMusicOperation {
  const definition = FAL_MUSIC_MODELS[endpoint];
  if (!definition)
    throw new FalMusicError(
      `Unsupported fal music endpoint: ${endpoint}. Supported: ${Object.keys(FAL_MUSIC_MODELS).join(", ")}.`,
    );
  if (!request.prompt === !request.compositionPlan)
    throw new FalMusicError("Give exactly one of a prompt or a composition plan.");
  if (request.compositionPlan && !definition.compositionPlan)
    throw new FalMusicError(`${endpoint} does not accept a composition plan.`);
  if (request.compositionPlan && request.durationSec !== undefined)
    throw new FalMusicError("A composition plan sets its own length; drop --duration.");
  if (request.prompt !== undefined) {
    const [min, max] = definition.promptLength;
    if (request.prompt.length < min || request.prompt.length > max)
      throw new FalMusicError(`${endpoint} needs a prompt of ${min}–${max} characters.`);
  }
  if (request.durationSec !== undefined) {
    if (!definition.durationRange)
      throw new FalMusicError(
        `${endpoint} has no duration input (${definition.duration === "fixed-30s" ? "it returns a fixed 30 s clip" : "the model decides the length"}); trim the result instead.`,
      );
    const [min, max] = definition.durationRange;
    if (!Number.isFinite(request.durationSec) || request.durationSec < min || request.durationSec > max)
      throw new FalMusicError(`${endpoint} accepts a duration of ${min}–${max} seconds.`);
  }
  if (request.seed !== undefined && (!definition.seed || !Number.isInteger(request.seed)))
    throw new FalMusicError(`${endpoint} does not accept --seed${definition.seed ? " other than an integer" : ""}.`);
  if (request.negativePrompt !== undefined && !definition.negativePrompt)
    throw new FalMusicError(`${endpoint} does not accept --negative-prompt.`);
  return {
    endpoint,
    model: definition.model,
    input: definition.build(request),
    units: definition.units(request),
    container: definition.container,
    definition,
  };
}
