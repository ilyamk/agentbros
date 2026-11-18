import { getLength, getPointAtLength, getTangentAtLength } from "@remotion/paths";
import { Easing } from "remotion";
import { z } from "zod";

/** Schema, pure plan and geometry of kinetic-line-draw, free of GSAP so node tests and tools can import them. */

const strokeSchema = z.object({
  /** SVG path data in the `viewBox` space. */
  d: z.string(),
  /** Draw it in the accent colour and give it the hero beat. */
  accent: z.boolean(),
});

const brushSchema = z.object({
  /** Widest point of the brush, in `viewBox` units. */
  width: z.number().positive(),
  /** How much the stroke thins towards its end, 0 (even) to 0.9. */
  taper: z.number().min(0).max(0.9),
  /** Scale of the drawing on its first frame; it settles to 1 on expo.out over one `draw` (muse: 0.35 to 0.14 of the height, 2.5). */
  entryScale: z.number().min(1).max(4),
  /** Blur in pixels on the first frames, gone after about 5 frames (muse: motion-blurred on entry). */
  entryBlur: z.number().min(0).max(40),
  /**
   * Seconds the entry scale takes to settle on expo.out. Absent: one `draw`. muse's brush stays large far longer than
   * its draw: about 1.5 s (`brushSettleShare`, `BRUSH_SETTLE_MUSE`).
   */
  settle: z.number().positive().max(4).optional(),
});

/**
 * muse t18 (F958-F1010), the brush's height over its rest height, measured frame by frame (blue extent): 3.3, 2.65 after
 * 3 frames, 1.95 after 6, 1.62 after 9, 1.41 after 12, 1.18 after 21, 1.07 after 31: what is left of the entry scale
 * decays by about e^(-0.14 f), so it still shows 18% of its excess at 12 frames, where a 13-frame expo.out has settled.
 * expo.out leaves 2^(-10 t) of it, which matches over about 1.5 s (45 frames).
 */
export const BRUSH_SETTLE_MUSE = 1.5;

/** Share of the entry scale's excess left `seconds` after the draw starts, on expo.out over `settle` seconds. Pure. */
export const brushSettleShare = (seconds: number, settle: number): number => {
  if (seconds <= 0) return 1;
  if (seconds >= settle) return 0;
  return 2 ** (-10 * (seconds / settle));
};

const followerSchema = z.object({
  /** Length of the pen in `viewBox` units; its tip sits on the drawing point. */
  size: z.number().positive(),
  /** The pen's angle in degrees, held while it writes (a hand does not turn the pen with the stroke). */
  angle: z.number(),
  colour: z.string(),
});

export const lineDrawSchema = z.object({
  /** Strokes in drawing order. */
  strokes: z.array(strokeSchema).min(1),
  viewBox: z.tuple([z.number().positive(), z.number().positive()]),
  /** Dot that pops where the last accent stroke ends; null for none. */
  dot: z.tuple([z.number(), z.number()]).nullable(),
  /** Line that rises under the drawing; empty for none. */
  caption: z.string(),
  color: z.string(),
  accent: z.string(),
  background: z.string(),
  /** Stroke width in `viewBox` units. */
  strokeWidth: z.number().positive(),
  at: z.number().nonnegative(),
  /** Seconds between strokes starting. */
  stagger: z.number().nonnegative(),
  /** Seconds one stroke takes to draw. */
  draw: z.number().positive(),
  /** A variable-width brush instead of an even line: each stroke is a filled outline revealed along its centre line. */
  brush: brushSchema.nullable().optional(),
  /** A pen that rides the tip of the stroke being drawn (paper-style's quill), then lifts off after the last one. */
  follower: followerSchema.nullable().optional(),
});

export type LineDrawProps = z.infer<typeof lineDrawSchema>;
export type BrushOptions = z.infer<typeof brushSchema>;

export const lineDrawPlan = (props: LineDrawProps) => {
  const start = props.at / 30;
  const starts = props.strokes.map((_, index) => start + index * props.stagger);
  const heroIndex = props.strokes.map((stroke) => stroke.accent).lastIndexOf(true);
  const hero = heroIndex >= 0 ? starts[heroIndex] + props.draw : -1;
  const drawn = Math.max(...starts) + props.draw;
  return { start, starts, hero, drawn, caption: drawn - 0.2 };
};

/** The stroke ease, the same curve as the `kinetic.inOut` CustomEase the timeline uses ("M0,0 C0.7,0 0.12,1 1,1"). */
export const strokeEase = Easing.bezier(0.7, 0, 0.12, 1);

/** Width of a brush at share s (0..1) of its length: a quick swell from a 30% touch-down, then thinning by `taper`. Pure. */
export const brushWidth = (s: number, width: number, taper: number): number => {
  const x = Math.min(Math.max(s, 0), 1);
  return width * Math.min(1, 0.3 + x / 0.06) * (1 - taper * x);
};

/**
 * A filled outline around the centre line `d`: points on both sides at half the brush width along the normal, joined
 * into one closed path with round-ish ends. Pure (sampled with @remotion/paths).
 */
export const brushOutline = (d: string, width: number, taper: number, samples = 160): string => {
  const length = getLength(d);
  if (!(length > 0)) return "";
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const at = Math.min(length * s, length - 1e-6);
    const p = getPointAtLength(d, at);
    const t = getTangentAtLength(d, at);
    if (!p || !t) continue;
    const half = brushWidth(s, width, taper) / 2;
    left.push(`${(p.x - t.y * half).toFixed(2)},${(p.y + t.x * half).toFixed(2)}`);
    right.push(`${(p.x + t.y * half).toFixed(2)},${(p.y - t.x * half).toFixed(2)}`);
  }
  return `M${left.join(" L")} L${right.reverse().join(" L")} Z`;
};

/**
 * Where the pen sits at a time (seconds from the block's start): on the tip of the most recently started stroke still
 * drawing, held at a finished stroke's end until the next one starts, and lifted (null) before the first and a beat
 * after the last. The tip follows the same ease the timeline gives DrawSVG, so the pen never leaves the line. Pure.
 */
export const penTip = (
  props: Pick<LineDrawProps, "strokes" | "at" | "stagger" | "draw">,
  seconds: number,
): { x: number; y: number; stroke: number } | null => {
  const plan = lineDrawPlan(props as LineDrawProps);
  if (seconds < plan.start || seconds > plan.drawn + 0.25) return null;
  let index = 0;
  for (let i = 0; i < props.strokes.length; i++) if (plan.starts[i]! <= seconds) index = i;
  const progress = strokeEase(Math.min(Math.max((seconds - plan.starts[index]!) / props.draw, 0), 1));
  const d = props.strokes[index]!.d;
  const point = getPointAtLength(d, getLength(d) * progress);
  if (!point) return null;
  return { x: point.x, y: point.y, stroke: index };
};

/**
 * muse's monogram: a fat accent brush writes a cursive mark in two strokes while the drawing settles from 3x to size
 * on expo.out over about 1.5 s (still about 1.4x after 12 frames, as muse), blurred on entry; then it holds, centred, with no fade.
 */
export const brushMonogramPreset: LineDrawProps = {
  strokes: [
    {
      d: "M60,250 C70,170 110,90 150,90 C190,90 160,220 140,260 C170,170 210,110 245,120 C280,130 240,230 230,260",
      accent: true,
    },
    { d: "M230,260 C260,180 300,120 335,130 C370,140 330,240 340,262 C350,280 390,250 420,215", accent: true },
  ],
  viewBox: [480, 340],
  dot: null,
  caption: "",
  color: "#111111",
  accent: "#2F6BFF",
  background: "#F4F3EF",
  strokeWidth: 5,
  at: 6,
  stagger: 0.22,
  draw: 0.43,
  brush: { width: 34, taper: 0.55, entryScale: 3, entryBlur: 10, settle: BRUSH_SETTLE_MUSE },
};

/** paper-style's quill: a script line written in stroke order behind a pen, then a red circle drawn round it. */
export const penWritePreset: LineDrawProps = {
  strokes: [
    {
      d: "M40,150 C60,80 90,70 95,120 C100,170 70,170 80,130 C95,90 130,90 135,140 C138,170 150,170 165,140",
      accent: false,
    },
    {
      d: "M165,140 C175,100 200,95 205,135 C208,165 225,165 240,130 C250,105 270,105 272,135 C274,165 300,160 315,125",
      accent: false,
    },
    { d: "M315,125 C330,85 360,90 360,130 C360,165 395,160 410,120", accent: false },
    { d: "M30,120 C40,40 300,20 420,70 C470,100 450,190 300,205 C180,215 40,200 30,120", accent: true },
  ],
  viewBox: [480, 240],
  dot: null,
  caption: "",
  color: "#1C1A17",
  accent: "#D23B2A",
  background: "#F1EBDD",
  strokeWidth: 4,
  at: 6,
  stagger: 0.32,
  draw: 0.34,
  follower: { size: 120, angle: 35, colour: "#1C1A17" },
};
