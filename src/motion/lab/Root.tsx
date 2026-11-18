import React from "react";
import { Composition } from "remotion";
import { AlphabetStagger } from "./AlphabetStagger";
import { BeatLine } from "./BeatLine";
import { CurveBook } from "./CurveBook";
import { EditorialMask } from "./EditorialMask";
import { GlyphSeed } from "./GlyphSeed";
import {
  CaptionDemo,
  CollageDemo,
  DollyDemo,
  ElasticDemo,
  GlyphRiseDemo,
  GrowDemo,
  LightDemo,
  LightPathDemo,
  MorphDemo,
  RaceDemo,
  RadialDemo,
  ScrambleDemo,
  SlamDemo,
  SmearDemo,
  TypingDemo,
} from "./KineticDemos";
import { KINETIC_LAB_FRAMES, KineticLab } from "./KineticLab";
import { LabReel } from "./LabReel";
import { PhonePlayback } from "./PhonePlayback";
import { PlayWipe } from "./PlayWipe";
import { PosterStack } from "./PosterStack";
import { PLAY_FRAMES, REEL_LAYOUT, WHIP_LAYOUT } from "./reel-layout";
import { ShotListCamera } from "./ShotListCamera";
import { ShutterStop } from "./ShutterStop";
import { StudioDemo } from "./StudioDemo";
import { Sunrise } from "./Sunrise";
import { TextBloomDemo } from "./TextBloomDemo";
import { WeightWave } from "./WeightWave";
import { WhipSentence } from "./WhipSentence";

const V = { width: 1080, height: 1920, fps: 30 };
const L = { width: 1920, height: 1080, fps: 30 };

export const LabRoot: React.FC = () => (
  <>
    <Composition id="LabReel" component={LabReel} durationInFrames={REEL_LAYOUT.totalFrames} {...L} />
    <Composition id="PosterStackV" component={PosterStack} durationInFrames={110} {...V} />
    <Composition id="PosterStackL" component={PosterStack} durationInFrames={110} {...L} />
    <Composition id="EditorialMaskV" component={EditorialMask} durationInFrames={100} {...V} />
    <Composition id="EditorialMaskL" component={EditorialMask} durationInFrames={100} {...L} />
    <Composition id="AlphabetStaggerL" component={AlphabetStagger} durationInFrames={150} {...L} />
    <Composition id="GlyphSeedV" component={GlyphSeed} durationInFrames={90} {...V} />
    <Composition id="GlyphSeedL" component={GlyphSeed} durationInFrames={90} {...L} />
    <Composition id="WeightWaveL" component={WeightWave} durationInFrames={90} {...L} />
    <Composition id="CurveBookL" component={CurveBook} durationInFrames={90} {...L} />
    <Composition id="BeatLineL" component={BeatLine} durationInFrames={105} {...L} />
    <Composition id="WhipSentenceL" component={WhipSentence} durationInFrames={WHIP_LAYOUT.totalFrames} {...L} />
    <Composition id="PlayWipeL" component={PlayWipe} durationInFrames={PLAY_FRAMES} {...L} />
    <Composition id="ShutterStopL" component={ShutterStop} durationInFrames={60} {...L} />
    <Composition id="ShotListCameraL" component={ShotListCamera} durationInFrames={120} {...L} />
    <Composition id="StudioDemoL" component={StudioDemo} durationInFrames={130} {...L} />
    <Composition
      id="StudioScreenshotL"
      component={StudioDemo}
      defaultProps={{ source: "screenshot" as const }}
      durationInFrames={110}
      {...L}
    />
    <Composition id="PhonePlaybackV" component={PhonePlayback} durationInFrames={110} {...V} />
    <Composition id="SunriseL" component={Sunrise} durationInFrames={150} {...L} />
    <Composition id="TextBloomL" component={TextBloomDemo} durationInFrames={40} {...L} />
    <Composition id="KineticLab" component={KineticLab} durationInFrames={KINETIC_LAB_FRAMES} {...L} />
    <Composition id="SmearDemoL" component={SmearDemo} durationInFrames={90} {...L} />
    <Composition id="SlamDemoL" component={SlamDemo} durationInFrames={120} {...L} />
    <Composition id="GlyphRiseDemoL" component={GlyphRiseDemo} durationInFrames={80} {...L} />
    <Composition id="DollyDemoL" component={DollyDemo} durationInFrames={150} {...L} />
    <Composition id="ElasticDemoL" component={ElasticDemo} durationInFrames={120} {...L} />
    <Composition id="ScrambleDemoL" component={ScrambleDemo} durationInFrames={60} {...L} />
    <Composition id="CaptionDemoL" component={CaptionDemo} durationInFrames={110} {...L} />
    <Composition id="TypingDemoL" component={TypingDemo} durationInFrames={90} {...L} />
    <Composition id="MorphDemoL" component={MorphDemo} durationInFrames={130} {...L} />
    <Composition id="GrowDemoL" component={GrowDemo} durationInFrames={100} {...L} />
    <Composition id="CollageDemoL" component={CollageDemo} durationInFrames={140} {...L} />
    <Composition id="RaceDemoL" component={RaceDemo} durationInFrames={120} {...L} />
    <Composition id="RadialDemoL" component={RadialDemo} durationInFrames={90} {...L} />
    <Composition id="LightDemoL" component={LightDemo} durationInFrames={120} {...L} />
    <Composition id="LightPathDemoL" component={LightPathDemo} durationInFrames={110} {...L} />
  </>
);
