import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type WordHighlightProps = {
  text: string;
  highlightWord: string;
  highlightColor: string;
  textColor?: string;
  startFrame?: number;
  style?: React.CSSProperties;
};

/** Text with animated highlighter pen effect on a specific word */
export const WordHighlight: React.FC<WordHighlightProps> = ({
  text,
  highlightWord,
  highlightColor,
  textColor = "#ffffff",
  startFrame = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - startFrame);
  const highlightProgress = interpolate(localFrame, [0, 0.5 * fps], [0, 100], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  const parts = text.split(new RegExp(`(${highlightWord})`, "gi"));

  return (
    <span style={{ color: textColor, ...style }}>
      {parts.map((part, i) =>
        part.toLowerCase() === highlightWord.toLowerCase() ? (
          <span
            key={i}
            style={{
              backgroundImage: `linear-gradient(${highlightColor}, ${highlightColor})`,
              backgroundSize: `${highlightProgress}% 40%`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "0 85%",
              padding: "0 4px",
            }}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
};
