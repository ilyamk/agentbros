import { z } from "zod";
import { TechniqueFunctionSchema } from "./reference";

// Shot tournaments (shot:tournament) and library usage across films (library:usage). Rules: src/lib/film/AGENTS.md.

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const ShotWeightSchema = z.enum(["hero", "support"]);

/** pipeline/cue-placements.json as library:usage reads it: only the fields usage needs, the rest passes. */
export const CuePlacementsSchema = z
  .object({
    fps: z.number().positive(),
    blocks: z.array(
      z
        .object({
          id: z.string().min(1),
          startFrame: z.number().int(),
          props: z.record(z.string(), z.unknown()).optional(),
        })
        .loose(),
    ),
  })
  .loose();
export type CuePlacements = z.infer<typeof CuePlacementsSchema>;

export const UsageBlockSchema = z.object({
  /** Library block id, as in the registry. */
  id: z.string().min(1),
  /** sha256 (16 hex) of the block's props as canonical JSON; `{}` when the film set none. */
  propsHash: z.string().regex(/^[a-f0-9]{16}$/),
  weight: ShotWeightSchema,
});
export type UsageBlock = z.infer<typeof UsageBlockSchema>;

/** memory/usage/<project>.json: the library blocks one film used. Local memory, git-ignored. */
export const LibraryUsageSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** yyyy-mm-dd, the day it was recorded. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  blocks: z.array(UsageBlockSchema),
});
export type LibraryUsage = z.infer<typeof LibraryUsageSchema>;

const DistanceFeatureSchema = z.object({
  feature: z.string(),
  value: z.number(),
  /** The corpus band it was compared with, p25 to p75, and where it came from. */
  band: z.object({ p25: z.number(), p75: z.number(), n: z.number().int().nonnegative(), from: z.string() }),
  /** 0 inside the band; outside, the gap to the nearer edge over the band's width (floored). */
  distance: z.number().nonnegative(),
});

export const CorpusDistanceSchema = z.object({
  function: TechniqueFunctionSchema.optional(),
  /** Mean of the features' distances; null when the corpus has no band for any feature. */
  distance: z.number().nonnegative().nullable(),
  features: z.array(DistanceFeatureSchema),
  /** Features with no corpus band in the same unit: left out, never guessed. */
  unavailable: z.array(z.string()),
});
export type CorpusDistance = z.infer<typeof CorpusDistanceSchema>;

const SensorSchema = z.object({
  /** "motion:check" or a film:measure leg id. */
  id: z.string(),
  status: z.enum(["pass", "fail", "warn", "skipped"]),
  value: z.number().nullable(),
  message: z.string(),
});

export const TournamentVariantSchema = z.object({
  /** Blind label shown to the critic: A, B, C. */
  label: z.string().regex(/^[A-C]$/),
  composition: z.string().min(1),
  propsFile: z.string().optional(),
  propsSha256: Sha256.optional(),
  /** A generic name for the variant's technique (`mask-reveal`), never a product: the memory observation is written in these words. Never in a packet. */
  technique: z.string().min(1).optional(),
  /** The rendered shot range. */
  render: z.string(),
  renderSha256: Sha256,
  sensors: z.array(SensorSchema),
  /** True when any sensor failed: the variant cannot win. */
  failed: z.boolean(),
  corpus: CorpusDistanceSchema,
  /** motion:strip --vs sheet of this variant against the nearest reference technique, when the reference has a video. */
  strip: z.string().optional(),
  /** Measured numbers of the shot range, for the rationale. */
  measured: z.record(z.string(), z.number()),
});
export type TournamentVariant = z.infer<typeof TournamentVariantSchema>;

/** An unordered pair, its labels in alphabetical order: AB, AC, BC. */
const PairIdSchema = z.string().regex(/^(AB|AC|BC)$/);
/** "ab": the pair's first label shown first; "ba": reversed. Every pair is judged in both. */
const PairOrderSchema = z.enum(["ab", "ba"]);

export const TournamentPacketSchema = z.object({
  pairId: PairIdSchema,
  order: PairOrderSchema,
  first: z.string().regex(/^[A-C]$/),
  second: z.string().regex(/^[A-C]$/),
  /** Packet file under out/<id>/tournament/<shot>/, labels only. */
  file: z.string(),
});

export const TournamentJudgementSchema = z.object({
  pairId: PairIdSchema,
  order: PairOrderSchema,
  winner: z.union([z.string().regex(/^[A-C]$/), z.literal("tie")]),
  reason: z.string().min(1),
});
export type TournamentJudgement = z.infer<typeof TournamentJudgementSchema>;

/** What the critic hands back: one judgement per packet. */
export const TournamentResultsSchema = z.object({
  schemaVersion: z.literal(1),
  shotId: z.string().min(1),
  /** The record's seed: results for another preparation are refused. */
  seed: z.string().regex(/^[a-f0-9]{16}$/),
  judgements: z.array(TournamentJudgementSchema).min(1),
});
export type TournamentResults = z.infer<typeof TournamentResultsSchema>;

export const TournamentDecisionSchema = z.object({
  winner: z.string().regex(/^[A-C]$/),
  composition: z.string(),
  propsSha256: Sha256.optional(),
  /** Net agreed pairwise wins per label (a win in both orders +1, a loss -1). */
  net: z.record(z.string(), z.number()),
  /** Labels a sensor excluded. */
  excluded: z.array(z.string()),
  /** What settled it: agreed pairwise wins, the corpus distance between tied variants, the label as a last resort, or one survivor. */
  decidedBy: z.enum(["pairwise", "corpus-distance", "label", "sole-survivor"]),
  rationale: z.string(),
  at: z.string(),
});

/** pipeline/tournament/<shot>.json. */
export const ShotTournamentSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  shotId: z.string(),
  function: TechniqueFunctionSchema.optional(),
  weight: ShotWeightSchema.optional(),
  frames: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }),
  fps: z.number().positive(),
  /** sha256 of the project, shot and sorted variant identities: the labels follow from it and nothing else. */
  seed: z.string().regex(/^[a-f0-9]{16}$/),
  /** The nearest reference technique of the same function, which every strip sits against. */
  reference: z
    .object({
      refId: z.string(),
      techniqueId: z.string(),
      name: z.string(),
      startSec: z.number(),
      endSec: z.number(),
      media: z.string().optional(),
    })
    .optional(),
  variants: z.array(TournamentVariantSchema).min(2).max(3),
  packets: z.array(TournamentPacketSchema),
  /** Why the shot has no winner yet, e.g. every variant failed a sensor. */
  undecided: z.string().optional(),
  judgements: z.array(TournamentJudgementSchema).optional(),
  decision: TournamentDecisionSchema.optional(),
});
export type ShotTournament = z.infer<typeof ShotTournamentSchema>;
