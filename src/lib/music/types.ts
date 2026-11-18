import { z } from "zod";
import { MusicCandidateSchema } from "../../types/film";

/** What a film asks of its music. Every field is optional; ranking only judges what is stated. */
export const MusicBriefSchema = z.object({
  bpm: z.number().positive().optional(),
  /** Allowed distance from `bpm`, in BPM. Half and double tempo also count, with a penalty. */
  bpmTolerance: z.number().nonnegative().default(6),
  durationSec: z.number().positive().optional(),
  /** Seconds into the cue where the energy should arrive: the brief's "drop", which the audio map calls a surge. */
  dropAtSec: z.number().nonnegative().optional(),
  intro: z.enum(["quiet", "full"]).optional(),
  ending: z.enum(["hard", "fade"]).optional(),
});
export type MusicBrief = z.infer<typeof MusicBriefSchema>;

/** Measured from the preview's audio map, or read from the host's metadata when not analysed. */
export const MusicFitSchema = z.object({
  analysed: z.boolean(),
  bpm: z.object({
    value: z.number().optional(),
    source: z.enum(["measured", "metadata", "none"]),
    relation: z.enum(["exact", "half", "double", "off"]).optional(),
    gridTrust: z.enum(["reliable", "weak", "none"]).optional(),
  }),
  /** Where in the track the cue should start so that its surge lands at the brief's drop. */
  offsetSec: z.number().nonnegative().optional(),
  /** Track time of the surge used, and its cue time. */
  surgeSec: z.number().nonnegative().optional(),
  dropAtCueSec: z.number().nonnegative().optional(),
  /** Mean level (0-1) before and after the surge; contrast is after minus before. */
  introLevel: z.number().optional(),
  afterLevel: z.number().optional(),
  contrast: z.number().optional(),
  ending: z
    .object({
      /** The track's own ending, only when the whole track was analysed. */
      track: z.enum(["hard-stop", "fade", "unmeasured"]),
      /** Where an editor would cut the cue, and whether that is on a measured downbeat. Not the track's natural ending. */
      cueCutSec: z.number().optional(),
      cueCutOnDownbeat: z.boolean().optional(),
    })
    .optional(),
  /** Level per second across the cue window, 0-1. */
  energy: z.array(z.number()).default([]),
  lengthSec: z.number().optional(),
  /** Shorter than the cue: a loop to stitch or repeat. */
  loop: z.boolean().default(false),
  score: z.number(),
  notes: z.array(z.string()).default([]),
});
export type MusicFit = z.infer<typeof MusicFitSchema>;

/**
 * A candidate as a search returns it: the contract's fields plus what shortlist and
 * acquire need later. MusicCandidateSchema strips the extras, so the contract stays valid.
 */
export const MusicHitSchema = MusicCandidateSchema.extend({
  /** Remote audio for choosing by ear. May expire (Deezer signs its links). */
  previewUrl: z.string().optional(),
  /** Remote original, when the licence and the host allow a direct download. */
  originalUrl: z.string().optional(),
  acquisition: z.enum(["direct", "manual", "oauth", "native-platform", "local"]),
  acquisitionNote: z.string().optional(),
  instrumental: z.enum(["yes", "no", "unknown"]),
  tags: z.array(z.string()).default([]),
  /** True when the licence was read from the host's own per-track record, not an aggregator. */
  sourceVerified: z.boolean(),
  /** Syncing to picture is an adaptation under CC, so an ND track cannot go in a film. */
  syncAllowed: z.boolean(),
  shareAlike: z.boolean().default(false),
  /** The host behind an aggregator hit, e.g. "jamendo" for an Openverse row. */
  origin: z.string().optional(),
  chart: z.object({ provider: z.string(), position: z.number().int().positive(), scope: z.string() }).optional(),
  statedRights: z
    .object({
      status: z.enum(["unknown", "owned", "licensed", "study-only"]),
      note: z.string().optional(),
      statedBy: z.enum(["source.json", "user"]).optional(),
    })
    .optional(),
  score: z.number().optional(),
  fit: MusicFitSchema.optional(),
  /** Tempo the host states, when it states one (Incompetech, Freesound). */
  metadataBpm: z.number().positive().optional(),
});
export type MusicHit = z.infer<typeof MusicHitSchema>;

export const ProviderStatusSchema = z.object({
  provider: z.string(),
  status: z.enum(["ok", "not-connected", "failed"]),
  count: z.number().int().nonnegative(),
  message: z.string().optional(),
  howToConnect: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const MusicSearchFileSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["free-stock", "trending", "reference"]),
  brief: z.string(),
  notice: z.string().optional(),
  providers: z.array(ProviderStatusSchema).default([]),
  excluded: z.record(z.string(), z.number()).default({}),
  unmatched: z.array(z.string()).default([]),
  musicBrief: MusicBriefSchema.optional(),
  candidates: z.array(MusicHitSchema),
});
export type MusicSearchFile = z.infer<typeof MusicSearchFileSchema>;

export const MUSIC_PATHS = {
  options: "pipeline/music/options.json",
  decision: "pipeline/music-decision.json",
  shortlist: "pipeline/music-shortlist.json",
  candidates: "pipeline/music/candidates",
  contactSheet: "pipeline/music/contact-sheet.png",
  searchFreeStock: "pipeline/music/search-free-stock.json",
  searchTrending: "pipeline/music/search-trending.json",
  reference: "pipeline/music/reference",
  receipts: "pipeline/music/receipts",
  credits: "pipeline/music/credits.json",
  shortlistFit: "pipeline/music/shortlist-fit.json",
} as const;

/** Stated in every output that carries chart data. */
export const TRENDING_NOTICE =
  "These are general popularity charts from Deezer and Apple, not TikTok's own trending list. The 30 s previews are for choosing and for reading rhythm only. A trending track is never embedded: the film is cut to its grid and delivered without it, and the user adds the sound on the platform.";

export const CANNOT_HEAR_NOTICE =
  "Agents cannot hear. The contact sheet shows shape and energy only; the user has to choose by ear from the listed files.";
