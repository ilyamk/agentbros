import { z } from "zod";
import { ReferenceIdSchema } from "./reference";
import { ModelPreparationBindingSchema } from "./model-preparation-binding";
import { ReferencePackBindingSchema } from "./reference-pack-binding";

// Artefacts of the bespoke film chain. See docs/production-chain.md.

const Seconds = z.number().finite().nonnegative();
const Span = z.object({ startSec: Seconds, endSec: Seconds });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

// --- Audio map: one analyser's reading of a track, the spine an edit hangs on ---

export const GridTrustSchema = z.enum(["reliable", "weak", "none"]);

export const AudioEventSchema = z.object({
  timeSec: Seconds,
  kind: z.enum(["kick", "snare", "hat", "perc", "onset"]),
  strength: z.number().min(0).max(1),
  metric: z.enum(["downbeat", "beat", "offbeat", "off-grid"]),
});

export const GridSourceSchema = z.enum(["drums-stem", "drums-mix", "tracker"]);

const DrumHitSchema = z.object({ timeSec: Seconds, strength: z.number().min(0).max(1) });

export const GridSchema = z.object({
  source: GridSourceSchema,
  confidence: z.number().min(0).max(1),
  periodSec: z.number().positive().optional(),
  /** Where the beats fall within one period: beat k is at phaseSec + k * periodSec. */
  phaseSec: z.number().nonnegative().optional(),
  beatsPerBar: z.number().int().positive(),
  downbeatConfidence: z.number().min(0).max(1),
  /** False when downbeatConfidence is below 0.2 or there is no grid: downbeats are a guess, not structure. */
  barKnown: z.boolean().optional(),
  /** Root-mean-square distance of the hits from the fitted grid, when the grid was fitted to hits. */
  residualMs: z.number().nonnegative().optional(),
  bars: z.array(Span),
  candidates: z.array(
    z.object({
      source: GridSourceSchema,
      trust: GridTrustSchema,
      confidence: z.number().min(0).max(1),
      bpm: z.number().positive().optional(),
      phaseSec: z.number().nonnegative().optional(),
    }),
  ),
});

export const KeyMomentSchema = z.object({
  timeSec: Seconds,
  kind: z.enum(["surge", "drop", "hard-stop", "riser-end", "impact"]),
  strength: z.number().min(0).max(1),
});

const Unit = z.number().min(0).max(1);

export const SectionLabelSchema = z.enum(["intro", "build", "drop", "break", "outro"]);
export const BreakKindSchema = z.enum(["silence", "stop", "drum-dropout", "bass-dropout"]);

/** The track's form: what an edit hangs its shots, holds and bursts on. Read from stems when the map has them. */
export const MusicStructureSchema = z.object({
  source: z.enum(["stems", "mix"]),
  /** Copied from `grid.barKnown`: phrases are still counted in bars, with confidence lowered when the bar line is a guess. */
  barKnown: z.boolean().optional(),
  /** Bars come from the downbeats; with no grid there are none and phrases come from novelty alone. */
  barSec: z.number().positive().optional(),
  bars: z.array(
    Span.extend({ energy: Unit, density: z.number().nonnegative(), drums: Unit, bass: Unit, novelty: Unit }),
  ),
  /** Phrase spans. `level` is the longest of 4, 8 or 16 bars whose line the start sits on; 0 when there is no grid. */
  phrases: z.array(
    Span.extend({
      startBar: z.number().int().nonnegative().optional(),
      bars: z.number().int().nonnegative(),
      level: z.union([z.literal(0), z.literal(4), z.literal(8), z.literal(16)]),
      confidence: Unit,
    }),
  ),
  /** `intensity` (half level, half drum density, each against the fullest section) is what the label follows. */
  sections: z.array(
    Span.extend({
      label: SectionLabelSchema,
      energy: Unit,
      density: z.number().nonnegative(),
      drums: Unit,
      bass: Unit,
      intensity: Unit.optional(),
      confidence: Unit,
      reason: z.string(),
    }),
  ),
  /** Drum density spikes in the bar before a boundary. */
  fills: z.array(Span.extend({ boundarySec: Seconds, strength: Unit })),
  /** Rising brightness or level that resolves into a boundary. */
  risers: z.array(
    Span.extend({ boundarySec: Seconds, strength: Unit, rises: z.array(z.enum(["centroid", "energy"])) }),
  ),
  breaks: z.array(Span.extend({ kind: BreakKindSchema, strength: Unit })),
  ending: z.object({
    kind: z.enum(["hard-stop", "fade"]),
    lastSoundSec: Seconds,
    fadeSec: Seconds,
    finalDownbeatSec: Seconds.optional(),
  }),
});

export const AudioMapSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    path: z.string(),
    sha256: Sha256,
    durationSec: z.number().positive(),
    /** Encoder priming: by default the map keeps the presented timeline, priming included, as players play it. */
    decoder: z
      .object({
        codec: z.string(),
        sampleRate: z.number().nonnegative(),
        editList: z.boolean(),
        declaredDelaySamples: z.number().nonnegative(),
        primingSec: z.number().nonnegative(),
        primingCorrected: z.boolean(),
      })
      .optional(),
  }),
  tempo: z.object({
    bpm: z.number().positive().optional(),
    confidence: z.number().min(0).max(1),
    /** "none" or "weak": pace by phrases and sections, the beat grid is what the tracker imposed. */
    gridTrust: GridTrustSchema,
  }),
  beatsSec: z.array(Seconds),
  downbeatsSec: z.array(Seconds),
  phrases: z.array(Span.extend({ energy: z.number().min(0).max(1) })),
  sections: z.array(
    Span.extend({ level: z.enum(["low", "mid", "high"]), density: z.number().nonnegative(), feel: z.string() }),
  ),
  events: z.array(AudioEventSchema),
  keyMoments: z.array(KeyMomentSchema),
  silences: z.array(Span),
  risers: z.array(Span),
  energyCurve: z.array(
    z.object({
      timeSec: Seconds,
      rms: z.number().min(0).max(1),
      low: z.number().min(0).max(1),
      high: z.number().min(0).max(1),
    }),
  ),
  /** Which reading won the beat grid and why; `tempo`, `beatsSec` and `downbeatsSec` already follow it. */
  grid: GridSchema.optional(),
  /** Hits transcribed from the drums stem, or from the full mix when no stems were made. */
  drums: z
    .object({
      source: z.enum(["drums-stem", "mix"]),
      kick: z.array(DrumHitSchema),
      snare: z.array(DrumHitSchema),
      hat: z.array(DrumHitSchema),
      bass: z.array(DrumHitSchema).optional(),
    })
    .optional(),
  stems: z.object({ model: z.string(), dir: z.string() }).optional(),
  structure: MusicStructureSchema.optional(),
  mapImagePath: z.string().optional(),
});

// --- Cue sheet: the edit's timing, snapped to the audio map ---

export const CueKindSchema = z.enum(["cut", "transition", "reveal", "hit", "stop", "sfx"]);
export const CueSnapSchema = z.enum(["downbeat", "beat", "event", "key-moment", "phrase", "none"]);
/** Sound families a cue can name; the sound step picks the file. Mirrors `SfxKind` in src/motion/library/types.ts. */
export const SfxKindSchema = z.enum([
  "click",
  "pop",
  "whoosh",
  "impact",
  "chime",
  "riser",
  "sub-drop",
  "tick",
  "glass",
  "none",
]);
/** A deliberate silence on a cut or hero moment, with why: what the sound step reads as decided, not forgotten. */
export const CueSilenceSchema = z.object({ reason: z.string().trim().min(3) });
/**
 * The sound decision fields of a cue: `sfx` (a sound kind), or `silent: {reason}`; a hero cue may add `layers`. Optional
 * so old sheets parse; `cueDecision()` in src/lib/audio/cut-decisions.ts says which cues must decide (cut, transition,
 * reveal and hit unless `weight: "support"`) and plan:check blocks the undecided.
 */
const CueDecisionFields = {
  sfx: z.string().optional(),
  silent: CueSilenceSchema.optional(),
  /** Extra sounds on a hero cue, layered with `sfx`: e.g. a tick transient, a whoosh body and a sub-drop tail. */
  layers: z
    .array(SfxKindSchema.exclude(["none"]))
    .min(1)
    .optional(),
  weight: z.enum(["hero", "support"]).optional(),
};

export const CueSheetSchema = z.object({
  schemaVersion: z.literal(1),
  fps: z.number().positive(),
  audioMapPath: z.string(),
  /** Seconds of the track at the film's first frame. */
  musicOffsetSec: Seconds,
  cues: z.array(
    z.object({
      id: z.string(),
      kind: CueKindSchema,
      intentSec: Seconds,
      snap: CueSnapSchema,
      snappedSec: Seconds,
      frame: z.number().int().nonnegative(),
      deltaSec: z.number().finite(),
      anchorKind: z.string().optional(),
      /** Frame of the music anchor; `frame` is where the picture lands, `leadFrames` earlier. */
      anchorFrame: z.number().int().nonnegative().optional(),
      leadFrames: z.number().int().nonnegative().optional(),
      shotId: z.string().optional(),
      ...CueDecisionFields,
    }),
  ),
});

// --- Music choice ---

export const MusicRouteSchema = z.enum([
  "reference-track",
  "free-stock",
  "trending-native",
  "generated",
  "user-supplied",
  "synth",
  "silence",
]);

export const MusicCandidateSchema = z.object({
  id: z.string(),
  route: MusicRouteSchema,
  provider: z.string(),
  title: z.string(),
  creator: z.string().optional(),
  sourceUrl: z.string().optional(),
  durationSec: z.number().positive().optional(),
  /** A preview is for choosing and for reading rhythm, never for delivery. */
  previewPath: z.string().optional(),
  originalPath: z.string().optional(),
  licence: z.object({
    code: z.string(),
    url: z.string().optional(),
    commercial: z.enum(["yes", "no", "unknown"]),
    attribution: z.string().optional(),
    verifiedAt: z.string().optional(),
  }),
  audioMapPath: z.string().optional(),
  why: z.string().optional(),
});

export const MusicShortlistSchema = z.object({
  schemaVersion: z.literal(1),
  brief: z.string(),
  candidates: z.array(MusicCandidateSchema),
});

/** The excerpt of the chosen track the film uses: what audio:map reads, what the writers and the director hear. */
export const MusicCutSchema = z.object({
  /** Project-relative, normally music/cue.wav. */
  file: z.string().min(1),
  sha256: Sha256,
  source: z.object({ path: z.string().min(1), sha256: Sha256 }),
  startSec: Seconds,
  durationSec: z.number().positive(),
  requestedDurationSec: z.number().positive(),
  /** downbeat: the end was moved onto the nearest downbeat of the candidate's map; requested: cut where asked. */
  endsOn: z.enum(["downbeat", "requested"]),
  gridTrust: z.string().optional(),
  /** Where start and duration came from: the flags, the shortlist fit, the listening file's name, a file cut elsewhere, or the whole file. */
  from: z.enum(["flags", "fit", "listen", "file", "whole"]),
});

export const MusicDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** The user's own words. The route is never decided without asking. */
    askedUser: z.object({ question: z.string(), answer: z.string(), at: z.string() }),
    route: MusicRouteSchema,
    candidateId: z.string().optional(),
    delivery: z.enum(["embedded", "native-on-platform", "study-only", "none"]),
    reason: z.string(),
    credit: z.string().optional(),
    cut: MusicCutSchema.optional(),
  })
  .refine((decision) => decision.route !== "silence" || decision.delivery === "none", {
    message: "silence delivers no music",
    path: ["delivery"],
  })
  .refine((decision) => decision.route !== "trending-native" || decision.delivery !== "embedded", {
    message: "a trending track is added on the platform, never embedded",
    path: ["delivery"],
  });

// --- Material ---

/** One piece of outside media and where it came from: what a shot is made of, with provenance, licence and cost. */
export const MaterialItemSchema = z.object({
  id: z.string().min(1),
  /** Script beat or shot ids this item serves. */
  shots: z.array(z.string()).default([]),
  what: z.string().min(1),
  kind: z.enum([
    "footage",
    "image",
    "ui-capture",
    "generated-video",
    "generated-image",
    "recording",
    "cut-out",
    "audio",
    "model",
    "other",
  ]),
  route: z.enum(["supplied", "stock", "capture", "generated", "recorded", "library"]),
  /** planned: free and not yet fetched; pending: waits for the user's yes or a recording; acquired: on disk. */
  status: z.enum(["planned", "pending", "acquired"]),
  path: z.string().optional(),
  /** URL and provider id, model and operation id, or who recorded it. */
  provenance: z.string().min(1),
  licence: z.string().min(1),
  licenceUrl: z.string().optional(),
  /** Spent, in USD; null when free or not spent yet. */
  costUsd: z.number().nonnegative().nullable().default(null),
  /** The bound the user authorised for a paid item: a planning bound, not a cap on billing. */
  maxCostUsd: z.number().positive().optional(),
  modelPreparation: ModelPreparationBindingSchema.optional(),
  /** The approved reference pack this generated item is made from (RFC 0003 §6.5). */
  referencePack: ReferencePackBindingSchema.optional(),
  /** A generated item that deliberately uses no reference inputs, and why (RFC 0003 AC16). */
  referencePlan: z
    .object({ mode: z.literal("none"), reason: z.string().trim().min(1) })
    .strict()
    .optional(),
});

export const MaterialSchema = z.object({
  schemaVersion: z.literal(1),
  filmType: z.string().min(1),
  items: z.array(MaterialItemSchema).min(1),
});

// --- Targets and measurement ---

const RangeSchema = z.object({ min: z.number().optional(), max: z.number().optional() });

/** Numbers the film has to match, read from a reference's measured layers or set by hand with a reason. */
export const FilmTargetsSchema = z.object({
  schemaVersion: z.literal(1),
  referenceId: ReferenceIdSchema.optional(),
  source: z.enum(["reference", "manual", "corpus"]),
  reason: z.string().optional(),
  /** source corpus: the references whose distributions set the ranges (`film:targets --corpus`). Absent otherwise. */
  corpus: z
    .object({
      referenceIds: z.array(ReferenceIdSchema).min(1),
      playbook: z.string().optional(),
      excluded: z.array(z.string()).optional(),
    })
    .optional(),
  measuredFrom: z.record(z.string(), z.number()).default({}),
  medianShotSec: RangeSchema,
  /** p90 / p10 of shot length: a low ratio is a uniform cadence. */
  shotLengthVariety: RangeSchema,
  cutsPerMinute: RangeSchema,
  stillShare: RangeSchema,
  longestStillSec: RangeSchema,
  audioRequired: z.boolean(),
  loudnessLufs: RangeSchema,
  cutsOnAudioRatio: RangeSchema,
  /** The reference climax's shape, as advisory targets: film:measure warns, never fails, on these. */
  climax: z
    .object({
      timeShare: RangeSchema,
      prominence: RangeSchema,
      breathDepth: RangeSchema,
      riseFrames: RangeSchema,
      holdSec: RangeSchema,
      /** Absolute frames from the nearest beat. */
      beatOffsetFrames: RangeSchema,
    })
    .optional(),
});

export const FilmLegSchema = z.object({
  id: z.string(),
  status: z.enum(["pass", "warn", "fail", "skipped"]),
  value: z.number().nullable(),
  target: RangeSchema.optional(),
  message: z.string(),
  fix: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});

export const FilmMeasureSchema = z.object({
  schemaVersion: z.literal(1),
  renderSha256: Sha256,
  targetsPath: z.string().optional(),
  verdict: z.enum(["pass", "fail"]),
  legs: z.array(FilmLegSchema),
  /** Stretches where the picture stopped moving, for the critic. */
  frozenSpans: z.array(Span).default([]),
});

/** One kept render of a film: a content-addressed copy under out/<id>/versions/, so a later render cannot overwrite it. */
export const FilmVersionSchema = z.object({
  sha256: Sha256,
  /** Root-relative path of the kept copy. */
  file: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** The steps that produced or sealed it ("render", "build", "measure"…), first first. */
  steps: z.array(z.string().min(1)).min(1),
  createdAt: z.iso.datetime(),
  composition: z.string().optional(),
  draft: z.boolean().default(false),
  /** film:measure's verdict on exactly this render, kept because pipeline/film-measure.json is overwritten by the next one. */
  measure: z
    .object({
      verdict: z.enum(["pass", "fail"]),
      path: z.string().optional(),
      failing: z.array(z.string()).default([]),
    })
    .optional(),
});
export const FilmVersionsIndexSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  versions: z.array(FilmVersionSchema),
});

export type AudioMap = z.infer<typeof AudioMapSchema>;
export type MusicStructure = z.infer<typeof MusicStructureSchema>;
export type CueSheet = z.infer<typeof CueSheetSchema>;
export type CueSheetCue = CueSheet["cues"][number];
export type SfxKindName = z.infer<typeof SfxKindSchema>;
export type MusicCandidate = z.infer<typeof MusicCandidateSchema>;
export type MusicShortlist = z.infer<typeof MusicShortlistSchema>;
export type MusicDecision = z.infer<typeof MusicDecisionSchema>;
export type MusicCut = z.infer<typeof MusicCutSchema>;
export type FilmTargets = z.infer<typeof FilmTargetsSchema>;
export type FilmMeasure = z.infer<typeof FilmMeasureSchema>;
export type Material = z.infer<typeof MaterialSchema>;
export type FilmVersion = z.infer<typeof FilmVersionSchema>;
export type FilmVersionsIndex = z.infer<typeof FilmVersionsIndexSchema>;
