import { z } from "zod";
export const ResourceProviderIdSchema = z.enum([
  "pexels",
  "freesound",
  "openverse",
  "wikimedia",
  "mixkit",
  "lots-of-sounds",
  "epidemic-sound",
  "tiktok-cml",
  "youtube-audio-library",
  "meta-sound-collection",
  "lottiefiles",
  "iconify",
  "google-fonts",
  "poly-haven",
  "pixabay",
  "unsplash",
  "nasa",
  "kenney",
  "ambientcg",
  "rive",
  "ccmixter",
  "internet-archive",
  "jamendo",
  "incompetech",
  "deezer",
  "itunes",
  "pixabay-music",
  "ncs",
  "ende-app",
]);
/** One colour vocabulary for every stock source; each adapter maps or reports what it cannot filter. */
export const STOCK_COLOURS = [
  "black_and_white",
  "black",
  "white",
  "gray",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
  "green",
  "teal",
  "blue",
  "brown",
] as const;
/** Pixabay content categories (the one stock source that filters by category). */
export const STOCK_CATEGORIES = [
  "backgrounds",
  "fashion",
  "nature",
  "science",
  "education",
  "feelings",
  "health",
  "people",
  "religion",
  "places",
  "animals",
  "industry",
  "computer",
  "food",
  "sports",
  "transportation",
  "travel",
  "buildings",
  "business",
  "music",
] as const;
export const ResourceRightsSchema = z
  .object({
    licence: z.string(),
    licenceUrl: z.string().url().optional(),
    version: z.string().optional(),
    commercialAllowed: z.union([z.boolean(), z.literal("unknown")]),
    derivativesAllowed: z.union([z.boolean(), z.literal("unknown")]),
    attributionRequired: z.union([z.boolean(), z.literal("unknown")]),
    attributionText: z.string(),
    shareAlike: z.boolean().default(false),
    allowedPlacements: z.array(z.string()).default([]),
    restrictions: z.array(z.string()).default([]),
    evidenceUrl: z.string().url(),
    checkedAsOf: z.iso.datetime(),
    verifiedAtSource: z.boolean().default(false),
  })
  .strict();
export const ResourceCandidateSchema = z
  .object({
    id: z.string().min(1),
    provider: ResourceProviderIdSchema,
    kind: z.enum(["image", "video", "audio", "animation", "font", "model"]),
    title: z.string(),
    sourceUrl: z.string().url(),
    author: z.string(),
    /** Provider-specific author handle (Unsplash username, Pixabay/Pexels numeric id) for same-author series. */
    authorId: z.string().min(1).optional(),
    authorUrl: z.string().url().optional(),
    previewUrl: z.string().url().optional(),
    downloadUrl: z.string().url().optional(),
    originalDownloadUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    upstream: z
      .object({
        source: z.string(),
        provider: z.string().optional(),
        id: z.string().optional(),
        fileRole: z.enum(["preview", "original", "unverified"]),
      })
      .strict()
      .optional(),
    acquisition: z.enum(["direct", "oauth-original", "original-source", "manual", "native-platform"]),
    media: z
      .object({
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        durationSec: z.number().nonnegative().optional(),
      })
      .strict(),
    /** Downloadable files of one item (video sizes, the API-limited still); acquisition picks one for the target frame. */
    renditions: z
      .array(
        z
          .object({
            url: z.string().url(),
            width: z.number().positive(),
            height: z.number().positive(),
            bytes: z.number().nonnegative().optional(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    visual: z
      .object({
        dominantColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        blurHash: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    details: z
      .object({
        description: z.string().max(5000).optional(),
        location: z.string().max(500).optional(),
        camera: z.string().max(500).optional(),
      })
      .strict()
      .optional(),
    /** Provider usage-reporting endpoint called once when the item is acquired (Unsplash download tracking). */
    tracking: z.object({ downloadLocation: z.string().url() }).strict().optional(),
    tags: z.array(z.string()).default([]),
    rights: ResourceRightsSchema,
    cost: z.object({ status: z.enum(["free", "subscription", "unknown"]), quotaNote: z.string().optional() }).strict(),
  })
  .strict();
export type ResourceCandidate = z.infer<typeof ResourceCandidateSchema>;
export type ResourceRights = z.infer<typeof ResourceRightsSchema>;
export const ResourceUsageSchema = z
  .object({
    commercial: z.boolean().default(false),
    modified: z.boolean().default(true),
    advertising: z.boolean().default(false),
    placements: z.array(z.string()).default([]),
    acceptShareAlike: z.boolean().default(false),
    endorsement: z.boolean().default(false),
    standaloneResale: z.boolean().default(false),
    /** Credit the creator in release credits even when the licence does not require it. */
    credit: z.boolean().default(false),
  })
  .strict();
export type ResourceUsage = z.input<typeof ResourceUsageSchema>;
