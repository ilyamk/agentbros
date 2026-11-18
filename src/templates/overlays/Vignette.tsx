import React from "react";
import { AbsoluteFill } from "remotion";

type VignetteProps = {
  intensity?: number; // 0-1
  color?: string;
};

/** Dark vignette overlay — adds depth and focus to center */
export const Vignette: React.FC<VignetteProps> = ({ intensity = 0.6, color = "#000000" }) => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at center, transparent 40%, ${color} 100%)`,
        opacity: intensity,
        pointerEvents: "none",
      }}
    />
  );
};
