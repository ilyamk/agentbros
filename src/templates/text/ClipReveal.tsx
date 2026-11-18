import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type ClipRevealProps = {
  text: string;
  startFrame?: number;
  /** Reveal direction */
  direction?: "left" | "right" | "center";
  /** Duration in seconds for full reveal */
  durationSec?: number;
  springConfig?: { damping?: number; stiffness?: number };
  style?: React.CSSProperties;
};

/**
 * Text revealed via clip-path — the text is always in position
 * but a rectangular mask slides open to reveal it.
 * Clean, modern, editorial feel.
 */
export const ClipReveal: React.FC<ClipRevealProps> = ({
  text,
  startFrame = 0,
  direction = "left",
  springConfig = { damping: 200, stiffness: 80 },
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame,
    fps,
    delay: startFrame,
    config: springConfig,
  });

  let clipPath: string;
  switch (direction) {
    case "left":
      clipPath = `inset(0 ${interpolate(progress, [0, 1], [100, 0])}% 0 0)`;
      break;
    case "right":
      clipPath = `inset(0 0 0 ${interpolate(progress, [0, 1], [100, 0])}%)`;
      break;
    case "center": {
      const inset = interpolate(progress, [0, 1], [50, 0]);
      clipPath = `inset(0 ${inset}%)`;
      break;
    }
  }

  return <div style={{ clipPath, ...style }}>{text}</div>;
};
