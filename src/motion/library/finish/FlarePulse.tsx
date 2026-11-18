import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { hitsDecay } from "../../kinetic-math";
import { curves, track, type CurveName, type Keyframe } from "../../timing";

type FlarePulseSettings = {
  /** Flare source, as a share of the frame. */
  x: number;
  y: number;
  /** Frames of the beats that flash the flare. */
  hits: readonly number[];
  /** Frames each flash takes to fade. */
  decay?: number;
  colour?: string;
  /** Glow left between beats, 0 to 1. */
  idle?: number;
  /** Length of the anamorphic streak as a share of the frame width. */
  streak?: number;
  /** Streak angle in degrees, clockwise from horizontal (0 is the classic anamorphic line; nowakdesign's lens streak is about -32). */
  angle?: number;
  /**
   * Flare level per frame as `track` keyframes ({ at, value 0..1, curve }); when given it replaces `hits` and `idle`,
   * so the flare can recede with the subject (nowakdesign: full on arrival, half by 6 frames, expo.out).
   */
  intensity?: readonly Keyframe[];
  /** Streak thickness as a share of the frame's short side (0.024 a thin line; a bloomed lens streak is about 0.07). */
  thickness?: number;
};

/** The flare's level on `frame`: the `intensity` track when given, otherwise `idle` plus a decaying kick on each hit. */
export const flareLevel = (
  frame: number,
  { hits, decay = 14, idle = 0.35, intensity = [] }: Pick<FlarePulseSettings, "hits" | "decay" | "idle" | "intensity">,
): number =>
  intensity.length
    ? Math.max(0, Math.min(1, track(frame, intensity)))
    : Math.min(1, idle + hitsDecay(frame, hits, decay));

/** An anamorphic lens flare that flashes on beats: hot core, long horizontal streak and soft ghosts across the axis. Screen-blended overlay. */
export const FlarePulse: React.FC<FlarePulseSettings> = ({
  x,
  y,
  hits,
  decay = 14,
  colour = "#7fb2ff",
  idle = 0.35,
  streak = 0.9,
  angle = 0,
  intensity = [],
  thickness = 0.024,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const level = flareLevel(frame, { hits, decay, idle, intensity });
  const px = x * width;
  const py = y * height;
  const unit = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const ghosts = [
    { t: 0.6, r: 0.05, a: 0.14 },
    { t: 1.25, r: 0.09, a: 0.08 },
    { t: 1.6, r: 0.03, a: 0.18 },
    { t: 2, r: 0.14, a: 0.05 },
  ];
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      <div
        style={{
          position: "absolute",
          left: px - width * streak * 0.5,
          top: py - (unit * thickness) / 2,
          width: width * streak,
          height: unit * thickness,
          borderRadius: "50%",
          background: `radial-gradient(ellipse 50% 50% at 50% 50%, color-mix(in srgb, white ${90 * level}%, transparent) 0%, color-mix(in srgb, ${colour} ${70 * level}%, transparent) 25%, transparent 100%)`,
          filter: `blur(${unit * 0.004}px)`,
          transform: angle ? `rotate(${angle}deg)` : undefined,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: px - unit * 0.3,
          top: py - unit * 0.3,
          width: unit * 0.6,
          height: unit * 0.6,
          background: `radial-gradient(circle, color-mix(in srgb, white ${100 * level}%, transparent) 0%, color-mix(in srgb, ${colour} ${55 * level}%, transparent) 6%, color-mix(in srgb, ${colour} ${14 * level}%, transparent) 30%, transparent 70%)`,
        }}
      />
      {ghosts.map((g) => {
        const gx = px + (cx - px) * g.t;
        const gy = py + (cy - py) * g.t;
        const r = unit * g.r;
        return (
          <div
            key={g.t}
            style={{
              position: "absolute",
              left: gx - r,
              top: gy - r,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: `radial-gradient(circle, transparent 35%, color-mix(in srgb, ${colour} ${100 * g.a * level}%, transparent) 70%, transparent 72%)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

export const flarePulseSchema = z.object({
  x: z.number(),
  y: z.number(),
  hits: z.array(z.number().int()),
  decay: z.number().int().min(2).max(60),
  colour: z.string(),
  idle: z.number().min(0).max(1),
  streak: z.number().min(0).max(2),
  angle: z.number().min(-90).max(90).optional(),
  thickness: z.number().min(0.004).max(0.3).optional(),
  intensity: z
    .array(
      z.object({
        at: z.number(),
        value: z.number().min(0).max(1),
        curve: z.enum(Object.keys(curves) as [CurveName, ...CurveName[]]).optional(),
      }),
    )
    .optional(),
});

export type FlarePulseProps = z.infer<typeof flarePulseSchema>;

/**
 * nowakdesign glint-square-pull-back (3.93-4.30 s): a diagonal streak with bloom at full on the arrival frame, at about half
 * when the subject has receded 6 frames later (expo.out), gone over the next 14. `at` is the arrival frame.
 */
export const lensStreakPreset = (
  at: number,
): Pick<FlarePulseProps, "angle" | "intensity" | "idle" | "streak" | "hits" | "thickness"> => ({
  hits: [],
  idle: 0,
  streak: 1.6,
  angle: -40,
  thickness: 0.07,
  intensity: [
    { at: at - 1, value: 0 },
    { at, value: 1 },
    { at: at + 6, value: 0.55, curve: "expoOut" },
    { at: at + 20, value: 0, curve: "drift" },
  ],
});

export const FlarePulsePreview: React.FC<FlarePulseProps> = (props) => (
  <AbsoluteFill style={{ background: "radial-gradient(ellipse 90% 80% at 30% 30%, #0e1430 0%, #04050a 70%)" }}>
    <FlarePulse {...props} />
  </AbsoluteFill>
);
