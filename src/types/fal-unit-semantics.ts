import { z } from "zod";

const date = z.union([z.iso.date(), z.iso.datetime()]);
const positive = z.number().finite().positive();
export const FalUnitSemanticsSchema = z
  .object({
    endpoint: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
      .max(200),
    unitPrice: positive.optional(),
    meaning: z.enum([
      "generated-second",
      "input-video-second",
      "output-image",
      "output-megapixel",
      "video-megapixel",
      "frames",
      "request",
      "input-kilo-characters",
      "input-audio-minute",
      "output-audio-second",
      "ambiguous",
    ]),
    framesPerUnit: positive.optional(),
    roundUp: z.boolean().optional(),
    approximate: z.boolean().optional(),
    perSample: z.boolean().optional(),
    validUntil: date.optional(),
    regularUsdPerUnit: positive.optional(),
    baseSeconds: positive.optional(),
    baseUsd: positive.optional(),
    extraUsdPerSecond: positive.optional(),
    clips: z
      .array(z.object({ durationSec: positive, resolution: z.string().min(1).optional(), usd: positive }).strict())
      .min(1)
      .optional(),
    tiers: z
      .array(
        z
          .object({
            when: z
              .object({
                resolution: z.string().min(1).optional(),
                generateAudio: z.boolean().optional(),
                voiceControl: z.boolean().optional(),
              })
              .strict(),
            usdPerUnit: positive,
            validUntil: date.optional(),
            regularUsdPerUnit: positive.optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    example: z
      .object({ text: z.string().min(1), usd: z.number().finite().nonnegative() })
      .strict()
      .optional(),
    reason: z.string().min(1).optional(),
    // Pin the API inputs independently of the page rate so --changed also detects tariff drift.
    apiSnapshot: z
      .object({ unit: z.string().min(1), unitPrice: z.number().finite().nonnegative() })
      .strict()
      .optional(),
    evidence: z.object({ url: z.url(), quote: z.string().min(1), observedAsOf: date }).strict(),
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.meaning === "frames" && row.framesPerUnit === undefined)
      ctx.addIssue({ code: "custom", path: ["framesPerUnit"], message: "Frame pricing requires framesPerUnit" });
    if (
      [row.baseSeconds, row.baseUsd, row.extraUsdPerSecond].some((value) => value !== undefined) &&
      [row.baseSeconds, row.baseUsd, row.extraUsdPerSecond].some((value) => value === undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["baseSeconds"],
        message: "Base-duration pricing requires baseSeconds, baseUsd and extraUsdPerSecond",
      });
  });
export type FalUnitSemantics = z.infer<typeof FalUnitSemanticsSchema>;
export const FalUnitSemanticsFileSchema = z
  .object({
    version: z.literal(1),
    syncedAt: date.nullable(),
    records: z.array(FalUnitSemanticsSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (new Set(file.records.map((row) => row.endpoint)).size !== file.records.length)
      ctx.addIssue({ code: "custom", path: ["records"], message: "Duplicate endpoint" });
  });
export type FalUnitSemanticsFile = z.infer<typeof FalUnitSemanticsFileSchema>;
