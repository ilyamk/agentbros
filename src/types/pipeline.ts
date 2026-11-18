import { z } from "zod";
import {
  ElevenLabsIdSchema,
  InlinePronunciationSchema,
  SpeechCueSchema,
  SpeechOptionsSchema,
  VoiceRefSchema,
  VoiceSettingsSchema,
} from "./elevenlabs";
import { LeftPanelSchema } from "./video";
import { FalEndpointRequestSchema, FalOperationRequestSchema } from "./generation";

// --- Stage & status enums ---

export const PipelineStageSchema = z.enum([
  "brief",
  "script",
  "design",
  "characters",
  "storyboard",
  "asset-plan",
  "assets",
  "narrator-direction",
  "voiceover",
  "caption-edit",
  "rhythm",
  "audio-mix",
  "talking-head",
  "compose",
  "render",
  "qa",
]);

export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PIPELINE_STAGES: PipelineStage[] = PipelineStageSchema.options;

export const StageStatusSchema = z.enum(["pending", "running", "done", "failed", "skipped"]);

export type StageStatus = z.infer<typeof StageStatusSchema>;

// --- Brief ---

/**
 * Quality tier — drives default model picks across the asset planner.
 *   - "fast"     : minimum-cost defaults (FLUX schnell, Seedance 2 fast 480p, no premium)
 *   - "balanced" : strong defaults at moderate cost (FLUX dev, Seedance 2 fast 720p, gpt-image-1 for memes)
 *   - "quality"  : best-in-class for hero shots (gpt-image-2 high, Kling 2.5 turbo, Seedance 2 fast 720p with audio)
 *
 * The asset-planner agent reads `brief.qualityTier` and maps it via
 * `TIER_MODEL_PICKS` in `src/lib/pricing.ts`.
 */
export const QualityTierSchema = z.enum(["fast", "balanced", "quality"]);

export type QualityTier = z.infer<typeof QualityTierSchema>;

/**
 * Tempo / cut density — how aggressively the storyboarder should chop the
 * video into scenes.
 *   - "calm"     : long holds, ≤ 2 left-panel changes for 20s (documentary)
 *   - "standard" : moderate cuts, 3–4 changes for 20s (educational explainer)
 *   - "snappy"   : quick cuts, 5+ changes (TikTok / Reels / promo ad)
 */
export const TempoStyleSchema = z.enum(["calm", "standard", "snappy"]);

export type TempoStyle = z.infer<typeof TempoStyleSchema>;

export const FormatSchema = z.enum(["vertical", "square", "landscape"]);

export type Format = z.infer<typeof FormatSchema>;

/**
 * The kind of film, chosen first: it decides the chain's steps, the material route and the tools (src/lib/film/routes.ts).
 * Optional so older briefs still validate; an absent type is routed as motion-graphics and reported.
 */
export const FilmTypeSchema = z.enum([
  "motion-graphics",
  "ui-demo",
  "footage",
  "ai-video",
  "talking-head",
  "explainer",
  "collage",
  "replica",
]);

export type FilmType = z.infer<typeof FilmTypeSchema>;

export const BriefSchema = z.object({
  topic: z.string(),
  audience: z.string(),
  tone: z.string(),
  /** Primary delivery format — drives storyboarder leftPanel decisions and design-director.talkingHead.enabled. */
  format: FormatSchema,
  /**
   * All render formats to ship. Defaults to `[format]`.
   * Set to multiple formats (e.g. `["landscape", "vertical"]`) when the same
   * content should be repurposed for different platforms (YouTube + Reels +
   * Stories). Composer registers one Composition per entry; the same
   * scene data flows through, only the layout reflows.
   */
  outputFormats: z.array(FormatSchema).optional(),
  /** Total video duration in seconds (max 90) */
  durationSec: z.number().positive().max(90),
  productName: z.string(),
  tagline: z.string().optional(),
  callToAction: z.string().optional(),
  /** URLs, file paths, or free-text references the creative should draw from */
  references: z.array(z.string()).default([]),
  /** BCP-47 language tag, e.g. "en", "fr", "ru" */
  language: z.string().default("en"),
  /** Drives model defaults — see QualityTierSchema. Defaults to "balanced". */
  qualityTier: QualityTierSchema.default("balanced"),
  /** Drives storyboarder cut density and asset-planner left-panel-change budget. Default "standard". */
  tempoStyle: TempoStyleSchema.default("standard"),
  /**
   * Hard ceiling on total estimated USD spend across all paid APIs (fal, ElevenLabs, …).
   * The orchestrator halts before any stage that would push the cost-ledger past this number.
   * Omitted or null authorises no paid spend (it is not "no ceiling"): paid work is refused until the user's
   * own words set one with `pnpm budget --ceiling-usd N --answer "..."`. A number lets a paid command install
   * a first durable ceiling of at most USD 10 (src/lib/jobs/initial-policy.ts).
   */
  budgetUsd: z.number().nonnegative().nullable().default(null),
  notes: z.string().optional(),
  /** "bespoke" hands composition to motion-engineer and turns on the creative checks in pipeline:check. */
  renderMode: z.enum(["template", "bespoke"]).optional(),
  /** Bespoke chain profile. "promo" (films of 45 s or less): reference-number checks are advisory. */
  profile: z.enum(["full", "promo"]).default("full"),
  /** The film's type. See FilmTypeSchema. */
  filmType: FilmTypeSchema.optional(),
  /** A second type for a hybrid: its material and tools join the primary type's route. */
  secondaryFilmType: FilmTypeSchema.optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

// --- Script ---

/** Voice keys derived from VOICES in src/lib/elevenlabs/tts.ts */
export const NarratorVoiceSchema = z.enum(["rachel", "drew", "clyde", "domi", "bella", "adam", "custom"]);

export type NarratorVoice = z.infer<typeof NarratorVoiceSchema>;

export const BeatKindSchema = z.enum(["hook", "pain", "solution", "proof", "cta", "transition", "reveal"]);

export type BeatKind = z.infer<typeof BeatKindSchema>;

export const ScriptBeatSchema = z.object({
  id: z.string(),
  lineId: ElevenLabsIdSchema.optional(),
  speakerId: ElevenLabsIdSchema.optional(),
  kind: BeatKindSchema,
  text: z.string(),
  durationSec: z.number().positive(),
  /** Hook technique used — e.g. "pattern interrupt", "curiosity gap", "contradiction" */
  attentionDevice: z.string().optional(),
});

export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

export const ScriptSchema = z
  .object({
    narratorVoice: NarratorVoiceSchema,
    voiceRef: VoiceRefSchema.optional(),
    voiceoverEnabled: z.boolean(),
    language: z.string(),
    beats: z.array(ScriptBeatSchema),
    dialogue: z
      .array(
        z
          .object({
            lineId: ElevenLabsIdSchema,
            speakerId: ElevenLabsIdSchema,
            sceneId: ElevenLabsIdSchema,
            shotId: ElevenLabsIdSchema.optional(),
            language: z.string().min(2),
            text: z.string().trim().min(1),
            voiceRef: VoiceRefSchema.optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    /** Recurring motifs the script returns to (e.g. "speed", "trust") */
    themes: z.array(z.string()).default([]),
    signOff: z.string().optional(),
  })
  .superRefine((script, ctx) => {
    const ids = [
      ...script.beats.flatMap((beat) => (beat.lineId ? [beat.lineId] : [])),
      ...(script.dialogue ?? []).map((line) => line.lineId),
    ];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["dialogue"], message: "Each scripted line ID must be unique" });
  });

export type Script = z.infer<typeof ScriptSchema>;

// --- Design ---

export const DesignPaletteMoodSchema = z.enum(["dark", "light", "vibrant", "muted", "editorial"]);

export type DesignPaletteMood = z.infer<typeof DesignPaletteMoodSchema>;

export const FontTokenSchema = z.enum([
  "primary",
  "display",
  "condensed",
  "serif",
  "rounded",
  "narrow",
  "geometric",
  "cyrillic-condensed",
  "cyrillic-wide",
  "cyrillic-grotesk",
  "cyrillic-rounded",
]);

export type FontToken = z.infer<typeof FontTokenSchema>;

export const MotionStyleSchema = z.enum(["snappy", "smooth", "cinematic", "playful"]);

export type MotionStyle = z.infer<typeof MotionStyleSchema>;

export const DesignSchema = z.object({
  palette: z.object({
    accent: z.string(),
    background: z.string(),
    text: z.string(),
    mood: DesignPaletteMoodSchema,
  }),
  /** Max 2 fonts. Valid values: "primary"|"display"|"condensed"|"serif"|"rounded"|"narrow"|"geometric"|"cyrillic-condensed"|"cyrillic-wide"|"cyrillic-grotesk"|"cyrillic-rounded" */
  fonts: z.array(FontTokenSchema).max(2),
  format: z.enum(["vertical", "square", "landscape"]),
  /**
   * One of the gradient presets from design-tokens:
   * "cleanLight"|"cleanDark"|"aurora"|"sunset"|"ocean"|"purplePinkTeal"
   * |"greenMint"|"iridescent"|"polarLights"|"minimalLight"
   */
  gradientPreset: z.string().optional(),
  talkingHead: z
    .object({
      enabled: z.boolean(),
      presenterStyleNote: z.string().optional(),
      /**
       * Project-wide canvas mood for the left panel — `"light"` (off-white)
       * or `"dark"` (near-black). Composer copies this verbatim into
       * `project.json.talkingHead.leftPanelCanvas`. Eliminates flicker.
       */
      leftPanelCanvas: z.enum(["light", "dark"]).default("light"),
    })
    .optional(),
  moodReferences: z
    .array(
      z.object({
        url: z.string().optional(),
        note: z.string(),
      }),
    )
    .default([]),
  motionStyle: MotionStyleSchema,
  /** Motion library blocks the look is built from, by registry name. */
  libraryBlocks: z.array(z.string()).optional(),
});

export type Design = z.infer<typeof DesignSchema>;

// --- Characters ---

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** e.g. "presenter", "customer", "antagonist" */
  role: z.string(),
  /** Full visual + personality description injected verbatim into AI prompts */
  description: z.string(),
  /** Narrator voice key for TTS lines this character speaks */
  voiceKey: NarratorVoiceSchema.optional(),
  voiceRef: VoiceRefSchema.optional(),
  /** On-camera delivery register retained for native-audio presenter prompts. */
  presenterPersona: z.string().min(1).optional(),
  /** Canonical AI-image prompt for generating this character */
  visualPrompt: z.string().optional(),
});

export type Character = z.infer<typeof CharacterSchema>;

export const CharacterBibleSchema = z.object({
  characters: z.array(CharacterSchema),
});

export type CharacterBible = z.infer<typeof CharacterBibleSchema>;

// --- Storyboard ---

export const StoryboardSceneSchema = z.object({
  id: z.string(),
  /** References ScriptSchema.beats[].id */
  beatId: z.string(),
  headline: z.string().optional(),
  subtext: z.string().optional(),
  /** On-screen copy beyond the headline and subtext. SCRIPT_TEXT_LOST and FONT_GLYPHS_MISSING read it. */
  onScreenText: z.array(z.string()).optional(),
  voiceoverText: z.string(),
  durationSec: z.number().positive(),
  /** Reuses LeftPanelSchema from src/types/video.ts */
  leftPanel: LeftPanelSchema.optional(),
  presenterStartSec: z.number().nonnegative().optional(),
  presenterEndSec: z.number().nonnegative().optional(),
  /** Character IDs from CharacterBible that appear in this scene */
  characterIds: z.array(z.string()).default([]),
  sfxCue: z.string().optional(),
  musicIntensity: z.enum(["none", "low", "medium", "high"]),
  transitionToNext: z.enum(["cut", "fade", "crossfade"]).optional(),
  transitionDurationFrames: z.number().int().positive().optional(),
});

export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const StoryboardSchema = z.object({
  scenes: z.array(StoryboardSceneSchema),
});

export type Storyboard = z.infer<typeof StoryboardSchema>;

// --- Asset plan ---

export const AssetSourceSchema = z.enum([
  "pexels",
  "pixabay",
  "unsplash",
  "freesound",
  "fal-model",
  "fal-flux",
  "fal-gpt-image",
  "fal-kling",
  "fal-bytedance",
  "fal-minimax",
  "elevenlabs-music",
  "elevenlabs-sfx",
  "lottiefiles",
  "manual",
  "inline",
]);

export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetKindSchema = z.enum([
  "stock-photo",
  "stock-video",
  "ai-image",
  "ai-video",
  "ai-audio",
  "ai-3d",
  "ai-upscale",
  "ai-cutout",
  "meme",
  "screenshot",
  "sketch",
  "tweet",
  "archival",
  "sfx",
  "music",
  "lottie",
  "voiceover",
  "talking-head-clip",
  // Traceability marker for left-panel kinds that render from inline data
  // (chart, sketch points, tweet text, plain text). No binary asset to fetch.
  "inline",
]);

export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetSpecSchema = z
  .object({
    /** Unique within the plan */
    id: z.string(),
    kind: AssetKindSchema,
    source: AssetSourceSchema,
    /** Prompt text for AI-generated assets */
    prompt: z.string().optional(),
    /** Search query for stock asset APIs */
    query: z.string().optional(),
    /** Project-relative destination path (e.g. "assets/images/hero.png") */
    targetPath: z.string(),
    /** Reference image URLs for img2img workflows */
    referenceImageUrls: z.array(z.string()).optional(),
    /** Free-form extra data (dimensions, model override, etc.) */
    metadata: z.record(z.string(), z.unknown()).optional(),
    status: StageStatusSchema,
    errorMessage: z.string().optional(),
  })
  .superRefine((asset, context) => {
    if (["ai-audio", "ai-3d", "ai-upscale", "ai-cutout"].includes(asset.kind) && asset.source !== "fal-model")
      context.addIssue({ code: "custom", path: ["source"], message: "This asset kind requires fal-model" });
    if (asset.source !== "fal-model") return;
    if (
      !["ai-image", "meme", "ai-video", "talking-head-clip", "ai-audio", "ai-3d", "ai-upscale", "ai-cutout"].includes(
        asset.kind,
      )
    )
      context.addIssue({ code: "custom", message: "fal-model only publishes image, video, audio or 3D assets" });
    const parsed = z
      .union([FalOperationRequestSchema, FalEndpointRequestSchema])
      .safeParse(asset.metadata?.operationRequest);
    if (!parsed.success)
      context.addIssue({
        code: "custom",
        path: ["metadata", "operationRequest"],
        message: "fal-model needs a strict FalOperationRequest or FalEndpointRequest",
      });
  });

export type AssetSpec = z.infer<typeof AssetSpecSchema>;

export const AssetPlanSchema = z.object({
  assets: z.array(AssetSpecSchema),
});

export type AssetPlan = z.infer<typeof AssetPlanSchema>;

// --- Narrator direction ---

export const DirectedBeatSchema = z.object({
  beatId: z.string(),
  directedText: z.string(),
  cues: z.array(SpeechCueSchema).max(50).optional(),
  pronunciations: z.array(InlinePronunciationSchema).min(1).max(100).optional(),
  expectedSpokenText: z.string().min(1).optional(),
  emotionalContext: z.string().optional(),
  emphasisWords: z.array(z.string()).default([]),
});

export type DirectedBeat = z.infer<typeof DirectedBeatSchema>;

export const DeliveryArcStepSchema = z.object({
  fromSec: z.number().nonnegative(),
  toSec: z.number().positive(),
  /** Observable physical / vocal direction the AI presenter should perform during this slice */
  direction: z.string(),
});

export type DeliveryArcStep = z.infer<typeof DeliveryArcStepSchema>;

/**
 * Mode B — native-audio Seedance direction. When present, voice-producer
 * SKIPS ElevenLabs TTS for the presenter (Seedance generates audio with
 * built-in lip-sync). Asset-planner embeds these fields verbatim into the
 * talking-head Seedance prompt.
 */
export const NativeAudioDirectionSchema = z.object({
  language: z.string().default("en"),
  /** Total presenter speaking time in seconds — must be ≤ 15 for one segment */
  totalSeconds: z.number().positive(),
  /** Copied verbatim from characters.json[0].presenterPersona */
  presenterPersona: z.string(),
  deliveryArc: z.array(DeliveryArcStepSchema).min(1),
  /** All beats concatenated into one paragraph with natural punctuation. No SSML, no audio tags. */
  fullScript: z.string(),
  /** Negative instructions for the model (e.g. "no on-screen captions") */
  constraints: z.array(z.string()).default([]),
});

export type NativeAudioDirection = z.infer<typeof NativeAudioDirectionSchema>;

export const NarratorDirectionSchema = z.object({
  voiceRef: VoiceRefSchema.optional(),
  speechSettings: VoiceSettingsSchema.optional(),
  speechOptions: SpeechOptionsSchema.optional(),
  modelId: z
    .enum(["eleven_multilingual_v2", "eleven_v3", "eleven_v4", "eleven_flash_v2_5", "seedance-2-fast"])
    .default("eleven_v3"),
  voiceSettings: z
    .object({
      stability: z.number().min(0).max(1).default(0.4),
      similarity_boost: z.number().min(0).max(1).default(0.75),
      style: z.number().min(0).max(1).default(0.5),
      use_speaker_boost: z.boolean().default(true),
    })
    .default({ stability: 0.4, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true }),
  beats: z.array(DirectedBeatSchema).default([]),
  pacingNote: z.string().optional(),
  /** Mode B — present only when AI presenter speaks via Seedance native audio. */
  nativeAudioDirection: NativeAudioDirectionSchema.optional(),
});

export type NarratorDirection = z.infer<typeof NarratorDirectionSchema>;

// --- Caption edit ---

export const EditedWordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  emphasis: z.boolean().default(false),
});

export type EditedWord = z.infer<typeof EditedWordSchema>;

export const SceneCaptionEditSchema = z.object({
  sceneId: z.string(),
  words: z.array(EditedWordSchema),
  droppedFillers: z.array(z.string()).default([]),
});

export type SceneCaptionEdit = z.infer<typeof SceneCaptionEditSchema>;

export const CaptionEditSchema = z.object({
  scenes: z.array(SceneCaptionEditSchema),
  /** Format-specific max words on screen at once (vertical 4, square 4, landscape 6) */
  wordsInView: z.number().int().positive().default(3),
});

export type CaptionEdit = z.infer<typeof CaptionEditSchema>;

// --- Rhythm ---

export const SceneRhythmSchema = z.object({
  sceneId: z.string(),
  measuredVoiceoverSec: z.number().nonnegative(),
  originalDurationSec: z.number().positive(),
  adjustedDurationSec: z.number().positive(),
  trailingPauseSec: z.number().min(0).default(0.2),
  reasoning: z.string().optional(),
});

export type SceneRhythm = z.infer<typeof SceneRhythmSchema>;

export const RhythmSchema = z.object({
  scenes: z.array(SceneRhythmSchema),
  totalAdjustedSec: z.number().nonnegative(),
});

export type Rhythm = z.infer<typeof RhythmSchema>;

// --- Audio mix ---

export const VolumeKeyframeSchema = z.object({
  /** Seconds from start of full video timeline */
  atSec: z.number().nonnegative(),
  /** Volume 0–1 */
  volume: z.number().min(0).max(1),
});

export type VolumeKeyframe = z.infer<typeof VolumeKeyframeSchema>;

export const AudioTrackMixSchema = z.object({
  track: z.enum(["music", "voiceover", "sfx"]),
  baseVolume: z.number().min(0).max(1),
  keyframes: z.array(VolumeKeyframeSchema).default([]),
});

export type AudioTrackMix = z.infer<typeof AudioTrackMixSchema>;

export const AudioMixSchema = z.object({
  tracks: z.array(AudioTrackMixSchema),
  totalDurationSec: z.number().positive(),
});

export type AudioMix = z.infer<typeof AudioMixSchema>;

// --- Pipeline state ---

export const StageRecordSchema = z.object({
  status: StageStatusSchema,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  agentId: z.string().optional(),
  /** Path to the stage's primary artefact (relative to the pipeline dir) */
  artefactPath: z.string().optional(),
  errorMessage: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
});

export type StageRecord = z.infer<typeof StageRecordSchema>;

export const PipelineHistoryActionSchema = z.enum(["start", "complete", "fail", "skip", "reset", "approve", "revise"]);

export type PipelineHistoryAction = z.infer<typeof PipelineHistoryActionSchema>;

export const PipelineHistoryEntrySchema = z.object({
  /** ISO 8601 datetime */
  timestamp: z.string(),
  stage: PipelineStageSchema,
  action: PipelineHistoryActionSchema,
  actor: z.string().optional(),
  note: z.string().optional(),
  decisionId: z.string().min(1).max(220).optional(),
});

export type PipelineHistoryEntry = z.infer<typeof PipelineHistoryEntrySchema>;

export const PipelineStateSchema = z.object({
  projectId: z.string(),
  version: z.string().default("1"),
  /** Monotonic compare-and-swap revision; absent in legacy state files. */
  revision: z.number().int().nonnegative().default(0),
  currentStage: PipelineStageSchema.optional(),
  stages: z.record(PipelineStageSchema, StageRecordSchema),
  history: z.array(PipelineHistoryEntrySchema),
  /** ISO 8601 */
  createdAt: z.string(),
  /** ISO 8601 */
  updatedAt: z.string(),
});

export type PipelineState = z.infer<typeof PipelineStateSchema>;
