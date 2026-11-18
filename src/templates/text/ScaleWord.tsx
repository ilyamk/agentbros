import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type ScaleWordProps = {
  text: string;
  startFrame?: number;
  /** Seconds between each word */
  staggerSec?: number;
  /** Spring preset */
  bounce?: "none" | "soft" | "hard";
  /** Scale from (0 = invisible, 0.5 = half size) */
  scaleFrom?: number;
  style?: React.CSSProperties;
  wordStyle?: React.CSSProperties;
};

/** Each word scales in with bounce — great for impactful single-line statements */
export const ScaleWord: React.FC<ScaleWordProps> = ({
  text,
  startFrame = 0,
  staggerSec = 0.15,
  bounce = "soft",
  scaleFrom = 0,
  style,
  wordStyle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const springConfig =
    bounce === "hard"
      ? { damping: 6, stiffness: 120 }
      : bounce === "soft"
        ? { damping: 14, stiffness: 100 }
        : { damping: 200, stiffness: 100 };

  const words = text.split(/\s+/);
  const staggerFrames = Math.round(staggerSec * fps);

  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: "0.2em", justifyContent: "center", ...style }}>
      {words.map((word, i) => {
        const wordDelay = startFrame + i * staggerFrames;
        const progress = spring({
          frame,
          fps,
          delay: wordDelay,
          config: springConfig,
        });

        const scale = interpolate(progress, [0, 1], [scaleFrom, 1]);
        const opacity = interpolate(progress, [0, 0.3], [0, 1], {
          extrapolateRight: "clamp",
        });

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform: `scale(${scale})`,
              ...wordStyle,
            }}
          >
            {word}
          </span>
        );
      })}
    </span>
  );
};
