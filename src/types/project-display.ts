import { z } from "zod";

export const PROJECT_TITLE_LIMIT = 200;
export const ProjectTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_TITLE_LIMIT)
  .refine((title) => !/[\p{Cc}\u2028\u2029]/u.test(title), "Use a single line without control characters");

export const ProjectRenameSchema = z.strictObject({ title: ProjectTitleSchema });
export const ProjectDisplaySchema = ProjectRenameSchema.extend({ v: z.literal(1) });
export const ProjectRemovalSchema = z.strictObject({ confirm: z.string().min(1).max(128) });
export const ProjectSettingsResponseSchema = z.strictObject({ ok: z.literal(true) });
