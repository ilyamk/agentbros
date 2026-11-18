import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React, { useId } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { z } from "zod";
import { easeFamily, type EaseFamilyName } from "../../ease-family";
import { DEMO, DemoSceneA, DemoSceneB, TransitionDemo } from "./demo";

/**
 * Noise matte wipe: an organic, soft-edged front (smoke, cloud, ink) crosses the frame. The matte is a field
 * v = (1 - roughness) * gradient + roughness * noise, both in 0..1, where the gradient is 0 at `origin` and 1 at the far
 * edge or corner; a pixel is uncovered once the moving level `c` passes it, over a soft band `feather` wide:
 * alpha = clamp((c - v) / feather). The noise is a seeded SVG feTurbulence inside an inline `<mask>`, so the shape is the
 * same on every render and only the level moves with the frame.
 */

export const NOISE_MATTE_ORIGINS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "left",
  "right",
  "top",
  "bottom",
  "centre",
] as const;
export type NoiseMatteOrigin = (typeof NOISE_MATTE_ORIGINS)[number];

export const NOISE_MATTE_CURVES = [
  "power2.out",
  "power1.inOut",
  "power2.inOut",
  "sine.inOut",
  "power3.out",
  "linear",
  "power1.out",
  "sine.out",
] as const;
export type NoiseMatteCurve = (typeof NOISE_MATTE_CURVES)[number];

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/** The curves the references measured, by GSAP's definitions; power2.out, power1.inOut and sine.inOut are not in easeFamily, so they live here. */
export const noiseMatteEase = (curve: NoiseMatteCurve, t: number): number => {
  const x = clamp01(t);
  if (curve === "linear") return x;
  if (curve === "power2.out") return 1 - (1 - x) ** 3;
  if (curve === "power1.inOut") return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
  if (curve === "sine.inOut") return -(Math.cos(Math.PI * x) - 1) / 2;
  if (curve === "power1.out") return 1 - (1 - x) ** 2;
  if (curve === "sine.out") return Math.sin((Math.PI * x) / 2);
  return easeFamily[curve as EaseFamilyName](x);
};

/**
 * The level that uncovers the field at eased progress e: 0 at e = 0 (nothing uncovered, since v >= 0) and 1 + feather at
 * e = 1 (everything uncovered, since v <= 1). Pure.
 */
export const noiseMatteLevel = (eased: number, feather: number): number => clamp01(eased) * (1 + feather * 1.05);

/** Matte alpha of one pixel with field value v at level c. Pure; the SVG filter computes the same thing per pixel. */
export const noiseMatteAlpha = (v: number, level: number, feather: number): number =>
  clamp01((level - v) / Math.max(feather, 1e-6));

/** The field value of a pixel from its gradient and noise values, both 0..1. Pure. */
export const noiseMatteField = (gradient: number, noise: number, roughness: number): number =>
  (1 - roughness) * clamp01(gradient) + roughness * clamp01(noise);

export type NoiseMattePhases = {
  /** cover mode: share of the seam where the cover is complete. */
  covered: number;
  /** Share of the seam where the scenes swap (the perceived cut). */
  cut: number;
  /** cover mode: share of the seam where the cover starts to part. */
  part: number;
};

/**
 * Where the cover holds and the cut sits. reveal: the cut is where half the field is uncovered on the curve. cover:
 * the cover rises over `1 - hold` / 2 of the seam, holds full for `hold`, and parts over the rest; the scenes swap in the
 * middle of the hold, where no pixel of either shows. Pure.
 */
export const noiseMattePhases = (mode: "reveal" | "cover", hold: number, curve: NoiseMatteCurve): NoiseMattePhases => {
  if (mode === "cover") {
    const h = Math.min(Math.max(hold, 0), 0.6);
    const covered = (1 - h) / 2;
    return { covered, cut: covered + h / 2, part: covered + h };
  }
  // Solve curve(t) = 0.5 by bisection: the front has crossed the middle of the field.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (noiseMatteEase(curve, mid) < 0.5) lo = mid;
    else hi = mid;
  }
  const cut = (lo + hi) / 2;
  return { covered: cut, cut, part: cut };
};

/**
 * cover mode: the level of the rising cover (stage "rising", alpha = clamp((level - v) / feather) over the old scene),
 * then full, then of the parting cover (stage "parting", the centre opens first: cover alpha is the complement). The
 * rise runs on the first half of `curve` and the parting on its second half, so an inOut curve is fastest around the
 * full-cover frames, where muse's change is hidden. Pure.
 */
export const noiseMatteCoverLevel = (
  p: number,
  phases: NoiseMattePhases,
  curve: NoiseMatteCurve,
  feather: number,
): { stage: "rising" | "full" | "parting" | "done"; level: number } => {
  const half = noiseMatteEase(curve, 0.5);
  if (p >= 1) return { stage: "done", level: noiseMatteLevel(1, feather) };
  if (p < phases.covered)
    return {
      stage: "rising",
      level: noiseMatteLevel(noiseMatteEase(curve, (p / phases.covered) * 0.5) / Math.max(half, 1e-6), feather),
    };
  if (p < phases.part) return { stage: "full", level: noiseMatteLevel(1, feather) };
  const t = (p - phases.part) / Math.max(1 - phases.part, 1e-6);
  return {
    stage: "parting",
    level: noiseMatteLevel((noiseMatteEase(curve, 0.5 + t * 0.5) - half) / Math.max(1 - half, 1e-6), feather),
  };
};

/** Gradient geometry in frame pixels: a linear gradient for an edge, a radial one for a corner or the centre. Pure. */
export const noiseMatteGradient = (
  origin: NoiseMatteOrigin,
  width: number,
  height: number,
):
  | { kind: "linear"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "radial"; cx: number; cy: number; r: number } => {
  switch (origin) {
    case "left":
      return { kind: "linear", x1: 0, y1: 0, x2: width, y2: 0 };
    case "right":
      return { kind: "linear", x1: width, y1: 0, x2: 0, y2: 0 };
    case "top":
      return { kind: "linear", x1: 0, y1: 0, x2: 0, y2: height };
    case "bottom":
      return { kind: "linear", x1: 0, y1: height, x2: 0, y2: 0 };
    case "centre":
      return { kind: "radial", cx: width / 2, cy: height / 2, r: Math.hypot(width, height) / 2 };
    default: {
      const cx = origin.endsWith("left") ? 0 : width;
      const cy = origin.startsWith("top") ? 0 : height;
      return { kind: "radial", cx, cy, r: Math.hypot(width, height) };
    }
  }
};

type MatteProps = {
  id: string;
  origin: NoiseMatteOrigin;
  level: number;
  feather: number;
  roughness: number;
  seed: number;
  grain: number;
  invert?: boolean;
};

/** One inline SVG `<mask>`: the gradient rect, turbulence added in a filter and thresholded to alpha at `level`. */
const MatteDef: React.FC<MatteProps> = ({ id, origin, level, feather, roughness, seed, grain, invert }) => {
  const { width, height } = useVideoConfig();
  const g = noiseMatteGradient(origin, width, height);
  const f = Math.max(feather, 1e-3);
  // alpha = (level - v) / f, or its complement for a parting cover.
  const slope = invert ? 1 / f : -1 / f;
  const offset = invert ? 1 - level / f : level / f;
  const frequency = 1 / Math.max(grain * Math.min(width, height), 1);
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <defs>
        {g.kind === "linear" ? (
          <linearGradient id={`${id}-g`} gradientUnits="userSpaceOnUse" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
            <stop offset="0" stopColor="#000" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
        ) : (
          <radialGradient id={`${id}-g`} gradientUnits="userSpaceOnUse" cx={g.cx} cy={g.cy} r={g.r}>
            <stop offset="0" stopColor="#000" />
            <stop offset="1" stopColor="#fff" />
          </radialGradient>
        )}
        <filter
          id={`${id}-f`}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={width}
          height={height}
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={3} seed={seed} result="raw" />
          {/* fractalNoise sits around 0.5 with a narrow spread: stretch it to about 0..1 and make it opaque. */}
          <feColorMatrix
            in="raw"
            type="matrix"
            values="2.2 0 0 0 -0.6  2.2 0 0 0 -0.6  2.2 0 0 0 -0.6  0 0 0 0 1"
            result="noise"
          />
          <feComposite
            in="SourceGraphic"
            in2="noise"
            operator="arithmetic"
            k1={0}
            k2={1 - roughness}
            k3={roughness}
            k4={0}
            result="field"
          />
          <feColorMatrix
            in="field"
            type="matrix"
            values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${slope} 0 0 0 ${offset}`}
          />
        </filter>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={width}
          height={height}
          style={{ maskType: "alpha" }}
        >
          <rect x={0} y={0} width={width} height={height} fill={`url(#${id}-g)`} filter={`url(#${id}-f)`} />
        </mask>
      </defs>
    </svg>
  );
};

type NoiseMatteWipeOptions = {
  /** reveal: the next scene opens behind the front. cover: a `cover` colour rises over the old scene, holds, and parts from the centre onto the new one. */
  mode: "reveal" | "cover";
  /** Where the front starts: a corner (ace's smoke), an edge (flex's cloud from the right, muse's cloud from the bottom) or the centre. */
  origin: NoiseMatteOrigin;
  curve: NoiseMatteCurve;
  /** Width of the soft front in field units (0.02 hard, 0.25 smoky). */
  feather: number;
  /** How much the noise bends the front, 0 (a straight or round gradient) to 1 (pure noise). */
  roughness: number;
  /** Size of the noise's largest blobs as a share of the frame's short side. */
  grain: number;
  seed: number;
  /** A coloured band just ahead of the front (flex's chromatic fringe); omit for none. */
  fringe?: string;
  /** Width of the fringe band in field units. */
  fringeWidth: number;
  /** cover mode: the colour of the cover. */
  cover: string;
  /** cover mode: share of the seam the cover holds full (muse: 2-3 frames of about 18). */
  hold: number;
};

const NoiseMatteWipePresentation: React.FC<TransitionPresentationComponentProps<NoiseMatteWipeOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const id = `nm${useId().replaceAll(":", "")}`;
  const { mode, origin, curve, feather, roughness, grain, seed, fringe, fringeWidth, cover, hold } = passedProps;
  const phases = noiseMattePhases(mode, hold, curve);
  if (mode === "cover") {
    if (presentationDirection === "exiting") return p < phases.cut ? <AbsoluteFill>{children}</AbsoluteFill> : null;
    if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
    const { stage, level } = noiseMatteCoverLevel(p, phases, curve, feather);
    const rising = stage === "rising";
    const parting = stage === "parting";
    const showCover = rising || parting;
    return (
      <AbsoluteFill>
        {p >= phases.cut ? <AbsoluteFill>{children}</AbsoluteFill> : null}
        {showCover ? (
          <>
            <MatteDef
              id={id}
              origin={rising ? origin : "centre"}
              level={level}
              feather={feather}
              roughness={roughness}
              seed={seed}
              grain={grain}
              invert={parting}
            />
            <AbsoluteFill
              style={{ backgroundColor: cover, maskImage: `url(#${id})`, WebkitMaskImage: `url(#${id})` }}
            />
          </>
        ) : (
          <AbsoluteFill style={{ backgroundColor: cover }} />
        )}
      </AbsoluteFill>
    );
  }
  if (presentationDirection === "exiting" || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const eased = noiseMatteEase(curve, p);
  const level = noiseMatteLevel(eased, feather + (fringe ? fringeWidth : 0));
  return (
    <AbsoluteFill>
      <MatteDef
        id={id}
        origin={origin}
        level={level}
        feather={feather}
        roughness={roughness}
        seed={seed}
        grain={grain}
      />
      {fringe ? (
        <>
          <MatteDef
            id={`${id}-fr`}
            origin={origin}
            level={level + fringeWidth}
            feather={feather}
            roughness={roughness}
            seed={seed}
            grain={grain}
          />
          <AbsoluteFill
            style={{
              backgroundColor: fringe,
              opacity: 0.85,
              maskImage: `url(#${id}-fr)`,
              WebkitMaskImage: `url(#${id}-fr)`,
            }}
          />
        </>
      ) : null}
      <AbsoluteFill style={{ maskImage: `url(#${id})`, WebkitMaskImage: `url(#${id})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Opens the next scene behind an organic soft front (reveal), or covers the old scene in a soft cloud, holds and parts
 * onto the new one (cover). Pair with `cutTiming(10..20)`: ace's smoke evenly from a corner (noiseMatteAcePreset: linear, 13 frames), flex's
 * cloud 11 frames from the right on power1.inOut with a fringe, muse's cloud cover 18 frames on power2.inOut.
 */
export const noiseMatteWipe = ({
  mode = "reveal",
  origin = "bottom-right",
  curve = "power2.out",
  feather = 0.08,
  roughness = 0.3,
  grain = 0.5,
  seed = 7,
  fringe,
  fringeWidth = 0.05,
  cover = "#F4F4F2",
  hold = 0.14,
}: Partial<NoiseMatteWipeOptions> = {}): TransitionPresentation<NoiseMatteWipeOptions> => ({
  component: NoiseMatteWipePresentation,
  props: { mode, origin, curve, feather, roughness, grain, seed, fringe, fringeWidth, cover, hold },
});

export const noiseMatteWipeSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  mode: z.enum(["reveal", "cover"]),
  origin: z.enum(NOISE_MATTE_ORIGINS),
  curve: z.enum(NOISE_MATTE_CURVES),
  feather: z.number().min(0.01).max(0.4),
  roughness: z.number().min(0).max(1),
  grain: z.number().min(0.05).max(1),
  seed: z.number().int().min(0),
  fringe: z.string().optional(),
  fringeWidth: z.number().min(0).max(0.2),
  cover: z.string(),
  hold: z.number().min(0).max(0.6),
  transitionFrames: z.number().int().min(6).max(36),
});

export type NoiseMatteWipeProps = z.infer<typeof noiseMatteWipeSchema>;

export const NOISE_MATTE_WIPE_FRAMES = 84;

export const noiseMatteWipeDefaults: NoiseMatteWipeProps = {
  mode: "reveal",
  origin: "right",
  curve: "power1.inOut",
  feather: 0.08,
  roughness: 0.3,
  grain: 0.5,
  seed: 7,
  fringeWidth: 0.05,
  cover: "#F4F4F2",
  hold: 0.14,
  transitionFrames: 11,
};

/**
 * ace's smoke (F456-F480 at 60 fps), matched by covered share of the frame, not by the curve's name: ace's cell goes
 * dark 0.04, 0.25, 0.37, 0.47, 0.65, 0.78, 0.85, 0.94, 0.97 a 30-fps frame apart, an even front with a soft tail. Ours on
 * power2.out over 9 frames covers 0.05, 0.47, 0.79, 0.95: far too fast at the start, since the matte is full before
 * the curve ends. Linear over 13 frames sits between our linear 12 (0.09, 0.19, 0.39, 0.58, 0.72, 0.84, 0.95) and 14
 * (0.02, 0.12, 0.21, 0.39, 0.55, 0.69, 0.80, 0.90, 0.97). Measured with out/qa coverage renders, origin top-right.
 */
export const noiseMatteAcePreset: Pick<NoiseMatteWipeProps, "mode" | "origin" | "curve" | "transitionFrames"> = {
  mode: "reveal",
  origin: "top-right",
  curve: "linear",
  transitionFrames: 13,
};

/** Library preview: the light product card is overtaken by a dark cloud front from the right (flex's timing) onto an ink statement. */
export const NoiseMatteWipePreview: React.FC<NoiseMatteWipeProps> = ({
  transitionFrames,
  seamFrame: _seam,
  ...options
}) => (
  <TransitionDemo
    presentation={noiseMatteWipe(options)}
    transitionFrames={transitionFrames}
    totalFrames={NOISE_MATTE_WIPE_FRAMES}
    before={<DemoSceneA />}
    after={<DemoSceneB ground={options.mode === "cover" ? DEMO.indigo : DEMO.ink} title="Dark mode" />}
  />
);
