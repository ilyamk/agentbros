import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

type ScanLinesProps = {
  opacity?: number;
  lineHeight?: number;
  speed?: number; // pixels per frame
  color?: string;
};

/** Retro scan line overlay effect */
export const ScanLines: React.FC<ScanLinesProps> = ({
  opacity = 0.08,
  lineHeight = 4,
  speed = 0.5,
  color = "#000000",
}) => {
  const frame = useCurrentFrame();
  const offset = (frame * speed) % (lineHeight * 2);

  return (
    <AbsoluteFill
      style={{
        backgroundImage: `repeating-linear-gradient(
          0deg,
          transparent,
          transparent ${lineHeight}px,
          ${color} ${lineHeight}px,
          ${color} ${lineHeight * 2}px
        )`,
        backgroundPositionY: offset,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};
