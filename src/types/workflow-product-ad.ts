import { z } from "zod";
import { AssetProvenanceSchema, AssetRightsSchema } from "./assets";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2000);
const frame = z.number().int().nonnegative().max(108000);
const region = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, "Critical region must stay inside source frame");
export const ProductAdRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("product-ad"),
    projectId: id,
    productName: text,
    audience: text,
    cta: z
      .object({
        label: text,
        url: z
          .string()
          .url()
          .refine((u) => new URL(u).protocol === "https:", "CTA must be HTTPS"),
      })
      .strict(),
    style: z
      .object({
        accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
        background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
        text: z.string().regex(/^#[a-fA-F0-9]{6}$/),
      })
      .strict(),
    media: z
      .array(
        z
          .object({
            id,
            path: text,
            sha256: sha,
            kind: z.enum(["image", "video", "audio"]),
            provenance: AssetProvenanceSchema,
            rights: AssetRightsSchema,
            criticalRegion: region.optional(),
          })
          .strict(),
      )
      .min(4)
      .max(30),
    claims: z
      .array(
        z
          .object({
            id,
            statement: text,
            evidence: z
              .object({
                path: text,
                sha256: sha,
                excerpt: text,
                reviewer: text,
                reviewedAt: z.string().datetime(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    beats: z
      .array(
        z
          .object({
            id,
            role: z.enum(["hook", "problem", "demo", "proof", "cta"]),
            durationFrames: z.number().int().min(30).max(600),
            headline: z.string().trim().min(1).max(80),
            subtext: z.string().max(160).optional(),
            spokenText: text,
            visual: z
              .object({
                mediaId: id,
                sourceStartFrame: frame.default(0),
                interaction: z
                  .object({
                    action: text,
                    visibleOutcome: text,
                    startFrame: frame,
                    endFrame: frame,
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
            voice: z
              .object({
                mediaId: id,
                sourceStartFrame: frame.default(0),
                words: z
                  .array(
                    z
                      .object({
                        text: z.string().trim().min(1).max(80),
                        startFrame: frame,
                        endFrame: frame,
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(150),
              })
              .strict(),
            claimIds: z.array(id).default([]),
            framingNotes: text,
          })
          .strict(),
      )
      .length(5),
    music: z
      .object({
        mediaId: id,
        sourceStartFrame: frame.default(0),
        volume: z.number().min(0.25).max(0.35),
      })
      .strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const roles = ["hook", "problem", "demo", "proof", "cta"];
    if (r.beats.some((b, i) => b.role !== roles[i]))
      ctx.addIssue({
        code: "custom",
        path: ["beats"],
        message: "Expected hook → problem → demo → proof → CTA order",
      });
    for (const [key, values] of [
      ["media", r.media],
      ["claims", r.claims],
      ["beats", r.beats],
    ] as const)
      if (new Set(values.map((v) => v.id)).size !== values.length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Duplicate IDs",
        });
    if (r.beats.reduce((n, b) => n + b.durationFrames, 0) > 1800)
      ctx.addIssue({
        code: "custom",
        path: ["beats"],
        message: "Advertising workflow maximum is 60 seconds",
      });
    for (const [i, b] of r.beats.entries()) {
      if (b.voice.words.map((w) => w.text).join(" ") !== b.spokenText.replace(/\s+/g, " ").trim())
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "voice"],
          message: "Timed caption words must reproduce spokenText exactly",
        });
      if (
        b.voice.words.some(
          (w, j) =>
            w.startFrame >= w.endFrame ||
            w.endFrame > b.durationFrames ||
            (j > 0 && w.startFrame < b.voice.words[j - 1].endFrame),
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "voice"],
          message: "Caption intervals must be ordered within owned beat frames",
        });
      if (b.role === "proof" && !b.claimIds.length)
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "claimIds"],
          message: "Proof beat requires source-backed claims",
        });
      if (b.role === "demo" && !b.visual.interaction)
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "visual"],
          message: "Demo requires an actual supplied interaction and visible outcome declaration",
        });
      if (b.role === "cta" && (b.headline !== r.cta.label || b.subtext !== r.cta.url))
        ctx.addIssue({
          code: "custom",
          path: ["beats", i],
          message: "CTA beat must show the exact declared action and destination",
        });
    }
  });
export type ProductAdRequest = z.infer<typeof ProductAdRequestSchema>;
