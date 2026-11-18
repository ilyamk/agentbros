import { z } from "zod";
import { FittedEaseSchema, ReferenceIdSchema, ShotCameraSchema, ShotTransitionSchema } from "./reference";

// The build sheet of an exact replica: public/projects/<project>/pipeline/replica-spec.json, one shot per corrected
// reference shot. ref:replica-check validates it against the reference record.

const Frame = z.number().int();

export const ReplicaRightsStatusSchema = z.enum(["owned", "licensed", "study-only"]);

/** The user's answer to the rights gate, written by film:rights: pipeline/replica-rights.json. The spec's `rights` repeats it. */
export const ReplicaRightsSchema = z.object({
  schemaVersion: z.literal(1),
  status: ReplicaRightsStatusSchema,
  userStatement: z.string().min(1),
  askedAt: z.string().min(1),
});
export type ReplicaRights = z.infer<typeof ReplicaRightsSchema>;

/** The reference's fitted camera, copied from motion.json; `ease.pick` names the form the build uses. */
export const ReplicaCameraSchema = ShotCameraSchema.partial().extend({
  kind: ShotCameraSchema.shape.kind,
  ease: FittedEaseSchema.partial()
    .extend({ pick: FittedEaseSchema.shape.pick, spring: FittedEaseSchema.shape.spring.partial().optional() })
    .optional(),
});

export const ReplicaColourSchema = z.object({
  L: z.number().min(0).max(100),
  a: z.number(),
  b: z.number(),
  keyHues: z.array(z.string()).default([]),
  source: z.enum(["measured", "palette", "observed"]).optional(),
});

export const ReplicaShotSchema = z.object({
  id: z.string().min(1),
  /** A corrected reference shot id: a merge keeps the first id, a split shot's parts are `<id>.1`, `<id>.2`… */
  referenceShot: z.string().min(1),
  startFrame: Frame.nonnegative(),
  durationFrames: Frame.positive(),
  transitionIn: z
    .union([ShotTransitionSchema, z.object({ kind: ShotTransitionSchema, frames: Frame.positive() })])
    .optional(),
  framing: z.union([z.string(), z.looseObject({})]).optional(),
  camera: ReplicaCameraSchema.optional(),
  cadence: Frame.min(1).max(4).optional(),
  colour: ReplicaColourSchema,
  type: z.array(z.looseObject({ text: z.string() })).default([]),
  cues: z.array(z.looseObject({ kind: z.string(), frame: Frame })).default([]),
  blocks: z.array(z.string()).default([]),
  content: z.string().min(1).default("keep"),
  confidence: z.enum(["measured", "observed", "rough"]),
  unreachable: z.object({ nearest: z.string(), residual: z.string() }).optional(),
});

export const ReplicaSpecSchema = z.object({
  reference: ReferenceIdSchema,
  fps: z.number().positive(),
  format: z.enum(["vertical", "square", "landscape"]),
  rights: z.object({ status: ReplicaRightsStatusSchema, userStatement: z.string().min(1), askedAt: z.string().min(1) }),
  /** Deliberate differences; `shots` (spec shot ids) exempts those shots' colour and type from matching the measurement. */
  swaps: z
    .array(
      z.object({
        what: z.string(),
        from: z.string(),
        to: z.string(),
        why: z.string(),
        shots: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  shots: z.array(ReplicaShotSchema).min(1),
  rounds: z
    .array(
      z.object({
        round: z.number().int().positive(),
        fixed: z.array(z.string()).default([]),
        compare: z.string().optional(),
        remains: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type ReplicaSpec = z.infer<typeof ReplicaSpecSchema>;
export type ReplicaShot = z.infer<typeof ReplicaShotSchema>;
