import { z } from "zod";
import { SfxKindSchema } from "./film";

/** A finding of Earshot's model-free audit (`check`): a code such as `clicks` or `truncated`, and its sentence. */
const CheckFindingSchema = z.object({ code: z.string(), msg: z.string() }).passthrough();

/** Earshot's audit of one candidate, or why it was not run. Advisory: it ranks, it never approves a sound. */
export const CandidateChecksSchema = z.discriminatedUnion("engine", [
  z.object({
    engine: z.literal("earshot"),
    ok: z.boolean(),
    warnings: z.array(CheckFindingSchema),
    notes: z.array(CheckFindingSchema),
    /** The saved audio:review report (project-relative), bound to the candidate's sha256. */
    report: z.string().optional(),
  }),
  z.object({ engine: z.literal("none"), reason: z.string().min(1) }),
]);
export type CandidateChecks = z.infer<typeof CandidateChecksSchema>;

export const SfxCandidateSchema = z.object({
  /** Stable within the cue: A, B, C… in gathering order. */
  id: z.string().regex(/^[A-Z]{1,2}$/),
  origin: z.enum(["earshot", "library", "synth"]),
  /** Path under public/, as sfx:cues places it. */
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** The Earshot take receipt this came from (project-relative). */
  takeReceipt: z.string().optional(),
  timing: z.object({
    durationSec: z.number().positive(),
    /** Seconds into the file placed on the cue frame (peak for a whoosh or riser, onset otherwise). */
    alignSec: z.number().nonnegative(),
    onsetSec: z.number().nonnegative(),
    peakSec: z.number().nonnegative(),
    tailSec: z.number().nonnegative(),
  }),
  /** Independent local measurement (ffmpeg EBU R128), whatever Earshot says. */
  loudness: z.object({ integratedLufs: z.number().nullable(), truePeakDb: z.number().nullable() }),
  checks: CandidateChecksSchema,
  scores: z.object({
    /** Fit of length, pre-roll and tail to the room around the cue (libraryFit), 0..1. */
    fit: z.number().min(0).max(1),
    /** 1 for a clean audit, lower per warning and note; null without Earshot. */
    artifacts: z.number().min(0).max(1).nullable(),
    total: z.number().min(0).max(1),
  }),
  /** Why the candidate cannot be chosen (silent, clipped, starts before the film…). */
  excluded: z.string().optional(),
});
export type SfxCandidate = z.infer<typeof SfxCandidateSchema>;

export const SfxSelectionCueSchema = z.object({
  /** The cue-sheet cue id; sfx:cues --selection binds the chosen sound to it. */
  cueId: z.string().min(1),
  frame: z.number().int().nonnegative(),
  kind: z.string(),
  sfx: SfxKindSchema.exclude(["none"]),
  room: z.object({ beforeSec: z.number().nonnegative(), afterSec: z.number().nonnegative() }),
  candidates: z.array(SfxCandidateSchema),
  /** The chosen candidate's id; null when none is eligible (sfx:cues then picks as before). */
  selected: z.string().nullable(),
  reason: z.string().min(1),
});
export type SfxSelectionCue = z.infer<typeof SfxSelectionCueSchema>;

/** `pipeline/sfx-selection.json`: each hero sound chosen from measured candidates by fixed criteria (sfx:audition). */
export const SfxSelectionSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  /** The cue sheet's fps: `frame` is in it. */
  fps: z.number().positive(),
  cueSheet: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  earshot: z.object({
    available: z.boolean(),
    reason: z.string().optional(),
    packageSha: z.string().optional(),
  }),
  /** The ranking rule in words, so a reader needs no code. */
  criteria: z.string().min(1),
  cues: z.array(SfxSelectionCueSchema),
  notice: z.string(),
});
export type SfxSelection = z.infer<typeof SfxSelectionSchema>;
