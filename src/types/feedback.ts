import { z } from "zod";
import { RegionSchema } from "./console";

/**
 * The user's feedback on a film they watched, as a structured step input (`pnpm feedback`).
 * Quotes are the user's own words, verbatim; the source is always the user, never a proxy or an agent.
 * `routedTo` is written by code (src/lib/feedback/route.ts, footage.ts, campaign.ts), never by hand: a film step, a
 * footage step (recut-plan, captions, shorts, reframe, mix), a campaign `variant` or `dependency`, or `ask`.
 */

export const ASPECTS = [
  "concept",
  "audience",
  "hook-line",
  "opening-picture",
  "words",
  "claim",
  "ending-cta",
  "music",
  "sfx-mix",
  "voice",
  "captions",
  "pacing",
  "length",
  "look",
  "shot",
  "material",
  "framing",
  "cuts",
  "shorts",
  "unclear",
] as const;
export const AspectSchema = z.enum(ASPECTS);
export type Aspect = z.infer<typeof AspectSchema>;

export const FEEDBACK_ROUTES = ["film", "footage", "campaign"] as const;
export const SeveritySchema = z.enum(["must", "should", "nit"]);
export const ItemStatusSchema = z.enum(["open", "addressed", "declined"]);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** A step id, or `ask` when the user must say where the change belongs. */
export const RoutedToSchema = z.string().regex(/^(ask|[a-z][a-z0-9-]*)$/);

export const FeedbackItemSchema = z.object({
  id: z.string().regex(/^i\d+$/),
  /** The user's words, verbatim, in their language. */
  quote: z.string().trim().min(2),
  aspect: AspectSchema,
  at: z
    .object({ fromSec: z.number().nonnegative(), toSec: z.number().nonnegative() })
    .refine((range) => range.toSec >= range.fromSec, "toSec is before fromSec")
    .optional(),
  shotId: z.string().min(1).optional(),
  /** The frame of the watched render the user pointed at, and the area of it (normalised 0–1), when they did. */
  frame: z.number().int().nonnegative().optional(),
  region: RegionSchema.optional(),
  /** A campaign: the variant the user watched, and the shared material the item is about. */
  memberId: z.string().min(1).optional(),
  materialId: z.string().min(1).optional(),
  severity: SeveritySchema,
  routedTo: RoutedToSchema,
  status: ItemStatusSchema,
  /** Why the owner left the result unchanged (film:done --unchanged-because), when declined. */
  declinedBecause: z.string().min(1).optional(),
});
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const FeedbackSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^fb-\d{3,}$/),
  route: z.enum(FEEDBACK_ROUTES),
  /** The exact file the user watched: feedback on another render is refused. */
  watched: z.object({ path: z.string().min(1), sha256: Sha256 }),
  /** Only the user gives feedback: no proxy, no agent, no critic. */
  source: z.object({
    kind: z.literal("user"),
    at: z.string().min(1),
    /** `console` when the studio console recorded it (RFC 0004 D9). */
    channel: z.enum(["cli", "console"]).optional(),
  }),
  verdict: z.enum(["accept", "revise"]),
  items: z.array(FeedbackItemSchema).min(1),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/** What the orchestrator writes for `pnpm feedback --file`: the user's items; code fills id, route, hashes and routing. */
export const FeedbackInputSchema = z.object({
  verdict: z.enum(["accept", "revise"]).default("revise"),
  watched: z.object({ path: z.string().min(1).optional(), sha256: Sha256.optional() }).optional(),
  source: z.object({ kind: z.literal("user") }).optional(),
  items: z
    .array(
      z.object({
        quote: z.string().trim().min(2),
        aspect: AspectSchema,
        at: z.object({ fromSec: z.number().nonnegative(), toSec: z.number().nonnegative() }).optional(),
        shotId: z.string().min(1).optional(),
        frame: z.number().int().nonnegative().optional(),
        region: RegionSchema.optional(),
        memberId: z.string().min(1).optional(),
        materialId: z.string().min(1).optional(),
        severity: SeveritySchema.default("must"),
      }),
    )
    .min(1),
});
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;

/**
 * `pipeline/feedback/open/<step>.json`: a step's open items, a tracked input of that step. Writing it reopens the step and
 * everything downstream through the receipt hashes; resealing the step with changed outputs clears it.
 */
export const OpenFeedbackSchema = z.object({
  schemaVersion: z.literal(1),
  step: z.string().min(1),
  items: z
    .array(
      z.object({
        feedbackId: z.string().regex(/^fb-\d{3,}$/),
        itemId: z.string().regex(/^i\d+$/),
        quote: z.string().min(2),
        aspect: AspectSchema,
        severity: SeveritySchema,
        at: z.object({ fromSec: z.number(), toSec: z.number() }).optional(),
        shotId: z.string().optional(),
        frame: z.number().int().nonnegative().optional(),
        region: RegionSchema.optional(),
        watched: z.string().min(1),
      }),
    )
    .min(1),
  /** The user's own answer when the same aspect came back to this step: what exactly they want. */
  clarifications: z.array(z.object({ quote: z.string().trim().min(2), at: z.string() })).default([]),
  /**
   * A footage step has no receipts: what its output was when the feedback came (the recut it applies to and a
   * fingerprint of the plan, timeline or shorts files). footage:next settles the items once the fingerprint moves.
   */
  baseline: z.object({ recutId: z.string().nullable(), value: z.string() }).optional(),
});
export type OpenFeedback = z.infer<typeof OpenFeedbackSchema>;
