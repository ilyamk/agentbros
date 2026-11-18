import React from "react";
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from "remotion";

const Fade: React.FC = () => {
  const shade = Math.round(interpolate(useCurrentFrame(), [0, 29], [0, 255]));
  return <AbsoluteFill style={{ backgroundColor: `rgb(${shade},${shade},${shade})` }} />;
};

registerRoot(() => <Composition id="Fade" component={Fade} width={64} height={64} fps={30} durationInFrames={30} />);
