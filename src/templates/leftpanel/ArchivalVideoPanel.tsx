import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { Video } from "@remotion/media";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";

type Props = Extract<LeftPanel, { kind: "archival" }>;

export const ArchivalVideoPanel: React.FC<Props> = ({
  videoUrl,
  startFrom,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);

  const trimBefore = Math.round(startFrom * fps);

  return (
    <AbsoluteFill style={{ ...entranceStyle }}>
      <Video
        objectFit="cover"
        src={videoUrl.startsWith("http") ? videoUrl : staticFile(videoUrl)}
        trimBefore={trimBefore}
        muted
        style={{ width: "100%", height: "100%" }}
      />
    </AbsoluteFill>
  );
};
