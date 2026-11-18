import { z } from "zod";
import { EntityRefSchema } from "./entities";
import { MediaPinSchema, RightsStatementShape, refineRightsStatement } from "./model-preparation";
import { EntityViewRoleSchema } from "./reference-view";
import { ReferencePackIdSchema } from "./reference-pack-binding";
export {
  EntityViewRoleSchema,
  EntityReferenceFactsSchema,
  ReferenceViewFactsSchema,
  type EntityViewRole,
  type EntityReferenceFacts,
  type ReferenceViewFacts,
} from "./reference-view";
export { ReferencePackBindingSchema, ReferencePackIdSchema, type ReferencePackBinding } from "./reference-pack-binding";
export { MediaPinSchema } from "./model-preparation";

/**
 * Reference packs (RFC 0003 §6): roles, per-shot requirements in pipeline/references.json, derivatives in
 * pipeline/reference-derivatives/<id>/ and packs in pipeline/reference-packs/<id>/. Schemas only; the planner,
 * compiler and checks live in src/lib/references (WP1+).
 */

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const assetId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Same id rule as model preparations and pack ids. */
const slug = ReferencePackIdSchema;
const note = z.string().trim().min(1).max(4000);
const int = z.number().int();

// --- §6.1 Roles ---

/** What a reference input is for. */
export const ReferenceRoleSchema = z.enum([
  "identity",
  "wardrobe",
  "expression",
  "prop",
  "product",
  "location",
  "lighting",
  "style",
  "first-frame",
  "last-frame",
  "keyframe",
  "motion",
  "performance",
  "camera",
  "depth",
  "pose",
  "edge",
  "mask",
  "source-video",
  "voice",
  "sound",
  "music",
]);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;
export const ModalitySchema = z.enum(["image", "video", "audio"]);
export type Modality = z.infer<typeof ModalitySchema>;
export const ShotSpokenLineSchema = z
  .object({
    lineId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    speakerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/),
    text: z.string().trim().min(1).max(2000),
    startSec: z.number().finite().nonnegative(),
    endSec: z.number().finite().positive(),
  })
  .strict()
  .refine((line) => line.endSec > line.startSec, "Speech window must have positive duration");
export const SpeechReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("voice-sample") }).strict(),
  z.object({ kind: z.literal("environment") }).strict(),
  z
    .object({
      kind: z.literal("performed-lines"),
      sha256: hash,
      receipt: z.string().min(1),
      receiptSha256: hash,
      use: z.enum(["reference", "drive"]),
      lines: z.array(ShotSpokenLineSchema).min(1).max(40),
    })
    .strict(),
]);

// --- §6.4 Derivatives ---

export const DerivationStepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("trim"), startSec: z.number().nonnegative(), durationSec: z.number().positive() }).strict(),
  z
    .object({
      op: z.literal("crop"),
      x: int.nonnegative(),
      y: int.nonnegative(),
      width: int.positive(),
      height: int.positive(),
    })
    .strict(),
  z
    .object({
      op: z.literal("scale"),
      width: int.positive(),
      height: int.positive(),
      fit: z.enum(["pad", "crop", "exact"]),
    })
    .strict(),
  z.object({ op: z.literal("fps"), fps: z.number().positive() }).strict(),
  /** Snap dimensions (and frame counts where the model needs it) to a multiple, e.g. 16 for Wan. */
  z.object({ op: z.literal("snap"), multipleOf: int.positive() }).strict(),
  z
    .object({
      op: z.literal("extract-frame"),
      at: z.union([z.literal("first"), z.literal("last"), z.number().nonnegative()]),
    })
    .strict(),
  z.object({ op: z.literal("flatten"), background: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
  /** Cut-out through src/lib/matte. */
  z.object({ op: z.literal("cutout"), engine: z.literal("matte-onnx") }).strict(),
  z.object({ op: z.literal("strip-audio") }).strict(),
  z
    .object({ op: z.literal("depth-video"), engine: z.enum(["local", "fal"]), endpoint: z.string().min(1).optional() })
    .strict(),
  z
    .object({ op: z.literal("pose-video"), engine: z.enum(["local", "fal"]), endpoint: z.string().min(1).optional() })
    .strict(),
  z
    .object({
      op: z.literal("mask-video"),
      engine: z.enum(["matte-onnx", "fal"]),
      prompt: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ op: z.literal("edge-video"), kind: z.enum(["canny", "lineart"]) }).strict(),
  z
    .object({
      op: z.literal("blender-pass"),
      scene: z.string().min(1),
      pass: z.enum(["beauty", "clay", "depth", "normal", "mist", "camera-path"]),
    })
    .strict(),
  z.object({ op: z.literal("audio-clean"), engine: z.enum(["local", "fal"]) }).strict(),
  z
    .object({ op: z.literal("audio-trim"), startSec: z.number().nonnegative(), durationSec: z.number().positive() })
    .strict(),
  z.object({ op: z.literal("loudness"), lufs: z.number() }).strict(),
  z.object({ op: z.literal("contact-sheet"), columns: int.min(1).max(8) }).strict(),
]);
export type DerivationStep = z.infer<typeof DerivationStepSchema>;

/** pipeline/reference-derivatives/<id>/spec.json: immutable; a changed recipe takes a new id. */
export const DerivativeSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: slug,
    input: z.union([z.object({ assetId }).strict(), z.object({ derivativeId: slug }).strict()]),
    steps: z.array(DerivationStepSchema).min(1),
    purpose: note,
    /** The role the output serves; when set, refs:derive runs that role's sensors on the output (WP10). */
    role: ReferenceRoleSchema.optional(),
  })
  .strict();
export type DerivativeSpec = z.infer<typeof DerivativeSpecSchema>;

/**
 * MediaPin for derivatives: an audio-only input or output (audio-trim, loudness) has no picture, so width and
 * height are optional here and required only for image and video content types.
 */
export const DerivativeMediaPinSchema = MediaPinSchema.extend({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (/^(image|video)\//.test(value.contentType) && !(value.width && value.height))
    ctx.addIssue({ code: "custom", path: ["width"], message: "Image and video pins record width and height." });
});
export type DerivativeMediaPin = z.infer<typeof DerivativeMediaPinSchema>;

/** pipeline/reference-derivatives/<id>/receipt.json. A fal-backed step records its operationId. */
export const DerivativeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: slug,
    specSha256: hash,
    createdAt: z.iso.datetime(),
    input: DerivativeMediaPinSchema,
    output: DerivativeMediaPinSchema,
    engine: z
      .object({
        kind: z.enum(["ffmpeg", "matte-onnx", "local-model", "blender", "fal"]),
        version: note,
        modelSha256: hash.optional(),
        operationId: note.optional(),
      })
      .strict(),
    /** Spent in USD; null when local or not known. */
    costUsd: z.number().nonnegative().nullable(),
    /** Sensor readings, e.g. temporalFlicker, borderUniformity, snrDb. */
    measurements: z.record(z.string(), z.number()).default({}),
    warnings: z.array(note),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.engine.kind === "fal" && !value.engine.operationId)
      ctx.addIssue({
        code: "custom",
        path: ["engine", "operationId"],
        message: "A fal derivative records its operationId.",
      });
  });
export type DerivativeReceipt = z.infer<typeof DerivativeReceiptSchema>;

// --- §6.3 Requirements ---

export const ReferenceSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: EntityRefSchema, viewRole: EntityViewRoleSchema }).strict(),
  /** An imported original in the asset registry. */
  z.object({ kind: z.literal("asset"), assetId }).strict(),
  z.object({ kind: z.literal("derivative"), derivativeId: slug }).strict(),
  /** Chaining: a frame of another shot's output. */
  z.object({ kind: z.literal("shot-output"), shotId: slug, frame: z.enum(["first", "last"]) }).strict(),
]);
export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>;

export const ReferenceRequirementSchema = z
  .object({
    /** Stable within the shot: "hero-identity", "market-plate", "dance-motion". */
    key: slug,
    role: ReferenceRoleSchema,
    modality: ModalitySchema,
    required: z.boolean().default(true),
    /** Absent: still to be made or acquired. */
    source: ReferenceSourceSchema.optional(),
    /** Derivation steps to apply before packing. */
    prepare: z.array(DerivationStepSchema).default([]),
    /** What the model takes from this input: "the face and hair of the woman". */
    roleSentence: z.string().trim().min(1).max(400),
    speech: SpeechReferenceSchema.optional(),
    status: z.enum(["missing", "planned", "pending-approval", "ready"]),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "ready" && !value.source)
      ctx.addIssue({ code: "custom", path: ["source"], message: "A ready requirement needs a source." });
    if (value.speech && value.modality !== "audio")
      ctx.addIssue({ code: "custom", path: ["speech"], message: "Speech bindings require an audio reference." });
  });
export type ReferenceRequirement = z.infer<typeof ReferenceRequirementSchema>;

export const ShotReferenceIntentSchema = z.enum([
  "keyframe-image",
  "image-to-video",
  "reference-to-video",
  "video-edit",
  "motion-transfer",
  "character-replace",
  "control-to-video",
  "lip-sync",
  "voice",
  "extend",
]);
export const ShotReferencesSchema = z
  .object({
    shotId: slug,
    materialItemId: z.string().min(1),
    intent: ShotReferenceIntentSchema,
    target: z.object({ family: z.string().min(1), endpoint: z.string().min(1).optional() }).strict(),
    requirements: z.array(ReferenceRequirementSchema).min(1),
    chaining: z.enum(["none", "first-from-previous-last", "anchor-reinject"]).default("none"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.requirements.forEach((requirement, index) => {
      if (seen.has(requirement.key))
        ctx.addIssue({
          code: "custom",
          path: ["requirements", index, "key"],
          message: `Duplicate requirement key "${requirement.key}" in shot ${value.shotId}.`,
        });
      seen.add(requirement.key);
    });
  });
export type ShotReferences = z.infer<typeof ShotReferencesSchema>;

/** pipeline/references.json: a revisable draft, one entry per generated shot. */
export const ReferencesPlanSchema = z
  .object({ schemaVersion: z.literal(1), shots: z.array(ShotReferencesSchema) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.shots.forEach((shot, index) => {
      if (seen.has(shot.shotId))
        ctx.addIssue({ code: "custom", path: ["shots", index, "shotId"], message: `Duplicate shot ${shot.shotId}.` });
      seen.add(shot.shotId);
    });
  });
export type ReferencesPlan = z.infer<typeof ReferencesPlanSchema>;

// --- §6.5 Packs ---

export const PackAttachmentSchema = z
  .object({
    requirementKey: slug,
    /** Resolved: entity view, asset or derivative output. */
    source: z.object({ assetId }).strict(),
    /** Profile slot id. */
    slot: z.string().min(1),
    /** 1-based within the slot; the marker index. */
    order: int.positive(),
    roleSentence: z.string().trim().min(1),
    speech: SpeechReferenceSchema.optional(),
    element: z
      .object({ index: int.positive(), part: z.enum(["frontal", "reference", "video", "voice"]) })
      .strict()
      .optional(),
  })
  .strict();
export type PackAttachment = z.infer<typeof PackAttachmentSchema>;

/** pipeline/reference-packs/<id>/spec.json: immutable. */
export const ReferencePackSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: slug,
    shotId: slug,
    endpoint: z.string().min(1),
    profileFamily: z.string().min(1),
    attachments: z.array(PackAttachmentSchema).min(1),
    prompt: z
      .object({
        /** What happens: subject, motion and camera channels. */
        action: z.string().trim().min(1),
        /** Entity fixedSentence(s), verbatim. */
        invariants: z.array(z.string().min(1)).default([]),
        camera: z.string().optional(),
        /** Dialogue, SFX and music lines in the model's own conventions. */
        audio: z.string().optional(),
        preserve: z.array(z.string().min(1)).default([]),
        /** People or objects that must not change (Genjutsu parity). */
        otherSubjects: z.array(z.string().min(1)).default([]),
        /** Rendered as a negative prompt only when the profile has one, else folded into prose. */
        avoid: z.array(z.string().min(1)).default([]),
        /** Free text appended last (Genjutsu additionalPrompt). */
        additional: z.string().max(6000).optional(),
      })
      .strict(),
    /** Duration, aspect, resolution…; validated against the endpoint schema by the compiler. */
    params: z.record(z.string(), z.unknown()).default({}),
    audioPolicy: z.enum(["native", "mute", "replace-in-edit", "reference-driven"]),
    nativeSpeech: z.array(ShotSpokenLineSchema).min(1).max(40).optional(),
    scriptSha256: hash.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.attachments.forEach((attachment, index) => {
      const key = `${attachment.slot}#${attachment.order}`;
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["attachments", index, "order"],
          message: `Two attachments share slot ${attachment.slot} order ${attachment.order}.`,
        });
      seen.add(key);
    });
  });
export type ReferencePackSpec = z.infer<typeof ReferencePackSpecSchema>;

/** pipeline/reference-packs/<id>/receipt.json: what the model will see, pinned by hash. */
export const ReferencePackReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: slug,
    id: slug,
    createdAt: z.iso.datetime(),
    spec: ReferencePackSpecSchema,
    profileSha256: hash,
    endpoint: z.string().min(1),
    schemaSha256: hash,
    requestSha256: hash,
    attachments: z.array(
      z
        .object({
          requirementKey: slug,
          marker: z.string(),
          pointer: z.string().min(1),
          /** Audio attachments have no picture, so the derivative pin (optional width and height) is used. */
          media: DerivativeMediaPinSchema,
          provenanceSha256: hash,
        })
        .strict(),
    ),
    compiledPrompt: z.string(),
    /** Marker → assetId, e.g. "@Image1" → "sha256:…". */
    markerMap: z.record(z.string(), assetId),
    warnings: z.array(z.string()),
    reviewFiles: z.array(z.object({ path: note, sha256: hash }).strict()).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.spec.id !== value.id)
      ctx.addIssue({ code: "custom", path: ["spec", "id"], message: "Receipt and spec ids differ." });
    if (value.spec.endpoint !== value.endpoint)
      ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Receipt and spec endpoints differ." });
  });
export type ReferencePackReceipt = z.infer<typeof ReferencePackReceiptSchema>;

/** pipeline/reference-packs/<id>/rights.json: the user's statement, bound to the pack receipt hash. */
export const PackRightsSchema = z
  .object({ schemaVersion: z.literal(1), packSha256: hash, ...RightsStatementShape })
  .strict()
  .superRefine(refineRightsStatement);
export type PackRights = z.infer<typeof PackRightsSchema>;

/** The reviewer's visual check of the pack board (generalised from PreparationVisualReviewSchema). */
export const PackVisualReviewSchema = z
  .object({
    packSha256: hash,
    reviewer: note,
    evidence: note,
    /** Every marker on the board names the attachment the compiled prompt means. */
    markersVerified: z.literal(true),
    /** The compiled prompt states the change and what is preserved without ambiguity. */
    promptReviewed: z.literal(true),
    attachments: z
      .array(
        z
          .object({
            sha256: hash,
            requirementKey: slug,
            /** The input shows what its role sentence asks for: identity, angle, detail, motion or sound. */
            suitable: z.literal(true),
            evidence: note,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PackVisualReview = z.infer<typeof PackVisualReviewSchema>;

/** pipeline/reference-packs/<id>/approval.json: the user's yes, bound to the exact pack and rights hashes. */
export const PackApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    packSha256: hash,
    /** Present exactly when the pack needs rights (packRightsRequired in src/lib/references/packs). */
    rightsSha256: hash.optional(),
    userStatement: note,
    approvedAt: z.iso.datetime(),
    review: PackVisualReviewSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.review.packSha256 !== value.packSha256)
      ctx.addIssue({ code: "custom", path: ["review", "packSha256"], message: "The review is for another pack." });
  });
export type PackApproval = z.infer<typeof PackApprovalSchema>;

const passFail = z.enum(["pass", "fail"]);
const passFailNa = z.enum(["pass", "fail", "not-applicable"]);
/** pipeline/reference-packs/<id>/results/<output-sha>/review.json (RFC §10.3). */
export const PackResultReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    packSha256: hash,
    outputSha256: hash,
    reviewer: note,
    evidence: note,
    identity: passFailNa,
    wardrobe: passFailNa,
    preserved: passFail,
    otherSubjects: passFailNa,
    motion: passFailNa,
    /** No copy-paste of the reference's pose, light or background. */
    naturalness: passFail,
    promptFit: passFail,
    temporalConsistency: passFail,
    audio: z.enum(["pass", "fail", "replace-in-edit"]),
    speech: z
      .array(
        z
          .object({
            lineId: z.string().min(1),
            words: passFail,
            speaker: passFail,
            sync: passFailNa,
            evidence: note,
          })
          .strict(),
      )
      .optional(),
    verdict: z.enum(["pass", "repair", "reshoot"]),
    /** Optional evidence (D10): never a verdict on its own. */
    identitySimilarity: z
      .array(z.object({ attachmentSha256: hash, model: note, version: note, score: z.number() }).strict())
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dimensions = [
      value.identity,
      value.wardrobe,
      value.preserved,
      value.otherSubjects,
      value.motion,
      value.naturalness,
      value.promptFit,
      value.temporalConsistency,
      value.audio,
    ];
    if (
      value.verdict === "pass" &&
      (dimensions.includes("fail") ||
        value.speech?.some((line) => [line.words, line.speaker, line.sync].includes("fail")))
    )
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "A failed dimension cannot receive a passing verdict.",
      });
  });
export type PackResultReview = z.infer<typeof PackResultReviewSchema>;
