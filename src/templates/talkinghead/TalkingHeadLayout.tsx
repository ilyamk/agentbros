import React from "react";
import type { ReactNode, CSSProperties } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";

export type CaptionStyle = {
  activeColor: string;
  inactiveColor: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  wordsInView: number;
};

export type TalkingHeadConfig = {
  /** Border/frame colour surrounding both panels (default: peach #F4B89C) */
  borderColor: string;
  /** Padding between outer frame edge and panel content (px) */
  outerPadding: number;
  /** Gap between left and right panels (px) */
  panelGap: number;
  /** Panel corner radius (px) */
  borderRadius: number;
  /** Right panel width as a fraction of total inner width (0–1) */
  rightPanelWidthFraction: number;
  /** Caption styling */
  captionStyle: CaptionStyle;
};

export const DEFAULT_TALKING_HEAD_CONFIG: TalkingHeadConfig = {
  borderColor: "#F4B89C",
  outerPadding: 40,
  panelGap: 24,
  borderRadius: 28,
  rightPanelWidthFraction: 0.32,
  captionStyle: {
    activeColor: "#FFE600",
    inactiveColor: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 8,
    fontSize: 56,
    wordsInView: 3,
  },
};

export type TalkingHeadLayoutProps = {
  config: TalkingHeadConfig;
  /** Right panel — the presenter video */
  presenterChildren: ReactNode;
  /** Left panel — chart, meme, graphic, etc. */
  leftChildren: ReactNode;
  /** Optional karaoke captions overlay */
  captionsChildren?: ReactNode;
  /** Left panel background colour (default: #FFFFFF) */
  leftBackground?: string;
};

export const TalkingHeadLayout: React.FC<TalkingHeadLayoutProps> = ({
  config,
  presenterChildren,
  leftChildren,
  captionsChildren,
  leftBackground = "#FFFFFF",
}) => {
  const { width, height } = useVideoConfig();

  const { borderColor, outerPadding, panelGap, borderRadius, rightPanelWidthFraction } = config;

  const innerWidth = width - outerPadding * 2;
  const innerHeight = height - outerPadding * 2;

  const panelStyle: CSSProperties = {
    borderRadius,
    overflow: "hidden",
    position: "relative",
    flexShrink: 0,
  };

  const isVertical = height >= width;
  // Square needs room for both panels; keep the presenter in the lower half.

  if (isVertical) {
    // Stacked layout for 9:16 (Reels / Stories / TikTok).
    // Top: full-width visual panel.
    // Bottom: square 1:1 presenter (cropped from the 9:16 source via objectFit: cover).
    // The visual panel takes whatever vertical space remains.
    const presenterSize = Math.min(innerWidth, Math.floor((innerHeight - panelGap) * 0.52)); // 1:1 square, full inner width
    const topPanelHeight = innerHeight - presenterSize - panelGap;

    return (
      <AbsoluteFill style={{ backgroundColor: borderColor }}>
        <div
          style={{
            position: "absolute",
            top: outerPadding,
            left: outerPadding,
            width: innerWidth,
            height: innerHeight,
            display: "flex",
            flexDirection: "column",
            gap: panelGap,
          }}
        >
          {/* Top — visual panel (chart/text/aiImage/sketch) */}
          <div
            style={{
              ...panelStyle,
              width: innerWidth,
              height: topPanelHeight,
              backgroundColor: leftBackground,
            }}
          >
            {leftChildren}
          </div>

          {/* Bottom — square presenter, cropped from 9:16 source */}
          <div
            style={{
              ...panelStyle,
              width: presenterSize,
              height: presenterSize,
              alignSelf: "center",
            }}
          >
            {presenterChildren}
          </div>
        </div>

        {/* Captions overlay — pinned just above the presenter square */}
        {captionsChildren != null && (
          <div
            style={{
              position: "absolute",
              bottom: outerPadding + presenterSize - 80,
              left: 0,
              width: "100%",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              pointerEvents: "none",
            }}
          >
            {captionsChildren}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // Side-by-side landscape layout (default — original behaviour).
  const rightPanelWidth = Math.round((innerWidth - panelGap) * rightPanelWidthFraction);
  const leftPanelWidth = innerWidth - rightPanelWidth - panelGap;

  return (
    <AbsoluteFill style={{ backgroundColor: borderColor }}>
      {/* Inner content row */}
      <div
        style={{
          position: "absolute",
          top: outerPadding,
          left: outerPadding,
          width: innerWidth,
          height: innerHeight,
          display: "flex",
          flexDirection: "row",
          gap: panelGap,
        }}
      >
        {/* Left visual panel */}
        <div
          style={{
            ...panelStyle,
            width: leftPanelWidth,
            height: innerHeight,
            backgroundColor: leftBackground,
          }}
        >
          {leftChildren}
        </div>

        {/* Right presenter panel */}
        <div
          style={{
            ...panelStyle,
            width: rightPanelWidth,
            height: innerHeight,
          }}
        >
          {presenterChildren}
        </div>
      </div>

      {/* Captions overlay — centred across the full frame, pinned 60px from bottom */}
      {captionsChildren != null && (
        <div
          style={{
            position: "absolute",
            bottom: 60,
            left: 0,
            width: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {captionsChildren}
        </div>
      )}
    </AbsoluteFill>
  );
};
