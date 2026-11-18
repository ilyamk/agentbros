import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, random } from "remotion";

type NoiseGrainProps = {
  opacity?: number;
  speed?: number; // how often the pattern changes (frames between changes)
};

/** Film grain / noise overlay using SVG filter */
export const NoiseGrain: React.FC<NoiseGrainProps> = ({ opacity = 0.05, speed = 2 }) => {
  const frame = useCurrentFrame();
  const seed = Math.floor(frame / speed);

  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity, mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%">
        <filter id={`noise-${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" seed={seed} stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#noise-${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};
