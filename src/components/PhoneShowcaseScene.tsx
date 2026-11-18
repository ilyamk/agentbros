import React from "react";
import { AbsoluteFill, Img, useCurrentFrame, useVideoConfig, interpolate, spring, staticFile } from "remotion";
import { displayFont, primaryFont } from "../lib/fonts";
import { typography, spacing, animation, phoneMockup } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type PhoneShowcaseSceneProps = {
  headline: string;
  subtext?: string;
  imageUrl: string;
  accentColor: string;
  bgColor: string;
  textColor: string;
};

/** Clean bright background colors for showcase scenes */
const SHOWCASE_BACKGROUNDS = {
  purple: "#DDD6F3",
  green: "#C8E6C9",
} as const;

export const PhoneShowcaseScene: React.FC<PhoneShowcaseSceneProps> = ({ headline, subtext, imageUrl }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const fmt: FormatKey = height > width ? "vertical" : "square";
  const headTypo = typography.headline[fmt];
  const subTypo = typography.accentSub[fmt];

  // Pick bright background: green for WhatsApp/feature, purple for reveal
  const isGreenScene = imageUrl.includes("4714");
  const sceneBg = isGreenScene ? SHOWCASE_BACKGROUNDS.green : SHOWCASE_BACKGROUNDS.purple;

  const frameStyle = phoneMockup.frameStyle.dark;

  // Frame 0-6: Headline fast fade
  const headlineOpacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Frame 4-18: Phone scales in (from small — NO slide)
  const phoneProgress = spring({
    frame,
    fps,
    delay: 4,
    config: { damping: 14, stiffness: 80 },
  });
  const phoneScale = interpolate(phoneProgress, [0, 1], [0.5, 1]);
  const phoneOpacity = interpolate(frame, [4, 12], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Phone subtle float
  const floatY = interpolate(frame % Math.round(3 * fps), [0, Math.round(1.5 * fps), Math.round(3 * fps)], [0, -8, 0]);

  // Subtle tilt for 3D feel
  const tiltX = interpolate(frame, [0, Math.round(2 * fps), durationInFrames], [3, 0, -2], {
    extrapolateRight: "clamp",
  });

  // Frame 22-32: Subtext fades in
  const subtextOpacity = interpolate(frame, [22, 32], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Exit fade
  const exitOpacity = interpolate(frame, [durationInFrames - animation.exitFadeSec * fps, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  // Phone dimensions — BIG
  const phoneWidth = phoneMockup.width[fmt];
  const phoneHeight = Math.round(phoneWidth * phoneMockup.aspectRatio);
  const bezelRadius = Math.round(phoneWidth * phoneMockup.bezelRadiusFraction);
  const innerRadius = Math.round(phoneWidth * phoneMockup.innerRadiusFraction);

  // Position phone lower so it crops at bottom (intentional — fills frame)
  const phoneTopPercent = fmt === "vertical" ? "38%" : "32%";

  return (
    <AbsoluteFill style={{ opacity: exitOpacity }}>
      {/* Clean bright flat background */}
      <AbsoluteFill style={{ backgroundColor: sceneBg }} />

      {/* Headline — top area, dark text on bright bg */}
      <div
        style={{
          position: "absolute",
          top: fmt === "vertical" ? spacing.safeTop[fmt] + 20 : 60,
          left: spacing.sidePadding[fmt],
          right: spacing.sidePadding[fmt],
          opacity: headlineOpacity,
          fontFamily: displayFont,
          fontSize: headTypo.fontSize,
          fontWeight: headTypo.fontWeight,
          color: "#1A1A2E",
          textAlign: "center",
          lineHeight: headTypo.lineHeight,
          whiteSpace: "pre-line",
          zIndex: 3,
        }}
      >
        {headline}
      </div>

      {/* Subtext — below headline */}
      {subtext && (
        <div
          style={{
            position: "absolute",
            top:
              fmt === "vertical"
                ? spacing.safeTop[fmt] + 20 + headTypo.fontSize * headTypo.lineHeight * 2.2
                : 60 + headTypo.fontSize * headTypo.lineHeight * 2.2,
            left: spacing.sidePadding[fmt],
            right: spacing.sidePadding[fmt],
            opacity: subtextOpacity,
            fontFamily: primaryFont,
            fontSize: subTypo.fontSize,
            fontWeight: subTypo.fontWeight,
            color: "#1A1A2E99",
            textAlign: "center",
            letterSpacing: subTypo.letterSpacing,
            textTransform: subTypo.textTransform,
            lineHeight: subTypo.lineHeight,
            zIndex: 3,
          }}
        >
          {subtext}
        </div>
      )}

      {/* Phone mockup — BIG, scale entrance, crops at bottom */}
      <div
        style={{
          position: "absolute",
          top: phoneTopPercent,
          left: "50%",
          transform: `translate(-50%, 0%) scale(${phoneScale}) translateY(${floatY}px) perspective(1200px) rotateY(${tiltX}deg)`,
          transformOrigin: "center top",
          opacity: phoneOpacity,
          zIndex: 2,
        }}
      >
        {/* Phone outer frame */}
        <div
          style={{
            width: phoneWidth + 16,
            height: phoneHeight + 16,
            borderRadius: bezelRadius + 4,
            padding: 8,
            background: frameStyle.gradient,
            boxShadow: frameStyle.shadow,
          }}
        >
          {/* Screen */}
          <div
            style={{
              width: phoneWidth,
              height: phoneHeight,
              borderRadius: innerRadius,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <Img
              src={staticFile(imageUrl)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />

            {/* Dynamic Island */}
            <div
              style={{
                position: "absolute",
                top: Math.round(phoneWidth * 0.03),
                left: "50%",
                transform: "translateX(-50%)",
                width: Math.round(phoneWidth * phoneMockup.dynamicIslandWidth),
                height: Math.round(phoneWidth * phoneMockup.dynamicIslandHeight),
                backgroundColor: "#000000",
                borderRadius: 100,
              }}
            />
          </div>
        </div>

        {/* Side button */}
        <div
          style={{
            position: "absolute",
            right: -3,
            top: Math.round(phoneHeight * 0.22),
            width: 3,
            height: Math.round(phoneHeight * 0.08),
            backgroundColor: "#2a2a2a",
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />

        {/* Volume buttons */}
        <div
          style={{
            position: "absolute",
            left: -3,
            top: Math.round(phoneHeight * 0.18),
            width: 3,
            height: Math.round(phoneHeight * 0.05),
            backgroundColor: "#2a2a2a",
            borderTopLeftRadius: 2,
            borderBottomLeftRadius: 2,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -3,
            top: Math.round(phoneHeight * 0.26),
            width: 3,
            height: Math.round(phoneHeight * 0.05),
            backgroundColor: "#2a2a2a",
            borderTopLeftRadius: 2,
            borderBottomLeftRadius: 2,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
