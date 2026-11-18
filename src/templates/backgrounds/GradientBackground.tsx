import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { GradientBlob } from "../../lib/design-tokens";

type GradientBackgroundProps = {
  /** Base background color */
  base: string;
  /** Array of radial gradient blobs */
  blobs: readonly GradientBlob[];
  /** Animation speed multiplier (0 = static, 1 = normal, 2 = fast) */
  speed?: number;
};

/**
 * Multi-blob animated gradient background.
 *
 * Renders 4-6 overlapping radial gradients that slowly drift
 * during the scene for a living, breathing background effect.
 *
 * Usage:
 *   import { gradients } from "../../lib/design-tokens";
 *   <GradientBackground {...gradients.aurora} />
 */
export const GradientBackground: React.FC<GradientBackgroundProps> = ({ base, blobs, speed = 1 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  return (
    <>
      <AbsoluteFill style={{ backgroundColor: base }} />
      {blobs.map((blob, i) => {
        const shift = interpolate(frame, [0, durationInFrames], [0, blob.drift * speed], { extrapolateRight: "clamp" });
        // Alternate: even blobs drift X, odd blobs drift Y for organic feel
        const x = i % 2 === 0 ? blob.x + shift : blob.x;
        const y = i % 2 === 1 ? blob.y + shift : blob.y;

        return (
          <AbsoluteFill
            key={i}
            style={{
              background: `radial-gradient(ellipse at ${x}% ${y}%, ${blob.color} 0%, transparent ${blob.radius}%)`,
              opacity: blob.opacity,
            }}
          />
        );
      })}
    </>
  );
};
