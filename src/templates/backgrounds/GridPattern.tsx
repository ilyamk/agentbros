import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type GridPatternProps = {
  color?: string;
  cellSize?: number;
  lineWidth?: number;
  animated?: boolean; // slowly zoom in
};

/** Subtle grid pattern background — tech/modern aesthetic */
export const GridPattern: React.FC<GridPatternProps> = ({
  color = "#ffffff15",
  cellSize = 60,
  lineWidth = 1,
  animated = true,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const scale = animated
    ? interpolate(frame, [0, durationInFrames], [1, 1.15], {
        extrapolateRight: "clamp",
      })
    : 1;

  return (
    <AbsoluteFill
      style={{
        backgroundImage: `
          linear-gradient(${color} ${lineWidth}px, transparent ${lineWidth}px),
          linear-gradient(90deg, ${color} ${lineWidth}px, transparent ${lineWidth}px)
        `,
        backgroundSize: `${cellSize}px ${cellSize}px`,
        transform: `scale(${scale})`,
        pointerEvents: "none",
      }}
    />
  );
};
