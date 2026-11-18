import { z } from "zod";

/** Frame numbers index decoded frames of the analysed file (`source.analysedPath`), from 0, inclusive at both ends. */
const Frame = z.number().int().nonnegative();

export const FootageTransitionTypeSchema = z.enum(["cut", "dissolve", "fade"]);

export const FootageCutSchema = z
  .object({
    frame: Frame,
    type: FootageTransitionTypeSchema,
    startFrame: Frame,
    endFrame: Frame,
    confidence: z.number().min(0).max(1),
    timeSec: z.number().nonnegative(),
    timecode: z.string().regex(/^\d{2}:\d{2}:\d{2}\.\d{3}$/),
    measures: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  })
  .refine((cut) => cut.startFrame <= cut.frame && cut.frame <= cut.endFrame + 1, {
    message: "frame must lie within the transition",
  })
  .refine((cut) => cut.type !== "cut" || cut.startFrame === cut.endFrame, { message: "a cut spans no frames" });

export const FootageShotSchema = z.object({
  id: z.string().regex(/^s\d{3,}$/),
  startFrame: Frame,
  endFrame: Frame,
  /** Seconds, end exclusive, so the file also works as `motion:strip --by-shots`. */
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  durationFrames: z.number().int().positive(),
  /** First and last frames outside any dissolve or fade at either end. */
  cleanStartFrame: Frame,
  cleanEndFrame: Frame,
  transitionIn: z.union([FootageTransitionTypeSchema, z.literal("start")]),
  timecode: z.string(),
});

export const FootageShotsSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    path: z.string(),
    analysedPath: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    variableFrameRate: z.boolean(),
    normalised: z.object({ fps: z.number().positive(), filter: z.string() }).optional(),
    /** How long after the container's start (usually the audio's) the video stream starts. After normalising, analysed frame F is original-stream frame F - round(startOffsetSec x fps). */
    startOffsetSec: z.number().nonnegative().optional(),
  }),
  fps: z.number().positive(),
  frames: z.number().int().positive(),
  durationSec: z.number().positive(),
  detector: z.object({
    engine: z.enum(["transnetv2", "reference"]),
    version: z.string(),
    device: z.string().optional(),
    torch: z.string().optional(),
    fadeDetector: z.string(),
    refinement: z.string(),
    params: z.record(z.string(), z.number()),
    candidates: z.number().int().nonnegative(),
    fallback: z.object({ reason: z.string(), fix: z.string() }).optional(),
  }),
  cuts: z.array(FootageCutSchema),
  shots: z.array(FootageShotSchema).min(1),
  storyboard: z.array(z.string()),
  strips: z.record(z.string(), z.string()).optional(),
});

export type FootageCut = z.infer<typeof FootageCutSchema>;
export type FootageShot = z.infer<typeof FootageShotSchema>;
export type FootageShots = z.infer<typeof FootageShotsSchema>;
