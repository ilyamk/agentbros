import React from "react";
import type { LeftPanel } from "../../types/video";
import { AnimatedLineChart } from "./AnimatedLineChart";
import { HandDrawnSketch } from "./HandDrawnSketch";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { TweetCard } from "./TweetCard";
import { MemePanel } from "./MemePanel";
import { AIImagePanel } from "./AIImagePanel";
import { ArchivalVideoPanel } from "./ArchivalVideoPanel";
import { TextPanel } from "./TextPanel";

export const LeftPanelRouter: React.FC<{ panel: LeftPanel }> = ({ panel }) => {
  switch (panel.kind) {
    case "chart":
      return <AnimatedLineChart {...panel} />;
    case "sketch":
      return <HandDrawnSketch {...panel} />;
    case "screenshot":
      return <ScreenshotPanel {...panel} />;
    case "tweet":
      return <TweetCard {...panel} />;
    case "meme":
      return <MemePanel {...panel} />;
    case "aiImage":
      return <AIImagePanel {...panel} />;
    case "archival":
      return <ArchivalVideoPanel {...panel} />;
    case "text":
      return <TextPanel {...panel} />;
  }
};
