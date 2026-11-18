import { z } from "zod";
import { FilmTypeSchema } from "./pipeline";
import { RecipeIdSchema } from "./recipes";
import { FootageGoalSchema } from "./footage-goals";

/**
 * A playbook is one kind of content task, named the way a user asks for it. It is the orchestrator's first decision and
 * points into the existing registries (route, film type, workflow, recipe, skills, agents, library) without restating
 * them. Files: `playbooks/<id>/playbook.json` (this schema) and `playbooks/<id>/AGENTS.md` (the method). Index:
 * `playbooks/AGENTS.md`.
 */
export const PlaybookIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(48);

const words = z
  .array(
    z
      .string()
      .min(2)
      .regex(/^[^A-Z]*$/, "triggers are lower case"),
  )
  .min(3);

export const PlaybookRouteSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("film"),
      filmType: FilmTypeSchema,
      secondaryFilmType: FilmTypeSchema.optional(),
      start: z.string().startsWith("pnpm "),
    })
    .strict(),
  z
    .object({
      kind: z.literal("footage"),
      /** Default goals for `footage:next --goal`. */
      footageGoals: z.array(FootageGoalSchema).min(1),
      start: z.string().startsWith("pnpm "),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow"),
      /** A `video:workflow` scenario (WORKFLOWS in src/lib/workflows/dispatch.ts; tests/playbooks.test.ts keeps them equal). */
      workflow: z.enum(["product-ad", "education", "recording-edit", "shorts-series"]),
      start: z.string().startsWith("pnpm "),
    })
    .strict(),
  z.object({ kind: z.literal("template"), recipe: RecipeIdSchema, start: z.string().startsWith("pnpm ") }).strict(),
  z
    .object({
      kind: z.literal("campaign"),
      scenario: z.enum([
        "ad-experiments",
        "catalogue-videos",
        "reference-family",
        "localise-campaign",
        "content-series",
      ]),
      start: z.string().startsWith("pnpm "),
    })
    .strict(),
]);

/** Where a film is published. Safe zones per format: CAPTION_SAFE_ZONE and the UI bands in src/lib/captions/readability.ts. */
export const PlaybookPlatformSchema = z.enum([
  "tiktok",
  "instagram-reels",
  "youtube-shorts",
  "youtube",
  "instagram-feed",
  "linkedin",
  "x",
  "app-store",
  "google-play",
  "website",
  "presentation",
]);

/** A platform profile: the delivery facts a film for this task must meet there. */
export const PlaybookProfileSchema = z
  .object({
    platform: PlaybookPlatformSchema,
    formats: z.array(z.enum(["vertical", "square", "landscape"])).min(1),
    /** Length band in seconds that works for this task on this platform. */
    durationSec: z.object({ min: z.number().positive(), max: z.number().positive() }).strict(),
    /** Integrated loudness target, when the platform states or normalises to one. */
    loudnessLufs: z.number().min(-30).max(-5).optional(),
    /** Caption profile id (src/motion/library/captions), or "none" when burned captions do not belong. */
    captions: z.string().min(2).optional(),
    /** One line with the platform rule that matters most (with its source in the playbook's References). */
    note: z.string().min(5).max(300),
  })
  .strict()
  .refine((profile) => profile.durationSec.max >= profile.durationSec.min, { message: "durationSec.max below min" });

/** A question for the user at the start, specific to this task. */
export const PlaybookIntakeSchema = z
  .object({
    ask: z.string().min(5).max(240),
    why: z.string().min(5).max(240),
    /** What the agent assumes when the user does not say. Absent: the question blocks the start. */
    default: z.string().min(1).max(200).optional(),
  })
  .strict();

/** A known-good starting point: library blocks, a style, a template or recipe the agent starts from instead of nothing. */
export const PlaybookStarterSchema = z
  .object({
    blocks: z.array(z.string().min(2)),
    /** A style profile id from the motion library styles or src/lib/templates/styles.ts. */
    style: z.string().min(2).optional(),
    template: z.string().min(2).optional(),
    note: z.string().min(5).max(300),
  })
  .strict();

/** A sub-format inside the task (podcast inside footage-edit), with what changes. */
export const PlaybookVariantSchema = z
  .object({
    id: PlaybookIdSchema,
    title: z.string().min(3),
    triggers: z
      .object({
        en: z.array(z.string().min(2)),
        ru: z.array(z.string().min(2)),
        zh: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    changes: z.string().min(10).max(500),
  })
  .strict();

/** A real project accepted by the user under this playbook: what makes it `proven`. */
export const PlaybookEvidenceSchema = z
  .object({ project: z.string().min(2), acceptedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();

export const PlaybookSchema = z
  .object({
    version: z.literal(1),
    id: PlaybookIdSchema,
    title: z.string().min(3),
    /** draft: method incomplete. ready: complete and checked. proven: a real project under it was accepted by the user. */
    status: z.enum(["draft", "ready", "proven"]),
    /** When the method and its research were last reviewed (platform rules and trends move in months). */
    reviewedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** One line, as in the index. */
    summary: z.string().min(10).max(240),
    /**
     * Request words for `playbook --match`, per language; word stems are fine ("туториал" matches "туториала"). Chinese
     * triggers match as character runs. `zh` is optional in the schema (fixtures) but `--check` requires it of every
     * playbook. `generic` repeats triggers from the lists that also describe neighbouring kinds of video ("short video",
     * "рекламный ролик"): they score 0.5 and never make a match clear on their own.
     */
    triggers: z
      .object({
        en: words,
        ru: words,
        zh: z
          .array(
            z
              .string()
              .min(1)
              .regex(/^[^A-Z]*$/, "triggers are lower case"),
          )
          .optional(),
        generic: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    /** Neighbours: when the request is really one of them. */
    notFor: z.array(z.object({ when: z.string().min(5), use: PlaybookIdSchema }).strict()),
    route: PlaybookRouteSchema,
    /** Other routes that serve the same task in a stated situation. */
    alternatives: z.array(z.object({ when: z.string().min(5), route: PlaybookRouteSchema }).strict()),
    /**
     * Agents in `.agents/agents/` this task adds. For a film route the chain's step owners come from the chain and are
     * not listed again.
     */
    agents: z.array(z.string().min(2)),
    /** Skills in `.agents/skills/` the method relies on. */
    skills: z.array(z.string().min(2)),
    /**
     * Third-party skills in `skills-lock.json` that help but are not shipped with every copy (no redistribution grant):
     * installed from upstream when absent, never required. `pnpm playbook --id` says whether each is installed and how.
     */
    optionalSkills: z.array(z.string().min(2)).optional(),
    /** Motion library categories and block ids (docs/library/catalogue.json). */
    library: z.object({ categories: z.array(z.string().min(2)), blocks: z.array(z.string().min(2)) }).strict(),
    /** package.json aliases the method names. */
    commands: z.array(z.string().min(2)),
    /** Repository files read with the playbook's AGENTS.md (which is always read and not listed). */
    read: z.array(z.string().min(3)),
    /** Repository files read only at the named steps of the playbook's route: film chain steps, footage:next steps or template stages. */
    stepRead: z.record(z.string().min(2), z.array(z.string().min(3)).min(1)).optional(),
    /** What QA looks at hardest for this task, beyond the film type's own QA lines (never restated). */
    qa: z.array(z.string().min(5)).min(2),
    /** Benchmark task ids from bench/suite.json that judge the playbook. */
    benchmarks: z.array(z.string().min(2)),
    /** Questions for the user at the start. */
    intake: z.array(PlaybookIntakeSchema).optional(),
    /** Delivery facts per platform. */
    profiles: z.array(PlaybookProfileSchema).optional(),
    starter: PlaybookStarterSchema.optional(),
    variants: z.array(PlaybookVariantSchema).optional(),
    /** Accepted real projects; required for `proven`. */
    evidence: z.array(PlaybookEvidenceSchema).optional(),
  })
  .strict()
  .refine((playbook) => playbook.status !== "proven" || (playbook.evidence?.length ?? 0) > 0, {
    message: "a proven playbook names at least one accepted project in evidence",
  });

/** `pipeline/playbook.json` in a project: which playbook it follows. */
export const ProjectPlaybookSchema = z
  .object({
    version: z.literal(1),
    id: PlaybookIdSchema,
    chosenAt: z.string().datetime(),
    by: z.enum(["agent", "user"]),
  })
  .strict();

export type PlaybookRoute = z.infer<typeof PlaybookRouteSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
export type ProjectPlaybook = z.infer<typeof ProjectPlaybookSchema>;
