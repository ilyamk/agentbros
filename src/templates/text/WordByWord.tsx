import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type WordByWordProps = {
  text: string;
  startFrame?: number;
  /** Opt-in deterministic opacity fade; existing spring behavior remains unchanged. */
  fadeDurationFrames?: number;
  /** Seconds between each word appearing */
  staggerSec?: number;
  /** Animation style */
  entrance?: "fade" | "slideUp" | "scale" | "pop";
  /** Spring config */
  springConfig?: { damping?: number; stiffness?: number };
  style?: React.CSSProperties;
  wordStyle?: React.CSSProperties;
  /** Color for specific word (by index, 0-based) */
  accentWordIndex?: number;
  accentColor?: string;
};

/** Words appear one at a time with configurable entrance animation */
export const WordByWord: React.FC<WordByWordProps> = ({
  text,
  startFrame = 0,
  fadeDurationFrames,
  staggerSec = 0.12,
  entrance = "fade",
  springConfig = { damping: 200, stiffness: 100 },
  style,
  wordStyle,
  accentWordIndex,
  accentColor = "#6C5CE7",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words = text.split(/\s+/);
  const staggerFrames = Math.round(staggerSec * fps);

  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: "0.25em", ...style }}>
      {words.map((word, i) => {
        const wordDelay = startFrame + i * staggerFrames;
        const progress = spring({
          frame,
          fps,
          delay: wordDelay,
          config: springConfig,
        });

        let transform = "";
        let opacity =
          entrance === "fade" && fadeDurationFrames !== undefined
            ? interpolate(frame, [wordDelay, wordDelay + fadeDurationFrames], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              })
            : progress;

        switch (entrance) {
          case "fade":
            break;
          case "slideUp":
            transform = `translateY(${interpolate(progress, [0, 1], [30, 0])}px)`;
            break;
          case "scale":
            transform = `scale(${interpolate(progress, [0, 1], [0.3, 1])})`;
            break;
          case "pop":
            transform = `scale(${interpolate(progress, [0, 1], [0, 1])})`;
            opacity = progress;
            break;
        }

        const isAccent = accentWordIndex === i;

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform,
              color: isAccent ? accentColor : undefined,
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
