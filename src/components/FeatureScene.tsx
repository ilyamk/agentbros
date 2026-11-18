import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { displayFont, primaryFont } from "../lib/fonts";
import { typography, spacing, animation } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type FeatureSceneProps = {
  headline: string;
  subtext?: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
};

export const FeatureScene: React.FC<FeatureSceneProps> = ({ headline, subtext, accentColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const fmt: FormatKey = height > width ? "vertical" : "square";
  const headTypo = typography.hero[fmt];
  const subTypo = typography.subtext[fmt];

  // Frame 0-8: Headline fast fade + scale
  const headlineOpacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headlineScale = interpolate(spring({ frame, fps, config: animation.bouncy }), [0, 1], [0.85, 1]);

  // Frame 18-28: Subtext fades in
  const subtextOpacity = interpolate(frame, [18, 28], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Subtle red accent glow — pulsing for urgency
  const dangerGlow = interpolate(
    frame % Math.round(1.5 * fps),
    [0, Math.round(0.75 * fps), Math.round(1.5 * fps)],
    [0.08, 0.2, 0.08],
  );

  // Exit fade
  const exitOpacity = interpolate(frame, [durationInFrames - animation.exitFadeSec * fps, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: exitOpacity }}>
      {/* Flat dark background */}
      <AbsoluteFill style={{ backgroundColor: "#0F0F1A" }} />

      {/* Subtle red glow for urgency */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 800,
          height: 800,
          borderRadius: "50%",
          background: `radial-gradient(circle, #FF444440 0%, transparent 60%)`,
          opacity: dangerGlow,
        }}
      />

      {/* Content — MASSIVE centered text, NO card */}
      <AbsoluteFill className="flex flex-col items-center justify-center">
        <div
          style={{
            transform: `scale(${headlineScale})`,
            opacity: headlineOpacity,
            fontFamily: displayFont,
            fontSize: headTypo.fontSize,
            fontWeight: headTypo.fontWeight,
            color: textColor,
            textAlign: "center",
            lineHeight: headTypo.lineHeight,
            letterSpacing: headTypo.letterSpacing,
            paddingLeft: spacing.sidePadding[fmt],
            paddingRight: spacing.sidePadding[fmt],
            whiteSpace: "pre-line",
          }}
        >
          {headline}
        </div>

        {subtext && (
          <div
            style={{
              opacity: subtextOpacity,
              fontFamily: primaryFont,
              fontSize: subTypo.fontSize + 4,
              fontWeight: 500,
              color: `${textColor}99`,
              textAlign: "center",
              marginTop: spacing.headlineGap + 12,
              paddingLeft: spacing.sidePadding[fmt],
              paddingRight: spacing.sidePadding[fmt],
              lineHeight: subTypo.lineHeight,
            }}
          >
            {subtext}
          </div>
        )}

        {/* Accent bar below */}
        <div
          style={{
            width: 80,
            height: 5,
            backgroundColor: accentColor,
            marginTop: 32,
            borderRadius: 3,
            opacity: subtextOpacity,
            boxShadow: `0 0 20px ${accentColor}60`,
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
