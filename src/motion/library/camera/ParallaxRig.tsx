import React from "react";
import { Easing, useCurrentFrame } from "remotion";
import { z } from "zod";
import { Camera } from "../../camera";
import { shake, type CameraPose } from "../../camera-math";
import { progress, type CurveRef } from "../../timing";

/** Camera and state-to-state ease from design-reference/craft-rules.md. */
export const CAMERA_EASE = Easing.bezier(0.65, 0, 0.35, 1);
import { DemoWorld } from "./world";

export type RigMove = "dolly-in" | "dolly-out" | "truck" | "crane" | "orbit";

export type RigOptions = {
  move: RigMove;
  from: number;
  to: number;
  /** Pixels of travel at the focal plane (dolly: world units towards the scene). */
  amount: number;
  curve?: CurveRef;
  /** 0..1 of handheld micro-shake layered on top; 0.3 reads as a person holding a light camera. */
  handheld?: number;
  seed?: string;
  /** Depth held sharp; pair with a lens aperture for depth of field. */
  focus?: number;
};

/** Camera pose for a classic 2.5D move. Feed it to `<Camera pose>` with your own `DepthLayer`s. */
export const rigPose = (
  frame: number,
  { move, from, to, amount, curve = CAMERA_EASE, handheld = 0, seed = "rig", focus = 0 }: RigOptions,
): CameraPose => {
  const t = progress(frame, from, to - from, curve);
  const s = t * 2 - 1;
  const hand =
    handheld > 0
      ? shake(frame, { seed, amplitude: 7 * handheld, rollAmplitude: 0.18 * handheld })
      : { x: 0, y: 0, roll: 0 };
  const base: CameraPose = { x: 0, y: 0, dolly: 0, roll: 0, focus };
  if (move === "dolly-in") base.dolly = amount * t;
  if (move === "dolly-out") base.dolly = amount * (1 - t);
  if (move === "truck") base.x = (amount / 2) * s;
  if (move === "crane") base.y = -(amount / 2) * s;
  if (move === "orbit") {
    // A 2.5D orbit: lateral travel with a dolly arc and a hint of roll, so near planes swing past far ones.
    base.x = (amount / 2) * s;
    base.dolly = amount * 0.35 * Math.sin(Math.PI * t);
    base.roll = -0.8 * s;
  }
  return { ...base, x: base.x + hand.x, y: base.y + hand.y, roll: base.roll + hand.roll };
};

export const parallaxRigSchema = z.object({
  move: z.enum(["dolly-in", "dolly-out", "truck", "crane", "orbit"]),
  amount: z.number().min(0).max(1200),
  handheld: z.number().min(0).max(1),
  aperture: z.number().min(0).max(0.06),
  headline: z.string(),
});

export type ParallaxRigProps = z.infer<typeof parallaxRigSchema>;

export const PARALLAX_RIG_FRAMES = 120;

export const ParallaxRigPreview: React.FC<ParallaxRigProps> = ({ move, amount, handheld, aperture, headline }) => {
  const frame = useCurrentFrame();
  const pose = rigPose(frame, {
    move: move as RigMove,
    from: 6,
    to: PARALLAX_RIG_FRAMES - 6,
    amount,
    handheld,
    seed: "preview",
  });
  return (
    <Camera pose={pose} lens={{ aperture }}>
      <DemoWorld headline={headline} />
    </Camera>
  );
};
