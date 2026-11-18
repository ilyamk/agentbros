import { z } from "zod";

export const PreparationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const GenjutsuModeSchema = z.enum(["object-swap", "motion-transfer", "restyle"]);
export type GenjutsuMode = z.infer<typeof GenjutsuModeSchema>;
export const ModelPreparationGuideSchema = z
  .object({ mode: GenjutsuModeSchema, guide: z.string(), command: z.string() })
  .strict();
export const ModelPreparationBindingSchema = z
  .object({ id: PreparationIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type ModelPreparationBinding = z.infer<typeof ModelPreparationBindingSchema>;
