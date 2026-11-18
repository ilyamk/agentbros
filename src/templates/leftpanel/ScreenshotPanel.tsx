import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Img, staticFile } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";

type Props = Extract<LeftPanel, { kind: "screenshot" }>;

export const ScreenshotPanel: React.FC<Props> = ({
  imageUrl,
  kenBurns,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);

  const scale = kenBurns
    ? 1 +
      interpolate(frame, [0, durationInFrames], [0, 0.08], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  const translateX = kenBurns
    ? interpolate(frame, [0, durationInFrames], [0, -20], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden", ...entranceStyle }}>
      <Img
        src={imageUrl.startsWith("http") ? imageUrl : staticFile(imageUrl)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale}) translateX(${translateX}px)`,
          transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  );
};
