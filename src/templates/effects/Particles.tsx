import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, random } from "remotion";

type ParticlesProps = {
  count?: number;
  color?: string;
  minSize?: number;
  maxSize?: number;
  speed?: number;
  seed?: number;
};

/** Floating particles overlay — ambient background effect */
export const Particles: React.FC<ParticlesProps> = ({
  count = 30,
  color = "#ffffff",
  minSize = 2,
  maxSize = 6,
  speed = 1,
  seed = 0,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const particles = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        x: random(`x-${seed}-${i}`) * width,
        y: random(`y-${seed}-${i}`) * height,
        size: minSize + random(`size-${seed}-${i}`) * (maxSize - minSize),
        speedX: (random(`sx-${seed}-${i}`) - 0.5) * 2,
        speedY: (random(`sy-${seed}-${i}`) - 0.5) * 2 - 0.5,
        delay: random(`delay-${seed}-${i}`) * 2 * fps,
        opacity: 0.2 + random(`op-${seed}-${i}`) * 0.5,
      })),
    [count, width, height, minSize, maxSize, seed, fps],
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {particles.map((p, i) => {
        const x = ((p.x + p.speedX * frame * speed) % (width + 20)) - 10;
        const y = ((p.y + p.speedY * frame * speed) % (height + 20)) - 10;
        const opacity = interpolate(frame, [p.delay, p.delay + fps], [0, p.opacity], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: color,
              opacity,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
