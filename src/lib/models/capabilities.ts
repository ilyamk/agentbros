import {
  MODEL_CAPABILITY_IDS,
  providerOf,
  type FalCatalogEntry,
  type InputFieldSummary,
  type InputMedia,
  type ModelCapability,
  type ModelChoicePrice,
} from "../../types/fal-catalog";
import { readCachedApiModel, readHiggsfieldSchemaDoc } from "./fal-catalog";
import { snapshotFromOpenApi } from "../providers/fal-openapi";
import {
  exactChoicePrice,
  modelChoicePrice,
  planningChoicePrice,
  type ModelPriceParameters,
} from "./model-choice-price";

/**
 * One capability vocabulary over catalogue input fields, fal and Higgsfield alike (docs/fal-catalogue.md#capabilities).
 * Built from the tracked catalogues' field names; every id is held by at least one active model (tests/model-capabilities.test.ts).
 */

/** Request fields that set the output length, aspect and resolution (shared with checkModelConstraints). */
export const DURATION_FIELD = /^(duration(?:_s|_sec|_seconds)?|seconds|music_length_ms)$/;
export const ASPECT_FIELD = /^(aspect_ratio|aspect)$/;
export const RESOLUTION_FIELD = /^(resolution|output_resolution)$/;
/** fal `image_size` presets and the aspect each one gives. */
export const SIZE_ASPECTS: Readonly<Record<string, string>> = {
  square: "1:1",
  square_hd: "1:1",
  portrait_4_3: "3:4",
  portrait_16_9: "9:16",
  landscape_4_3: "4:3",
  landscape_16_9: "16:9",
};
/** Categories whose output length follows the input, never a request field. */
export const INPUT_LENGTH_CATEGORIES: readonly string[] = [
  "text-to-speech",
  "speech-to-speech",
  "audio-to-audio",
  "speech-to-text",
  "audio-to-text",
  "audio-to-video",
];

type Matcher = (field: InputFieldSummary, entry: FalCatalogEntry) => boolean;
type CapabilityDefinition = { description: string; match: Matcher };
const named =
  (pattern: RegExp, extra: Matcher = () => true): Matcher =>
  (field, entry) =>
    pattern.test(field.name) && extra(field, entry);
const types = (field: InputFieldSummary) => field.type.split("|");
const numeric = (field: InputFieldSummary) => types(field).some((type) => type === "number" || type === "integer");
const enumHas = (field: InputFieldSummary, pattern: RegExp) =>
  field.enum?.some((value) => pattern.test(String(value))) ?? false;
const outputs = (entry: FalCatalogEntry, kind: string) => (entry.outputs.kinds as string[]).includes(kind);

export const CAPABILITIES = {
  "image-input": { description: "Takes an image input of any role", match: (field) => field.media === "image" },
  "start-frame": {
    description: "First frame of a generated video (start_image_url; image_url in image-to-video)",
    match: (field, entry) =>
      /^(start_image_url|first_frame_url|first_image_url|first_frame_image_url|start_frame(_url)?)$/.test(field.name) ||
      (/^(image_url|input_image_url)$/.test(field.name) &&
        entry.category === "image-to-video" &&
        outputs(entry, "video")),
  },
  "end-frame": {
    description: "Last frame of a generated video (end_image_url, last_frame_url, tail_image_url, last_image_url)",
    match: named(/^(end_image_url|last_frame_url|tail_image_url|image_tail(_url)?|end_frame(_url)?|last_image_url)$/),
  },
  "multi-reference": {
    description: "Several reference images in one array field (limit: maxReferenceImages)",
    match: (field) => field.media === "image" && field.array === true && !/mask/.test(field.name),
  },
  "video-input": {
    description: "Takes a video input (edit, restyle, reference, motion source)",
    match: (field) => field.media === "video",
  },
  "audio-input": { description: "Takes an audio input", match: (field) => field.media === "audio" },
  "generate-audio": {
    description: "Generates a soundtrack with the video (generate_audio, sound on/off, bgm)",
    match: (field) =>
      (/^(generate_audio|generate_audio_switch|include_audio|bgm|audio)$/.test(field.name) &&
        types(field).includes("boolean")) ||
      (field.name === "sound" && enumHas(field, /^on$/)),
  },
  "audio-driven": {
    description: "Video driven by an input audio track (lip sync, talking avatar, audio-to-video)",
    match: (field, entry) => field.media === "audio" && outputs(entry, "video"),
  },
  voice: {
    description: "Choice of a voice or speaker (voice, voice_id, speaker)",
    match: named(
      /^(voice|voice_id|voice_ids|voice_setting|speaker|speaker_id|speakers|target_voice|voice_description|voice_instruction)$/,
    ),
  },
  "voice-clone": {
    description: "Speaks in a voice cloned from a reference recording",
    match: named(
      /^(ref_audio_url|reference_audio_url|voice_url|speaker_voice_embedding_file_url|target_voice_audio_url)$/,
      (_, entry) => outputs(entry, "audio"),
    ),
  },
  lyrics: { description: "Sung lyrics for generated music", match: named(/^(lyrics|lyrics_prompt)$/) },
  language: {
    description: "Language choice (speech, transcription, translation, dubbing)",
    match: named(
      /^(language|language_code|language_boost|target_language|source_language|output_language|voice_language|custom_audio_language|translation_language|target_lang|source_lang)$/,
    ),
  },
  seed: { description: "Seed for repeatable results", match: named(/^(seed|model_seed|image_seed)$/) },
  "negative-prompt": { description: "Negative prompt", match: named(/^(negative_prompt|audio_negative_prompt)$/) },
  "camera-control": {
    description: "Camera movement, angle, fixed camera or trajectory",
    match: named(/^(camera_(movement|motion|lora|fixed|poses|trajectory|angle)|free_camera_preset)$/),
  },
  loop: { description: "Loopable output (loop, loop_mode)", match: named(/^(loop|loop_mode)$/) },
  "multi-shot": {
    description: "Several shots in one generation (multi_prompt, multi_shots)",
    match: named(/^(multi_prompt|multi_shots|generate_multi_clip_switch)$/),
  },
  elements: {
    description: "Named elements (characters, objects) bound by reference images",
    match: named(/^elements$/),
  },
  keyframes: { description: "Intermediate keyframes at chosen times", match: named(/^(keyframes|keyframe_indexes)$/) },
  mask: {
    description: "Edit inside a supplied mask (inpaint, masked video)",
    match: (field) => (field.media === "image" || field.media === "video") && /mask/.test(field.name),
  },
  "style-reference": {
    description: "Style taken from a reference image or style code",
    match: named(/^(style_image_url|image_style_url|style_reference_image_url|image_style_references|style_codes)$/),
  },
  "style-preset": {
    description: "Named style preset",
    match: named(/^(style|style_preset|style_id|style_name|base_style|styles)$/, (field) =>
      types(field).some((type) => type === "string" || type === "array"),
    ),
  },
  "character-reference": {
    description: "A character, person or subject kept from a reference",
    match: named(/^(subject_reference_image_url|character|custom_reference_id|person_image_url|face_image_url)$/),
  },
  lora: { description: "Custom LoRA weights", match: named(/^loras$/) },
  fps: {
    description: "Output frame rate control",
    match: named(/^(fps|frames_per_second|frame_rate|target_fps|output_fps)$/, numeric),
  },
  "num-outputs": {
    description: "Several outputs per request (num_images, num_outputs, batch_size)",
    match: named(
      /^(num_images|num_outputs|num_samples|max_images|batch_size|num_results|num_images_per_size)$/,
      (field) => numeric(field) && field.max !== 1,
    ),
  },
  "transparent-background": {
    description: "Transparent background or alpha output",
    match: (field) =>
      (/^(background|background_color)$/.test(field.name) && enumHas(field, /^transparent$/i)) ||
      (field.name === "output_format" && enumHas(field, /^(rgba|alpha)$/)) ||
      /^(preserve_alpha|use_original_alpha)$/.test(field.name),
  },
  "prompt-expansion": {
    description: "The provider rewrites or expands the prompt (can be switched)",
    match: named(
      /^(enable_prompt_expansion|prompt_optimizer|enhance_prompt|prompt_extend|prompt_enhancement|expand_prompt|prompt_expansion_mode|enhance_prompt_mode)$/,
    ),
  },
  "safety-tolerance": { description: "Adjustable safety tolerance", match: named(/^safety_tolerance$/) },
  guidance: {
    description: "Guidance or CFG scale",
    match: named(/^(guidance_scale|cfg_scale|cfg|true_cfg|real_cfg_scale|guidance)$/, numeric),
  },
  steps: {
    description: "Inference step count",
    match: named(/^(num_inference_steps|steps|number_of_steps|num_steps|steps_num)$/, numeric),
  },
  "output-format": {
    description: "Choice of output file format or codec",
    match: named(
      /^(output_format|image_format|audio_format|export_format|format|output_container_and_codec|codec|video_output_type|output_codec)$/,
      (field) => (field.enum?.length ?? 0) >= 2,
    ),
  },
  "upscale-factor": { description: "Upscale factor", match: named(/^(upscale_factor|scale_factor)$/) },
  "web-search": {
    description: "Grounds the prompt with a web or image search",
    match: named(/^(enable_web_search|enable_image_search)$/),
  },
} as const satisfies Record<ModelCapability, CapabilityDefinition>;

export const CAPABILITY_IDS: readonly ModelCapability[] = MODEL_CAPABILITY_IDS;
/** The first input field that proves `capability`, or undefined. */
export function capabilityField(entry: FalCatalogEntry, capability: ModelCapability): InputFieldSummary | undefined {
  const match: Matcher = CAPABILITIES[capability].match;
  return entry.inputs.find((field) => match(field, entry));
}
/** Input fields matching a raw `--field` pattern (case-insensitive). */
export function fieldsMatching(entry: FalCatalogEntry, pattern: string): InputFieldSummary[] {
  const re = new RegExp(pattern, "i");
  return entry.inputs.filter((field) => re.test(field.name));
}

export type NumericLimit = {
  field: string;
  enum?: number[];
  min?: number;
  max?: number;
  default?: number;
};
export type MediaSecondsLimit = { field: string; min?: number; max?: number; source: string } | "unknown";
export type PriceStatus = "bounded" | "estimated" | "unknown";
export type CapabilityProfile = {
  provider: "fal" | "higgsfield";
  endpoint: string;
  category: string;
  tier: string;
  status: string;
  capabilities: ModelCapability[];
  fields: Partial<Record<ModelCapability, string>>;
  limits: {
    durationSec: NumericLimit | "follows-input" | null;
    aspects: string[];
    resolutions: string[];
    fps: NumericLimit | null;
    maxReferenceImages: number | "unknown" | null;
    inputAudioSec: MediaSecondsLimit | null;
    inputVideoSec: MediaSecondsLimit | null;
    outputFormats: string[];
  };
  inputs: InputMedia[];
  outputs: string[];
  price: { status: PriceStatus; scenario: ModelPriceParameters } & ModelChoicePrice;
};

const asNumber = (value: unknown): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
};
function numericLimit(field: InputFieldSummary, scale = 1): NumericLimit {
  const limit: NumericLimit = { field: field.name };
  const values = (field.enum ?? []).map(asNumber).filter((value): value is number => value !== undefined);
  if (values.length) limit.enum = values.map((value) => value * scale);
  if (field.min !== undefined) limit.min = field.min * scale;
  if (field.max !== undefined) limit.max = field.max * scale;
  const fallback = asNumber(field.default);
  if (fallback !== undefined) limit.default = fallback * scale;
  return limit;
}
/** Output length limits in seconds; `follows-input` where the category takes it from the source. */
export function durationLimit(entry: FalCatalogEntry): CapabilityProfile["limits"]["durationSec"] {
  if (INPUT_LENGTH_CATEGORIES.includes(entry.category)) return "follows-input";
  const field = entry.inputs.find((item) => DURATION_FIELD.test(item.name));
  if (!field) return entry.inputs.some((item) => item.media === "video") ? "follows-input" : null;
  return numericLimit(field, field.name.endsWith("_ms") ? 1 / 1000 : 1);
}
export function aspectChoices(entry: FalCatalogEntry): string[] {
  const values = entry.inputs.flatMap((field) =>
    ASPECT_FIELD.test(field.name)
      ? (field.enum ?? []).map(String)
      : field.name === "image_size"
        ? (field.enum ?? []).flatMap((item) =>
            typeof item === "string" && SIZE_ASPECTS[item] ? [SIZE_ASPECTS[item]] : [],
          )
        : [],
  );
  return [...new Set(values)];
}
export function resolutionChoices(entry: FalCatalogEntry): string[] {
  return [
    ...new Set(
      entry.inputs
        .filter((field) => RESOLUTION_FIELD.test(field.name))
        .flatMap((field) => (field.enum ?? []).map(String)),
    ),
  ];
}

// --- Stated input media length (seconds) --------------------------------------------------------
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const limitMemo = new Map<string, { audio: MediaSecondsLimit; video: MediaSecondsLimit }>();
/** "2-30 seconds", "4–30 seconds", "each 1-30s", "30s total", "up to 30 seconds". */
export function secondsFromDescription(text: string): { min?: number; max?: number } | undefined {
  const range = /(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec\b|secs\b|seconds?\b)/i.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const upper =
    /(?:up to|at most|max(?:imum)?(?: of)?)\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec\b|secs\b|seconds?\b)/i.exec(text) ??
    /(\d+(?:\.\d+)?)\s*(?:s|seconds?)\s+total/i.exec(text);
  return upper ? { max: Number(upper[1]) } : undefined;
}
function schemaProperties(
  provider: "fal" | "higgsfield",
  entry: FalCatalogEntry,
): { properties: Json; resolve: (node: unknown) => Json } | undefined {
  if (!entry.schema) return undefined;
  try {
    if (provider === "higgsfield") {
      const doc = readHiggsfieldSchemaDoc(entry.schema.sha256);
      const schema = doc?.schema as Json | undefined;
      const defs = isObject(schema?.$defs) ? schema.$defs : {};
      const resolve = (node: unknown): Json => {
        if (isObject(node) && typeof node.$ref === "string") return (defs[node.$ref.split("/").pop()!] as Json) ?? {};
        return isObject(node) ? node : {};
      };
      return schema && isObject(schema.properties) ? { properties: schema.properties, resolve } : undefined;
    }
    const model = readCachedApiModel(entry.schema.sha256);
    if (!model) return undefined;
    const snapshot = snapshotFromOpenApi(model, String(entry.schema.asOf), entry.schema.sha256);
    const components = snapshot.schemas as Record<string, Json>;
    const resolve = (node: unknown): Json => {
      if (isObject(node) && typeof node.$ref === "string") return components[node.$ref.split("/").pop()!] ?? {};
      return isObject(node) ? node : {};
    };
    const input = resolve(snapshot.input);
    return isObject(input.properties) ? { properties: input.properties, resolve } : undefined;
  } catch {
    return undefined;
  }
  return undefined;
}
function statedSeconds(
  field: Json,
  resolve: (node: unknown) => Json,
): { min?: number; max?: number; how: string } | undefined {
  const nodes = [field, ...(Array.isArray(field.anyOf) ? field.anyOf.map(resolve) : []), resolve(field.items)];
  for (const node of nodes) {
    const xfal = node["x-fal"];
    if (isObject(xfal) && (asNumber(xfal.max_duration) !== undefined || asNumber(xfal.min_duration) !== undefined))
      return { min: asNumber(xfal.min_duration), max: asNumber(xfal.max_duration), how: "x-fal duration bounds" };
  }
  for (const node of nodes)
    if (typeof node.description === "string") {
      const seconds = secondsFromDescription(node.description);
      if (seconds) return { ...seconds, how: "field description" };
    }
  return undefined;
}
/**
 * Input audio/video length the schema states for its media fields: Higgsfield field descriptions in the tracked
 * schema docs, fal `x-fal` bounds when the schema cache holds the endpoint. Otherwise `unknown`.
 */
export function inputMediaSeconds(entry: FalCatalogEntry): { audio: MediaSecondsLimit; video: MediaSecondsLimit } {
  const provider = providerOf(entry);
  const key = `${provider}:${entry.endpoint}:${entry.schema?.sha256 ?? "none"}`;
  const cached = limitMemo.get(key);
  if (cached) return cached;
  const schema = schemaProperties(provider, entry);
  const pick = (media: InputMedia): MediaSecondsLimit => {
    for (const field of entry.inputs.filter((item) => item.media === media)) {
      const node = schema ? schema.resolve(schema.properties[field.name]) : undefined;
      const seconds = node && statedSeconds(node, schema!.resolve);
      if (seconds)
        return {
          field: field.name,
          ...(seconds.min !== undefined ? { min: seconds.min } : {}),
          ...(seconds.max !== undefined ? { max: seconds.max } : {}),
          source: `${provider === "higgsfield" ? "Higgsfield schema" : "fal schema cache"} ${entry.schema!.sha256.slice(0, 12)} (${seconds.how})`,
        };
    }
    return "unknown";
  };
  const result = { audio: pick("audio"), video: pick("video") };
  limitMemo.set(key, result);
  return result;
}
/** Rejections and warnings for `--input-audio-sec` / `--input-video-sec` against stated limits. */
export function checkInputSeconds(
  entry: FalCatalogEntry,
  request: { inputAudioSec?: number; inputVideoSec?: number },
): { rejectedBecause: string[]; warnings: string[]; reasons: string[] } {
  const out = { rejectedBecause: [] as string[], warnings: [] as string[], reasons: [] as string[] };
  const wanted: [InputMedia & ("audio" | "video"), number | undefined][] = [
    ["audio", request.inputAudioSec],
    ["video", request.inputVideoSec],
  ];
  if (wanted.every(([, value]) => value === undefined)) return out;
  const limits = inputMediaSeconds(entry);
  for (const [media, seconds] of wanted) {
    if (seconds === undefined || !entry.inputs.some((field) => field.media === media)) continue;
    const limit = limits[media];
    if (limit === "unknown")
      out.warnings.push(`input ${media} length limit unknown; check ${seconds} s in the provider docs`);
    else if (limit.max !== undefined && seconds > limit.max)
      out.rejectedBecause.push(`input ${media} ${seconds} s above stated max ${limit.max} s (${limit.field})`);
    else if (limit.min !== undefined && seconds < limit.min)
      out.rejectedBecause.push(`input ${media} ${seconds} s below stated min ${limit.min} s (${limit.field})`);
    else out.reasons.push(`Input ${media} ${seconds} s within stated ${limit.min ?? 0}–${limit.max ?? "?"} s`);
  }
  return out;
}

export function priceStatus(price: ModelChoicePrice): PriceStatus {
  return exactChoicePrice(price) ? "bounded" : planningChoicePrice(price) ? "estimated" : "unknown";
}

/** Everything a catalogue entry states it can do, its limits and its price for one scenario. Offline. */
export function capabilityProfile(
  entry: FalCatalogEntry,
  scenario: ModelPriceParameters = {},
  options: { price?: (entry: FalCatalogEntry, parameters: ModelPriceParameters) => ModelChoicePrice } = {},
): CapabilityProfile {
  const fields: Partial<Record<ModelCapability, string>> = {};
  for (const id of CAPABILITY_IDS) {
    const field = capabilityField(entry, id);
    if (field) fields[id] = field.name;
  }
  const references = entry.inputs.filter((field) => (CAPABILITIES["multi-reference"].match as Matcher)(field, entry));
  const maxes = references.map((field) => field.max).filter((value): value is number => value !== undefined);
  const fpsField = capabilityField(entry, "fps");
  const formatField = capabilityField(entry, "output-format");
  const media = inputMediaSeconds(entry);
  const has = (kind: InputMedia) => entry.inputs.some((field) => field.media === kind);
  const price = options.price ? options.price(entry, scenario) : modelChoicePrice(entry, scenario);
  return {
    provider: providerOf(entry),
    endpoint: entry.endpoint,
    category: entry.category,
    tier: entry.tier,
    status: entry.status,
    capabilities: Object.keys(fields) as ModelCapability[],
    fields,
    limits: {
      durationSec: durationLimit(entry),
      aspects: aspectChoices(entry),
      resolutions: resolutionChoices(entry),
      fps: fpsField ? numericLimit(fpsField) : null,
      maxReferenceImages: references.length ? (maxes.length ? Math.max(...maxes) : "unknown") : null,
      inputAudioSec: has("audio") ? media.audio : null,
      inputVideoSec: has("video") ? media.video : null,
      outputFormats: (formatField?.enum ?? []).map(String),
    },
    inputs: [...new Set(entry.inputs.flatMap((field) => (field.media ? [field.media] : [])))],
    outputs: [...entry.outputs.kinds],
    price: { status: priceStatus(price), scenario, ...price },
  };
}
