import React from "react";
import { AbsoluteFill, Composition, registerRoot, Sequence } from "remotion";
import { binaryTextPreset, Decode } from "../library/kinetic/Decode";
import { blurTextPreset, MarkerHighlight } from "../library/typography/MarkerHighlight";
import { SentenceBuild, textGeneratePreset } from "../library/typography/SentenceBuild";

const BINARY = 60;
const GENERATE = 83;
const BLUR = 74;

const TextEntrancesReel: React.FC = () => (
  <AbsoluteFill>
    <Sequence durationInFrames={BINARY} name="Binary text">
      <Decode {...binaryTextPreset} />
      <div
        style={{
          position: "absolute",
          left: "10%",
          right: "10%",
          top: "17%",
          borderTop: "2px solid #8FA77B",
          color: "#F2F4DE",
          paddingTop: 24,
          font: "600 32px Arial, sans-serif",
          letterSpacing: "0.09em",
        }}
      >
        SIGNAL TO STORY
      </div>
    </Sequence>
    <Sequence from={BINARY} durationInFrames={GENERATE} name="Text generate effect">
      <SentenceBuild {...textGeneratePreset} />
    </Sequence>
    <Sequence from={BINARY + GENERATE} durationInFrames={BLUR} name="Blur text">
      <MarkerHighlight {...blurTextPreset} />
    </Sequence>
  </AbsoluteFill>
);

const Root: React.FC = () => (
  <Composition
    id="TextEntrancesReelV"
    component={TextEntrancesReel}
    durationInFrames={BINARY + GENERATE + BLUR}
    width={1080}
    height={1920}
    fps={30}
  />
);

registerRoot(Root);
