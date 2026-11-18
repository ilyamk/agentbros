import { z } from "zod";
import { ModalitySchema, ReferenceRoleSchema } from "./references";

/**
 * Model reference profiles (RFC 0003 §6.2): one entry per model family, data in
 * src/lib/models/reference-profiles.json. Every limit carries its evidence tier and check date.
 */

export const EvidenceSchema = z
  .object({
    tier: z.enum(["official", "wrapper", "observed", "unverified"]),
    url: z.url().optional(),
    note: z.string().optional(),
    checkedAt: z.iso.date(),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

const range = z
  .object({ min: z.number(), max: z.number(), combinedMax: z.number().optional() })
  .strict()
  .refine((value) => value.min <= value.max, { message: "min exceeds max", path: ["min"] });

export const SlotSchema = z
  .object({
    /** "images", "videos", "audio", "elements", "start", "end", "control". */
    id: z.string().min(1),
    modality: ModalitySchema,
    /** JSON pointer template into the input: "/image_urls", "/elements/{n}/frontal_image_url". */
    pointer: z.string().regex(/^\//),
    /** Roles this slot can carry. */
    roles: z.array(ReferenceRoleSchema).min(1),
    min: z.number().int().nonnegative().default(0),
    max: z.number().int().positive(),
    durationSec: range.optional(),
    pixels: z
      .object({
        minEdge: z.number().optional(),
        maxEdge: z.number().optional(),
        multipleOf: z.number().int().optional(),
        aspect: z.tuple([z.number(), z.number()]).optional(),
      })
      .strict()
      .optional(),
    fps: z.tuple([z.number(), z.number()]).optional(),
    maxBytes: z.number().int().positive().optional(),
    /** MIME types. */
    formats: z.array(z.string()).optional(),
    alpha: z.enum(["supported", "flatten", "unknown"]).default("unknown"),
    /** What the slot carries beyond its role, e.g. ["face"] for Kling motion-control face elements. */
    carries: z.array(z.string()).optional(),
    /**
     * How the prompt names the slot (absent = "indexed"). "indexed": the dialect's marker, numbered per marker group.
     * "none": bound by position (first/last frame, motion-control inputs) and never named by a marker; its role
     * sentence still reads as plain prose, "The <slot id> <image|video|audio> is <roleSentence>.", it takes no
     * marker number and the bijection check ignores it. Optional, not defaulted, so parsed profiles keep their digest.
     */
    marker: z.enum(["indexed", "none"]).optional(),
    /** Slots sharing a group share one running marker index (absent = the slot's modality). */
    markerGroup: z.string().min(1).optional(),
    evidence: EvidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.min > value.max) ctx.addIssue({ code: "custom", path: ["min"], message: "Slot min exceeds max." });
    if (value.marker === "none" && value.markerGroup !== undefined)
      ctx.addIssue({ code: "custom", path: ["markerGroup"], message: "A marker-less slot has no marker group." });
    if (value.marker === "none" && value.pointer.includes("{n}"))
      ctx.addIssue({
        code: "custom",
        path: ["marker"],
        message: "Element slots are named by their element's marker; only a plain slot can be marker-less.",
      });
  });
export type Slot = z.infer<typeof SlotSchema>;

export const PromptSectionSchema = z.enum([
  "action",
  "bindings",
  "invariants",
  "camera",
  "audio",
  "preserve",
  "otherSubjects",
  "avoid",
  "additional",
]);
export type PromptSection = z.infer<typeof PromptSectionSchema>;
export const DEFAULT_PROMPT_ORDER: PromptSection[] = [...PromptSectionSchema.options];

export const DialectKindSchema = z.enum([
  "at-indexed",
  "at-element",
  "at-named",
  "prose-indexed",
  "natural",
  "parameter",
  "none",
]);

export const ReferenceProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** "seedance-2.5", "kling-o3", "nano-banana-2.1", "genjutsu-object-swap". */
    family: z.string().min(1),
    /** Exact endpoint ids or globs resolved against the catalogue. */
    endpoints: z.array(z.string().min(1)).min(1),
    provider: z.enum(["fal", "higgsfield"]),
    status: z.enum(["live", "retiring", "retired"]),
    slots: z.array(SlotSchema).min(1),
    totals: z
      .object({ max: z.number().int().optional(), withVideoMaxImages: z.number().int().optional() })
      .strict()
      .default({}),
    dialect: z
      .object({
        kind: DialectKindSchema,
        /** { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" }; any subset of modalities. */
        templates: z.partialRecord(ModalitySchema, z.string().min(1)).optional(),
        /** "@Element{n}". */
        elementTemplate: z.string().min(1).optional(),
        evidence: EvidenceSchema,
      })
      .strict(),
    promptOrder: z.array(PromptSectionSchema).default(() => [...DEFAULT_PROMPT_ORDER]),
    /**
     * Named composition template; "default" is §7 step 5. "genjutsu-legacy" reproduces genjutsuPrompt() byte for
     * byte: one "Reference bindings: @Image1 (entity, role); …" line, "Preserve: …", "Do not alter these other
     * subjects: …".
     */
    promptTemplate: z.enum(["default", "genjutsu-legacy"]).default("default"),
    negativePrompt: z.boolean().default(false),
    speechInput: z.enum(["reference", "drive"]).optional(),
    omitPrompt: z.literal(true).optional(),
    policies: z
      .object({
        realFaces: z.enum(["allowed", "consented-flow", "rejected", "unknown"]),
        audioFromVideoRefs: z.enum(["used", "ignored", "unknown"]).default("unknown"),
        nativeAudioWithVideoInput: z.boolean().optional(),
        multiVideoReasoning: z.enum(["supported", "degrades", "unknown"]).default("unknown"),
      })
      .strict(),
    guidance: z.array(z.object({ text: z.string().min(1), evidence: EvidenceSchema }).strict()).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.slots.forEach((slot, index) => {
      if (ids.has(slot.id))
        ctx.addIssue({ code: "custom", path: ["slots", index, "id"], message: `Duplicate slot id ${slot.id}.` });
      ids.add(slot.id);
    });
    if (new Set(value.promptOrder).size !== value.promptOrder.length)
      ctx.addIssue({ code: "custom", path: ["promptOrder"], message: "A prompt section appears twice." });
  });
export type ReferenceProfile = z.infer<typeof ReferenceProfileSchema>;

/** src/lib/models/reference-profiles.json. */
export const ReferenceProfilesFileSchema = z
  .object({ schemaVersion: z.literal(1), profiles: z.array(ReferenceProfileSchema) })
  .strict()
  .superRefine((value, ctx) => {
    const families = new Set<string>();
    value.profiles.forEach((profile, index) => {
      if (families.has(profile.family))
        ctx.addIssue({
          code: "custom",
          path: ["profiles", index, "family"],
          message: `Duplicate profile family ${profile.family}.`,
        });
      families.add(profile.family);
    });
  });
export type ReferenceProfilesFile = z.infer<typeof ReferenceProfilesFileSchema>;
