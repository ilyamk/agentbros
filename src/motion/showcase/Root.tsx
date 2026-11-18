import React from "react";
import { Composition } from "remotion";
import { SHOWCASE_LAYOUT } from "./layout";
import { RoastDark, RoastGreen } from "./scenes/Roast";
import { Showcase } from "./Showcase";

const L = { width: 1920, height: 1080, fps: 30 };

export const ShowcaseRoot: React.FC = () => (
  <>
    <Composition id="Showcase" component={Showcase} durationInFrames={SHOWCASE_LAYOUT.totalFrames} {...L} />
    <Composition id="ShowcaseRoastGreen" component={RoastGreen} durationInFrames={1} {...L} />
    <Composition id="ShowcaseRoastDark" component={RoastDark} durationInFrames={1} {...L} />
  </>
);
