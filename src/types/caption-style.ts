import { z } from "zod";

/**
 * Burned caption look for timeline renders. `karaoke`, `phrase`, `keyword` and `bilingual` are the registered
 * template profiles (`caption.*`). The presets after them are the motion library's `captions` category
 * (`src/motion/library/captions/style.ts`). The last four are the profiles saved before the presets; each is drawn by
 * its closest preset (`word-highlight` → `clean-sentence`, `bold-upper` → `outline-pop`, `boxed-word` → `word-box`,
 * `keyword-emphasis` → `keyword-colour`).
 */
export const CaptionProfileIdSchema = z.enum([
  "karaoke",
  "phrase",
  "keyword",
  "bilingual",
  "outline-pop",
  "italic-shadow",
  "keyword-colour",
  "word-box",
  "line-box",
  "chunky-stack",
  "editorial-mix",
  "clean-sentence",
  "single-punch",
  "typewriter",
  "word-highlight",
  "bold-upper",
  "boxed-word",
  "keyword-emphasis",
]);
export type CaptionProfileId = z.infer<typeof CaptionProfileIdSchema>;

const languageTag = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);

export const CaptionStyleSelectionSchema = z
  .object({
    profile: CaptionProfileIdSchema,
    /** Props for the chosen profile or block, merged over its defaults and validated by its own schema. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** Bilingual only: languages of `text` and of each caption's supplied `translation`. */
    sourceLanguage: languageTag.optional(),
    translationLanguage: languageTag.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.profile !== "bilingual") return;
    if (!value.sourceLanguage || !value.translationLanguage)
      ctx.addIssue({ code: "custom", message: "Bilingual captions need sourceLanguage and translationLanguage" });
    else if (value.sourceLanguage.toLowerCase() === value.translationLanguage.toLowerCase())
      ctx.addIssue({ code: "custom", message: "Choose distinct source and translation languages" });
  });
export type CaptionStyleSelection = z.infer<typeof CaptionStyleSelectionSchema>;
