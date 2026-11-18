import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { captionState } from "../../lib/templates/caption-state";
import type { TemplateInstance } from "../../types/templates";
import { primaryFont } from "../../lib/fonts";
import { typography, spacing } from "../../lib/design-tokens";
type Props = {
  props: Extract<TemplateInstance, { id: "caption.phrase" | "caption.keyword" }>["props"];
  keyword?: boolean;
};
export const PhraseCaption: React.FC<Props> = ({ props, keyword = false }) => {
  const frame = useCurrentFrame(),
    { fps, width, height } = useVideoConfig();
  const fmt = height > width ? "vertical" : height < width ? "landscape" : "square";
  const state = captionState(props.words, frame, fps, props.maxWords);
  if (!state.visible) return null;
  const start = state.group[0].start * fps;
  const opacity = interpolate(frame, [start, start + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        ...typography.feature[fmt],
        fontFamily: primaryFont,
        textAlign: "center",
        opacity,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: spacing.headlineGap / 2,
      }}
    >
      {state.group.map((word, i) => (
        <span
          key={`${word.start}-${i}`}
          style={{
            color: keyword && word.emphasis ? props.activeColor : undefined,
            textDecoration: keyword && i === state.activeIndex && word.emphasis ? "underline" : undefined,
          }}
        >
          {word.text}
        </span>
      ))}
    </div>
  );
};
