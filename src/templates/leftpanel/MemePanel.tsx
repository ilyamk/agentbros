import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, Img, staticFile } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";
import { useCanvasMood, canvasBg } from "./_canvas";

type Props = Extract<LeftPanel, { kind: "meme" }>;

export const MemePanel: React.FC<Props> = ({ imageUrl, bounce, entrance = "fade", kind: _kind, caption: _caption }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);
  const mood = useCanvasMood();

  // Continuous gentle bounce using sin — amplitude ±0.04 around 0.98
  const scale = bounce ? 0.98 + 0.04 * ((Math.sin(frame / 8) + 1) / 2) : 1;

  return (
    <AbsoluteFill
      style={{
        background: canvasBg(mood),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...entranceStyle,
      }}
    >
      <Img
        src={imageUrl.startsWith("http") ? imageUrl : staticFile(imageUrl)}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
    </AbsoluteFill>
  );
};
