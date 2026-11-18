import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type SlideRevealProps = {
  text: string;
  startFrame?: number;
  /** Direction the text slides from */
  direction?: "left" | "right" | "up" | "down";
  springConfig?: { damping?: number; stiffness?: number };
  style?: React.CSSProperties;
};

/**
 * Text slides into view from a direction with overflow:hidden mask.
 * Creates a clean "reveal" effect where text appears to slide out from behind a wall.
 */
export const SlideReveal: React.FC<SlideRevealProps> = ({
  text,
  startFrame = 0,
  direction = "up",
  springConfig = { damping: 200, stiffness: 100 },
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

  const offset = interpolate(progress, [0, 1], [110, 0]);

  let transform = "";
  switch (direction) {
    case "up":
      transform = `translateY(${offset}%)`;
      break;
    case "down":
      transform = `translateY(${-offset}%)`;
      break;
    case "left":
      transform = `translateX(${offset}%)`;
      break;
    case "right":
      transform = `translateX(${-offset}%)`;
      break;
  }

  return (
    <div style={{ overflow: "hidden", ...style }}>
      <div style={{ transform }}>{text}</div>
    </div>
  );
};
