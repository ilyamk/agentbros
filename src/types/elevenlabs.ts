import { z } from "zod";
import {
  BATCH_SPEECH_MODELS,
  BATCH_SPEECH_PROFILES,
  DIALOGUE_MODELS,
  MAX_DIALOGUE_CHARACTERS,
  MAX_DIALOGUE_VOICES,
  SPEECH_OUTPUTS,
  STS_MODELS,
  providerLanguage,
  supportsVoiceChangeLanguage,
} from "./elevenlabs-profiles";

export const ElevenLabsIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const file = z.string().min(1).max(4096);
const text = z.string().min(1).max(40_000);
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/);
export const SpeechCueSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    direction: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\[\]<>\r\n]+$/u),
  })
  .strict();
export const InlinePronunciationSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    ipa: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^/\[\]<>\s]+$/u),
  })
  .strict()
  .refine((entry) => entry.end > entry.start, "An IPA substitution must cover a word");
export const VoiceRefSchema = z
  .object({
    provider: z.literal("elevenlabs"),
    voiceId: ElevenLabsIdSchema,
    model: z.string().min(1),
    language,
    manifest: file.optional(),
    manifestSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    selection: file.optional(),
    selectionSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.manifest) === Boolean(value.manifestSha256),
    "Voice manifest and hash must be supplied together",
  )
  .refine(
    (value) => Boolean(value.selection) === Boolean(value.selectionSha256),
    "Voice selection and hash must be supplied together",
  );
export const VoiceSettingsSchema = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarity_boost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    speed: z.number().min(0.7).max(1.2).optional(),
    use_speaker_boost: z.boolean().optional(),
    clone_strength: z.number().min(0).max(1).optional(),
  })
  .strict();
const effects = z
  .object({
    filter_preset_id: ElevenLabsIdSchema.optional(),
    environment_id: ElevenLabsIdSchema.optional(),
    background_noise_id: ElevenLabsIdSchema.optional(),
    distance: z.number().min(0).max(1).optional(),
    send_level: z.number().min(0).max(1).optional(),
    pan: z.number().min(-1).max(1).optional(),
  })
  .strict();
const dictionary = z
  .object({ pronunciation_dictionary_id: ElevenLabsIdSchema, version_id: ElevenLabsIdSchema })
  .strict();
const continuity = {
  previousText: text.optional(),
  nextText: text.optional(),
  previousRequestIds: z.array(ElevenLabsIdSchema).max(3).optional(),
  nextRequestIds: z.array(ElevenLabsIdSchema).max(3).optional(),
};
export const SpeechOptionsSchema = z
  .object({
    dictionaries: z.array(dictionary).max(3).optional(),
    effects: effects.optional(),
    seed: z.number().int().min(0).max(4294967295).optional(),
    textNormalization: z.enum(["auto", "on", "off"]).optional(),
    enableLogging: z.boolean().optional(),
    ...continuity,
  })
  .strict();
const line = {
  lineId: ElevenLabsIdSchema.optional(),
  approvedText: text.optional(),
  expectedSpokenText: text.optional(),
  pronunciations: z.array(InlinePronunciationSchema).min(1).max(100).optional(),
};
const base = {
  version: z.literal(1),
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  output: file,
  operationId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/)
    .optional(),
  maxCostUsd: z.number().positive().finite().optional(),
};
const speech = {
  language,
  outputFormat: z.enum(SPEECH_OUTPUTS).default("mp3_44100_128"),
  ...SpeechOptionsSchema.shape,
};
export const ElevenLabsAudioRequestSchema = z
  .discriminatedUnion("task", [
    z
      .object({
        ...base,
        ...speech,
        task: z.literal("tts"),
        model: z.enum(BATCH_SPEECH_MODELS).default("eleven_v3"),
        text,
        ...line,
        speaker: ElevenLabsIdSchema.optional(),
        sceneId: ElevenLabsIdSchema.optional(),
        voiceId: ElevenLabsIdSchema.optional(),
        voiceRef: VoiceRefSchema.optional(),
        settings: VoiceSettingsSchema.optional(),
        usePvcAsIvc: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        ...speech,
        task: z.literal("dialogue"),
        model: z.enum(DIALOGUE_MODELS).default("eleven_v3"),
        settings: z
          .object({
            stability: z.number().min(0).max(1).optional(),
            similarity: z.number().min(0).max(1).optional(),
            clone_strength: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
        turns: z
          .array(
            z
              .object({
                text: z.string().min(1).max(MAX_DIALOGUE_CHARACTERS),
                ...line,
                voiceId: ElevenLabsIdSchema.optional(),
                voiceRef: VoiceRefSchema.optional(),
                speaker: ElevenLabsIdSchema,
                sceneId: ElevenLabsIdSchema,
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      })
      .strict(),
    z
      .object({
        ...base,
        task: z.literal("isolate"),
        source: file,
        provider: z.enum(["elevenlabs", "fal"]).default("elevenlabs"),
      })
      .strict(),
    z
      .object({
        ...base,
        task: z.literal("voice-change"),
        source: file,
        provider: z.enum(["elevenlabs", "fal"]).default("elevenlabs"),
        voiceId: ElevenLabsIdSchema.optional(),
        voiceRef: VoiceRefSchema.optional(),
        model: z.enum(STS_MODELS).default("eleven_multilingual_sts_v2"),
        language,
        settings: VoiceSettingsSchema.optional(),
        removeBackgroundNoise: z.boolean().optional(),
        seed: SpeechOptionsSchema.shape.seed,
        outputFormat: z.enum(SPEECH_OUTPUTS).optional(),
        enableLogging: z.boolean().optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.task === "isolate") return;
    const voices = value.task === "dialogue" ? value.turns : [value];
    for (const voice of voices) {
      if (!voice.voiceId && !voice.voiceRef) fail("Supply voiceId or a pinned voiceRef");
      if (
        voice.voiceRef &&
        ((voice.voiceId && voice.voiceRef.voiceId !== voice.voiceId) ||
          voice.voiceRef.model !== value.model ||
          voice.voiceRef.language !== value.language)
      )
        fail("voiceRef conflicts with voice, model or language");
    }
    if (value.task === "voice-change") {
      if (!supportsVoiceChangeLanguage(value.model, value.language))
        fail("The selected voice changer cannot process the requested language");
      if (value.settings?.clone_strength !== undefined) fail("Clone strength is a v4 synthesis control");
      if (
        value.provider === "fal" &&
        [value.removeBackgroundNoise, value.seed, value.outputFormat, value.enableLogging].some(
          (field) => field !== undefined,
        )
      )
        fail("These Voice Changer controls require the direct ElevenLabs route");
      return;
    }
    const profile = BATCH_SPEECH_PROFILES[value.model];
    const texts = value.task === "dialogue" ? value.turns : [value];
    if (texts.some((entry) => entry.pronunciations && (!entry.approvedText || value.model !== "eleven_v4")))
      fail("Inline IPA needs the v4 profile and approved source text");
    const hasRequestIds = Boolean(value.previousRequestIds?.length || value.nextRequestIds?.length);
    if (!profile.continuity && (hasRequestIds || value.previousText || value.nextText))
      fail("The selected model does not support request stitching");
    if (value.enableLogging === false && hasRequestIds) fail("Request-ID stitching requires provider history");
    if (value.model === "eleven_v4" && !profile.languages?.includes(providerLanguage(value.language)))
      fail("Unsupported Eleven v4 language");
    if (value.task === "tts") {
      if (
        value.settings &&
        Object.entries(value.settings).some(
          ([key, setting]) => setting !== undefined && !(profile.settings as readonly string[]).includes(key),
        )
      )
        fail("These voice settings are not supported by the selected speech profile");
      if (value.text.length > profile.limit) fail(`TTS limit is ${profile.limit} characters for ${value.model}`);
      if (value.usePvcAsIvc && value.settings?.clone_strength !== undefined)
        fail("Choose either the IVC variant or explicit clone strength");
      if (profile.audioTags && /<\/?(?:break|phoneme|speak|prosody|emphasis)\b/i.test(value.text))
        fail("Use punctuation/audio tags, not SSML for expressive models");
    }
    if (value.task === "dialogue") {
      if (new Set(value.turns.map((turn) => turn.voiceRef?.voiceId ?? turn.voiceId)).size > MAX_DIALOGUE_VOICES)
        fail("Dialogue supports at most ten distinct voices");
      if (value.turns.reduce((size, turn) => size + turn.text.length, 0) > MAX_DIALOGUE_CHARACTERS)
        fail(`Split dialogue into reviewed batches of at most ${MAX_DIALOGUE_CHARACTERS} characters`);
      const lineIds = value.turns.flatMap((turn) => (turn.lineId ? [turn.lineId] : []));
      if (new Set(lineIds).size !== lineIds.length) fail("Dialogue line IDs must be unique");
      if (value.turns.some((turn) => /<\/?(?:break|phoneme|speak|prosody|emphasis)\b/i.test(turn.text)))
        fail("Dialogue does not support SSML");
      if (value.model !== "eleven_v4" && value.settings?.clone_strength !== undefined)
        fail("Clone strength is a v4 synthesis control");
      if ([value.previousText, value.nextText].some((context) => (context?.length ?? 0) > 100))
        fail("Dialogue context accepts up to 100 characters on either side");
    }
  });
export type ElevenLabsAudioRequest = z.infer<typeof ElevenLabsAudioRequestSchema>;

export const CharacterAlignmentSchema = z
  .object({
    characters: z.array(z.string()).max(500_000),
    character_start_times_seconds: z.array(z.number().finite().nonnegative()).max(500_000),
    character_end_times_seconds: z.array(z.number().finite().nonnegative()).max(500_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.characters.length !== value.character_start_times_seconds.length ||
      value.characters.length !== value.character_end_times_seconds.length
    )
      ctx.addIssue({ code: "custom", message: "Character alignment lengths differ" });
    for (let index = 0; index < value.characters.length; index++)
      if (
        value.character_end_times_seconds[index]! < value.character_start_times_seconds[index]! ||
        (index > 0 && value.character_start_times_seconds[index]! < value.character_start_times_seconds[index - 1]!)
      )
        ctx.addIssue({ code: "custom", message: "Character times must be ordered and nonnegative" });
  });
export const VoiceSegmentSchema = z
  .object({
    voice_id: ElevenLabsIdSchema,
    start_time_seconds: z.number().finite().nonnegative(),
    end_time_seconds: z.number().finite().nonnegative(),
    character_start_index: z.number().int().nonnegative(),
    character_end_index: z.number().int().nonnegative(),
    dialogue_input_index: z.number().int().nonnegative(),
  })
  .passthrough();
export const SpeechResponseSchema = z
  .object({
    audio_base64: z.string().min(1).max(90_000_000),
    alignment: z.unknown().optional(),
    normalized_alignment: z.unknown().optional(),
    voice_segments: z.unknown().optional(),
  })
  .passthrough();

export const VoiceManagementRequestSchema = z
  .object({
    ...base,
    task: z.enum([
      "design",
      "create-designed",
      "clone-instant",
      "clone-professional",
      "add-samples",
      "train",
      "dictionary",
      "refresh",
      "adopt",
    ]),
    name: z.string().min(1).max(100).optional(),
    description: z.string().min(20).max(1000).optional(),
    previewText: z.string().min(100).max(1000).optional(),
    language: language.optional(),
    voiceId: ElevenLabsIdSchema.optional(),
    generatedVoiceId: ElevenLabsIdSchema.optional(),
    model: z
      .enum(["eleven_multilingual_ttv_v2", "eleven_ttv_v3", ...BATCH_SPEECH_MODELS, "eleven_v4_turbo"])
      .optional(),
    samples: z.array(file).min(1).max(25).optional(),
    dictionary: file.optional(),
    sourceManifest: file.optional(),
    removeBackgroundNoise: z.boolean().optional(),
    rights: z
      .object({
        source: z.string().min(1).max(2000),
        consent: z.string().min(1).max(4000),
        permittedUses: z
          .array(z.enum(["tts", "dialogue", "voice-change", "video-reference"]))
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const need = (condition: boolean, message: string) => {
      if (!condition) ctx.addIssue({ code: "custom", message });
    };
    if (value.task === "design")
      need(!!value.description && !!value.previewText, "Design needs description and previewText");
    if (value.task === "design" && value.model)
      need(
        ["eleven_multilingual_ttv_v2", "eleven_ttv_v3"].includes(value.model),
        "Choose a documented voice-design model",
      );
    if (value.task === "train")
      need(!!value.model && !value.model.includes("ttv"), "Training needs the exact synthesis model");
    if (["create-designed", "clone-instant", "clone-professional", "dictionary"].includes(value.task))
      need(!!value.name, "A name is required");
    if (value.task === "create-designed")
      need(
        !!value.generatedVoiceId && !!value.description,
        "Choose a generated preview ID and supply its description before creating a voice",
      );
    if (["clone-instant", "clone-professional", "add-samples", "train"].includes(value.task))
      need(!!value.rights, "Voice cloning needs supplied rights and consent evidence");
    if (["clone-instant", "add-samples"].includes(value.task))
      need(!!value.samples?.length, "This task needs local voice samples");
    if (["add-samples", "train"].includes(value.task)) need(!!value.voiceId, "This task needs the existing voice ID");
    if (value.task === "clone-professional") need(!!value.language, "Professional cloning needs the sample language");
    if (value.task === "dictionary") need(!!value.dictionary, "Supply a pronunciation dictionary file");
    if (value.task === "refresh")
      need(!!value.voiceId && !!value.sourceManifest, "Readiness refresh needs voiceId and the prior voice manifest");
    if (value.task === "adopt")
      need(
        !!value.voiceId && !!value.model && !value.model.includes("ttv") && !!value.rights && !!value.language,
        "Adoption needs the shared voice ID, synthesis model, language and supplied rights",
      );
  });
export type VoiceManagementRequest = z.infer<typeof VoiceManagementRequestSchema>;

export const VoiceSelectionRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: ElevenLabsIdSchema,
    output: file,
    voiceRef: VoiceRefSchema,
    takes: z
      .array(
        z
          .object({
            use: z.enum(["neutral", "emotion", "short-line", "pronunciation"]),
            receipt: file,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .length(4),
  })
  .strict()
  .refine(
    (value) => new Set(value.takes.map((take) => take.use)).size === 4,
    "Supply one take for each calibration case",
  );

export const DubbingRequestSchema = z
  .object({
    ...base,
    task: z.enum(["create", "add-language", "regenerate", "edit-source", "edit-translation"]),
    source: file.optional(),
    sourceLanguage: language.optional(),
    targetLanguage: language,
    binding: file.optional(),
    transcript: file.optional(),
    translations: file.optional(),
    enterprise: z.boolean().default(false),
    expectedRevision: z.number().int().nonnegative().optional(),
    segmentId: ElevenLabsIdSchema.optional(),
    text: text.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.task === "create" && !value.source)
      ctx.addIssue({ code: "custom", message: "Dubbing create needs a local source and an initial target language" });
    if (value.transcript && (value.task !== "create" || !value.sourceLanguage))
      ctx.addIssue({ code: "custom", message: "Supplied source transcript requires create and sourceLanguage" });
    if (value.translations && (value.task !== "add-language" || value.expectedRevision === undefined))
      ctx.addIssue({
        code: "custom",
        message: "Supplied translations require add-language and the reviewed source revision",
      });
    if (value.task !== "create" && !value.binding)
      ctx.addIssue({ code: "custom", message: "Use the existing dubbing binding" });
    if (
      (value.transcript || value.translations || value.task.startsWith("edit-") || value.task === "regenerate") &&
      !value.enterprise
    )
      ctx.addIssue({
        code: "custom",
        message: "Supplied transcripts/translations, editing and regeneration require Enterprise entitlement",
      });
    if (value.task === "regenerate" && value.expectedRevision === undefined)
      ctx.addIssue({ code: "custom", message: "Regeneration must name the reviewed target revision" });
    if (
      value.task.startsWith("edit-") &&
      (!value.segmentId || value.text === undefined || value.expectedRevision === undefined)
    )
      ctx.addIssue({ code: "custom", message: "Segment edits require segmentId, text and expectedRevision" });
  });
export type DubbingRequest = z.infer<typeof DubbingRequestSchema>;
