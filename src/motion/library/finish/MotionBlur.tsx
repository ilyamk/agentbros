import { loadFont } from "@remotion/google-fonts/Inter";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { Shutter, VelocityBlur } from "../../fx";
import { curves, track, velocity, type Keyframe } from "../../timing";

/** Craft-rule peaks: 6-12 px of smear on text-sized elements, 15-20 px on a full-frame move. */
export const BLUR_PEAK = { text: 10, frame: 18 } as const;

type MotionBlurProps = {
  /** Pixels per frame of the move this frame, usually `velocity()` of the track that moves the content. */
  speed: number;
  /** Smear only along the move: a horizontal move is blurred horizontally only. */
  axis: "x" | "y";
  /** Peak blur in pixels; use `BLUR_PEAK.text` or `BLUR_PEAK.frame`. */
  peak?: number;
  /** "velocity" is one cheap directional pass; "shutter" is true sub-frame blur via @remotion/motion-blur, `samples` times the cost. */
  mode?: "velocity" | "shutter";
  /** Frame windows for "shutter" mode. */
  windows?: readonly (readonly [number, number])[];
  /** Sub-frame samples in "shutter" mode; 16-24 hides the steps on a big scale change. */
  samples?: number;
  shutterAngle?: number;
  /**
   * The shot's flat ground. Velocity mode paints it outside the blur; shutter mode paints it under every sample and
   * averages them exactly, so it keeps its colour on blurred frames. Children then stay transparent.
   */
  ground?: string;
  /** Shutter mode: the children paint an opaque ground of their own; average the samples exactly instead of adding them. */
  opaque?: boolean;
  children: React.ReactNode;
};

/**
 * Motion blur with peaks held to the craft rules. Wrap any move faster than about 30 px a frame. Pass the shot's
 * `ground` here rather than painting it inside the children, or set `opaque` in shutter mode when they must paint it.
 */
export const MotionBlur: React.FC<MotionBlurProps> = ({
  speed,
  axis,
  peak = BLUR_PEAK.text,
  mode = "velocity",
  windows = [],
  samples = 8,
  shutterAngle = 180,
  ground,
  opaque,
  children,
}) => {
  if (mode === "shutter")
    return (
      <Shutter windows={windows} samples={samples} shutterAngle={shutterAngle} ground={ground} opaque={opaque}>
        {children}
      </Shutter>
    );
  const blurred = (
    <VelocityBlur axis={axis} speed={speed} shutter={0.15} maxBlur={peak}>
      {children}
    </VelocityBlur>
  );
  return ground ? <AbsoluteFill style={{ backgroundColor: ground }}>{blurred}</AbsoluteFill> : blurred;
};

export const motionBlurSchema = z.object({
  text: z.string(),
  peak: z.number().min(0).max(40),
  background: z.string(),
  ink: z.string(),
});

export type MotionBlurPreviewProps = z.infer<typeof motionBlurSchema>;

const { fontFamily } = loadFont("normal", { weights: ["700"], subsets: ["latin"] });

export const MotionBlurPreview: React.FC<MotionBlurPreviewProps> = ({ text, peak, background, ink }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const keys: Keyframe[] = [
    { at: 6, value: -width },
    { at: 20, value: 0, curve: curves.expoOut },
    { at: 58, value: 0 },
    { at: 68, value: width, curve: curves.expoIn },
  ];
  const x = (f: number) => track(f, keys);
  return (
    <AbsoluteFill>
      <MotionBlur speed={velocity(x, frame)} axis="x" peak={peak} ground={background}>
        <AbsoluteFill
          style={{ justifyContent: "center", alignItems: "center", transform: `translateX(${x(frame)}px)` }}
        >
          <div
            style={{
              fontFamily,
              fontWeight: 700,
              fontSize: Math.min(width, height) * 0.12,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: ink,
            }}
          >
            {text}
          </div>
        </AbsoluteFill>
      </MotionBlur>
    </AbsoluteFill>
  );
};
