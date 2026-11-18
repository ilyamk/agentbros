import { CameraMotionBlur } from "@remotion/motion-blur";
import React, { useId } from "react";
import { AbsoluteFill, Freeze, random, useCurrentFrame, useVideoConfig } from "remotion";
import { flashDecay, motionSigma } from "./timing";

export { Trail } from "@remotion/motion-blur";

type ShutterProps = {
  /** Frame windows `[from, to)` that need blur. Costs `samples` x the render of its children, so keep them short. */
  windows: readonly (readonly [number, number])[];
  samples?: number;
  shutterAngle?: number;
  /** Flat ground painted under every sample. The samples are then averaged exactly and the ground keeps its colour. */
  ground?: string;
  /** The children paint an opaque ground of their own: average the samples exactly instead of adding them. */
  opaque?: boolean;
  children: React.ReactNode;
};

/** Frame of sample `index` (0-based) out of `samples`, matching `@remotion/motion-blur`: `[frame + 1 - shutter, frame + 1)`. */
export const shutterSampleFrame = (frame: number, index: number, samples: number, shutterAngle: number): number =>
  frame - (shutterAngle / 360) * ((index + 1) / samples) + 1;

/** Opacity of sample `index` stacked from the bottom: 1/(index + 1) over the samples beneath is their running mean. */
export const averageLayerOpacity = (index: number): number => 1 / (index + 1);

/**
 * Exact mean of opaque samples: each one, at 1/k opacity over the k-1 beneath it, keeps the running average. Opaque
 * stays opaque and a flat ground keeps its colour, unlike the additive `CameraMotionBlur`, which lifts every channel
 * by a few levels. Only exact when every sample is opaque everywhere.
 */
const AverageShutter: React.FC<{
  samples: number;
  shutterAngle: number;
  ground?: string;
  children: React.ReactNode;
}> = ({ samples, shutterAngle, ground, children }) => {
  const frame = useCurrentFrame();
  const count = Math.max(1, Math.round(samples));
  return (
    <AbsoluteFill style={{ isolation: "isolate" }}>
      {Array.from({ length: count }, (_, index) => (
        <AbsoluteFill key={index} style={{ opacity: averageLayerOpacity(index), backgroundColor: ground }}>
          <Freeze frame={shutterSampleFrame(frame, index, count, shutterAngle)}>{children}</Freeze>
        </AbsoluteFill>
      ))}
    </AbsoluteFill>
  );
};

/**
 * True sub-frame motion blur, mounted only inside its windows. Children receive fractional frames there: floor before
 * seeding `random()`. Give the shot's flat ground as `ground` (or set `opaque` when the children paint one): the
 * samples are then averaged exactly. Without either, transparent children are added with `plus-lighter`, and a ground
 * painted inside them comes out lighter on blurred frames.
 */
export const Shutter: React.FC<ShutterProps> = ({
  windows,
  samples = 8,
  shutterAngle = 180,
  ground,
  opaque = false,
  children,
}) => {
  const frame = useCurrentFrame();
  const active = windows.some(([from, to]) => frame >= from && frame < to);
  if (!active) return <AbsoluteFill style={{ backgroundColor: ground }}>{children}</AbsoluteFill>;
  return ground !== undefined || opaque ? (
    <AverageShutter samples={samples} shutterAngle={shutterAngle} ground={ground}>
      {children}
    </AverageShutter>
  ) : (
    <CameraMotionBlur samples={samples} shutterAngle={shutterAngle}>
      {children}
    </CameraMotionBlur>
  );
};

type VelocityBlurProps = {
  axis: "x" | "y";
  /** Pixels per frame, usually `velocity()` of the track that moves the content. */
  speed: number;
  /** Blur sigma per pixel of per-frame travel. 0.15 is close to a 180 degree shutter. */
  shutter?: number;
  maxBlur?: number;
  children: React.ReactNode;
};

/** One clean directional streak. For large type crossing the frame fast, where `Shutter` samples would show as copies. */
export const VelocityBlur: React.FC<VelocityBlurProps> = ({ axis, speed, shutter = 0.15, maxBlur = 140, children }) => {
  const id = useId().replaceAll(":", "");
  const sigma = motionSigma(speed, shutter, maxBlur);
  const blurred = sigma > 0.5;
  return (
    <div style={{ position: "absolute", inset: 0, filter: blurred ? `url(#${id})` : undefined }}>
      {blurred ? (
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <filter id={id} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={axis === "x" ? `${sigma} 0` : `0 ${sigma}`} />
          </filter>
        </svg>
      ) : null}
      {children}
    </div>
  );
};

/** Seed for the grain of one frame. Holds for `cadence` frames, so grain moves on film time. */
export const grainSeed = (seed: string, frame: number, cadence: number): number =>
  Math.floor(random(`${seed}-${Math.floor(frame / cadence)}`) * 100000);

type FilmGrainProps = {
  seed?: string;
  /** Overall strength; 0.08 to 0.2 reads as stock, more reads as an effect. */
  opacity?: number;
  /** Frames each grain pattern holds: 2 is 15 patterns a second at 30fps. */
  cadence?: number;
  /** Grain size: 0.65 is coarse, 0.9 fine. */
  frequency?: number;
};

/** Monochrome grain in overlay, neutral at mid grey. Breaks banding in dark ramps. */
export const FilmGrain: React.FC<FilmGrainProps> = ({
  seed = "grain",
  opacity = 0.14,
  cadence = 2,
  frequency = 0.8,
}) => {
  const frame = useCurrentFrame();
  const id = useId().replaceAll(":", "");
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity, mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%">
        <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={frequency}
            numOctaves={2}
            seed={grainSeed(seed, frame, cadence)}
          />
          <feColorMatrix type="matrix" values="1.6 0 0 0 -0.3  1.6 0 0 0 -0.3  1.6 0 0 0 -0.3  0 0 0 0 1" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

type TextBloomProps = {
  /** Glow colour; the type keeps its own. */
  colour?: string;
  /** Glow radius in px at a 1080-px short side. */
  radius?: number;
  /** Resting glow opacity, 0 to 1. */
  strength?: number;
  /** Chromatic edge in px at 1080: red one way, blue the other. 0 none. */
  fringe?: number;
  /** Frame of the entry flash (-1 none), its length (ugc-app: about 3 frames, power2.out) and how far it lifts the glow. */
  flashAt?: number;
  flashFrames?: number;
  flashGain?: number;
  children: React.ReactNode;
};

/**
 * A soft colour bloom and a slight chromatic edge around type (or any layer with alpha), the glow flaring on an entry
 * frame and settling in a few frames (`flashDecay`). The bloom is the children's silhouette flooded with `colour` and
 * blurred, screened under them; the fringe splits red and blue sideways. Renders the children twice: keep sound outside.
 * Measured in ugc-app pass-through-type (the bloom flash settles in 3 frames).
 */
export const TextBloom: React.FC<TextBloomProps> = ({
  colour = "#8FB8FF",
  radius = 18,
  strength = 0.55,
  fringe = 1.5,
  flashAt = -1,
  flashFrames = 3,
  flashGain = 1.4,
  children,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const id = useId().replaceAll(":", "");
  const unit = Math.min(width, height) / 1080;
  const flash = flashDecay(frame, flashAt, flashFrames);
  const glow = Math.min(1, strength * (1 + flashGain * flash));
  const dx = fringe * unit * (1 + flash);
  return (
    <AbsoluteFill>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <filter id={`bloom-${id}`} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
          <feFlood floodColor={colour} />
          <feComposite in2="SourceAlpha" operator="in" result="tint" />
          <feGaussianBlur in="tint" stdDeviation={radius * unit * (1 + 0.5 * flash)} result="wide" />
          <feGaussianBlur in="tint" stdDeviation={radius * unit * 0.3} result="near" />
          <feMerge>
            <feMergeNode in="wide" />
            <feMergeNode in="near" />
          </feMerge>
        </filter>
        {dx > 0 ? (
          <filter id={`edge-${id}`} x="-5%" y="0" width="110%" height="100%" colorInterpolationFilters="sRGB">
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="r"
            />
            <feOffset in="r" dx={dx} result="ro" />
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
              result="g"
            />
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
              result="b"
            />
            <feOffset in="b" dx={-dx} result="bo" />
            <feComposite in="ro" in2="g" operator="arithmetic" k2={1} k3={1} result="rg" />
            <feComposite in="rg" in2="bo" operator="arithmetic" k2={1} k3={1} />
          </filter>
        ) : null}
      </svg>
      {glow > 0 ? (
        <AbsoluteFill style={{ filter: `url(#bloom-${id})`, opacity: glow, mixBlendMode: "screen" }}>
          {children}
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={dx > 0 ? { filter: `url(#edge-${id})` } : undefined}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};
