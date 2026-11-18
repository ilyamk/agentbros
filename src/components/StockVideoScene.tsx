import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, staticFile } from "remotion";
import { Video } from "@remotion/media";
import { displayFont, primaryFont } from "../lib/fonts";
import { typography, spacing, animation, captionLayout } from "../lib/design-tokens";
import type { FormatKey } from "../lib/design-tokens";

type StockVideoSceneProps = {
  headline: string;
  subtext?: string;
  accentColor: string;
  textColor: string;
  captionReservePx?: number;
  videoUrl: string;
  videoTiming?: { trimBefore: number; trimAfter: number; playbackRate: number };
};

export const StockVideoScene: React.FC<StockVideoSceneProps> = ({
  headline,
  subtext,
  accentColor,
  textColor,
  captionReservePx = 0,
  videoUrl,
  videoTiming,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height, width } = useVideoConfig();
  const fmt: FormatKey =
    captionReservePx > 0
      ? height > width
        ? "vertical"
        : width > height
          ? "landscape"
          : "square"
      : height > width
        ? "vertical"
        : "square";
  const headTypo = captionReservePx > 0 ? typography.bigTitle[fmt] : typography.headline[fmt];
  const subTypo = typography.accentSub[fmt];

  // Subtle zoom on video background (Ken Burns)
  const videoScale = interpolate(frame, [0, durationInFrames], [1, 1.08], {
    extrapolateRight: "clamp",
  });

  // Frame 0-12: Headline fade + scale
  const headlineOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headlineScale = interpolate(spring({ frame, fps, config: animation.smooth }), [0, 1], [0.85, 1]);

  // Short timeline scenes need a readable CTA before their exit fade.
  const subtextOpacity = interpolate(
    frame,
    captionReservePx > 0 ? [captionLayout.mediaSubtextReveal.start, captionLayout.mediaSubtextReveal.end] : [20, 32],
    [0, 1],
    {
      extrapolateRight: "clamp",
      extrapolateLeft: "clamp",
    },
  );

  // Exit fade — last 9 frames
  const exitOpacity = interpolate(frame, [durationInFrames - 9, durationInFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: exitOpacity }}>
      {/* Full-bleed stock video background */}
      <AbsoluteFill
        style={{
          transform: `scale(${videoScale})`,
          transformOrigin: "center center",
        }}
      >
        <Video
          objectFit="cover"
          src={/^https?:\/\//.test(videoUrl) ? videoUrl : staticFile(videoUrl)}
          {...videoTiming}
          style={{ width: "100%", height: "100%" }}
          volume={0}
          muted
        />
      </AbsoluteFill>

      {/* Dark gradient overlay for text readability */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0.05) 55%, transparent 100%)",
        }}
      />

      {/* Text content — bottom-aligned */}
      <AbsoluteFill
        className="flex flex-col items-center justify-end"
        style={{
          paddingLeft: spacing.sidePadding[fmt],
          paddingRight: spacing.sidePadding[fmt],
          paddingBottom:
            captionReservePx > 0
              ? spacing.safeBottom[fmt] + captionReservePx
              : fmt === "vertical"
                ? spacing.safeBottom.vertical + 40
                : spacing.safeBottom.square + 20,
        }}
      >
        {/* Headline */}
        <div
          data-avc-text-role="media-headline"
          style={{
            transform: `scale(${headlineScale})`,
            opacity: headlineOpacity,
            fontFamily: displayFont,
            fontSize: headTypo.fontSize,
            fontWeight: headTypo.fontWeight,
            color: captionReservePx > 0 ? captionLayout.mediaTextColor : textColor,
            textAlign: "center",
            lineHeight: headTypo.lineHeight,
            letterSpacing: "letterSpacing" in headTypo ? (headTypo as any).letterSpacing : -1,
            whiteSpace: "pre-line",
            textShadow: "0 4px 30px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {headline}
        </div>

        {/* Subtext */}
        {subtext && (
          <div
            data-avc-text-role="media-subtext"
            style={{
              opacity: subtextOpacity,
              fontFamily: primaryFont,
              fontSize: subTypo.fontSize,
              fontWeight: subTypo.fontWeight,
              color: captionReservePx > 0 ? captionLayout.mediaTextColor : accentColor,
              textAlign: "center",
              marginTop: spacing.headlineGap + 8,
              letterSpacing: subTypo.letterSpacing,
              textTransform: subTypo.textTransform,
              lineHeight: subTypo.lineHeight,
              textShadow: "0 2px 16px rgba(0,0,0,0.5)",
            }}
          >
            {subtext}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
