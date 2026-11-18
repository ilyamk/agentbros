import React from "react";
import { Composition, registerRoot } from "remotion";
import { VizFilm, vizFilmPropsSchema } from "./VizFilm";
const size = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] } as const;
const Root: React.FC = () => (
  <Composition
    id="VizFilm"
    component={VizFilm}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ format: "landscape" as const, shots: [] }}
    calculateMetadata={({ props }) => {
      const parsed = vizFilmPropsSchema.parse(props);
      const [width, height] = size[parsed.format];
      return {
        width,
        height,
        fps: 30,
        durationInFrames: Math.max(...parsed.shots.map((s) => s.startFrame + s.durationInFrames)),
      };
    }}
  />
);
registerRoot(Root);
