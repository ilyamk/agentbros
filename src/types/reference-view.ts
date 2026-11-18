import { z } from "zod";

/**
 * Leaf module (RFC 0003 §6.1): entity card view tags and per-view facts. entities.ts imports it;
 * references.ts re-exports it, so the two never import each other.
 */

/** Card-level view tags (EntityCard.references[].role). Free strings remain readable on cards; new cards use these. */
export const EntityViewRoleSchema = z.union([
  z.enum([
    "front",
    "three-quarter-left",
    "three-quarter-right",
    "profile-left",
    "profile-right",
    "back",
    "face-closeup",
    "full-body",
    "hands",
    "packshot-front",
    "packshot-back",
    "packshot-three-quarter",
    "label-detail",
    "plate-wide",
    "plate-medium",
    "plate-reverse",
    "style-board",
    "palette",
    "voice-sample",
    "performance-clip",
  ]),
  z.string().regex(/^(expression|outfit|plate|lighting|custom):[a-z0-9-]+$/),
]);
export type EntityViewRole = z.infer<typeof EntityViewRoleSchema>;

const ViewBackgroundSchema = z.enum(["neutral", "transparent", "scene", "unknown"]);
const ViewLightingSchema = z.enum(["even", "directional", "scene", "unknown"]);
const viewFactsShape = {
  /** Declared or measured head/object yaw. */
  yawDeg: z.number().min(-180).max(180).optional(),
  outfitId: z.string().min(1).optional(),
  handsEmpty: z.boolean().optional(),
  containsOtherPeople: z.boolean().optional(),
  styleNeutral: z.boolean().optional(),
};

/**
 * Facts stored on an entity card reference. No defaults: a card's version hash is the digest of its parsed card,
 * so an absent fact must stay absent (absent background/lighting reads as "unknown").
 */
export const EntityReferenceFactsSchema = z
  .object({ ...viewFactsShape, background: ViewBackgroundSchema.optional(), lighting: ViewLightingSchema.optional() })
  .strict();
export type EntityReferenceFacts = z.infer<typeof EntityReferenceFactsSchema>;

/** Resolved view facts used by coverage and pack checks (RFC §6.1): unknown background/lighting made explicit. */
export const ReferenceViewFactsSchema = z
  .object({
    ...viewFactsShape,
    background: ViewBackgroundSchema.default("unknown"),
    lighting: ViewLightingSchema.default("unknown"),
  })
  .strict();
export type ReferenceViewFacts = z.infer<typeof ReferenceViewFactsSchema>;
