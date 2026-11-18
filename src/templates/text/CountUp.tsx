import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type CountUpProps = {
  from?: number;
  to: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
  style?: React.CSSProperties;
};

/** Animated number counter — great for stats and metrics */
export const CountUp: React.FC<CountUpProps> = ({ from = 0, to, suffix = "", prefix = "", decimals = 0, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame,
    fps,
    config: { damping: 200 },
    durationInFrames: 2 * fps,
  });

  const value = interpolate(progress, [0, 1], [from, to]);
  const display = value.toFixed(decimals);

  return (
    <span style={style}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
};
