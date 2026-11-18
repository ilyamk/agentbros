import { VizRenderVariantsSchema, type VizRenderVariants, VizBindingSchema, type VizBinding } from "./viz";
import { AuthoredCopyCommandSchema, type AuthoredCopyCommand } from "./authored-copy";
import { z } from "zod";
import { CaptionStyleSelectionSchema, type CaptionStyleSelection } from "./caption-style";

/** Exact frame counts and rates; no floating point seconds in the edit model. */
export const RationalSchema = z
  .object({
    num: z.number().int().safe(),
    den: z.number().int().positive().safe(),
  })
  .strict();
export type Rational = z.infer<typeof RationalSchema>;
export const TimebaseSchema = RationalSchema.refine((v) => v.num > 0, "Timebase must be positive");
export const TimelineCaptionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    start: RationalSchema,
    end: RationalSchema,
    emphasis: z.boolean().optional(),
  })
  .passthrough();
export const ReframePositionSchema = z
  .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
  .strict();
/** Crop path from `reframe:track`: cover alignment per source frame (clip source timebase), linear between keyframes, held outside. */
export const ReframePathSchema = z
  .object({
    keyframes: z
      .array(
        z
          .object({
            frame: z.number().int().nonnegative().safe(),
            x: z.number().finite().min(0).max(1),
            y: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(20000),
  })
  .strict()
  .refine(
    (path) => path.keyframes.every((key, i) => i === 0 || key.frame > path.keyframes[i - 1]!.frame),
    "Reframe keyframes must have increasing frames",
  );
export const ReframeSettingSchema = z.union([ReframePositionSchema, ReframePathSchema]);
export const VisualReframesSchema = z
  .object({
    vertical: ReframeSettingSchema.optional(),
    square: ReframeSettingSchema.optional(),
    landscape: ReframeSettingSchema.optional(),
  })
  .strict();
export type ReframePosition = z.infer<typeof ReframePositionSchema>;
export type ReframePath = z.infer<typeof ReframePathSchema>;
export const TimelineClipSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(1),
    start: RationalSchema,
    source: z
      .object({
        start: RationalSchema,
        end: RationalSchema,
        timebase: TimebaseSchema,
      })
      .passthrough(),
    rate: TimebaseSchema.default({ num: 1, den: 1 }),
    transition: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("cut") }).strict(),
        z.object({ kind: z.literal("fade"), duration: RationalSchema }).strict(),
      ])
      .default({ kind: "cut" }),
    captions: z.array(TimelineCaptionSchema).default([]),
    payload: z
      .record(z.string(), z.unknown())
      .superRefine((payload, context) => {
        if (payload.vizRenderVariants !== undefined) {
          const parsed = VizRenderVariantsSchema.safeParse(payload.vizRenderVariants);
          if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid visualisation variants" });
        }
        if (payload.vizBinding !== undefined) {
          const parsed = VizBindingSchema.safeParse(payload.vizBinding);
          if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid visualisation binding" });
        }
        if (payload.reframe !== undefined) {
          const parsed = VisualReframesSchema.safeParse(payload.reframe);
          if (!parsed.success) context.addIssue({ code: "custom", message: "Invalid per-format reframe metadata" });
        }
      })
      .optional(),
  })
  .passthrough();
export type TimelineClip = z.infer<typeof TimelineClipSchema>;
export const OverlayLayerSchema = z.enum(["below-captions", "above-captions"]);
/**
 * A motion library block laid over the picture for [start, end) output frames. `props` override the block's
 * defaultProps; `offset` is how many output frames of the block had already played (set when a slice cuts into it).
 */
export const TimelineOverlaySchema = z
  .object({
    id: z.string().min(1),
    block: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(200),
    props: z.record(z.string(), z.unknown()),
    start: RationalSchema,
    end: RationalSchema,
    offset: RationalSchema.optional(),
    layer: OverlayLayerSchema,
  })
  .strict();
export type TimelineOverlay = z.infer<typeof TimelineOverlaySchema>;
export const TimelineIRSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    timebase: TimebaseSchema,
    tracks: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["visual", "presenter", "voiceover", "music", "sfx", "captions"]),
          clips: z.array(TimelineClipSchema),
        })
        .passthrough(),
    ),
    legacyProject: z.record(z.string(), z.unknown()).optional(),
    /** Burned caption profile for every caption owner; absent means karaoke. */
    captionStyle: CaptionStyleSelectionSchema.optional(),
    /** Library blocks over the picture; absent (never empty) when there are none, so older timelines hash as before. */
    overlays: z.array(TimelineOverlaySchema).min(1).max(200).optional(),
  })
  .passthrough();
export type TimelineIR = z.infer<typeof TimelineIRSchema>;
export const SpeechReplacementEditSchema = z
  .object({
    type: z.literal("speech-replacement"),
    trackId: z.string().min(1),
    clipId: z.string().min(1),
    start: RationalSchema,
    end: RationalSchema,
    replacementId: z.string().min(1),
    assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    captions: z.array(TimelineCaptionSchema).min(1),
    captionTrackId: z.string().min(1).optional(),
    pictureAssetId: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type SpeechReplacementEdit = z.infer<typeof SpeechReplacementEditSchema>;
export type EditCommand =
  | AuthoredCopyCommand
  | SpeechReplacementEdit
  | { type: "add-track"; track: TimelineIR["tracks"][number] }
  | {
      type: "trim";
      trackId: string;
      clipId: string;
      start: Rational;
      end: Rational;
    }
  | {
      type: "split";
      trackId: string;
      clipId: string;
      at: Rational;
      newClipId: string;
    }
  | {
      type: "reframe-visual";
      trackId: string;
      clipId: string;
      format: "vertical" | "square" | "landscape";
      position: ReframePosition | ReframePath | null;
    }
  | { type: "remove-visual"; trackId: string; clipId: string }
  | { type: "move"; trackId: string; clipId: string; start: Rational }
  | { type: "transfer"; trackId: string; clipId: string; targetTrackId: string; start: Rational }
  | { type: "ripple"; trackId: string; from: Rational; delta: Rational }
  | {
      type: "replace";
      trackId: string;
      clipId: string;
      assetId: string;
      source: TimelineClip["source"];
      vizBinding?: VizBinding;
      vizRenderVariants?: VizRenderVariants;
    }
  | {
      type: "transition";
      trackId: string;
      clipId: string;
      transition: TimelineClip["transition"];
    }
  | { type: "rate"; trackId: string; clipId: string; rate: Rational }
  | {
      type: "captions";
      trackId: string;
      clipId: string;
      captions: TimelineClip["captions"];
    }
  | { type: "audio-gain"; trackId: string; clipId: string; gain: number | null }
  | { type: "audio-loop"; trackId: string; clipId: string; loop: boolean | null }
  | { type: "caption-style"; style: CaptionStyleSelection | null }
  | { type: "add-overlay"; overlay: TimelineOverlay }
  | {
      type: "update-overlay";
      overlayId: string;
      block?: string;
      props?: Record<string, unknown>;
      start?: Rational;
      end?: Rational;
      layer?: TimelineOverlay["layer"];
    }
  | { type: "remove-overlay"; overlayId: string }
  | { type: "batch"; commands: EditCommand[] };
const binding = { trackId: z.string().min(1), clipId: z.string().min(1) };
export const EditCommandSchema: z.ZodType<EditCommand> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AuthoredCopyCommandSchema,
    SpeechReplacementEditSchema,
    z
      .object({
        type: z.literal("add-track"),
        track: TimelineIRSchema.shape.tracks.element,
      })
      .strict(),
    z
      .object({
        type: z.literal("trim"),
        ...binding,
        start: RationalSchema,
        end: RationalSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("split"),
        ...binding,
        at: RationalSchema,
        newClipId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("reframe-visual"),
        trackId: z.string().min(1).max(200),
        clipId: z.string().min(1).max(200),
        format: z.enum(["vertical", "square", "landscape"]),
        position: ReframeSettingSchema.nullable(),
      })
      .strict(),
    z
      .object({
        type: z.literal("remove-visual"),
        trackId: z.string().min(1).max(200),
        clipId: z.string().min(1).max(200),
      })
      .strict(),
    z.object({ type: z.literal("move"), ...binding, start: RationalSchema }).strict(),
    z
      .object({ type: z.literal("transfer"), ...binding, targetTrackId: z.string().min(1), start: RationalSchema })
      .strict(),
    z
      .object({
        type: z.literal("ripple"),
        trackId: z.string().min(1),
        from: RationalSchema,
        delta: RationalSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("replace"),
        ...binding,
        assetId: z.string().min(1),
        source: TimelineClipSchema.shape.source,
        vizBinding: VizBindingSchema.optional(),
        vizRenderVariants: VizRenderVariantsSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("transition"),
        ...binding,
        transition: TimelineClipSchema.shape.transition,
      })
      .strict(),
    z.object({ type: z.literal("rate"), ...binding, rate: TimebaseSchema }).strict(),
    z
      .object({
        type: z.literal("captions"),
        ...binding,
        captions: z.array(TimelineCaptionSchema),
      })
      .strict(),
    z
      .object({ type: z.literal("audio-gain"), ...binding, gain: z.number().finite().min(0).max(1).nullable() })
      .strict(),
    z.object({ type: z.literal("audio-loop"), ...binding, loop: z.boolean().nullable() }).strict(),
    z.object({ type: z.literal("caption-style"), style: CaptionStyleSelectionSchema.nullable() }).strict(),
    z.object({ type: z.literal("add-overlay"), overlay: TimelineOverlaySchema.omit({ offset: true }) }).strict(),
    z
      .object({
        type: z.literal("update-overlay"),
        overlayId: z.string().min(1).max(200),
        block: TimelineOverlaySchema.shape.block.optional(),
        props: TimelineOverlaySchema.shape.props.optional(),
        start: RationalSchema.optional(),
        end: RationalSchema.optional(),
        layer: OverlayLayerSchema.optional(),
      })
      .strict()
      .refine((cmd) => Object.keys(cmd).length > 2, "update-overlay needs at least one field to change"),
    z.object({ type: z.literal("remove-overlay"), overlayId: z.string().min(1).max(200) }).strict(),
    z
      .object({
        type: z.literal("batch"),
        commands: z.array(EditCommandSchema).min(1).max(100),
      })
      .strict(),
  ]),
);
