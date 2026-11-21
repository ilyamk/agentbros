import { z } from "zod";
import { unitTrayContentSchema } from "../motion/library/data/unit-tray-plan";
import { VizPlanSchema, VizBindingSchema } from "./viz";
const nonempty = z.string().min(1);
export const CaptionWordsSchema = z
  .array(
    z
      .object({
        text: nonempty,
        start: z.number().nonnegative(),
        end: z.number().positive(),
        emphasis: z.boolean().optional(),
      })
      .strict(),
  )
  .superRefine((words, ctx) => {
    words.forEach((word, index) => {
      if (word.end <= word.start || (index > 0 && word.start < words[index - 1].end))
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "Caption words must be ordered and non-overlapping.",
        });
    });
  });
const text = z
  .object({
    text: nonempty,
    accentWordIndex: z.number().int().nonnegative().optional(),
    staggerSec: z.number().min(0.03).max(0.5).default(0.12),
  })
  .strict();
const lines = z
  .object({
    lines: z.array(nonempty).min(1).max(5),
    accentLineIndex: z.number().int().nonnegative().optional(),
    staggerSec: z.number().min(0.1).max(0.8).default(0.2),
  })
  .strict();
const caption = z
  .object({
    words: CaptionWordsSchema,
    maxWords: z.number().int().min(1).max(6).default(3),
    activeColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default("#FFE600"),
  })
  .strict();
const headline = z.object({ headline: nonempty, subtext: z.string().optional() }).strict();
const imageProof = headline.extend({ imageUrl: nonempty }).strict();
const chartProof = z
  .object({
    title: nonempty,
    yUnit: nonempty,
    data: z.array(z.object({ label: z.string(), value: z.number() }).strict()).min(2),
    callout: z.object({ value: nonempty, label: z.string().optional() }).strict(),
  })
  .strict();
// Bounded copy is a drafting limit, not a substitute for measured font/layout QA.
const packTitle = z.string().trim().min(1).max(100);
const packBody = z.string().trim().min(1).max(140);
const languageTag = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
  .max(35);
const bilingualCues = z
  .array(
    z
      .object({
        start: z.number().nonnegative(),
        end: z.number().positive(),
        text: packBody,
        translation: packBody,
      })
      .strict(),
  )
  .min(1)
  .max(10000)
  .superRefine((cues, ctx) => {
    cues.forEach((cue, index) => {
      if (cue.end <= cue.start || (index > 0 && cue.start < cues[index - 1].end))
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "Bilingual cues must be ordered and non-overlapping.",
        });
    });
  });
export const TemplateInstanceSchema = z.discriminatedUnion("id", [
  z
    .object({
      id: z.literal("scene.visualisation"),
      version: z.literal(1),
      props: z
        .object({
          plans: z.array(VizPlanSchema).min(1),
          vizBinding: VizBindingSchema.optional(),
          ground: z.string().default("opaque"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.worked-example"),
      version: z.literal(1),
      props: z
        .object({
          headline: packTitle,
          steps: z
            .array(
              z
                .object({
                  label: z.string().trim().min(1).max(60),
                  detail: packBody,
                })
                .strict(),
            )
            .min(2)
            .max(3),
          result: packBody,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.product-walkthrough"),
      version: z.literal(1),
      props: z
        .object({
          headline: packTitle,
          imageUrl: nonempty,
          action: packBody,
          outcome: packBody,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.editorial-evidence"),
      version: z.literal(1),
      props: z
        .object({
          headline: packTitle,
          statement: packBody,
          sourceLabel: z.string().trim().min(1).max(100),
          interpretation: packBody.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("caption.bilingual"),
      version: z.literal(1),
      props: z
        .object({
          cues: bilingualCues,
          sourceLanguage: languageTag,
          translationLanguage: languageTag,
        })
        .strict()
        .refine(
          (p) => p.sourceLanguage.toLowerCase() !== p.translationLanguage.toLowerCase(),
          "Choose distinct source and translation languages.",
        ),
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.hook"),
      version: z.literal(1),
      props: headline,
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.definition"),
      version: z.literal(1),
      props: lines,
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.metric"),
      version: z.literal(1),
      props: z
        .object({
          headline: nonempty,
          to: z.number(),
          suffix: z.string().default(""),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.image-proof"),
      version: z.literal(1),
      props: imageProof,
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.device-proof"),
      version: z.literal(1),
      props: imageProof,
    })
    .strict(),
  z
    .object({
      id: z.literal("scene.chart-proof"),
      version: z.literal(1),
      props: chartProof,
    })
    .strict(),
  z
    .object({
      id: z.literal("text.word-reveal"),
      version: z.literal(1),
      props: text,
    })
    .strict(),
  z
    .object({
      id: z.literal("text.line-reveal"),
      version: z.literal(1),
      props: lines,
    })
    .strict(),
  z
    .object({
      id: z.literal("text.scale-emphasis"),
      version: z.literal(1),
      props: z
        .object({
          text: nonempty,
          bounce: z.enum(["none", "soft"]).default("none"),
          staggerSec: z.number().min(0.03).max(0.5).default(0.12),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("text.clip-reveal"),
      version: z.literal(1),
      props: z
        .object({
          text: nonempty,
          direction: z.enum(["left", "right", "center"]).default("center"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("text.count-up"),
      version: z.literal(1),
      props: z
        .object({
          from: z.number().default(0),
          to: z.number(),
          suffix: z.string().default(""),
          prefix: z.string().default(""),
          decimals: z.number().int().min(0).max(4).default(0),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.literal("caption.karaoke"),
      version: z.literal(1),
      props: caption,
    })
    .strict(),
  z
    .object({
      id: z.literal("caption.phrase"),
      version: z.literal(1),
      props: caption,
    })
    .strict(),
  z
    .object({
      id: z.literal("caption.keyword"),
      version: z.literal(1),
      props: caption,
    })
    .strict(),
  z
    .object({ id: z.literal("scene.physical-data"), version: z.literal(1), props: unitTrayContentSchema.strict() })
    .strict(),
]);
export type TemplateInstance = z.infer<typeof TemplateInstanceSchema>;
export type TemplateId = TemplateInstance["id"];
export const StyleProfileIdSchema = z.enum([
  "minimal-product",
  "ugc-direct",
  "educational-editorial",
  "documentary",
  "music-led",
  "education-worked-example",
  "product-walkthrough",
  "editorial-evidence",
]);
export type StyleProfileId = z.infer<typeof StyleProfileIdSchema>;
