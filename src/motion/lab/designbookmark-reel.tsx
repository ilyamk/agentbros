import React from "react";
import { Composition, registerRoot } from "remotion";
import { DESIGNBOOKMARK_REEL_FRAMES, DesignBookmarkReel } from "./DesignBookmarkReel";

const Root: React.FC = () => (
  <Composition
    id="DesignBookmarkReelV"
    component={DesignBookmarkReel}
    defaultProps={{ sound: false }}
    durationInFrames={DESIGNBOOKMARK_REEL_FRAMES}
    width={1080}
    height={1920}
    fps={30}
  />
);

registerRoot(Root);
