import { getLength, getPointAtLength } from "@remotion/paths";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { lightBlobs, radialLines, shockRingAt } from "./kinetic-math";
import { progress, type CurveRef } from "./timing";

type RadialFieldProps = {
  /** 0 to 1: from `energyAt`, a hit, or both. */
  energy: number;
  color: string;
  /** A second colour for a share of the lines, picked by seed. */
  accent?: string;
  seed?: string;
  count?: number;
  /** Centre, in stage pixels; defaults to the middle. */
  cx?: number;
  cy?: number;
  /** A clear pocket around the centre, as a share of the reach. */
  clear?: number;
};

/** A field of thin lines leaving one point. Sparse and calm at low energy, full and bright on a hit. */
export const RadialField: React.FC<RadialFieldProps> = ({
  energy,
  color,
  accent,
  seed = "radial",
  count = 260,
  cx,
  cy,
  clear,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const centreX = cx ?? width / 2;
  const centreY = cy ?? height / 2;
  const lines = radialLines(frame, {
    seed,
    count,
    cx: centreX,
    cy: centreY,
    reach: Math.hypot(width, height) * 0.62,
    energy,
    clear,
  });
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {lines.map((line, i) => (
        <line
          key={i}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={accent && i % 3 === 0 ? accent : color}
          strokeWidth={line.width}
          strokeOpacity={line.opacity}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
};

type ShockRingProps = {
  /** Frames of the hits. */
  hits: readonly number[];
  color: string;
  cx?: number;
  cy?: number;
  from?: number;
  to?: number;
  frames?: number;
  strokeWidth?: number;
};

/** A thin ring thrown out by each hit. */
export const ShockRing: React.FC<ShockRingProps> = ({ hits, color, cx, cy, from, to, frames, strokeWidth = 4 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {hits.map((at) => {
        const ring = shockRingAt(frame, at, { from, to: to ?? height * 0.95, frames });
        return ring.visible ? (
          <circle
            key={at}
            cx={cx ?? width / 2}
            cy={cy ?? height / 2}
            r={ring.radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeOpacity={ring.opacity}
            style={{ filter: `drop-shadow(0 0 10px ${color})` }}
          />
        ) : null;
      })}
    </svg>
  );
};

type LivingLightProps = {
  ground: string;
  /** Colours of the soft lights; one light per colour. */
  lights: readonly string[];
  energy?: number;
  /** 0 to 1: pushes the whole frame towards `flashColor` on a hit. */
  flash?: number;
  flashColor?: string;
  /** Dark corners, 0 to 1. */
  vignette?: number;
  vignetteColor?: string;
  seed?: string;
  speed?: number;
};

/** A ground that is never a flat fill: lights wander on seeded noise, corners fall away and hits open it up. Add `FilmGrain` over dark ramps. */
export const LivingLight: React.FC<LivingLightProps> = ({
  ground,
  lights,
  energy = 0.4,
  flash = 0,
  flashColor = "#FFFFFF",
  vignette = 0.6,
  vignetteColor = "#000000",
  seed = "light",
  speed,
}) => {
  const frame = useCurrentFrame();
  const blobs = lightBlobs(frame, { seed, count: lights.length, speed, energy });
  const layers = blobs.map(
    (blob, i) =>
      `radial-gradient(circle at ${blob.x * 100}% ${blob.y * 100}%, color-mix(in srgb, ${lights[i]!} ${blob.strength * 100}%, transparent) 0%, transparent ${blob.radius * 100}%)`,
  );
  return (
    <AbsoluteFill style={{ backgroundColor: ground }}>
      <AbsoluteFill style={{ background: layers.join(", ") }} />
      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at 50% 50%, transparent 42%, color-mix(in srgb, ${vignetteColor} ${vignette * 100}%, transparent) 108%)`,
          }}
        />
      ) : null}
      {flash > 0 ? <AbsoluteFill style={{ backgroundColor: flashColor, opacity: Math.min(flash, 1) }} /> : null}
    </AbsoluteFill>
  );
};

type LightPathProps = {
  /** SVG path in stage pixels. */
  d: string;
  at: number;
  frames?: number;
  curve?: CurveRef;
  color: string;
  headColor?: string;
  strokeWidth?: number;
  /** How long the head stays lit once the path is drawn. */
  headHold?: number;
  /** Frames over which the whole line fades after it is drawn; absent keeps it. */
  fadeFrames?: number;
};

/** A thin line drawn by a glowing head. Lead the eye between two shots, or stay behind as a curve or a cut. */
export const LightPath: React.FC<LightPathProps> = ({
  d,
  at,
  frames = 14,
  curve = "inOut",
  color,
  headColor = "#FFFFFF",
  strokeWidth = 3,
  headHold = 4,
  fadeFrames,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  if (frame < at) return null;
  const length = getLength(d);
  const drawn = progress(frame, at, frames, curve) * length;
  const point = getPointAtLength(d, Math.max(Math.min(drawn, length), 0.001));
  const headOn = frame <= at + frames + headHold;
  const fade = fadeFrames ? 1 - progress(frame, at + frames, fadeFrames, "linear") : 1;
  if (fade <= 0) return null;
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, opacity: fade }} aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={`${drawn} ${length}`}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 8px ${color})` }}
      />
      {headOn && point ? (
        <>
          <circle
            cx={point.x}
            cy={point.y}
            r={strokeWidth * 5}
            fill={color}
            opacity={0.45}
            style={{ filter: "blur(10px)" }}
          />
          <circle cx={point.x} cy={point.y} r={strokeWidth * 1.6} fill={headColor} />
        </>
      ) : null}
    </svg>
  );
};
