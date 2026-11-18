import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { captionLayout } from "../../lib/design-tokens";
import { displayFont } from "../../lib/fonts";
import type { CaptionStyle } from "./TalkingHeadLayout";

export type WordAlignment = {
  text: string;
  /** Word start time in seconds */
  start: number;
  /** Word end time in seconds */
  end: number;
  /** Alignment confidence score — absent in edited word files */
  loss?: number;
  /** When true, the word receives extra visual weight while active */
  emphasis?: boolean;
};

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  activeColor: "#FFE600",
  inactiveColor: "#FFFFFF",
  strokeColor: "#000000",
  strokeWidth: 8,
  fontSize: captionLayout.fontSize,
  wordsInView: 3,
};

export type KaraokeCaptionsProps = {
  words: WordAlignment[];
  /** Shift all word timestamps by this many seconds (e.g. when scene starts mid-voiceover) */
  startOffsetSec?: number;
  style?: Partial<CaptionStyle>;
  /** Font family (default: displayFont) */
  fontFamily?: string;
};

export const KaraokeCaptions: React.FC<KaraokeCaptionsProps> = ({ words, startOffsetSec = 0, style, fontFamily }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (words.length === 0) {
    return null;
  }

  const captionStyle: CaptionStyle = { ...DEFAULT_CAPTION_STYLE, ...style };
  const { activeColor, inactiveColor, strokeColor, strokeWidth, fontSize, wordsInView } = captionStyle;

  const currentTimeSec = frame / fps + startOffsetSec;

  // Find the currently active word (currentTime within [start, end]).
  let activeIndex = -1;
  for (let i = 0; i < words.length; i++) {
    if (currentTimeSec >= words[i].start && currentTimeSec < words[i].end) {
      activeIndex = i;
      break;
    }
  }
  // If between or past words, use the last word whose start has been reached.
  if (activeIndex === -1) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (currentTimeSec >= words[i].start) {
        activeIndex = i;
        break;
      }
    }
  }

  if (activeIndex === -1) {
    // No word has started yet.
    return null;
  }

  // Compute window: show `wordsInView` words centred on the active word.
  const windowSize = Math.max(1, wordsInView);
  const half = Math.floor(windowSize / 2);
  const windowStart = Math.max(0, activeIndex - half);
  const windowEnd = Math.min(words.length - 1, windowStart + windowSize - 1);
  const windowWords = words.slice(windowStart, windowEnd + 1);

  const resolvedFontFamily = fontFamily ?? displayFont;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        gap: fontSize * captionLayout.wordGapRatio,
        paddingLeft: 40,
        paddingRight: 40,
      }}
    >
      {windowWords.map((word, localIndex) => {
        const globalIndex = windowStart + localIndex;
        const isActive = globalIndex === activeIndex;

        // Fade in 6 frames before the word's start time.
        const wordStartFrame = Math.round((word.start - startOffsetSec) * fps);
        const fadeInStart = wordStartFrame - 6;
        const fadeInEnd = wordStartFrame;

        const opacity = interpolate(frame, [fadeInStart, fadeInEnd], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        // Emphasis words get extra visual weight when they are the active word.
        const fontWeight = isActive && word.emphasis ? 1000 : 800;

        return (
          <span
            data-avc-text-role="spoken-caption"
            key={`${globalIndex}-${word.text}`}
            style={{
              fontFamily: resolvedFontFamily,
              fontSize,
              fontWeight,
              fontStyle: "italic",
              letterSpacing: "0.02em",
              color: isActive ? activeColor : inactiveColor,
              WebkitTextStroke: `${strokeWidth}px ${strokeColor}`,
              paintOrder: "stroke fill",
              opacity,
              display: "inline-block",
              lineHeight: captionLayout.lineHeight,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};
