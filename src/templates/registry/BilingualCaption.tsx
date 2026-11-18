import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { primaryFont } from "../../lib/fonts";
import { spacing, typography } from "../../lib/design-tokens";
import type { TemplateInstance } from "../../types/templates";
type Props = Extract<
  TemplateInstance,
  {
    id: "caption.bilingual";
  }
>["props"];
/** Translation shares an explicitly supplied phrase interval; it has no inferred word alignment. */
export const BilingualCaption: React.FC<{
  props: Props;
  backgroundColor: string;
  textColor: string;
}> = ({ props, backgroundColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const cue = props.cues.find((c) => frame / fps >= c.start && frame / fps < c.end);
  if (!cue) return null;
  const fmt = height > width ? "vertical" : height < width ? "landscape" : "square";
  const opacity = interpolate(frame, [cue.start * fps, cue.start * fps + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const line = (size: React.CSSProperties): React.CSSProperties => {
    const fontSize = typeof size.fontSize === "number" ? size.fontSize : 40;
    return {
      ...size,
      backgroundColor: opaque(backgroundColor),
      color: textColor,
      padding: `${fontSize * 0.1}px ${fontSize * 0.3}px`,
      borderRadius: fontSize * 0.24,
      boxDecorationBreak: "clone",
      WebkitBoxDecorationBreak: "clone",
      lineHeight: 1.5,
    };
  };
  return (
    <div
      data-avc-text-role="spoken-caption"
      style={{
        boxSizing: "border-box",
        fontFamily: primaryFont,
        textAlign: "center",
        width: "100%",
        padding: `0 ${spacing.headlineGap}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: spacing.headlineGap / 3,
        opacity,
        overflowWrap: "anywhere",
      }}
    >
      <div lang={props.sourceLanguage}>
        <span style={line(typography.feature[fmt])}>{cue.text}</span>
      </div>
      <div lang={props.translationLanguage}>
        <span style={line(typography.subtext[fmt])}>{cue.translation}</span>
      </div>
    </div>
  );
};

/** A solid box per line, like the line-box preset: a translucent fill would be a scrim, so its alpha is dropped. */
const opaque = (colour: string): string => {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(colour);
  if (rgba) return `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`;
  const hex = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(colour);
  return hex ? `#${hex[1]}` : colour;
};
