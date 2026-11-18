import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill } from "remotion";
import { cutTiming, shapeWipe, whipPan } from "../transitions";
import { BeatLine } from "./BeatLine";
import { GlyphSeed } from "./GlyphSeed";
import { ink } from "./palette";
import { PlayWipe } from "./PlayWipe";
import { PosterStack } from "./PosterStack";
import { CIRCLE_FRAMES, reelFrames, WHIP_FRAMES } from "./reel-layout";
import { ShotListCamera } from "./ShotListCamera";
import { ShutterStop } from "./ShutterStop";
import { STUDIO_CLICK_POINT, StudioDemo } from "./StudioDemo";
import { Sunrise } from "./Sunrise";
import { WeightWave } from "./WeightWave";
import { WhipSentence } from "./WhipSentence";

/**
 * The toolkit as one argument: a frame is a function of its number, so blur, rhythm, randomness and weight can all be
 * computed, then shown working in a real interface. Scene lengths live in reel-layout, shared with the on-screen table.
 */
export const LabReel: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: ink }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={reelFrames("poster")}>
        <PosterStack />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={whipPan({ direction: "left" })} timing={cutTiming(WHIP_FRAMES)} />
      <TransitionSeries.Sequence durationInFrames={reelFrames("whip")}>
        <WhipSentence />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("beat")}>
        <BeatLine />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("glyph")}>
        <GlyphSeed />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("weight")}>
        <WeightWave />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("shutter")}>
        <ShutterStop />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("camera")}>
        <ShotListCamera />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("play")}>
        <PlayWipe />
      </TransitionSeries.Sequence>
      <TransitionSeries.Sequence durationInFrames={reelFrames("studio")}>
        <StudioDemo />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={shapeWipe({
          shape: "circle",
          originX: STUDIO_CLICK_POINT.x,
          originY: STUDIO_CLICK_POINT.y,
          fromSize: 8,
          curve: "drift",
        })}
        timing={cutTiming(CIRCLE_FRAMES)}
      />
      <TransitionSeries.Sequence durationInFrames={reelFrames("sunrise")}>
        <Sunrise />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
