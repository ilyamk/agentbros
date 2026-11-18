import { z } from "zod";

export const HttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "Use an HTTPS URL");
export const ContributorHandleSchema = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
export const ContributorSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    links: z.array(HttpsUrlSchema),
    bio: z.string().max(280),
    credits: z.string().max(500),
  })
  .strict();
export type Contributor = z.infer<typeof ContributorSchema>;
