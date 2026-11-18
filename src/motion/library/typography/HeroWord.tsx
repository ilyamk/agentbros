import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Shutter } from "../../fx";
import { arcGlyphs, mixHex, typeProgress } from "../../text-modes";
import { splitGraphemes } from "../../text-split";
import { curves, progress, track, type Keyframe } from "../../timing";
import { audioReactSchema, pulse, useAudioReact } from "../../sync/curves";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { ARRIVE, EXIT, STATE, Stage, resolveInk, useSafeArea } from "./Stage";

const CURVE_NAMES = ["linear", "expoOut", "expoIn", "inOut", "drift", "quadIn"] as const;

/** A keyframe of a hero move: `curve` eases the segment that ends on this key. */
export const heroKeySchema = z.object({ at: z.number(), value: z.number(), curve: z.enum(CURVE_NAMES).optional() });
export type HeroKey = z.infer<typeof heroKeySchema>;

const toKeys = (keys: readonly HeroKey[]): Keyframe[] =>
  keys.map((key) => ({ at: key.at, value: key.value, curve: curves[key.curve ?? "linear"] }));

/** Scale and vertical offset (share of the height) of a hero at a frame, from its keyframes and an optional drift. */
export const heroMove = (
  frame: number,
  p: {
    at: number;
    scaleKeys?: readonly HeroKey[];
    yKeys?: readonly HeroKey[];
    driftFrom?: number;
    driftFrames?: number;
  },
) => {
  const scale = p.scaleKeys?.length ? track(frame, toKeys(p.scaleKeys)) : 1;
  const y = p.yKeys?.length
    ? track(frame, toKeys(p.yKeys))
    : p.driftFrom
      ? p.driftFrom * (1 - progress(frame, p.at, p.driftFrames ?? 12, "expoOut"))
      : 0;
  return { scale, y };
};

export const heroWordSchema = z.object({
  /** One word, number or short phrase: "80%", "CODE.", "Is live". */
  text: z.string(),
  /** Optional line that joins the hero beside it (below on vertical): "cheaper than Clay". Empty for none. */
  caption: z.string(),
  face: z.enum(FACE_NAMES),
  /** Share of the safe width the hero fills, 0.5–0.95. With a caption, the hero and caption together. */
  width: z.number().min(0.3).max(1),
  /** Ground before the cut; "transparent" when the block sits over the previous shot. */
  groundBefore: z.string(),
  /** Ground from the cut on: the swap is the cut. */
  ground: z.string(),
  /** Hero ink; "auto" picks paper-white or near-black for the ground. */
  ink: z.string(),
  captionInk: z.string(),
  /** Frame of the hard cut: the word is fully on, with no ramp. */
  at: z.number().int().nonnegative(),
  /** Frame the caption arrives and the hero slides over to make room; -1 for none. */
  captionAt: z.number().int(),
  /** Scale the hero lands from on the cut and settles out of in 6 frames; 1 for a dead-still cut. */
  punch: z.number().min(1).max(1.2),
  /** "blur" fades out through blur over 6 frames; "cut" leaves on the frame. */
  exit: z.enum(["cut", "blur"]),
  /** Frame the hero leaves; -1 holds to the end. */
  exitAt: z.number().int(),
  grain: z.number().min(0).max(0.2),
  /** Share of the full frame width the hero fills (up to 0.95), instead of `width` of the safe area; on a vertical frame never past the safe width. */
  frameWidth: z.number().min(0.3).max(0.95).optional(),
  /** Scale keyframes on the hero, e.g. shrink on a beat, settle, re-grow into the next cut. 1 is the fitted size. */
  scaleKeys: z.array(heroKeySchema).optional(),
  /** Vertical offset keyframes as a share of the height (positive is down). Overrides `driftFrom`. */
  yKeys: z.array(heroKeySchema).optional(),
  /** Drift carried across the cut: the hero starts this share of the height below its place and eases up over `driftFrames`. */
  driftFrom: z.number().min(-0.5).max(0.5).optional(),
  driftFrames: z.number().int().min(1).optional(),
  /** Frame windows `[from, to)` with true sub-frame blur (a shutter) on the hero; the ground stays outside the blur. */
  blurWindows: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
  /** Sub-frame samples in the blur windows; 20 hides the steps of a big scale change. */
  blurSamples: z.number().int().min(2).max(40).optional(),
  /** Off unless set: the hero's scale pulses on the music, read from an AudioCurvesProvider above. `curve` defaults to "kick", `amount` (scale, at most 0.03) to 0.02. For a drop or a beat-led opener, not for a hero that should sit still. */
  react: audioReactSchema(0.03).optional(),
  /**
   * "cut" (default): on screen whole on the cut. "arc": the word enters on a baseline curving up at both ends, from
   * `arcFrom` of the height below its place, and the bend eases to straight as it rises, in `arcFrames` (power2.out),
   * its colour going from `arcInkFrom` to the ink (motionfly 6.77 s: y 0.76 to 0.50 in 9 frames, grey to purple).
   */
  entry: z.enum(["cut", "arc"]).optional(),
  /** Whole angle of the arc at the start, in radians. */
  arcBend: z.number().min(0).max(3).optional(),
  arcFrom: z.number().min(0).max(0.5).optional(),
  arcFrames: z.number().int().min(2).max(30).optional(),
  arcInkFrom: z.string().optional(),
});

export type HeroWordProps = z.infer<typeof heroWordSchema>;

/**
 * One word that is the whole shot: it arrives on a hard cut at half to nearly all of the frame width, the ground swaps
 * on the same frame, and nothing else happens. No flash, ring, echo or glow; the size and the cut are the event.
 */
export const HeroWord: React.FC<HeroWordProps> = (props) => {
  const {
    text,
    caption,
    face,
    width,
    groundBefore,
    ground,
    ink,
    captionInk,
    at,
    captionAt,
    punch,
    exit,
    exitAt,
    grain,
    frameWidth,
    blurWindows,
    blurSamples = 20,
  } = props;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const video = useVideoConfig();
  const set = faceStyle(face);
  const caps = face === "condensed" || face === "wide";
  const shown = caps ? text.toUpperCase() : text;
  const hasCaption = caption.trim() !== "" && captionAt >= 0;
  const captionRun = { ...faceRun("grotesk", caption || " "), fontWeight: 600 };
  const widths = useTextWidths([faceRun(face, text), captionRun], 100);
  const arc = props.entry === "arc";
  const glyphs = splitGraphemes(shown);
  const glyphWidths = useTextWidths(arc ? glyphs.map((glyph) => ({ ...faceRun(face, glyph), text: glyph })) : [], 100);
  const before = frame < at;
  const background = before ? groundBefore : ground;
  if (widths === null || glyphWidths === null || before)
    return (
      <Stage background={background} grain={grain}>
        {null}
      </Stage>
    );

  // The caption is set at a fixed share of the hero's size; landscape fits hero, gap and caption on one line.
  const [heroW, captionW] = widths as [number, number];
  // Widths are advance widths; ink overhangs them by a few percent, so the vertical safe width is never filled past SAFE_INK_FIT.
  const target = frameWidth
    ? safe.vertical
      ? Math.min(video.width * frameWidth, safe.width * SAFE_INK_FIT)
      : video.width * frameWidth
    : safe.width * width;
  const capShare = safe.vertical ? 0.26 : 0.34;
  const gapShare = 0.1;
  const across = hasCaption && !safe.vertical ? heroW + 100 * gapShare + captionW * capShare : heroW;
  const cap = frameWidth
    ? safe.vertical
      ? video.height * 0.4
      : video.height * 0.95
    : safe.vertical
      ? safe.height * 0.34
      : safe.height * 0.86;
  let size = Math.min(cap, (target * 100) / Math.max(across, 1));
  if (hasCaption && safe.vertical) size = Math.min(size, (target * 100) / Math.max(captionW * capShare, 1));
  const captionSize = size * capShare;
  const captionPx = (captionW * captionSize) / 100;
  const heroInk = resolveInk(ink, ground);
  const capInk = resolveInk(captionInk, ground);
  const settle = punch > 1 ? 1 + (punch - 1) * (1 - progress(frame, at, 6, ARRIVE)) : 1;
  const leaving = exitAt >= 0 && frame >= exitAt;
  if (leaving && exit === "cut")
    return (
      <Stage background={ground} grain={grain}>
        {null}
      </Stage>
    );
  const out = leaving ? progress(frame, exitAt, 6, EXIT) : 0;
  const join = hasCaption ? progress(frame, captionAt, 12, STATE) : 0;
  const capIn = hasCaption ? progress(frame, captionAt + 3, 6, ARRIVE) : 0;

  const moving = Boolean(props.scaleKeys?.length || props.yKeys?.length || props.driftFrom);
  const Hero: React.FC = () => {
    // Inside a blur window this renders once per sub-frame sample, each with its own fractional frame.
    const f = useCurrentFrame();
    const move = moving ? heroMove(f, props) : { scale: 1, y: 0 };
    const audio = useAudioReact(props.react, ["kick"]);
    const beat = audio ? pulse(audio.value, audio.amount ?? 0.02) : 1;
    const transform = moving
      ? `translateY(${move.y * video.height}px) scale(${settle * move.scale * beat})`
      : `scale(${settle * beat})`;
    const arcFrames = props.arcFrames ?? 9;
    const bending = arc && f < at + arcFrames;
    const t = arc ? typeProgress(f, at, arcFrames, "power2.out") : 1;
    const poses = bending
      ? arcGlyphs(
          glyphWidths.map((w) => (w * size) / 100),
          (props.arcBend ?? 1.2) * (1 - t),
        )
      : [];
    const rise = arc ? (1 - t) * (props.arcFrom ?? 0.26) * video.height : 0;
    const colour = arc && props.arcInkFrom ? mixHex(props.arcInkFrom, heroInk, t) : heroInk;
    return (
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          opacity: 1 - out,
          filter: out > 0 ? `blur(${out * 24}px)` : undefined,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: safe.vertical ? "column" : "row",
            alignItems: safe.vertical ? "center" : "baseline",
            gap: hasCaption ? (safe.vertical ? size * 0.04 : size * gapShare) * join : 0,
          }}
        >
          <div
            style={{
              ...set,
              textTransform: undefined,
              fontSize: size,
              lineHeight: 0.92,
              color: colour,
              whiteSpace: "pre",
              transform: rise ? `translateY(${rise}px) ${transform}` : transform,
              display: bending ? "flex" : undefined,
            }}
          >
            {bending
              ? glyphs.map((glyph, i) => (
                  <span
                    key={i}
                    style={{
                      display: "inline-block",
                      transform: `translate(${poses[i]!.dx}px, ${poses[i]!.dy}px) rotate(${poses[i]!.rotate}deg)`,
                    }}
                  >
                    {glyph}
                  </span>
                ))
              : shown}
          </div>
          {hasCaption ? (
            <div
              style={{
                overflow: "hidden",
                width: safe.vertical ? undefined : captionPx * join,
                height: safe.vertical ? captionSize * 1.25 * join : undefined,
                display: "flex",
                justifyContent: safe.vertical ? "center" : "flex-start",
              }}
            >
              <div
                style={{
                  fontFamily: captionRun.fontFamily,
                  fontWeight: 600,
                  letterSpacing: captionRun.letterSpacing,
                  fontSize: captionSize,
                  lineHeight: 1.1,
                  color: capInk,
                  whiteSpace: "pre",
                  opacity: capIn,
                  filter: capIn < 1 ? `blur(${(1 - capIn) * 8}px)` : undefined,
                }}
              >
                {caption}
              </div>
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    );
  };

  return (
    <Stage background={ground} grain={grain}>
      {blurWindows?.length ? (
        <Shutter
          windows={blurWindows}
          samples={blurSamples}
          shutterAngle={180}
          ground={ground === "transparent" ? undefined : ground}
        >
          <Hero />
        </Shutter>
      ) : (
        <Hero />
      )}
    </Stage>
  );
};

/** Share of the safe width a hero's advance width may take so its ink stays inside the safe zone (WORKFLOW at 1.0 overhung by 8 px). */
export const SAFE_INK_FIT = 0.95;

export const heroWordDefaults: HeroWordProps = {
  text: "80%",
  caption: "fewer retakes",
  face: "grotesk",
  width: SAFE_INK_FIT,
  groundBefore: "#F7F7F4",
  ground: "#EE5A24",
  ink: "#FBF8F3",
  captionInk: "#FBF8F3",
  at: 4,
  captionAt: 40,
  punch: 1,
  exit: "blur",
  exitAt: 96,
  grain: 0.03,
};

/** No caption, a drift in, then shrink on a beat, settle and re-grow under a sub-frame blur. */
export const heroWordShrinkPreset: HeroWordProps = {
  ...heroWordDefaults,
  caption: "",
  ground: "#E94D1C",
  ink: "#FAFAF6",
  captionInk: "#FAFAF6",
  captionAt: -1,
  grain: 0,
  frameWidth: 0.9,
  driftFrom: 0.07,
  driftFrames: 12,
  scaleKeys: [
    { at: 30, value: 1 },
    { at: 38, value: 0.49, curve: "inOut" },
    { at: 50, value: 0.39, curve: "expoOut" },
    { at: 72, value: 0.39 },
    { at: 80, value: 0.48, curve: "expoIn" },
  ],
  blurWindows: [[30, 39]],
  blurSamples: 20,
};

/** A cue where each scale move starts: the first is the whoosh of the shrink, the rest are silent. */
const scaleCues = (keys: readonly HeroKey[] = []): Cue[] =>
  keys
    .slice(1)
    .flatMap((key, i) =>
      key.value === keys[i]!.value
        ? []
        : [
            {
              frame: keys[i]!.at,
              kind: "hit" as const,
              sfx: "none" as const,
              weight: "support" as const,
              label: key.value < keys[i]!.value ? "hero shrinks" : "hero grows",
            },
          ],
    )
    .map((cue, i) => (i === 0 ? { ...cue, sfx: "whoosh" as const } : cue));

/** motionfly's announcement word: on white, rising on an arc that straightens in 9 frames, grey to purple, no caption. */
export const heroWordArcPreset: HeroWordProps = {
  ...heroWordDefaults,
  text: "Introducing",
  caption: "",
  captionAt: -1,
  groundBefore: "#FFFFFF",
  ground: "#FFFFFF",
  ink: "#884295",
  captionInk: "#884295",
  width: 0.62,
  grain: 0,
  entry: "arc",
  arcBend: 1.2,
  arcFrom: 0.26,
  arcFrames: 9,
  arcInkFrom: "#A8A8A8",
};

export const heroWordCues = (props: HeroWordProps): Cue[] => [
  { frame: props.at, kind: "cut", sfx: "impact", weight: "hero", label: "ground swap and hero word" },
  ...scaleCues(props.scaleKeys),
  ...(props.caption.trim() !== "" && props.captionAt >= 0
    ? [
        {
          frame: props.captionAt,
          kind: "reveal" as const,
          sfx: "whoosh" as const,
          weight: "support" as const,
          label: "caption joins",
        },
      ]
    : []),
  ...(props.exitAt >= 0
    ? [{ frame: props.exitAt, kind: "exit" as const, sfx: "none" as const, weight: "support" as const }]
    : []),
];
