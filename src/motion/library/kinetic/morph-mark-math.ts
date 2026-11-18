import { random } from "remotion";
import { z } from "zod";

/** Schema and pure plans of kinetic-morph-mark, free of GSAP so node tests and tools can import them. */

export const MORPH_MARK_WORDMARK_REVEALS = ["slide", "travel"] as const;

export const travelGlitchSchema = z.object({
  /** Colour copies of the mark, first to arrive first; each sits further right the earlier it came. */
  inks: z.array(z.string()).min(1).max(4),
  /** Largest offset of the first copy, as a share of the mark's size (foren about 0.25: the green copy trails the mark by about a quarter of its width at F146). */
  offset: z.number().min(0).max(0.5),
  seed: z.string(),
});
export type TravelGlitch = z.infer<typeof travelGlitchSchema>;

export const morphMarkSchema = z.object({
  /** SVG path data in a 200 × 200 box, morphed in order; the last is the mark that stays. */
  shapes: z.array(z.string()).min(2),
  /** Text that slides out beside (or under) the mark once it locks; empty for none. */
  wordmark: z.string(),
  color: z.string(),
  /** Fill of the final mark. */
  accent: z.string(),
  background: z.string(),
  at: z.number().nonnegative(),
  /** Seconds each morph takes. */
  morph: z.number().positive(),
  /** Seconds each intermediate shape holds. */
  hold: z.number().nonnegative(),
  /** Whole turns the mark makes across the morphs; it always lands upright. */
  turns: z.number(),
  /**
   * How the wordmark arrives. `slide` (default): the morph chain, then the word slides out from behind the mark.
   * `travel` (foren): a dot grows into an accent disc, the last shape wipes in inside it in stepped slices, then the
   * disc travels right revealing the word behind it and shrinks into the word's full stop. `travel` uses only the last
   * shape, and `morph`, `hold` and `turns` do not apply.
   */
  wordmarkReveal: z.enum(MORPH_MARK_WORDMARK_REVEALS).optional(),
  /**
   * `travel` only: colour-glitch the mark while it slices in (foren 4.63-5.03 s): the slices reveal left to right, and
   * seeded colour copies of the mark (green, lime, pink in foren) sit offset to its right and close in until the clean
   * mark lands at the end of the slices (`travelGlitchState`). Absent: clean slices, top to bottom, as before.
   */
  travelGlitch: travelGlitchSchema.optional(),
  /**
   * `travel` only: the disc's diameter as a share of the frame width (or of the safe width in vertical). Absent: 0.22.
   */
  discShare: z.number().min(0.04).max(0.6).optional(),
});

export type MorphMarkProps = z.infer<typeof morphMarkSchema>;

export const morphMarkPlan = (props: MorphMarkProps) => {
  const start = props.at / 30;
  const pop = 0.45;
  const morphs = props.shapes.slice(1).map((_, index) => start + pop + index * (props.morph + props.hold));
  const locked = (morphs.at(-1) ?? start + pop) + props.morph;
  return { start, morphs, locked, wordmark: locked - 0.05 };
};

/**
 * foren's beats in frames: the mark starts slicing in 6 frames after the dot, slices over 12 and holds 6, the disc
 * travels 7, then resolves 10. The disc itself keeps growing under the slices (`TRAVEL_DISC_GROW`).
 */
export const TRAVEL_FRAMES = { grow: 6, slices: 12, hold: 6, travel: 7, resolve: 10 } as const;
/**
 * foren 4.43-5.03 s, measured frame by frame (F133-F151): the disc's diameter grows from a dot to 0.266 of the frame
 * width over 18 frames on about power2.out (0.135 W after 4 frames, 0.22 W after 9), then holds. The 13% in the first
 * notes was an early frame of that growth; the earlier 0.22 was its middle.
 */
export const TRAVEL_DISC_GROW = 18;
export const TRAVEL_DISC_SHARE = 0.266;
/** foren's colour copies of the mark as it slices in, first to last: green, lime, pink (sampled F141-F150). */
export const TRAVEL_GLITCH_FOREN: TravelGlitch = {
  inks: ["#A9E49C", "#DCF66C", "#F4BCEF"],
  offset: 0.25,
  seed: "foren",
};
/** The mark wipes in as this many stepped slices, top to bottom (no tween between them). */
export const TRAVEL_SLICES = 4;
/** Share of the way from the centre to the full stop that the disc covers while travelling; the resolve covers the rest. */
export const TRAVEL_REACH = 0.7;

/** Frame of each beat, from the block's `at`. */
export const travelPlan = (at: number) => {
  const grow = at;
  const slices = grow + TRAVEL_FRAMES.grow;
  const hold = slices + TRAVEL_FRAMES.slices;
  const travel = hold + TRAVEL_FRAMES.hold;
  const resolve = travel + TRAVEL_FRAMES.travel;
  const done = resolve + TRAVEL_FRAMES.resolve;
  return { grow, slices, hold, travel, resolve, done };
};

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);
/** power3.out in GSAP's naming: a quartic ease-out. */
export const power3Out = (t: number) => 1 - (1 - clamp01(t)) ** 4;
/** power2.out in GSAP's naming: a cubic ease-out. */
export const power2Out = (t: number) => 1 - (1 - clamp01(t)) ** 3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Layout of the travel reveal, in pixels: the word's left edge and width, the stage centre, the disc and stop radii and the stop's centre. */
export type TravelLayout = {
  cx: number;
  cy: number;
  textLeft: number;
  textWidth: number;
  discR: number;
  stopR: number;
  stopX: number;
  stopY: number;
};

/**
 * Lay the word and its full stop out centred on (cx, cy): the stop sits `gap` after the word, its centre `stopDrop`
 * below the centre line (on the baseline). Pure.
 */
export const travelLayout = (
  cx: number,
  cy: number,
  textWidth: number,
  fontSize: number,
  discR: number,
): TravelLayout => {
  const stopR = fontSize * 0.1;
  const gap = fontSize * 0.05;
  const total = textWidth + gap + stopR * 2;
  const textLeft = cx - total / 2;
  return {
    cx,
    cy,
    textLeft,
    textWidth,
    discR,
    stopR,
    stopX: textLeft + textWidth + gap + stopR,
    stopY: cy + fontSize * 0.36 - stopR,
  };
};

/**
 * State of the travel reveal at a frame. The disc grows from nothing on power2.out over `TRAVEL_DISC_GROW`; `slices` is how many of the mark's
 * slices show (stepped); the mark goes on the first travel frame. The disc then covers `TRAVEL_REACH` of the way to the
 * stop and resolves into it, shrinking, on power3.out; `clipRight` is the word's revealed right edge, which wipes from
 * the word's left edge to the disc's left edge over the travel and follows the disc after it. Pure.
 */
export const travelState = (frame: number, at: number, layout: TravelLayout) => {
  const plan = travelPlan(at);
  const { cx, cy, discR, stopR, stopX, stopY, textLeft, textWidth } = layout;
  const grown = frame < plan.grow ? 0 : power2Out((frame - plan.grow) / TRAVEL_DISC_GROW);
  const slices =
    frame < plan.slices
      ? 0
      : Math.min(TRAVEL_SLICES, Math.floor(((frame - plan.slices) / TRAVEL_FRAMES.slices) * TRAVEL_SLICES) + 1);
  const travelled = power3Out((frame - plan.travel) / TRAVEL_FRAMES.travel);
  const resolved = power3Out((frame - plan.resolve) / TRAVEL_FRAMES.resolve);
  const midX = lerp(cx, stopX, TRAVEL_REACH);
  const x = frame < plan.resolve ? lerp(cx, midX, travelled) : lerp(midX, stopX, resolved);
  const y = lerp(cy, stopY, resolved);
  const r = frame < plan.travel ? discR * grown : lerp(discR, stopR, resolved);
  const discLeft = x - r;
  const front = frame < plan.travel ? textLeft : frame < plan.resolve ? lerp(textLeft, discLeft, travelled) : discLeft;
  const clipRight =
    frame >= plan.done ? textLeft + textWidth : Math.min(Math.max(front, textLeft), textLeft + textWidth);
  return { x, y, r, slices, markOn: frame >= plan.slices && frame < plan.travel, clipRight, done: frame >= plan.done };
};

/** Share of the slice phase at which the clean mark (and the last colour copy) comes in: foren's black reads from about F147-F148 of F139-F150, its fringes until F150. */
export const TRAVEL_GLITCH_CLEAN_AT = 0.7;

/**
 * The colour glitch over the travel mark's slices at a frame (foren F139-F150): copy `i` of `glitch.inks` appears at
 * `i / (n - 1) * TRAVEL_GLITCH_CLEAN_AT` of the slice phase and sits `dx` to the right of the mark, a share of the
 * mark's size: `offset * (n - i) / n`, shrinking as the square root of what is left of the phase (fringes linger to its last frame) and jittered per frame by the seed (0.65-1).
 * `clean` is whether the clean mark shows; after the slices only it does. Pure: same frame and seed, same offsets.
 */
export const travelGlitchState = (
  frame: number,
  at: number,
  glitch: TravelGlitch,
): { copies: { ink: string; dx: number }[]; clean: boolean } => {
  const plan = travelPlan(at);
  if (frame < plan.slices) return { copies: [], clean: false };
  if (frame >= plan.hold) return { copies: [], clean: true };
  const p = (frame - plan.slices) / TRAVEL_FRAMES.slices;
  const n = glitch.inks.length;
  const envelope = Math.sqrt(1 - p);
  const copies = glitch.inks.flatMap((ink, i) => {
    const from = n === 1 ? 0 : (i / (n - 1)) * TRAVEL_GLITCH_CLEAN_AT;
    if (p < from) return [];
    const jitter = 0.65 + 0.35 * random(`${glitch.seed}-${i}-${frame}`);
    return [{ ink, dx: glitch.offset * ((n - i) / n) * envelope * jitter }];
  });
  return { copies, clean: p >= TRAVEL_GLITCH_CLEAN_AT };
};
