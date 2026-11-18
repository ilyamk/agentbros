import { z } from "zod";

// Per-frame curves from an audio map, for audio-reactive motion. Pure (no Node imports): scenes import it.

/** Levels follow the sound with attack/release; envelopes peak at a hit and halve every half-life; phases run 0..1. */
export const LEVEL_CURVES = ["level", "low", "mid", "high", "energy"] as const;
export const STEM_CURVES = ["drums", "bass", "other", "vocals"] as const;
export const ENVELOPE_CURVES = ["kick", "snare", "hat", "downbeat"] as const;
export const PHASE_CURVES = ["beatPhase", "barPhase"] as const;
export const AUDIO_CURVE_NAMES = [...LEVEL_CURVES, ...STEM_CURVES, ...ENVELOPE_CURVES, ...PHASE_CURVES] as const;
export type AudioCurveName = (typeof AUDIO_CURVE_NAMES)[number];

export const AudioCurvesSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("audio-curves"),
  fps: z.number().positive(),
  /** Every curve has this many values, one per film frame from frame 0. */
  frameCount: z.number().int().nonnegative(),
  /** Seconds of the track at the film's first frame. */
  offsetSec: z.number().nonnegative(),
  source: z.object({ map: z.string(), input: z.string().optional(), stemsDir: z.string().optional() }),
  grid: z.object({
    trust: z.enum(["reliable", "weak", "none"]),
    bpm: z.number().positive().optional(),
    /** Beat and downbeat positions in film frames (fractional); empty when trust is "none". */
    beats: z.array(z.number()),
    downbeats: z.array(z.number()),
  }),
  params: z.object({
    attackMs: z.number().nonnegative(),
    releaseMs: z.number().nonnegative(),
    halfLifeMs: z.number().positive(),
    energyWindowMs: z.number().positive(),
  }),
  /** Values 0..1 per frame. Absent curves were not measurable: "mid" needs --input, stems need a map made with --stems, phases a grid. */
  curves: z.partialRecord(z.enum(AUDIO_CURVE_NAMES), z.array(z.number().min(0).max(1))),
});

export type AudioCurves = z.infer<typeof AudioCurvesSchema>;
