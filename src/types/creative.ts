import { VizBindingSchema } from "./viz";
import { z } from "zod";
import { ProductionRouteSchema, ReferenceIdSchema, TechniqueFunctionSchema } from "./reference";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

// --- Concept (artefact of the script stage) ---

/** One idea, as a concept team writes it and as concept.json keeps it. */
export const ConceptCandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  premise: z.string(),
  coreImage: z.string(),
  openingFrame: z.string(),
  whyWatch: z.string(),
  risks: z.array(z.string()).default([]),
  referenceIds: z.array(ReferenceIdSchema).default([]),
  turn: z.string().optional(),
  lastFrame: z.string().optional(),
  carries: z.string().optional(),
  rulesOut: z.array(z.string()).optional(),
  nativeMove: z.string().optional(),
});

export const ConceptSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidates: z.array(ConceptCandidateSchema).min(3),
    benchmark: z.object({ learn: z.array(z.string()), doNotTake: z.array(z.string()) }).optional(),
    selectedId: z.string(),
    rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
    productTruth: z.object({
      sources: z.array(z.string()),
      claims: z.array(
        z.object({ text: z.string(), status: z.enum(["working", "in-development", "horizon", "unverified"]) }),
      ),
    }),
  })
  .refine((concept) => concept.candidates.some((candidate) => candidate.id === concept.selectedId), {
    message: "selectedId must name a candidate",
    path: ["selectedId"],
  });

// --- Motion plan (artefact of the storyboard stage) ---

export const MotionPlanSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  fps: z.number().positive(),
  blueprintReferenceId: ReferenceIdSchema.optional(),
  shots: z
    .array(
      z.object({
        id: z.string(),
        beatId: z.string().optional(),
        vizBinding: VizBindingSchema.optional(),
        startFrame: z.number().int().nonnegative(),
        durationFrames: z.number().int().positive(),
        intent: z.string(),
        subject: z.string(),
        framing: z.string(),
        camera: z.string(),
        composition: z.string(),
        entrance: z.string(),
        exit: z.string(),
        curve: z.string(),
        beatSync: z.string().optional(),
        transitionToNext: z.string().optional(),
        /** What crosses the boundary into the next shot, or "hard-cut: <why>" for a deliberate one. */
        carry: z.string().optional(),
        /** What moves independently in the shot: background, subject, type, particles. */
        layers: z.array(z.string()).optional(),
        /** Share of the frame the subject fills, 0-1. */
        subjectFill: z.number().min(0).max(1).optional(),
        /** Seconds the shot's copy sits settled, after its entrance and before its exit. */
        readingHoldSec: z.number().nonnegative().optional(),
        route: ProductionRouteSchema,
        renderTask: z.string().min(1).optional(),
        techniqueIds: z.array(z.string()).default([]),
        /** Motion library blocks the shot is built from, by registry name; "custom: <what>" where none fits. */
        blocks: z.array(z.string()).optional(),
        /** What the shot does for the viewer, as ref:corpus indexes techniques: candidates come from that function's corpus entries. */
        function: TechniqueFunctionSchema.optional(),
        /** A hero shot carries the film: shot:tournament decides its technique before the build is recorded. */
        weight: z.enum(["hero", "support"]).optional(),
      }),
    )
    .min(1),
  /** One element no library block supplies, taken from this film's idea; plan:check's signature-element asks for it in a bespoke film. */
  signature: z
    .object({ description: z.string().min(1), shotIds: z.array(z.string()).min(1), whyFromIdea: z.string().min(1) })
    .optional(),
  onScreenCopy: z
    .array(z.object({ shotId: z.string(), text: z.string(), required: z.boolean().default(false) }))
    .default([]),
  finalFrameIntent: z.enum(["hold", "loop", "fade"]).default("hold"),
});

// --- Technique card (frontmatter of design-reference/techniques/<id>.md) ---

export const TechniqueCardSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  intent: z.string(),
  route: ProductionRouteSchema,
  timing: z.string(),
  curve: z.string().optional(),
  primitive: z.string().optional(),
  demo: z.string().optional(),
  sources: z.array(z.string()).default([]),
  status: z.enum(["draft", "demonstrated", "confirmed"]),
});

// --- Visual reviews and critique ---

const ReviewedFrameSchema = z.object({
  path: z.string(),
  timeSec: z.number().nonnegative().optional(),
  note: z.string().min(1),
});

/** Written to pipeline/reviews/<step>.json: records what was looked at, not that it is good. */
export const VisualReviewSchema = z.object({
  schemaVersion: z.literal(1),
  step: z.string(),
  renderSha256: Sha256,
  reviewer: z.string(),
  frames: z.array(ReviewedFrameSchema).min(1),
  issues: z.array(z.string()).default([]),
});

const CritiqueScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  note: z.string(),
  evidence: z.array(z.string()).min(1),
});

export const CritiqueSchema = z.object({
  schemaVersion: z.literal(1),
  round: z.number().int().positive(),
  renderSha256: Sha256,
  framesReviewed: z.array(ReviewedFrameSchema).min(1),
  scores: z.object({
    idea: CritiqueScoreSchema,
    hook: CritiqueScoreSchema,
    motion: CritiqueScoreSchema,
    rhythm: CritiqueScoreSchema,
    typography: CritiqueScoreSchema,
    composition: CritiqueScoreSchema,
    ending: CritiqueScoreSchema,
    referenceMatch: CritiqueScoreSchema.optional(),
  }),
  verdict: z.enum(["approve-for-human", "revise", "rethink-idea"]),
  actions: z.array(z.string()).default([]),
  humanVerdict: z
    .object({ verdict: z.enum(["accepted", "revise", "rejected"]), notes: z.string(), at: z.string() })
    .optional(),
});

export type Concept = z.infer<typeof ConceptSchema>;
export type MotionPlan = z.infer<typeof MotionPlanSchema>;
export type TechniqueCard = z.infer<typeof TechniqueCardSchema>;
export type VisualReview = z.infer<typeof VisualReviewSchema>;
export type Critique = z.infer<typeof CritiqueSchema>;
