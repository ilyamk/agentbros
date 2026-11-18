import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type GradientShiftProps = {
  colors: [string, string, string?];
  angle?: number; // starting angle
  rotateSpeed?: number; // degrees per second
};

/** Slowly rotating gradient background */
export const GradientShift: React.FC<GradientShiftProps> = ({ colors, angle = 135, rotateSpeed = 20 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const currentAngle = angle + (frame / fps) * rotateSpeed;
  const colorStr = colors.filter(Boolean).join(", ");

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${currentAngle}deg, ${colorStr})`,
      }}
    />
  );
};
