import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";
import { typography } from "../../lib/design-tokens";
import { displayFont } from "../../lib/fonts";
import { useCanvasMood, canvasBg, canvasFg } from "./_canvas";

type Props = Extract<LeftPanel, { kind: "text" }>;

const ALLOWED_SIZES = ["headline", "bigTitle", "hero"] as const;
type AllowedSize = (typeof ALLOWED_SIZES)[number];

export const TextPanel: React.FC<Props> = ({
  text,
  align,
  size,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);

  // Safe lookup — size is constrained by schema to the three allowed values
  const safeSize: AllowedSize = ALLOWED_SIZES.includes(size as AllowedSize) ? (size as AllowedSize) : "bigTitle";

  const typo = typography[safeSize].landscape;
  const mood = useCanvasMood();

  return (
    <AbsoluteFill
      style={{
        background: canvasBg(mood),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 48,
        ...entranceStyle,
      }}
    >
      <div
        style={{
          fontFamily: displayFont,
          fontSize: typo.fontSize,
          fontWeight: typo.fontWeight,
          lineHeight: typo.lineHeight,
          color: canvasFg(mood),
          textAlign: align,
          whiteSpace: "pre-line",
          width: "100%",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
