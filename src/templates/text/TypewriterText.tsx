import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

type TypewriterTextProps = {
  text: string;
  startFrame?: number;
  charsPerSecond?: number;
  showCursor?: boolean;
  style?: React.CSSProperties;
};

/** Typewriter text reveal with optional blinking cursor */
export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame = 0,
  charsPerSecond = 20,
  showCursor = true,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const localFrame = Math.max(0, frame - startFrame);
  const charsPerFrame = charsPerSecond / fps;
  const visibleChars = Math.min(Math.floor(localFrame * charsPerFrame), text.length);

  const cursorVisible = showCursor && visibleChars < text.length ? Math.floor(frame / (fps * 0.5)) % 2 === 0 : false;

  return (
    <span style={style}>
      {text.slice(0, visibleChars)}
      {cursorVisible && <span style={{ opacity: 1, fontWeight: 100 }}>|</span>}
    </span>
  );
};
