import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { condensedFont, primaryFont } from "../lib/fonts";
import { typography, animation } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type CTASceneProps = {
  headline: string;
  subtext?: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
};

export const CTAScene: React.FC<CTASceneProps> = ({ headline, subtext, accentColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const fmt: FormatKey = height > width ? "vertical" : "square";
  const headTypo = typography.condensedHero[fmt];
  const ctaTypo = typography.cta[fmt];
  const subTypo = typography.small[fmt];

  // Frame 0-6: Headline fast fade + scale
  const headlineOpacity = interpolate(frame, [0, 6], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headlineScale = interpolate(spring({ frame, fps, config: animation.veryBouncy }), [0, 1], [0.85, 1]);

  // Frame 12-20: Button fades in with scale
  const buttonProgress = spring({
    frame,
    fps,
    delay: 12,
    config: animation.bouncy,
  });
  const buttonOpacity = interpolate(frame, [12, 20], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });
  const buttonScale = interpolate(buttonProgress, [0, 1], [0.7, 1]);

  // Button pulse after entrance
  const pulse =
    frame > 20
      ? interpolate(
          (frame - 20) % Math.round(1.2 * fps),
          [0, Math.round(0.6 * fps), Math.round(1.2 * fps)],
          [1, 1.06, 1],
        )
      : 1;

  // Frame 28-38: Subtext fades in
  const subtextOpacity = interpolate(frame, [28, 38], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Exit fade
  const exitOpacity = interpolate(frame, [durationInFrames - 0.5 * fps, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: exitOpacity }}>
      {/* Bold accent color background */}
      <AbsoluteFill style={{ backgroundColor: accentColor }} />

      {/* Content */}
      <AbsoluteFill className="flex flex-col items-center justify-center px-12">
        {/* Headline — MASSIVE white condensed caps on green */}
        <div
          style={{
            transform: `scale(${headlineScale})`,
            opacity: headlineOpacity,
            fontFamily: condensedFont,
            fontSize: headTypo.fontSize,
            fontWeight: headTypo.fontWeight,
            color: textColor,
            textAlign: "center",
            lineHeight: headTypo.lineHeight,
            letterSpacing: headTypo.letterSpacing,
            textTransform: headTypo.textTransform,
            marginBottom: 48,
            whiteSpace: "pre-line",
          }}
        >
          {headline}
        </div>

        {/* CTA Button — white on dark */}
        <div
          style={{
            transform: `scale(${buttonScale * pulse})`,
            opacity: buttonOpacity,
          }}
        >
          <div
            style={{
              backgroundColor: textColor,
              color: accentColor,
              fontFamily: primaryFont,
              fontSize: ctaTypo.fontSize,
              fontWeight: ctaTypo.fontWeight,
              padding: "28px 72px",
              borderRadius: 60,
              textAlign: "center",
              boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
            }}
          >
            Try It Free
          </div>
        </div>

        {/* Subtext */}
        {subtext && (
          <div
            style={{
              opacity: subtextOpacity,
              fontFamily: primaryFont,
              fontSize: subTypo.fontSize,
              fontWeight: subTypo.fontWeight,
              color: `${textColor}CC`,
              textAlign: "center",
              marginTop: 32,
              letterSpacing: 1.5,
            }}
          >
            {subtext}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
