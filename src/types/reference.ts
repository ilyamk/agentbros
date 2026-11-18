import { z } from "zod";

// Standard decomposition of a reference video. Measured layers come from
// ref:analyze; judged layers are written by the reference-analyst agent.

const Seconds = z.number().finite().nonnegative();

export const ClaimBasisSchema = z.enum(["observed", "measured", "inferred"]);
export type ClaimBasis = z.infer<typeof ClaimBasisSchema>;

/** A judged value that states how it was established and how sure the analyst is. */
export const claim = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    basis: ClaimBasisSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()).default([]),
  });

export const ReferenceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const SpanSchema = z.object({ startSec: Seconds, endSec: Seconds });
const Layer = { schemaVersion: z.literal(1), referenceId: ReferenceIdSchema };

const UnavailableSchema = z.object({
  available: z.boolean(),
  engine: z.string().optional(),
  unavailableReason: z.string().optional(),
  fix: z.string().optional(),
});

// --- Measured layers ---

/** The picture inside the frame, in source pixels. Analysis reads a cropped copy; times are unchanged. */
export const ReferenceCropSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  method: z.enum(["letterbox", "static-bands", "manual"]),
  note: z.string().optional(),
});

export const ReferenceSourceSchema = z.object({
  ...Layer,
  origin: z.object({
    kind: z.enum(["file", "url"]),
    url: z.string().optional(),
    originalFilename: z.string(),
    acquiredAt: z.string(),
    tool: z.string().optional(),
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaPath: z.string(),
  probe: z.object({
    durationSec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    codec: z.string().optional(),
    hasAudio: z.boolean(),
  }),
  rights: z.object({
    status: z.enum(["unknown", "owned", "licensed", "study-only"]),
    note: z.string().optional(),
  }),
  notes: z.string().optional(),
  /**
   * A private reference (a client's film): in the local corpus, never in a tracked file. `ref:add --private` sets it
   * and ignores the directory in .git/info/exclude; ref:contribute refuses it and any tracked file naming its id.
   */
  private: z.boolean().optional(),
  /** Absent: never checked (an older record). null: checked, the picture fills the frame. */
  crop: ReferenceCropSchema.nullable().optional(),
  /** Crops replaced by `ref:add --id ID --crop …`, oldest first, with why (a crop fault such as a watermark read as a band). */
  cropHistory: z
    .array(
      z.object({
        crop: ReferenceCropSchema.nullable(),
        replacedAt: z.string(),
        request: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  /** Playbook ids this reference serves; `ref:corpus --playbook` filters on it. Absent on untagged records. */
  playbooks: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).optional(),
});

/** The detector writes the first eight; `iris`, `morph` and `bleach` (a flash to white) are the analyst's, through edit.json retype or split. */
export const ShotTransitionSchema = z.enum([
  "cut",
  "dissolve",
  "fade",
  "wipe",
  "whip",
  "match",
  "continuous",
  "unknown",
  "iris",
  "morph",
  "bleach",
]);

const Percentiles = z.tuple([z.number(), z.number(), z.number()]);

/** A shot's Lab, measured as ref:compare measures its reference side: 4 Hz samples without the first and last 0.1 s, mean and 10th/50th/90th percentile per channel. */
export const ShotColourSchema = z.object({
  L: z.number(),
  a: z.number(),
  b: z.number(),
  percentiles: z.object({ L: Percentiles, a: Percentiles, b: Percentiles }),
  samples: z.number().int().nonnegative(),
});

export const ReferenceShotsSchema = z.object({
  ...Layer,
  status: UnavailableSchema.optional(),
  detector: z.object({
    name: z.string(),
    version: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  shots: z.array(
    SpanSchema.extend({
      id: z.string(),
      transitionIn: ShotTransitionSchema,
      transitionConfidence: z.number().min(0).max(1),
      /** The measured span of a gradual transition into this shot. startSec is its middle. */
      transitionStartSec: Seconds.optional(),
      transitionEndSec: Seconds.optional(),
      transitionMeasures: z.record(z.string(), z.number()).optional(),
      thumbnailPath: z.string().optional(),
      stripPath: z.string().optional(),
      colour: ShotColourSchema.optional(),
    }),
  ),
  /** Smaller visual changes that did not count as shots: text swaps on a flat background, added elements. Worth a look. */
  candidates: z.array(z.object({ timeSec: Seconds, novelty: Seconds })).default([]),
  summary: z.object({ count: z.number().int().nonnegative(), medianDurationSec: Seconds, cutsPerMinute: Seconds }),
});

/** Letter case of a piece of screen text, kept in place of its words. */
export const TextCaseSchema = z.enum(["upper", "lower", "title", "sentence", "mixed", "none"]);

/**
 * Speech and screen text. The tracked `speech-text.json` is structure only (`content: "structure"`): times, letter
 * and digit counts, word counts, boxes, case and an opaque `textId` per distinct screen text, never the film's words.
 * The verbatim text lives in the git-ignored `media/speech-text.full.json` (same schema, `content: "full"`), written by
 * ref:analyze and ref:redact (src/lib/reference/speech-text.ts). A file without `content` is an older full one.
 */
export const ReferenceSpeechTextSchema = z.object({
  ...Layer,
  content: z.enum(["full", "structure"]).optional(),
  speech: UnavailableSchema.extend({
    language: z.string().optional(),
    words: z
      .array(
        SpanSchema.extend({
          /** Verbatim: only in the local full file. */
          text: z.string().optional(),
          /** Letters and digits in the word. */
          chars: z.number().int().nonnegative().optional(),
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .default([]),
  }),
  screenText: UnavailableSchema.extend({
    items: z
      .array(
        SpanSchema.extend({
          /** Verbatim: only in the local full file. */
          text: z.string().optional(),
          /** Same id for the same normalised text (letters and digits, lower case) within this film, numbered in order of first appearance. */
          textId: z.number().int().nonnegative().optional(),
          /** Letters and digits, the count ref:corpus filters on. */
          chars: z.number().int().nonnegative().optional(),
          words: z.number().int().nonnegative().optional(),
          case: TextCaseSchema.optional(),
          confidence: z.number().min(0).max(1).optional(),
          /** Frame-refined time the text appears; startSec comes from 2 fps sampling. */
          onsetSec: Seconds.optional(),
          box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
        }),
      )
      .default([]),
  }),
});

export const ReferenceAudioSchema = z.object({
  ...Layer,
  status: UnavailableSchema.optional(),
  hasAudio: z.boolean(),
  tempo: z
    .object({
      bpm: z.number().positive(),
      confidence: z.number().min(0).max(1),
      beatRegularity: z.number().min(0).max(1).optional(),
      beatsSec: z.array(Seconds),
      downbeatsSec: z.array(Seconds).default([]),
      downbeatConfidence: z.number().min(0).max(1).optional(),
    })
    .optional(),
  onsetsSec: z.array(Seconds).default([]),
  sections: z.array(SpanSchema.extend({ label: z.string(), energy: z.number().min(0).max(1).optional() })).default([]),
  loudness: z
    .object({
      integratedLufs: z.number().optional(),
      truePeakDb: z.number().optional(),
      loudnessRangeLu: z.number().optional(),
    })
    .optional(),
  silence: z.array(SpanSchema).default([]),
  stems: UnavailableSchema.extend({ paths: z.record(z.string(), z.string()).default({}) }).optional(),
});

/** Net travel per axis: x and y in frame widths (camera right and down are positive), z in log scale (push in is positive), r in radians (clockwise roll is positive). */
const AxisAmountSchema = z.object({ x: z.number(), y: z.number(), z: z.number(), r: z.number() });
const MoveKindSchema = z.enum([
  "static",
  "move_right",
  "move_left",
  "move_down",
  "move_up",
  "push_in",
  "pull_out",
  "roll_cw",
  "roll_ccw",
  "shake",
]);

/** A fitted ease, three ways: paste `gsap` into a GSAP tween, `css` into CSS, `spring.remotion` into Remotion's spring(). */
export const FittedEaseSchema = z.object({
  gsap: z.string(),
  gsapRmse: z.number().nonnegative(),
  cubicBezier: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  css: z.string(),
  bezierRmse: z.number().nonnegative(),
  spring: z.object({
    omega: z.number(),
    zeta: z.number(),
    settleSec: z.number(),
    remotion: z.object({ mass: z.number(), stiffness: z.number(), damping: z.number() }),
  }),
  springRmse: z.number().nonnegative(),
  best: z.enum(["gsap", "bezier", "spring"]),
  /** The form to use: a GSAP name when it fits nearly as well as the best. */
  pick: z.enum(["gsap", "bezier", "spring"]),
  overshoot: z.number().nonnegative(),
});

/** One shot's camera, integrated from tracked frame-to-frame similarity. The ease is fitted jointly with start, length and amount. */
export const ShotCameraSchema = z.object({
  kind: z.array(MoveKindSchema).min(1),
  amount: AxisAmountSchema,
  moves: z.number().int().nonnegative(),
  trackedShare: z.number().min(0).max(1).optional(),
  axis: z.enum(["x", "y", "z", "r"]).optional(),
  snap: z.boolean().optional(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  durationSec: z.number().optional(),
  /** Time between 5% and 95% of the travel: the length to compare moves on. */
  span90Sec: z.number().optional(),
  t5Sec: z.number().optional(),
  t95Sec: z.number().optional(),
  holdBeforeSec: z.number().optional(),
  holdAfterSec: z.number().optional(),
  peakSpeed: z.number().optional(),
  cutOff: z.boolean().optional(),
  leadInSec: z.number().optional(),
  ease: FittedEaseSchema.optional(),
  /** The main move's travel, 0 to 1, at 21 even steps between its 5% and 95% points. */
  progress: z.array(z.number()).optional(),
  moveAmount: AxisAmountSchema.optional(),
  otherMoves: z
    .array(
      z.object({
        kind: z.array(MoveKindSchema),
        axis: z.enum(["x", "y", "z", "r"]),
        startSec: z.number(),
        durationSec: z.number(),
        amount: AxisAmountSchema,
        ease: z.string(),
      }),
    )
    .optional(),
  drift: AxisAmountSchema.partial().optional(),
  shake: z.object({ axis: z.enum(["x", "y", "z", "r"]), swing: z.number() }).optional(),
  /** The fit is probably not a camera ease: element motion, a degenerate curve, a poor fit or a move longer than its shot. ref:corpus leaves it out. */
  suspect: z.boolean().optional(),
  suspectReasons: z.array(z.string()).optional(),
});

/** New drawings per second while things move: limited animation holds each drawing for two or three frames. */
export const CadenceSchema = z.object({
  movingFrames: z.number().int().nonnegative(),
  heldShare: z.number().min(0).max(1).optional(),
  framesPerDrawing: z.number().positive().optional(),
  drawingsPerSecond: z.number().positive().optional(),
  label: z.enum(["on ones", "mixed ones and twos", "on twos", "on threes"]).optional(),
});

export const ReferenceMotionSchema = z.object({
  ...Layer,
  status: UnavailableSchema.optional(),
  method: z.string(),
  shots: z.array(
    z.object({
      shotId: z.string(),
      meanEnergy: Seconds,
      peakEnergy: Seconds,
      peakSec: Seconds.optional(),
      cameraEstimate: z.enum(["static", "pan", "tilt", "zoom", "handheld", "complex", "unknown"]).default("unknown"),
      camera: ShotCameraSchema.optional(),
      cadence: CadenceSchema.optional(),
    }),
  ),
  cadence: CadenceSchema.optional(),
  /** Share of the frame that never changes across cuts (logo, watermark, overlay), left out of camera tracking. */
  staticOverlayShare: z.number().min(0).max(1).optional(),
  /** Motion energy is optical-flow speed in frame widths per second, or frame difference (0-255) for the ffmpeg fallback. */
  energyCurve: z.array(z.object({ timeSec: Seconds, energy: Seconds })).default([]),
  energyCurvePath: z.string().optional(),
});

export const ReferenceSyncSchema = z.object({
  ...Layer,
  status: UnavailableSchema.optional(),
  toleranceSec: z.number().positive(),
  /** Screen text is sampled, then refined to the frame where its box changes most. */
  textToleranceSec: z.number().positive().optional(),
  events: z.array(
    z.object({
      timeSec: Seconds,
      kinds: z.array(z.enum(["cut", "beat", "downbeat", "onset", "speech-start", "text-on", "motion-peak"])).min(1),
    }),
  ),
  metrics: z.object({
    cutsOnBeatRatio: z.number().min(0).max(1).optional(),
    cutsOnOnsetRatio: z.number().min(0).max(1).optional(),
    textOnBeatRatio: z.number().min(0).max(1).optional(),
    /** The ratio random times would reach at this tempo and tolerance. Compare against it. */
    cutsOnBeatChance: z.number().min(0).max(1).optional(),
    cutsOnOnsetChance: z.number().min(0).max(1).optional(),
    textOnBeatChance: z.number().min(0).max(1).optional(),
    cutCount: z.number().int().nonnegative().optional(),
    medianCutToBeatSec: Seconds.optional(),
    // Sync v2: at fast tempi ±80 ms covers much of the timeline, so judge lift and frame-tight anchors.
    /** cutsOnBeatRatio / cutsOnBeatChance: 1 is chance, 2 is twice chance. */
    cutsOnBeatLift: z.number().nonnegative().optional(),
    cutsOnOnsetLift: z.number().nonnegative().optional(),
    /** Half-width of the frame-tight window: one frame. */
    frameToleranceSec: z.number().positive().optional(),
    /** Cuts within ±1 frame of a downbeat; the reference layer has no hit strengths, so downbeats are the strong anchors. */
    cutsOnDownbeatFrameRatio: z.number().min(0).max(1).optional(),
    cutsOnDownbeatFrameChance: z.number().min(0).max(1).optional(),
    cutsOnDownbeatFrameLift: z.number().nonnegative().optional(),
    /** Median of cut minus nearest beat, signed: negative means the picture cuts before the beat. */
    signedMedianCutToBeatSec: z.number().finite().optional(),
  }),
  /** Doubts about the inputs, numbers unchanged: e.g. the beat grid's phase slipping against the loudness pulse. */
  warnings: z.array(z.string()).optional(),
});

// --- Judged layers ---

export const ReferenceStorySchema = z.object({
  ...Layer,
  idea: claim(z.string()),
  audience: claim(z.string()),
  hook: claim(SpanSchema.extend({ device: z.string(), description: z.string() })),
  beats: z.array(
    claim(SpanSchema.extend({ purpose: z.string(), retentionDevice: z.string().optional(), content: z.string() })),
  ),
  payoff: claim(z.string()).optional(),
  callToAction: claim(z.string()).optional(),
  whyItWorks: z.array(z.string()).default([]),
});

export const ReferenceVisualSchema = z.object({
  ...Layer,
  palette: claim(z.array(z.string())),
  typography: claim(z.array(z.object({ role: z.string(), description: z.string() }))),
  composition: claim(z.string()),
  materials: claim(z.string()).optional(),
  lighting: claim(z.string()).optional(),
  styleSummary: z.string(),
});

/**
 * One detector fault. merge: the first id stays, the cuts before the others go. reject: the cuts before these shots go.
 * split: a cut at `timeSec`; `shotIds` names the detector shot it falls in (ref:validate checks it). retype: these shots'
 * transition becomes `transition`. move: the cut before the one shot in `shotIds` (or `shotId`) moves to `toSec`.
 */
export const ShotCorrectionSchema = z
  .object({
    kind: z.enum(["merge", "split", "retype", "reject", "move"]),
    shotIds: z.array(z.string()).min(1).optional(),
    /** Shorthand for `shotIds: [shotId]`, used by `move`. */
    shotId: z.string().optional(),
    timeSec: Seconds.optional(),
    toSec: Seconds.optional(),
    transition: ShotTransitionSchema.optional(),
    note: z.string(),
  })
  .refine((value) => !!value.shotIds?.length || !!value.shotId, {
    message: "A correction names its shots: shotIds, or shotId for a move.",
    path: ["shotIds"],
  })
  .refine((value) => value.kind !== "move" || value.toSec !== undefined, {
    message: "A move gives toSec, the cut's new time.",
    path: ["toSec"],
  })
  .transform(({ shotId, shotIds, ...value }) => ({ ...value, shotIds: shotIds ?? [shotId!] }));

export const ReferenceEditSchema = z.object({
  ...Layer,
  rhythm: claim(z.string()),
  shots: z.array(z.object({ shotId: z.string(), purpose: claim(z.string()), technique: claim(z.string()).optional() })),
  /** `name`: a short kebab-case label (`whip-to-ui`, `hero-word-slam`) so ref:corpus can count a move across references. */
  /** startSec/endSec is the first occurrence; `spans` lists every occurrence when the move recurs. */
  signatureMoves: z
    .array(
      claim(
        SpanSchema.extend({
          name: z.string().optional(),
          description: z.string(),
          why: z.string(),
          spans: z.array(SpanSchema).min(1).optional(),
        }),
      ),
    )
    .default([]),
  /** Detector faults the analyst found by looking. shots.json stays as measured; these say how to read it. */
  corrections: z.array(claim(ShotCorrectionSchema)).default([]),
});

export const ProductionRouteSchema = z.enum([
  "remotion",
  "hyperframes",
  "blender",
  "vork",
  "generated",
  "footage",
  "unreachable",
]);

/** What a technique does for the viewer: ref:corpus indexes techniques by it. */
export const TechniqueFunctionSchema = z.enum(["hook", "reveal", "proof", "transition", "emphasis", "cta", "breath"]);

/** How a technique's typed facts were established, as for a claim: frames looked at, a layer's number, or reasoning. */
const TechniqueEvidence = {
  basis: ClaimBasisSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string()).optional(),
};

export const TechniqueTimingSchema = z.object({
  durationSec: Seconds,
  /** Signed: negative starts before the nearest cut. */
  startOffsetFromCutSec: z.number().finite().optional(),
  onBeat: z.boolean().optional(),
  ...TechniqueEvidence,
});

const CubicBezierSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** One phase of a two-phase move: the exit of the old state, the entry of the new, a hold or a settle. */
export const TechniqueEasePhaseSchema = z.object({
  part: z.enum(["exit", "entry", "hold", "settle", "overshoot", "main"]),
  name: z.string().optional(),
  cubicBezier: CubicBezierSchema.optional(),
  durationSec: Seconds.optional(),
});

export const TechniqueEaseSchema = z.object({
  /** A GSAP or CSS name, e.g. `power3.out`, `expo.inOut`. ref:corpus groups it by family (normaliseEaseName). */
  name: z.string().optional(),
  cubicBezier: CubicBezierSchema.optional(),
  /** motion.json: a fitted camera ease; strip: read from a `motion:strip --diff` frame by frame; inferred: a guess. */
  source: z.enum(["motion.json", "strip", "inferred"]),
  /** A move in phases, each with its own curve: `name` then describes the whole or is left out. */
  phases: z.array(TechniqueEasePhaseSchema).min(1).optional(),
  /** The fitted ease is cut off by a cut before the move settles: its tail is unknown. */
  truncated: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.string()).optional(),
});

export const TechniqueSoundSchema = z.object({
  /** `music-bed`: the music under the move, no hit on it. `dip`: the music breaks or drops out as the accent. `unknown`: no evidence either way. */
  kind: z.enum(["sfx", "music-hit", "voice", "silence", "music-bed", "dip", "unknown"]),
  layers: z.array(z.string()).optional(),
  note: z.string().optional(),
  ...TechniqueEvidence,
  /** How its timing was established (an onset at the move is measured) apart from what made it (usually inferred). */
  timingBasis: ClaimBasisSchema.optional(),
  sourceBasis: ClaimBasisSchema.optional(),
});

export const TechniqueTypographyEntrySchema = z.object({
  role: z.string().optional(),
  /** How the text arrives: `word-by-word slam`, `mask-up 6f`, `typewriter`. */
  entry: z.string().optional(),
  /** `free`: placed by the layout, no shared axis; `split-edges`: pinned to opposite edges. */
  alignment: z.enum(["left", "centre", "right", "free", "split-edges"]).optional(),
  /** Cap or glyph height as a share of the frame height. */
  size: z.number().positive().max(1).optional(),
  ...TechniqueEvidence,
});

/** One text treatment, or one per role (headline, label, caption). */
export const TechniqueTypographySchema = z.union([
  TechniqueTypographyEntrySchema,
  z.array(TechniqueTypographyEntrySchema).min(1),
]);

/** A technique's typography as a list, whichever form it was written in. */
export function typographyEntries(
  typography: z.infer<typeof TechniqueTypographySchema> | undefined,
): z.infer<typeof TechniqueTypographyEntrySchema>[] {
  return typography === undefined ? [] : Array.isArray(typography) ? typography : [typography];
}

/** One occurrence of a technique that recurs: its span, the shots it touches and its own timing. */
export const TechniqueOccurrenceSchema = z.object({
  span: SpanSchema,
  fromShot: z.number().int().nonnegative().optional(),
  toShot: z.number().int().nonnegative().optional(),
  shots: z.array(z.string()).min(1).optional(),
  timing: TechniqueTimingSchema.optional(),
});

/**
 * requiredPrimitives entries: `remotion:<Api>` (Remotion itself), `block:<id>` (a motion library block; `library:` is
 * read the same), `missing:<name>, what it must do`, and a plain name or `repo:<name>` for an export in this repository.
 */
export const PRIMITIVE_PREFIXES = ["remotion", "block", "missing", "repo"] as const;
export type PrimitiveKind = (typeof PRIMITIVE_PREFIXES)[number];

export function primitiveKind(entry: string): { kind: PrimitiveKind; name: string } {
  const match = /^([a-z]+):\s*(.+)$/i.exec(entry.trim());
  const prefix = match?.[1]!.toLowerCase();
  if (!match || !prefix) return { kind: "repo", name: entry.trim() };
  if (prefix === "library") return { kind: "block", name: match[2]!.trim() };
  return (PRIMITIVE_PREFIXES as readonly string[]).includes(prefix)
    ? { kind: prefix as PrimitiveKind, name: match[2]!.trim() }
    : { kind: "repo", name: entry.trim() };
}

export const ReferenceTechniqueSchema = z.object({
  id: z.string(),
  name: z.string(),
  spans: z.array(SpanSchema).min(1),
  description: z.string(),
  route: ProductionRouteSchema,
  routeReason: z.string(),
  difficulty: z.enum(["low", "medium", "high"]),
  requiredPrimitives: z.array(z.string()).default([]),
  techniqueCardId: z.string().optional(),
  // Typed facts, all optional so older files keep parsing. Fill them from strips, motion.json and sync.json.
  function: TechniqueFunctionSchema.optional(),
  timing: TechniqueTimingSchema.optional(),
  ease: TechniqueEaseSchema.optional(),
  sound: TechniqueSoundSchema.optional(),
  typography: TechniqueTypographySchema.optional(),
  /** Stacked visual layers in the move (ground, plate, type, overlay). */
  layers: z.number().int().positive().optional(),
  /** For a transition: the shot indices (0-based, in shots.json order after corrections) it leaves and enters. */
  fromShot: z.number().int().nonnegative().optional(),
  toShot: z.number().int().nonnegative().optional(),
  /** For a move across several shots: their ids (after corrections, e.g. `s004.2`), first to last. */
  shots: z.array(z.string()).min(1).optional(),
  /** Every occurrence when the technique recurs; the single fields above then describe the first or the typical one. */
  occurrences: z.array(TechniqueOccurrenceSchema).min(1).optional(),
});

export const ReferenceTechniquesSchema = z.object({
  ...Layer,
  techniques: z.array(ReferenceTechniqueSchema),
});

/** The transferable recipe: structure and craft of a reference with its content removed. */
export const ReferenceBlueprintSchema = z.object({
  ...Layer,
  format: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  durationSec: z.number().positive(),
  slots: z
    .array(
      z.object({
        id: z.string(),
        role: z.string(),
        startSec: Seconds,
        durationSec: z.number().positive(),
        visualRecipe: z.string(),
        motionRecipe: z.string(),
        soundRecipe: z.string(),
        copySlot: z.object({ purpose: z.string(), maxWords: z.number().int().positive().optional() }).optional(),
        techniqueIds: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  rhythm: z.object({ bpm: z.number().positive().optional(), cutGrid: z.string() }),
  style: z.string(),
  transferRules: z.object({ keep: z.array(z.string()), mustChange: z.array(z.string()) }),
});

export const REFERENCE_LAYERS = {
  "source.json": ReferenceSourceSchema,
  "shots.json": ReferenceShotsSchema,
  "speech-text.json": ReferenceSpeechTextSchema,
  "audio.json": ReferenceAudioSchema,
  "motion.json": ReferenceMotionSchema,
  "sync.json": ReferenceSyncSchema,
  "story.json": ReferenceStorySchema,
  "visual.json": ReferenceVisualSchema,
  "edit.json": ReferenceEditSchema,
  "techniques.json": ReferenceTechniquesSchema,
  "blueprint.json": ReferenceBlueprintSchema,
} as const;

export type ReferenceLayerFile = keyof typeof REFERENCE_LAYERS;
export const MEASURED_REFERENCE_LAYERS: ReferenceLayerFile[] = [
  "source.json",
  "shots.json",
  "speech-text.json",
  "audio.json",
  "motion.json",
  "sync.json",
];
export const JUDGED_REFERENCE_LAYERS: ReferenceLayerFile[] = [
  "story.json",
  "visual.json",
  "edit.json",
  "techniques.json",
  "blueprint.json",
];

// --- Corpus: every analysed reference read together (ref:corpus, design-reference/library/_corpus.json) ---

export const CorpusDistributionSchema = z.object({
  n: z.number().int().nonnegative(),
  min: z.number(),
  p10: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  p90: z.number(),
  max: z.number(),
});

export const CorpusTechniqueEntrySchema = z.object({
  refId: ReferenceIdSchema,
  techniqueId: z.string(),
  name: z.string(),
  spans: z.array(SpanSchema),
  route: ProductionRouteSchema,
  difficulty: z.enum(["low", "medium", "high"]),
  timing: TechniqueTimingSchema.optional(),
  ease: TechniqueEaseSchema.optional(),
  /** The ease's family from normaliseEaseName: linear, in, out, inOut, spring, steps or unknown. */
  easeFamily: z.string().optional(),
  sound: TechniqueSoundSchema.optional(),
});

const CorpusRecurrenceSchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  refs: z.array(ReferenceIdSchema),
});

export const ReferenceCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  libraryRoot: z.string(),
  playbook: z.string().optional(),
  excluded: z.array(z.string()).default([]),
  referenceIds: z.array(ReferenceIdSchema),
  /** What each metric is, its unit and where it is read from. */
  definitions: z.record(z.string(), z.string()),
  /** Across references: one value per reference that has the metric. */
  metrics: z.record(z.string(), CorpusDistributionSchema),
  /** Fitted camera eases in motion.json, by the name to use (GSAP name, CSS bezier or spring), counted over shots. */
  easeNames: z.record(z.string(), z.number().int().nonnegative()),
  /** The same fits and the techniques' eases (each phase counted), grouped by family: `out`, `out:3` (family and strength), `steps`. */
  easeFamilies: z
    .object({
      motion: z.record(z.string(), z.number().int().nonnegative()),
      techniques: z.record(z.string(), z.number().int().nonnegative()),
    })
    .optional(),
  /** Fits left out of easeNames and easeFamilies: across a judged cut the detector missed, or marked suspect. */
  excludedEaseFits: z
    .array(z.object({ refId: ReferenceIdSchema, shotId: z.string(), ease: z.string(), reason: z.string() }))
    .optional(),
  techniques: z.object({
    count: z.number().int().nonnegative(),
    byFunction: z.record(z.string(), z.array(CorpusTechniqueEntrySchema)),
  }),
  gaps: z.object({
    /** `missing:` primitives by name (the text before the first comma), most references first. */
    missingPrimitives: z.array(CorpusRecurrenceSchema),
    /** Named signature moves in edit.json seen in more than one reference first. */
    signatureMoves: z.array(CorpusRecurrenceSchema),
    unnamedSignatureMoves: z.number().int().nonnegative(),
    /** Technique names, normalised, seen in more than one reference. */
    techniqueNames: z.array(CorpusRecurrenceSchema),
  }),
  /** Private references in this corpus (source.json `private`, or ignored in .git/info/exclude): never name them in a tracked file; cite "a private reference". */
  privateReferenceIds: z.array(ReferenceIdSchema).optional(),
  references: z.array(
    z.object({
      id: ReferenceIdSchema,
      private: z.boolean().optional(),
      playbooks: z.array(z.string()).optional(),
      durationSec: z.number().optional(),
      cutsFrom: z.enum(["judged", "detector"]).optional(),
      present: z.array(z.string()),
      missing: z.array(z.string()),
      invalid: z.array(z.object({ file: z.string(), issue: z.string() })),
      unavailable: z.array(z.string()),
      metrics: z.record(z.string(), z.number()),
    }),
  ),
  warnings: z.array(z.string()).default([]),
});

export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>;
export type ReferenceCrop = z.infer<typeof ReferenceCropSchema>;
export type ShotCamera = z.infer<typeof ShotCameraSchema>;
export type ShotColour = z.infer<typeof ShotColourSchema>;
export type Cadence = z.infer<typeof CadenceSchema>;
export type ReferenceShots = z.infer<typeof ReferenceShotsSchema>;
export type ReferenceSpeechText = z.infer<typeof ReferenceSpeechTextSchema>;
export type ReferenceAudio = z.infer<typeof ReferenceAudioSchema>;
export type ReferenceMotion = z.infer<typeof ReferenceMotionSchema>;
export type ReferenceSync = z.infer<typeof ReferenceSyncSchema>;
export type ReferenceStory = z.infer<typeof ReferenceStorySchema>;
export type ReferenceVisual = z.infer<typeof ReferenceVisualSchema>;
export type ReferenceEdit = z.infer<typeof ReferenceEditSchema>;
export type ReferenceTechniques = z.infer<typeof ReferenceTechniquesSchema>;
export type ReferenceTechnique = z.infer<typeof ReferenceTechniqueSchema>;
export type TechniqueFunction = z.infer<typeof TechniqueFunctionSchema>;
export type ReferenceBlueprint = z.infer<typeof ReferenceBlueprintSchema>;
export type ReferenceCorpus = z.infer<typeof ReferenceCorpusSchema>;
export type CorpusDistribution = z.infer<typeof CorpusDistributionSchema>;
