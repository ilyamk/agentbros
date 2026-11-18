import React from "react";
import { registerRoot, Composition } from "remotion";
import { VizScene, type VizSceneProps } from "./VizScene";
const Root: React.FC = () => (
  <Composition
    id="VizScene"
    component={VizScene}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ plans: [], ground: "opaque" }}
    calculateMetadata={({ props }) => {
      const plan = (props as VizSceneProps).plans[0];
      if (!plan) throw new Error("Prepared plan required");
      return { width: plan.width, height: plan.height, durationInFrames: plan.spec.durationFrames, fps: 30 };
    }}
  />
);
registerRoot(Root);
