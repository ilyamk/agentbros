import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from "remotion";
import { displayFont, primaryFont } from "../lib/fonts";
import { typography, animation } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type ProductSceneProps = {
  headline: string;
  subtext?: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
};

export const ProductScene: React.FC<ProductSceneProps> = ({ headline, subtext, accentColor, bgColor, textColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const fmt: FormatKey = height > width ? "vertical" : "square";
  const headTypo = typography.bigTitle[fmt];
  const subTypo = typography.subtext[fmt];

  // Pulsing glow
  const glowScale = interpolate(frame % (2 * fps), [0, fps, 2 * fps], [1, 1.15, 1]);
  const glowOpacity = interpolate(spring({ frame, fps, config: animation.smooth }), [0, 1], [0, 0.4]);

  // Frame 0-8: Name fast fade + scale
  const nameOpacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });
  const nameScale = interpolate(spring({ frame, fps, config: animation.bouncy }), [0, 1], [0.8, 1]);

  // Frame 18-28: Subtext fades in
  const subtextOpacity = interpolate(frame, [18, 28], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
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

      <AbsoluteFill className="flex flex-col items-center justify-center">
        {/* Glow circle */}
        <div
          style={{
            position: "absolute",
            width: 500,
            height: 500,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${accentColor}50 0%, transparent 70%)`,
            transform: `scale(${glowScale})`,
            opacity: glowOpacity,
          }}
        />

        {/* Product name */}
        <div
          style={{
            transform: `scale(${nameScale})`,
            opacity: nameOpacity,
            fontFamily: displayFont,
            fontSize: headTypo.fontSize,
            fontWeight: headTypo.fontWeight,
            color: textColor,
            textAlign: "center",
            lineHeight: headTypo.lineHeight,
            zIndex: 1,
          }}
        >
          {headline}
        </div>

        {subtext && (
          <div
            style={{
              opacity: subtextOpacity,
              fontFamily: primaryFont,
              fontSize: subTypo.fontSize,
              fontWeight: subTypo.fontWeight,
              color: accentColor,
              textAlign: "center",
              marginTop: 20,
              lineHeight: subTypo.lineHeight,
              zIndex: 1,
            }}
          >
            {subtext}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
