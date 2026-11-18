import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type GlowPulseProps = {
  color: string;
  size?: number;
  speed?: number; // pulses per second
  intensity?: number; // 0-1
};

/** Pulsing radial glow effect — use as an overlay behind content */
export const GlowPulse: React.FC<GlowPulseProps> = ({ color, size = 400, speed = 0.8, intensity = 0.5 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cycleFrames = fps / speed;
  const progress = (frame % cycleFrames) / cycleFrames;
  const scale = interpolate(progress, [0, 0.5, 1], [1, 1.2, 1]);
  const opacity = interpolate(progress, [0, 0.5, 1], [intensity, intensity * 0.6, intensity]);

  return (
    <AbsoluteFill className="flex items-center justify-center" style={{ pointerEvents: "none" }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${color}80 0%, transparent 70%)`,
          transform: `scale(${scale})`,
          opacity,
        }}
      />
    </AbsoluteFill>
  );
};
