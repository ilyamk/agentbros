import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill } from "remotion";
import { cutTiming, shapeWipe, whipPan } from "../transitions";
import { sceneFrames, WHIP, WIPE } from "./layout";
import { roast } from "./palette";
import { Ending } from "./scenes/Ending";
import { ORDER_WIPE_POINT, OrderScene } from "./scenes/OrderScene";
import { Pour } from "./scenes/Pour";
import { Roast } from "./scenes/Roast";
import { Shelf } from "./scenes/Shelf";
import { Monday, Thursday, Tuesday, Wednesday } from "./scenes/Week";

/** A launch film for an invented roaster: the shelf's age, the week without roasting, the order, the roast, the pour. */
export const Showcase: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: roast }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("shelf")}>
        <Shelf />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={whipPan({ direction: "left" })} timing={cutTiming(WHIP)} />
      <TransitionSeries.Sequence durationInFrames={sceneFrames("monday")}>
        <Monday />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("tuesday")}>
        <Tuesday />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("wednesday")}>
        <Wednesday />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("thursday")}>
        <Thursday />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("order")}>
        <OrderScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={shapeWipe({
          shape: "circle",
          originX: ORDER_WIPE_POINT.x,
          originY: ORDER_WIPE_POINT.y,
          fromSize: 40,
          curve: "drift",
        })}
        timing={cutTiming(WIPE)}
      />
      <TransitionSeries.Sequence durationInFrames={sceneFrames("roast")}>
        <Roast />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={sceneFrames("pour")}>
        <Pour />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={whipPan({ direction: "up" })} timing={cutTiming(WHIP)} />
      <TransitionSeries.Sequence durationInFrames={sceneFrames("ending")}>
        <Ending />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
