import { z } from "zod";

export const FilmStyleIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const FilmStyleKeySchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:@[1-9][0-9]*)?$/);

const rule = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => new TextEncoder().encode(value).length <= 220);
const rules = z.array(rule).min(1).max(3);
export const FilmStyleStageSchema = z.enum(["look", "beat-sheet", "build", "sound", "critic"]);
export type FilmStyleStage = z.infer<typeof FilmStyleStageSchema>;

export const FilmStyleCardSchema = z
  .object({
    id: FilmStyleIdSchema,
    revision: z.number().int().positive(),
    title: z.string().trim().min(1).max(60),
    summary: rule,
    playbooks: z.array(FilmStyleIdSchema).min(1).max(8),
    preset: FilmStyleIdSchema,
    blocks: z.array(FilmStyleIdSchema).max(5),
    engines: z
      .array(
        z.enum([
          "remotion",
          "three",
          "blender",
          "vork",
          "capture-app",
          "hyperframes",
          "source-footage",
          "generated-media",
        ]),
      )
      .min(1)
      .max(3),
    stages: z.object({ look: rules, "beat-sheet": rules, build: rules, sound: rules, critic: rules }).strict(),
    choices: rule,
  })
  .strict();

export type FilmStyleCard = z.infer<typeof FilmStyleCardSchema>;

const FilmStyleTokensSchema = z
  .object({
    palette: z
      .object({
        background: z.string(),
        surface: z.string(),
        text: z.string(),
        muted: z.string(),
        accent: z.string(),
        accent2: z.string().optional(),
      })
      .strict(),
    fonts: z.object({ display: z.string(), body: z.string(), mono: z.string().optional() }).strict(),
    motion: z
      .object({
        springDamping: z.number(),
        springStiffness: z.number(),
        staggerFrames: z.number(),
        holdFrames: z.number(),
      })
      .strict(),
    finish: z
      .object({
        grain: z.number(),
        vignette: z.number(),
        motionBlur: z.boolean(),
        glow: z.number(),
        preset: z.enum(["clean", "filmic", "tactile"]).optional(),
      })
      .strict(),
    grounds: z.array(z.string()).optional(),
    typeScale: z.object({ hero: z.number(), title: z.number(), caption: z.number() }).strict().optional(),
  })
  .strict();

export const FilmStyleBindingSchema = z
  .object({
    version: z.literal(1),
    style: FilmStyleCardSchema,
    tokens: FilmStyleTokensSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FilmStyleBinding = z.infer<typeof FilmStyleBindingSchema>;
