import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";

type LetterRevealProps = {
  text: string;
  startFrame?: number;
  /** Seconds between each letter */
  staggerSec?: number;
  /** Animation style */
  entrance?: "fade" | "slideUp" | "scale" | "rotateIn";
  springConfig?: { damping?: number; stiffness?: number };
  style?: React.CSSProperties;
  letterStyle?: React.CSSProperties;
};

/** Letters appear one by one — cinematic character reveal */
export const LetterReveal: React.FC<LetterRevealProps> = ({
  text,
  startFrame = 0,
  staggerSec = 0.03,
  entrance = "fade",
  springConfig = { damping: 200, stiffness: 120 },
  style,
  letterStyle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const staggerFrames = Math.max(1, Math.round(staggerSec * fps));
  const letters = text.split("");

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", ...style }}>
      {letters.map((letter, i) => {
        const letterDelay = startFrame + i * staggerFrames;
        const progress = spring({
          frame,
          fps,
          delay: letterDelay,
          config: springConfig,
        });

        if (letter === " ") {
          return <span key={i} style={{ width: "0.25em" }} />;
        }

        let transform = "";
        let opacity = progress;

        switch (entrance) {
          case "fade":
            break;
          case "slideUp":
            transform = `translateY(${interpolate(progress, [0, 1], [20, 0])}px)`;
            break;
          case "scale":
            transform = `scale(${interpolate(progress, [0, 1], [0, 1])})`;
            break;
          case "rotateIn":
            transform = `rotateX(${interpolate(progress, [0, 1], [-90, 0])}deg)`;
            opacity = progress;
            break;
        }

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform,
              transformOrigin: "center bottom",
              ...letterStyle,
            }}
          >
            {letter}
          </span>
        );
      })}
    </span>
  );
};
