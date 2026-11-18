import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type LineByLineProps = {
  /** Lines of text (array or newline-separated string) */
  lines: string[] | string;
  startFrame?: number;
  /** Opt-in deterministic opacity fade; existing spring behavior remains unchanged. */
  fadeDurationFrames?: number;
  /** Seconds between each line appearing */
  staggerSec?: number;
  /** Animation style */
  entrance?: "slideUp" | "slideLeft" | "fade" | "clipReveal";
  springConfig?: { damping?: number; stiffness?: number };
  style?: React.CSSProperties;
  lineStyle?: React.CSSProperties;
  /** Apply accent color to a specific line (0-based index) */
  accentLineIndex?: number;
  accentColor?: string;
};

/** Lines of text appear one by one with staggered entrance */
export const LineByLine: React.FC<LineByLineProps> = ({
  lines: linesInput,
  startFrame = 0,
  fadeDurationFrames,
  staggerSec = 0.2,
  entrance = "fade",
  springConfig = { damping: 200, stiffness: 100 },
  style,
  lineStyle,
  accentLineIndex,
  accentColor = "#6C5CE7",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lines = typeof linesInput === "string" ? linesInput.split("\n") : linesInput;
  const staggerFrames = Math.round(staggerSec * fps);

  return (
    <div style={{ display: "flex", flexDirection: "column", ...style }}>
      {lines.map((line, i) => {
        const lineDelay = startFrame + i * staggerFrames;
        const progress = spring({
          frame,
          fps,
          delay: lineDelay,
          config: springConfig,
        });

        let transform = "";
        let opacity =
          entrance === "fade" && fadeDurationFrames !== undefined
            ? interpolate(frame, [lineDelay, lineDelay + fadeDurationFrames], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : progress;
        let clipPath: string | undefined;

        switch (entrance) {
          case "slideUp":
            transform = `translateY(${interpolate(progress, [0, 1], [40, 0])}px)`;
            break;
          case "slideLeft":
            transform = `translateX(${interpolate(progress, [0, 1], [-60, 0])}px)`;
            break;
          case "fade":
            break;
          case "clipReveal":
            opacity = 1;
            clipPath = `inset(0 ${interpolate(progress, [0, 1], [100, 0])}% 0 0)`;
            break;
        }

        const isAccent = accentLineIndex === i;

        return (
          <div
            key={i}
            style={{
              opacity,
              transform,
              clipPath,
              color: isAccent ? accentColor : undefined,
              ...lineStyle,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};
