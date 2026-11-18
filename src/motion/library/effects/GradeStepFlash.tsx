import React, { useId } from "react";
import { AbsoluteFill, Img, random, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import type { Cue } from "../types";
import {
  AIRFORM_ENTER,
  AIRFORM_EXIT,
  GRADE_STEP_PREVIEW,
  GRADES,
  bleachLevel,
  gradeAt,
  gradeChanges,
  gradeSchedule,
  matteRoute,
  sliceOffsets,
  waveOffsets,
  type Grade,
  type GradeSpan,
} from "./flash-plan";
import { DuotoneFilter, Halftone } from "./HalftoneImage";
import { ProcPlate } from "./plates";

/** RGB split of `dx` px: red right, blue left, green in place. Use as `filter: url(#id)`. */
export const FringeFilter: React.FC<{ id: string; dx: number }> = ({ id, dx }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-5%" y="0" width="110%" height="100%" colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx={dx} result="ro" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feOffset in="b" dx={-dx} result="bo" />
      <feComposite in="ro" in2="g" operator="arithmetic" k2={1} k3={1} result="rg" />
      <feComposite in="rg" in2="bo" operator="arithmetic" k2={1} k3={1} />
    </filter>
  </svg>
);

export type GradeLook = {
  /** Two tokens of the duotone step: shadows, highlights. */
  duotone: [string, string];
  /** Ground and dot colour of the "ground" step (a ground blink: flat ground, the subject re-rendered as light dots). */
  ground: string;
  groundInk: string;
  /** Dot cell (px at 1080) of the halftone and ground steps. */
  dotSize: number;
};

/** Per-step look of the later grades (bleach, wave, darken, matte, colour): the span's own colours and the frame inside it. */
export type GradeStepLook = Pick<GradeSpan, "ground" | "ink" | "content" | "src" | "matteSrc"> & {
  local?: number;
  frames?: number;
};

/**
 * One whole-frame grade on its children: none, mono (grey, a little contrast), negative (inverted), polarity (luminance
 * flipped, hues kept), duotone (two tokens), halftone (dot screen in the duotone tokens), ground (flat ground, light
 * dots), bleach (white decaying over the step), wave (sine displacement in bands), darken (subject dark on black),
 * matte (a supplied subject matte tinted; `darken` without one) or colour (any ground and ink, with or without the
 * plate). `fringe` px adds an RGB split.
 */
export const GradeLayer: React.FC<
  GradeLook & { grade: Grade; fringe?: number; step?: GradeStepLook; children: React.ReactNode }
> = ({ grade: asked, fringe = 0, duotone, ground, groundInk, dotSize, step = {}, children }) => {
  const id = useId().replaceAll(":", "");
  const { width } = useVideoConfig();
  const duoId = `duo-${id}`;
  const fringeId = `fringe-${id}`;
  const route = asked === "matte" ? matteRoute(step) : null;
  const grade: Grade = route === "darken" ? "darken" : asked;
  const local = step.local ?? 0;
  const colourGround = step.ground ?? "#000000";
  const colourInk = step.ink ?? "#FFFFFF";
  const css: Record<Grade, string> = {
    none: "",
    mono: "grayscale(1) contrast(1.25)",
    negative: "invert(1)",
    polarity: "invert(1) hue-rotate(180deg)",
    duotone: `url(#${duoId})`,
    halftone: "",
    ground: "",
    bleach: "",
    wave: "",
    darken: "brightness(0.3) contrast(1.35) saturate(0.6)",
    matte: "",
    colour: step.content ? `url(#${duoId})` : "",
  };
  let body: React.ReactNode = children;
  if (grade === "colour" && !step.content) body = <AbsoluteFill style={{ backgroundColor: colourGround }} />;
  if (route === "artwork" && step.src) {
    body = (
      <AbsoluteFill style={{ backgroundColor: step.ground ?? "#04080D" }}>
        <Img
          src={staticFile(step.src)}
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: `url(#${duoId})` }}
        />
      </AbsoluteFill>
    );
  }
  if (route === "cutout" && step.matteSrc) {
    // The plate masked by its subject's alpha cut-out, shown as a tinted negative. The hidden <Img> holds the render
    // until the cut-out has loaded, so the CSS mask never paints empty.
    const mask = `url("${staticFile(step.matteSrc)}")`;
    body = (
      <AbsoluteFill style={{ backgroundColor: step.ground ?? "#04080D" }}>
        <Img src={staticFile(step.matteSrc)} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
        <AbsoluteFill
          style={{
            maskImage: mask,
            WebkitMaskImage: mask,
            maskSize: "cover",
            WebkitMaskSize: "cover",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
          }}
        >
          <AbsoluteFill style={{ filter: `grayscale(1) invert(1) url(#${duoId})` }}>{children}</AbsoluteFill>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }
  if (grade === "bleach") {
    body = (
      <>
        {children}
        <AbsoluteFill style={{ backgroundColor: "#FFFFFF", opacity: bleachLevel(local, step.frames ?? 3) }} />
      </>
    );
  }
  if (grade === "wave") {
    const offsets = waveOffsets(local);
    body = (
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {offsets.map((offset, band) => (
          <AbsoluteFill
            key={band}
            style={{
              clipPath: `inset(${(band / offsets.length) * 100}% 0 ${(1 - (band + 1) / offsets.length) * 100}% 0)`,
              transform: `translateX(${offset * width}px)`,
            }}
          >
            {children}
          </AbsoluteFill>
        ))}
      </AbsoluteFill>
    );
  }
  if (grade === "halftone" || grade === "ground") {
    body = (
      <Halftone
        dotSize={dotSize}
        angle={45}
        push={0}
        ink={grade === "ground" ? groundInk : duotone[0]}
        ground={grade === "ground" ? ground : duotone[1]}
        dotsOn={grade === "ground" ? "light" : "dark"}
        gain={1.2}
        resolveAt={-1}
        resolveFrames={1}
      >
        {children}
      </Halftone>
    );
  }
  const filter = [css[grade], fringe > 0 ? `url(#${fringeId})` : ""].filter(Boolean).join(" ");
  return (
    <AbsoluteFill>
      {grade === "duotone" ? <DuotoneFilter id={duoId} dark={duotone[0]} light={duotone[1]} /> : null}
      {grade === "colour" && step.content ? <DuotoneFilter id={duoId} dark={colourGround} light={colourInk} /> : null}
      {grade === "matte" ? (
        <DuotoneFilter id={duoId} dark={step.ground ?? "#04080D"} light={step.ink ?? "#62E6F2"} />
      ) : null}
      {fringe > 0 ? <FringeFilter id={fringeId} dx={fringe} /> : null}
      <AbsoluteFill
        style={{ ...(filter ? { filter } : {}), ...(grade === "darken" ? { backgroundColor: "#030303" } : {}) }}
      >
        {body}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const stepSchema = z.object({
  grade: z.enum(GRADES),
  frames: z.number().int().min(1).max(24),
  fringe: z.boolean(),
  /** `colour` and `matte`: ground colour of the step. */
  ground: z.string().optional(),
  /** `colour` and `matte`: what the light parts of the plate (or the matte) become. */
  ink: z.string().optional(),
  /** `colour`: keep the plate (mapped to ground and ink) or show the flat ground only. */
  content: z.boolean().optional(),
  /** `matte`: a picture inside public/ drawn in place of the plate (white subject on black, e.g. x-ray artwork), tinted. */
  src: z.string().optional(),
  /**
   * `matte`: the plate subject's alpha cut-out inside public/ (PNG at the plate's size, transparent around the subject),
   * masking the plate so the subject shows as a tinted negative. `src` wins when both are set; with neither the step
   * renders `darken`. Make it with `pnpm matte --input <plate> --out <dir>` (free, local; docs/matte.md).
   */
  matteSrc: z.string().optional(),
});

const sliceSchema = z.object({
  /** Frame the slice glitch starts (-1 off); the plate arrives already sliced and resolves. */
  at: z.number().int().min(-1),
  /** Frames to resolve, 1 to 24 (10–12 in the references). */
  frames: z.number().int().min(1).max(24),
  bands: z.number().int().min(2).max(24),
  /** Largest sideways offset as a share of width (0.05–0.3). */
  offset: z.number().min(0).max(0.5),
  /** Frames at the start shown polarity-flipped (black ground to white); 0 none. Each flip costs two of the six changes a second. */
  flipFrames: z.number().int().min(0).max(4),
  /** Frames each offset step holds (no tween between steps). */
  hold: z.number().int().min(1).max(6),
  /** 0: every band keeps its side and shrinks (flash-safe). 1: bands re-roll on every step, the jumping look; check FLASH_RISK. */
  chaos: z.number().min(0).max(1),
  seed: z.string(),
});

export const gradeStepFlashSchema = z.object({
  /** The cut, in this block's frames: exit steps fill the frames before it and the plate is gone from it on (-1 no exit). */
  exitAt: z.number().int().min(-1),
  exit: z.array(stepSchema).max(10),
  /** Frame the plate enters (-1 no enter steps); enter steps run from it. */
  enterAt: z.number().int().min(-1),
  enter: z.array(stepSchema).max(10),
  /** The plate's own grade between the steps. */
  base: z.enum(GRADES),
  duotone: z.tuple([z.string(), z.string()]),
  /** RGB split in px on steps with `fringe`. */
  fringe: z.number().min(0).max(40),
  ground: z.string(),
  groundInk: z.string(),
  dotSize: z.number().min(3).max(60),
  slice: sliceSchema,
});

export type GradeStepFlashProps = z.infer<typeof gradeStepFlashSchema>;
type SliceSettings = GradeStepFlashProps["slice"];

const SLICE_OFF: SliceSettings = {
  at: -1,
  frames: 10,
  bands: 9,
  offset: 0.18,
  flipFrames: 1,
  hold: 2,
  chaos: 0,
  seed: "slice",
};

/** Seeded band edges (shares of height) for a slice glitch, fixed per seed. */
export const sliceBands = (bands: number, seed: string): number[] => {
  const weights = Array.from({ length: bands }, (_, i) => 0.4 + random(`${seed}-h-${i}`));
  const total = weights.reduce((a, b) => a + b, 0);
  const edges = [0];
  for (const w of weights) edges.push(edges[edges.length - 1]! + w / total);
  return edges;
};

/**
 * A held plate that exits or enters through whole-frame grade steps of a few frames each (mono, negative, duotone,
 * polarity, halftone, a ground blink), with an optional slice glitch (seeded horizontal bands jumping sideways,
 * resolving, the first frames polarity-flipped). Wrap one plate; it renders nothing from `exitAt` on. During a slice it
 * renders the children once per band: keep `<Audio>` and `<Video>` with sound outside.
 */
export const GradeStepFlash: React.FC<Partial<GradeStepFlashProps> & { children: React.ReactNode }> = ({
  children,
  exitAt = -1,
  exit = AIRFORM_EXIT.map((s) => ({ ...s, fringe: !!s.fringe })),
  enterAt = -1,
  enter = AIRFORM_ENTER.map((s) => ({ ...s, fringe: !!s.fringe })),
  base = "none",
  duotone = ["#E9E3CC", "#5A1E0E"],
  fringe = 10,
  ground = "#021563",
  groundInk = "#FFB3D9",
  dotSize = 12,
  slice = SLICE_OFF,
}) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  if (exitAt >= 0 && frame >= exitAt) return null;
  const spans = gradeSchedule({ exitAt, exit, enterAt, enter });
  const span = gradeAt(spans, frame);
  const local = frame - slice.at;
  const flipped = slice.at >= 0 && local >= 0 && local < slice.flipFrames;
  const grade: Grade = flipped ? "polarity" : (span?.grade ?? base);
  const look: GradeLook = { duotone, ground, groundInk, dotSize };
  const unit = width / 1080;
  const stepLook: GradeStepLook | undefined =
    span && !flipped
      ? {
          ground: span.ground,
          ink: span.ink,
          content: span.content,
          src: span.src,
          matteSrc: span.matteSrc,
          local: frame - span.from,
          frames: span.to - span.from,
        }
      : undefined;
  const graded = (
    <GradeLayer {...look} grade={grade} fringe={span?.fringe ? fringe * unit : 0} step={stepLook}>
      {children}
    </GradeLayer>
  );
  const offsets = sliceOffsets(frame, slice);
  if (!offsets.some((o) => o !== 0)) return graded;
  const edges = sliceBands(slice.bands, slice.seed);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {offsets.map((offset, band) => (
        <AbsoluteFill
          key={band}
          style={{
            clipPath: `inset(${edges[band]! * 100}% 0 ${(1 - edges[band + 1]!) * 100}% 0)`,
            transform: `translateX(${offset * width}px)`,
          }}
        >
          {graded}
        </AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
};

/** Frames where the picture changes, for the flash budget (tests check the defaults stay within six a second). */
export const gradeStepFlashChanges = ({
  exitAt,
  exit,
  enterAt,
  enter,
}: Pick<GradeStepFlashProps, "exitAt" | "exit" | "enterAt" | "enter">): number[] =>
  gradeChanges(gradeSchedule({ exitAt, exit, enterAt, enter }), exitAt);

/** A tick on each step, the cut as the hero impact, and a tick when the entering plate settles. */
export const gradeStepFlashCues = ({
  exitAt,
  exit,
  enterAt,
  enter,
}: Pick<GradeStepFlashProps, "exitAt" | "exit" | "enterAt" | "enter">): Cue[] => {
  const spans = gradeSchedule({ exitAt, exit, enterAt, enter });
  const cues: Cue[] = spans
    .filter((s) => s.side === "exit")
    .map((s, i) => ({
      frame: s.from,
      kind: i === 0 ? "hit" : "cut",
      sfx: "tick",
      weight: "support",
      label: `grade ${s.grade}`,
    }));
  if (exitAt >= 0) cues.push({ frame: exitAt, kind: "cut", sfx: "impact", weight: "hero", label: "plate cut" });
  return cues.sort((a, b) => a.frame - b.frame);
};

// --- Preview ---

export const GRADE_STEP_FLASH_FRAMES = 132;

export const gradeStepFlashDefaults: GradeStepFlashProps = {
  exitAt: GRADE_STEP_PREVIEW.exitAt,
  exit: AIRFORM_EXIT.map((s) => ({ ...s, fringe: !!s.fringe })),
  enterAt: 0,
  enter: AIRFORM_ENTER.map((s) => ({ ...s, fringe: !!s.fringe })),
  base: "none",
  duotone: ["#E9E3CC", "#5A1E0E"],
  fringe: 10,
  ground: "#021563",
  groundInk: "#FFB3D9",
  dotSize: 12,
  slice: {
    at: GRADE_STEP_PREVIEW.sliceAt,
    frames: GRADE_STEP_PREVIEW.sliceFrames,
    bands: 9,
    offset: 0.2,
    flipFrames: GRADE_STEP_PREVIEW.sliceFlipFrames,
    hold: 2,
    chaos: 0,
    seed: "slice",
  },
};

/** Cues of the preview: the airform exit at `exitAt`, and the sliced entrance at `slice.at`. */
export const gradeStepFlashPreviewCues = (props: GradeStepFlashProps): Cue[] => [
  ...gradeStepFlashCues(props),
  ...(props.slice.at >= 0
    ? [
        {
          frame: props.slice.at,
          kind: "cut" as const,
          sfx: "impact" as const,
          weight: "hero" as const,
          label: "sliced cut",
        },
      ]
    : []),
];

const Caption: React.FC<{ text: string }> = ({ text }) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: width * 0.08,
          top: height * 0.76,
          fontFamily: primaryFont,
          fontWeight: 500,
          fontSize: Math.min(width, height) * 0.034,
          color: "#F4F4F0",
          letterSpacing: "-0.01em",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Preview: a glowing macro plate held, then the measured exit (mono 3, negative 2, cream duotone with fringe 2) and a
 * cut to a lit desk plate entering on one negative frame; at `slice.at` a disc plate arrives sliced and polarity-flipped
 * for one frame, resolving in `slice.frames`. One flash event per second, as the budget allows.
 */
export const GradeStepFlashPreview: React.FC<GradeStepFlashProps> = (props) => {
  const { durationInFrames } = useVideoConfig();
  const second = props.slice.at >= 0 ? props.slice.at : durationInFrames;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Sequence durationInFrames={props.exitAt >= 0 ? props.exitAt : second} layout="none">
        <GradeStepFlash {...props} enterAt={-1} slice={SLICE_OFF}>
          <ProcPlate kind="crescent" seed="a" />
          <Caption text="Out here" />
        </GradeStepFlash>
      </Sequence>
      {props.exitAt >= 0 ? (
        <Sequence from={props.exitAt} durationInFrames={Math.max(1, second - props.exitAt)} layout="none">
          <GradeStepFlash {...props} exitAt={-1} slice={SLICE_OFF}>
            <ProcPlate kind="desk" seed="b" />
          </GradeStepFlash>
        </Sequence>
      ) : null}
      {props.slice.at >= 0 ? (
        <Sequence from={second} layout="none">
          <GradeStepFlash {...props} exitAt={-1} enterAt={-1} slice={{ ...props.slice, at: 0 }}>
            <ProcPlate kind="disc" seed="c" palette={["#F1EEE6", "#8A8578", "#141414"]} />
          </GradeStepFlash>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
