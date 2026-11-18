import { z } from "zod";
import { ConceptCandidateSchema } from "./creative";
import { FilmTypeSchema, ScriptSchema } from "./pipeline";

/** The creative department's artefacts: strategy, team ideas, script variants, blind pools, reviews and boards. */

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Concept teams' stances; their descriptions are in .agents/skills/creative-studio/references/creative-teams.md. */
export const TEAM_STANCES = ["metaphor", "product-in-use", "provocation", "human-moment"] as const;
export const TeamStanceSchema = z.enum(TEAM_STANCES);
export type TeamStance = z.infer<typeof TeamStanceSchema>;
export const DEFAULT_TEAMS: TeamStance[] = ["metaphor", "product-in-use", "provocation"];

/** Script-writer variants; their profiles are in the same references file. */
export const SCRIPT_VARIANTS = ["a", "b", "c"] as const;
export const ScriptVariantIdSchema = z.enum(SCRIPT_VARIANTS);
export type ScriptVariantId = z.infer<typeof ScriptVariantIdSchema>;
export const DEFAULT_VARIANTS: ScriptVariantId[] = ["a", "b", "c"];

export const StrategySchema = z.object({
  schemaVersion: z.literal(1),
  language: z.string().min(1),
  audience: z.object({ who: z.string().min(1), moment: z.string().min(1) }),
  platform: z.object({
    name: z.string().min(1),
    aspect: z.enum(["vertical", "square", "landscape"]),
    sound: z.enum(["on", "off", "either"]),
    placement: z.string().optional(),
  }),
  /** One sentence the film proves; never a list. */
  proposition: z.string().min(1),
  hook: z.object({ mechanic: z.string().min(1), firstTwoSeconds: z.string().min(1) }),
  tone: z.array(z.string().min(1)).min(1),
  mandatories: z.array(z.string()),
  forbidden: z.array(z.string()),
  successCriteria: z.array(z.string().min(1)).min(2),
  filmType: FilmTypeSchema,
  secondaryFilmType: FilmTypeSchema.optional(),
  /** Concept teams to brief, 2 to 4 distinct stances. Default: DEFAULT_TEAMS. */
  creativeTeams: z.array(TeamStanceSchema).min(2).max(4).optional(),
  /** What the buyer would otherwise do that looks most like the product on screen. */
  strongestAlternative: z.object({ name: z.string().min(1), whyConsidered: z.string().min(1) }).optional(),
  /** Proofs only this product can show: each cites a working product-truth claim (its text verbatim, or its id) and says what the frame looks like. */
  productOnlyProofs: z
    .array(z.object({ proof: z.string().min(1), claim: z.string().min(1), looksLike: z.string().min(1) }))
    .optional(),
  /** QA lines of a secondary film type the brief's limits overrule: the line quoted, and the limit that wins. */
  waivers: z.array(z.object({ rule: z.string().min(1), reason: z.string().min(1) })).default([]),
});

/** The creativity method and stimulus an idea came from: kept in the pool key, never shown to the director. */
export const StimulusRefSchema = z.object({
  method: z.string().min(1),
  seed: z.string().min(1),
  prompt: z.string().min(1),
});

/** Which category cliché an idea turns, and how: kept in the pool key, never shown to the director. */
export const SubvertsSchema = z.object({ cliche: z.string().min(1), how: z.string().min(1) });

/** Where an idea shows one of the strategy's product-only proofs: in its hook or its turn. Kept in the key. */
export const ProofFrameSchema = z.object({ proof: z.string().min(1), where: z.enum(["hook", "turn"]) });

export const TeamIdeasSchema = z.object({
  schemaVersion: z.literal(1),
  team: TeamStanceSchema,
  round: z.number().int().positive(),
  ideas: z
    .array(
      ConceptCandidateSchema.extend({
        stimulus: StimulusRefSchema.nullable().optional(),
        subverts: SubvertsSchema.nullable().optional(),
        proofFrame: ProofFrameSchema.optional(),
      }),
    )
    .min(4)
    .max(6),
  /** The obvious ideas the team wrote first and banned (kill-first-10). */
  killedObvious: z.array(z.string().min(1)).optional(),
});

/** What the category already does, read before any idea: its examples, conventions and clichés. */
export const CategoryScanSchema = z.object({
  schemaVersion: z.literal(1),
  category: z.string().min(1),
  examples: z
    .array(
      z.object({
        url: z.string().min(1),
        brand: z.string().min(1),
        hookFirst2s: z.string().min(1),
        coreVisualDevice: z.string().min(1),
        productRole: z.string().min(1),
        structure: z.string().min(1),
        evidence: z.enum(["read", "inferred"]),
      }),
    )
    .min(8),
  conventions: z.array(z.object({ convention: z.string().min(1), seenIn: z.string().min(1), why: z.string().min(1) })),
  cliches: z
    .array(z.object({ cliche: z.string().min(1), description: z.string().min(1), seenIn: z.string().min(1) }))
    .min(8),
  learn: z.array(z.string().min(1)),
  dontTake: z.array(z.string().min(1)),
  whiteSpace: z.array(z.string().min(1)),
});

export const ScriptMusicMapLinkSchema = z
  .object({ beatId: z.string(), sectionIndex: z.number().int().nonnegative() })
  .loose();

export const ScriptVariantSchema = z.object({
  schemaVersion: z.literal(1),
  variant: ScriptVariantIdSchema,
  round: z.number().int().positive(),
  hookLine: z.string(),
  density: z.enum(["sparse", "medium", "dense"]),
  script: ScriptSchema,
  /** Absent only when the user chose silence. */
  musicMap: z.object({ schemaVersion: z.literal(1), beats: z.array(ScriptMusicMapLinkSchema) }).optional(),
  /** The variant for the user to read, markdown in their language. */
  markdown: z.string().min(1),
});

export const ReadingOverrunSchema = z.object({
  beatId: z.string(),
  text: z.string(),
  needSec: z.number(),
  haveSec: z.number(),
});

export const CreativePoolSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["ideas", "scripts"]),
  round: z.number().int().positive(),
  seed: z.string(),
  rubricVersion: z.union([z.literal(1), z.literal(2)]),
  items: z
    .array(
      z.object({
        id: z.string().regex(/^[IS]\d+$/),
        /** Ideas: the candidate without its id. Scripts: hookLine, density, script and music map. */
        content: z.record(z.string(), z.unknown()),
        /** Scripts: measured reading overruns; any caps the reading axis. */
        readingOverruns: z.array(ReadingOverrunSchema).optional(),
      }),
    )
    .min(1),
});

/** Who wrote what; the director never reads it. */
export const PoolKeySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["ideas", "scripts"]),
  round: z.number().int().positive(),
  entries: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      sourceId: z.string(),
      file: z.string(),
      sha256: Sha256,
      stimulus: StimulusRefSchema.nullable().optional(),
      subverts: SubvertsSchema.nullable().optional(),
      proofFrame: ProofFrameSchema.optional(),
    }),
  ),
  /** Each author's banned obvious ideas, kept out of the pool. */
  killedObvious: z.record(z.string(), z.array(z.string())).optional(),
});

const AxisScoreSchema = z.object({ score: z.number().int().min(1).max(5), note: z.string().min(1) });

const ScoreTableSchema = z.record(z.string(), z.record(z.string(), z.number()));

export const JudgedSchema = z.object({
  sha256: Sha256,
  pairsSha256: Sha256,
  scores: ScoreTableSchema,
  top: z.array(z.string()),
  verdict: z.enum(["pass", "below-threshold"]),
});

export const RescoreSchema = z.object({
  reason: z.string().min(1),
  previousSha256: Sha256,
  sha256: Sha256,
  changes: z.array(
    z.object({ id: z.string(), axis: z.string(), from: z.number().nullable(), to: z.number().nullable() }),
  ),
  pairsOrSameImageChanged: z.boolean(),
  previousTop: z.array(z.string()),
  top: z.array(z.string()),
  previousVerdict: z.enum(["pass", "below-threshold"]),
  verdict: z.enum(["pass", "below-threshold"]),
});

export const CreativeReviewSchema = z.object({
  schemaVersion: z.literal(1),
  rubricVersion: z.union([z.literal(1), z.literal(2)]),
  kind: z.enum(["ideas", "scripts"]),
  round: z.number().int().positive(),
  /** SHA-256 of the pool file judged. */
  targetSha256: Sha256,
  scores: z.array(z.object({ id: z.string(), axes: z.record(z.string(), AxisScoreSchema) })).min(1),
  pairs: z.array(z.object({ first: z.string(), second: z.string(), winner: z.string() })),
  against: z.array(z.object({ id: z.string(), argument: z.string().min(1) })),
  /** For the authors when the round goes back to them; for the user otherwise. */
  notes: z.array(z.string()),
  lessonsCited: z.array(z.string()).default([]),
  /** Items the director judges to be one picture: at most one of each group enters the top. */
  sameImage: z.array(z.array(z.string()).min(2)).default([]),
  /** Written by creative:rank, never by hand. */
  ranking: z.array(z.string()).optional(),
  passing: z.array(z.string()).optional(),
  top: z.array(z.string()).optional(),
  verdict: z.enum(["pass", "below-threshold"]).optional(),
  /** The judgement (scores, pairs, sameImage) creative:rank last ranked, by hash: a later change is a rescore. */
  judged: JudgedSchema.optional(),
  /** Every rescore after a verdict, with the reason given and what changed. */
  rescoredAfterVerdict: z.array(RescoreSchema).default([]),
});

/** creative:rank's own record of what it ranked, beside the review: the baseline for a rescore even if the review is rewritten. */
export const JudgedRecordSchema = z.object({
  schemaVersion: z.literal(1),
  judged: JudgedSchema,
  rescoredAfterVerdict: z.array(RescoreSchema).default([]),
});

/** A creative pool reopened by an upstream change or the user's feedback: the authors write `round` from scratch. */
export const PoolReopenSchema = z.object({
  /** The round the authors write now: the next one after a reviewed round, or the same one when no review judged it. */
  round: z.number().int().positive(),
  cause: z.enum(["upstream", "feedback"]),
  /** Why, as the chain said it: the inputs that changed since the authors' step finished. */
  changed: z.array(z.string()),
  /** The user's words, verbatim, from the step's open feedback (cause feedback). */
  quotes: z.array(z.string()).default([]),
  feedbackIds: z.array(z.string()).default([]),
  /** The previous winner in one bounded line, snapshotted before the pick is rewritten. */
  previousWinner: z.string().optional(),
  /** Lane file → SHA-256 when reopened: a lane still holding that file has not written the new round. */
  supersedes: z.record(z.string(), z.string()).default({}),
  at: z.string(),
});

export const PoolReopensSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["ideas", "scripts"]),
  reopens: z.array(PoolReopenSchema),
});
export type PoolReopen = z.infer<typeof PoolReopenSchema>;

export const BOARD_ROLES = ["hook", "turn", "last"] as const;

export const ConceptBoardsSchema = z.object({
  candidates: z
    .array(
      z.object({
        id: z.string(),
        frames: z
          .array(
            z.object({
              role: z.enum(BOARD_ROLES),
              itemId: z.string().min(1),
              props: z.record(z.string(), z.unknown()).default({}),
              caption: z.string().min(1),
              /** Where in the block to take the still, 0-1. Default by role: hook 0.35, turn 0.55, last 0.75 (many blocks exit near their end). */
              at: z.number().min(0).max(1).optional(),
            }),
          )
          .min(2),
      }),
    )
    .min(1),
});

export type Strategy = z.infer<typeof StrategySchema>;
export type TeamIdeas = z.infer<typeof TeamIdeasSchema>;
export type CategoryScan = z.infer<typeof CategoryScanSchema>;
export type ScriptVariant = z.infer<typeof ScriptVariantSchema>;
export type CreativePool = z.infer<typeof CreativePoolSchema>;
export type PoolKey = z.infer<typeof PoolKeySchema>;
export type CreativeReview = z.infer<typeof CreativeReviewSchema>;
export type ConceptBoards = z.infer<typeof ConceptBoardsSchema>;
export type JudgedRecord = z.infer<typeof JudgedRecordSchema>;
