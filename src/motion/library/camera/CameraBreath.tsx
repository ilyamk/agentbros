import { noise2D } from "@remotion/noise";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { intentCurves, progress } from "../../timing";
import { DemoSceneA } from "../transitions/demo";
import type { Cue } from "../types";

export type BreathSettings = {
  /** Drift in pixels at 1080 px, along both axes; 6 to 14 is felt, not seen. */
  amplitude?: number;
  /** Share of scale the frame breathes in and out by; 0.008 to 0.02. */
  scaleAmplitude?: number;
  /** Degrees of roll; keep under 0.3. */
  rollAmplitude?: number;
  /** Seconds per breath (scale in and out once). */
  period?: number;
  /** Speed of the drift noise, cycles per second; slower is calmer. */
  wander?: number;
  seed?: string;
  /** Frames that punch in and release; the breath carries on under them. */
  hits?: readonly number[];
  /** Extra scale at the top of a punch, e.g. 0.05. */
  punch?: number;
  /** Frames from the hit until the punch has released. */
  punchFrames?: number;
};

export type BreathPose = { x: number; y: number; scale: number; roll: number };

/** Punch envelope of one hit: 0 before, up to 1 in 3 frames on `snap`, back to 0 on `glide`. */
const punchAt = (frame: number, at: number, frames: number): number => {
  if (frame < at) return 0;
  const attack = 3;
  if (frame < at + attack) return intentCurves.snap((frame - at) / attack);
  return 1 - progress(frame, at + attack, Math.max(1, frames - attack), intentCurves.glide);
};

/** The camera pose at a frame: seeded noise drift, a sine breath in scale, and the largest punch of any hit. Pure. */
export const breathPose = (
  frame: number,
  fps: number,
  unit: number,
  {
    amplitude = 10,
    scaleAmplitude = 0.012,
    rollAmplitude = 0.12,
    period = 4,
    wander = 0.18,
    seed = "breath",
    hits = [],
    punch = 0.05,
    punchFrames = 18,
  }: BreathSettings = {},
): BreathPose => {
  const t = (frame / fps) * wander;
  const breath = 0.5 - 0.5 * Math.cos((2 * Math.PI * frame) / (period * fps));
  const kick = hits.reduce((peak, at) => Math.max(peak, punchAt(frame, at, punchFrames)), 0);
  return {
    x: amplitude * unit * noise2D(`${seed}-x`, t, 0),
    y: amplitude * unit * 0.8 * noise2D(`${seed}-y`, 0, t),
    scale: 1 + scaleAmplitude * (0.5 + breath) + punch * kick,
    roll: rollAmplitude * noise2D(`${seed}-roll`, t * 0.7, 5),
  };
};

/**
 * Wraps any shot in a camera that is held, not locked: a slow seeded drift, a breath in scale and a faint roll, with an
 * optional punch-in on hits that releases on its own. 2D transforms only, so a frame opened directly matches playback.
 */
export const CameraBreath: React.FC<
  BreathSettings & { originX?: number; originY?: number; children: React.ReactNode }
> = ({ originX = 0.5, originY = 0.5, children, ...settings }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const pose = breathPose(frame, fps, unit, settings);
  // Overscan so the drift and roll never show the frame's edge: the largest shift plus the corner swing of the roll.
  const roll = ((settings.rollAmplitude ?? 0.12) * Math.PI) / 180;
  const overscan =
    1 + (2 * (settings.amplitude ?? 10) * unit + Math.max(width, height) * Math.sin(roll)) / Math.min(width, height);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${pose.x}px, ${pose.y}px) rotate(${pose.roll}deg) scale(${pose.scale * overscan})`,
          transformOrigin: `${originX * 100}% ${originY * 100}%`,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const cameraBreathSchema = z.object({
  amplitude: z.number().min(0).max(60),
  scaleAmplitude: z.number().min(0).max(0.08),
  rollAmplitude: z.number().min(0).max(1),
  period: z.number().min(1).max(12),
  wander: z.number().min(0.02).max(1),
  seed: z.string(),
  hits: z.array(z.number().int().min(0)),
  punch: z.number().min(0).max(0.3),
  punchFrames: z.number().int().min(4).max(60),
  /** Point the breath and the punch close on, as a share of the frame. */
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
});

export type CameraBreathProps = z.infer<typeof cameraBreathSchema>;

export const CAMERA_BREATH_FRAMES = 120;

export const cameraBreathDefaults: CameraBreathProps = {
  amplitude: 10,
  scaleAmplitude: 0.012,
  rollAmplitude: 0.12,
  period: 4,
  wander: 0.18,
  seed: "breath",
  hits: [57],
  punch: 0.06,
  punchFrames: 20,
  originX: 0.72,
  originY: 0.6,
};

export const cameraBreathCues = ({ hits }: Pick<CameraBreathProps, "hits">): Cue[] =>
  hits.map((frame) => ({ frame, kind: "hit", sfx: "impact", weight: "support", label: "punch-in" }));

/** Library preview: the breathing camera over a product card, punching in on the chart at the hit. */
export const CameraBreathPreview: React.FC<CameraBreathProps> = (props) => (
  <CameraBreath {...props}>
    <DemoSceneA />
  </CameraBreath>
);
