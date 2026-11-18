import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { condensedFont, primaryFont } from "../lib/fonts";
import { typography, spacing, animation } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type TitleSceneProps = {
  headline: string;
  subtext?: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
};

export const TitleScene: React.FC<TitleSceneProps> = ({ headline, subtext, accentColor, bgColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height, width } = useVideoConfig();
  const fmt: FormatKey = height > width ? "vertical" : "square";
  const typo = typography.condensedHero[fmt];
  const subTypo = typography.accentSub[fmt];

  // Frame 0-6: Headline fast fade + scale
  const headlineOpacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headlineScale = interpolate(spring({ frame, fps, config: animation.smooth }), [0, 1], [0.9, 1]);

  // Frame 15: Accent line scales in
  const lineProgress = spring({
    frame,
    fps,
    delay: 12,
    config: animation.stiff,
  });
  const lineWidth = interpolate(lineProgress, [0, 1], [0, 280]);
  const lineOpacity = interpolate(lineProgress, [0, 0.3], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Frame 25-35: Subtext fades in
  const subtextOpacity = interpolate(frame, [25, 35], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Subtle zoom
  const sceneScale = interpolate(frame, [0, durationInFrames], [1, 1.03], {
    extrapolateRight: "clamp",
  });

  // Exit fade
  const exitOpacity = interpolate(frame, [durationInFrames - animation.exitFadeSec * fps, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: exitOpacity }}>
      {/* Flat dark background */}
      <AbsoluteFill style={{ backgroundColor: bgColor }} />

      {/* Content */}
      <AbsoluteFill style={{ transform: `scale(${sceneScale})` }} className="flex flex-col items-center justify-center">
        {/* Accent line */}
        <div
          style={{
            width: lineWidth,
            height: 6,
            backgroundColor: accentColor,
            marginBottom: 36,
            borderRadius: 3,
            opacity: lineOpacity,
            boxShadow: `0 0 30px ${accentColor}80`,
          }}
        />

        {/* Headline — MASSIVE condensed caps */}
        <div
          style={{
            transform: `scale(${headlineScale})`,
            opacity: headlineOpacity,
            fontFamily: condensedFont,
            fontSize: typo.fontSize,
            fontWeight: typo.fontWeight,
            color: textColor,
            textAlign: "center",
            lineHeight: typo.lineHeight,
            letterSpacing: typo.letterSpacing,
            textTransform: typo.textTransform,
            whiteSpace: "pre-line",
            paddingLeft: spacing.sidePadding[fmt],
            paddingRight: spacing.sidePadding[fmt],
          }}
        >
          {headline}
        </div>

        {/* Subtext */}
        {subtext && (
          <div
            style={{
              opacity: subtextOpacity,
              fontFamily: primaryFont,
              fontSize: subTypo.fontSize,
              fontWeight: subTypo.fontWeight,
              color: accentColor,
              textAlign: "center",
              marginTop: spacing.headlineGap + 8,
              letterSpacing: subTypo.letterSpacing,
              textTransform: subTypo.textTransform,
              lineHeight: subTypo.lineHeight,
            }}
          >
            {subtext}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
