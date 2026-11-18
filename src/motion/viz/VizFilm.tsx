import React from "react";
import { z } from "zod";
import { AbsoluteFill, Sequence } from "remotion";
import { VizPlanSchema, VizBindingSchema, VizFormatSchema } from "../../types/viz";
import { VizScene } from "./VizScene";
export { VizFilmPropsSchema as vizFilmPropsSchema } from "../../types/viz";
import type { VizFilmProps } from "../../types/viz";
export type { VizFilmProps } from "../../types/viz";
export const VizFilm: React.FC<VizFilmProps> = (props) => (
  <AbsoluteFill style={{ backgroundColor: "#10121a" }}>
    {props.shots.map((shot) => (
      <Sequence key={shot.id} from={shot.startFrame} durationInFrames={shot.durationInFrames}>
        <VizScene plans={shot.plans} vizBinding={shot.vizBinding} ground="opaque" />
      </Sequence>
    ))}
  </AbsoluteFill>
);
