import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Img, staticFile } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";

type Props = Extract<LeftPanel, { kind: "aiImage" }>;

export const AIImagePanel: React.FC<Props> = ({
  imageUrl,
  kenBurns,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);

  // Stronger Ken Burns than ScreenshotPanel: 1.0→1.15 over duration
  const scale = kenBurns
    ? interpolate(frame, [0, durationInFrames], [1.0, 1.15], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  return (
    <AbsoluteFill style={{ background: "#000000", overflow: "hidden", ...entranceStyle }}>
      <Img
        src={imageUrl.startsWith("http") ? imageUrl : staticFile(imageUrl)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  );
};
