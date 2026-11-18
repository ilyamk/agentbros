import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Camera } from "../../camera";
import { shake, type CameraPose } from "../../camera-math";
import { track } from "../../timing";
import { primaryFont } from "../../../lib/fonts";
import { DEFOCUS_RAMP_FRAMES, defocusRamp } from "./camera-plan";
import { CAMERA_EASE } from "./ParallaxRig";
import { DemoWorld } from "./world";

export type FocusPullOptions = {
  /** Frames of the push (`dolly` from 0 to `push`). */
  pushFrom: number;
  pushTo: number;
  push: number;
  /** Rack window and depths: focus travels from `focusFrom` to `focusTo`. */
  rackFrom: number;
  rackTo: number;
  focusFrom: number;
  focusTo: number;
  handheld?: number;
};

/** A slow push with a rack focus inside it: the eye is handed from one plane to another while the camera closes in. */
export const focusPullPose = (frame: number, o: FocusPullOptions): CameraPose => {
  const hand = shake(frame, {
    seed: "focus-pull",
    amplitude: 5 * (o.handheld ?? 0),
    rollAmplitude: 0.1 * (o.handheld ?? 0),
  });
  return {
    x: hand.x,
    y: hand.y,
    roll: hand.roll,
    dolly: track(frame, [
      { at: o.pushFrom, value: 0 },
      { at: o.pushTo, value: o.push, curve: CAMERA_EASE },
    ]),
    focus: track(frame, [
      { at: o.rackFrom, value: o.focusFrom },
      { at: o.rackTo, value: o.focusTo, curve: CAMERA_EASE },
    ]),
  };
};

export const focusPullSchema = z.object({
  push: z.number().min(0).max(600),
  focusFrom: z.number().min(-400).max(1200),
  focusTo: z.number().min(-400).max(1200),
  aperture: z.number().min(0.005).max(0.06),
  handheld: z.number().min(0).max(1),
  headline: z.string(),
  /**
   * `pull` (default): the push with a rack focus. `ramp` (gojiberry defocus-end-card): the whole footage layer defocuses
   * on sine.inOut over `rampFrames` from `rampAt` up to `rampBlur` px (at 1080) while overlays stay sharp; use
   * `<DefocusRamp at frames blur overlay={card}>{footage}</DefocusRamp>`.
   */
  mode: z.enum(["pull", "ramp"]).optional(),
  rampAt: z.number().int().min(0).optional(),
  rampFrames: z.number().int().min(1).max(120).optional(),
  rampBlur: z.number().min(0).max(80).optional(),
});

export type FocusPullProps = z.infer<typeof focusPullSchema>;

export const FOCUS_PULL_FRAMES = 120;

/** Frame the ramp starts in the preview when `rampAt` is absent. */
export const DEFOCUS_RAMP_AT = 24;

/** The focus cue: the rack lands on the card (pull), or the plate is fully soft (ramp). */
export const focusPullCues = (p: Partial<FocusPullProps>) =>
  p.mode === "ramp"
    ? [
        {
          frame: (p.rampAt ?? DEFOCUS_RAMP_AT) + (p.rampFrames ?? DEFOCUS_RAMP_FRAMES),
          kind: "reveal" as const,
          weight: "support" as const,
          label: "plate defocused under the overlay",
        },
      ]
    : [{ frame: 70, kind: "reveal" as const, weight: "support" as const, label: "focus lands on the card" }];

/**
 * The footage layer blurs on a sine.inOut ramp (`defocusRamp` in camera-plan.ts) while `overlay` stays sharp above it.
 * `blur` is px at 1080 on the short side; the footage is overscanned so its blurred edges never show the ground.
 */
export const DefocusRamp: React.FC<{
  at: number;
  frames?: number;
  blur?: number;
  overlay?: React.ReactNode;
  children: React.ReactNode;
}> = ({ at, frames = DEFOCUS_RAMP_FRAMES, blur = 24, overlay, children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const px = defocusRamp(frame, at, frames, blur) * (Math.min(width, height) / 1080);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          filter: px > 0.05 ? `blur(${px}px)` : undefined,
          transform: px > 0.05 ? `scale(${1 + (px * 3) / Math.min(width, height)})` : undefined,
        }}
      >
        {children}
      </AbsoluteFill>
      {overlay ? <AbsoluteFill>{overlay}</AbsoluteFill> : null}
    </AbsoluteFill>
  );
};

/** Preview overlay of the ramp: a mark and a line set sharp over the softened plate, like an end card. */
const RampCard: React.FC<{ headline: string }> = ({ headline }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 28 * u, flexDirection: "column" }}>
      <div style={{ width: 120 * u, height: 120 * u, borderRadius: 32 * u, background: "#F2F0EA" }} />
      <div
        style={{
          fontFamily: primaryFont,
          fontWeight: 700,
          fontSize: 84 * u,
          letterSpacing: "-0.03em",
          color: "#F2F0EA",
        }}
      >
        {headline}
      </div>
    </AbsoluteFill>
  );
};

export const FocusPullPreview: React.FC<FocusPullProps> = ({
  push,
  focusFrom,
  focusTo,
  aperture,
  handheld,
  headline,
  mode,
  rampAt,
  rampFrames,
  rampBlur,
}) => {
  const frame = useCurrentFrame();
  if (mode === "ramp") {
    // The footage holds (a still camera with only its hand), the ramp softens it, the card stays sharp.
    const pose = focusPullPose(frame, {
      pushFrom: 0,
      pushTo: FOCUS_PULL_FRAMES,
      push: push * 0.3,
      rackFrom: 0,
      rackTo: 1,
      focusFrom: 0,
      focusTo: 0,
      handheld,
    });
    return (
      <DefocusRamp
        at={rampAt ?? DEFOCUS_RAMP_AT}
        frames={rampFrames ?? DEFOCUS_RAMP_FRAMES}
        blur={rampBlur ?? 24}
        overlay={<RampCard headline={headline} />}
      >
        <Camera pose={pose} lens={{ aperture, rackScale: 0.00004 }}>
          <DemoWorld headline="" />
        </Camera>
      </DefocusRamp>
    );
  }
  const pose = focusPullPose(frame, {
    pushFrom: 0,
    pushTo: FOCUS_PULL_FRAMES,
    push,
    rackFrom: 34,
    rackTo: 70,
    focusFrom,
    focusTo,
    handheld,
  });
  return (
    <Camera pose={pose} lens={{ aperture, rackScale: 0.00004 }}>
      <DemoWorld headline={headline} />
    </Camera>
  );
};
