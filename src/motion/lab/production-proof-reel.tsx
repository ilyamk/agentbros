import { Audio } from "@remotion/media";
import type React from "react";
import { AbsoluteFill, Composition, registerRoot, Sequence, Series, staticFile } from "remotion";
import { BarsFormNumber, barsFormNumberCues, barsFormNumberDefaults } from "../library/data/BarsFormNumber";
import {
  PrintRegistration,
  printRegistrationCues,
  printRegistrationDefaults,
} from "../library/effects/PrintRegistration";
import { WaveformWords, waveformWordsDefaults } from "../library/typography/WaveformWords";
import { AcceptRevision, acceptRevisionCues, acceptRevisionDefaults } from "../library/ui/AcceptRevision";
import { DeviceHandoff, deviceHandoffCues, deviceHandoffDefaults } from "../library/ui/DeviceHandoff";
import { EvidenceScroll, evidenceScrollCues, evidenceScrollDefaults } from "../library/ui/EvidenceScroll";
import { InspectorGeometry, inspectorGeometryCues, inspectorGeometryDefaults } from "../library/ui/InspectorGeometry";
import { VariationSelect, variationSelectCues, variationSelectDefaults } from "../library/ui/VariationSelect";
import type { Cue } from "../library/types";

const PRINT = 70;
const INSPECT = 98;
const REVISION = 96;
const EVIDENCE = 102;
const VARIATIONS = 100;
const DEVICE = 94;
const NUMBER = 85;
const WORDS = 112;

const total = PRINT + INSPECT + REVISION + EVIDENCE + VARIATIONS + DEVICE + NUMBER + WORDS;
const cues: Array<{ start: number; cues: Cue[] }> = [
  { start: 0, cues: printRegistrationCues(printRegistrationDefaults) },
  { start: PRINT, cues: inspectorGeometryCues(inspectorGeometryDefaults) },
  { start: PRINT + INSPECT, cues: acceptRevisionCues(acceptRevisionDefaults) },
  { start: PRINT + INSPECT + REVISION, cues: evidenceScrollCues(evidenceScrollDefaults) },
  { start: PRINT + INSPECT + REVISION + EVIDENCE, cues: variationSelectCues(variationSelectDefaults) },
  { start: PRINT + INSPECT + REVISION + EVIDENCE + VARIATIONS, cues: deviceHandoffCues(deviceHandoffDefaults) },
  { start: total - WORDS - NUMBER, cues: barsFormNumberCues(barsFormNumberDefaults) },
];

type ReelProps = { sound: boolean; levels: number[] };
const ProductionProofReel: React.FC<ReelProps> = ({ sound, levels }) => (
  <AbsoluteFill>
    <Series>
      <Series.Sequence durationInFrames={PRINT} name="Four-colour registration">
        <PrintRegistration {...printRegistrationDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={INSPECT} name="Control drives geometry">
        <InspectorGeometry {...inspectorGeometryDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={REVISION} name="Accept the revision">
        <AcceptRevision {...acceptRevisionDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={EVIDENCE} name="Evidence settles">
        <EvidenceScroll {...evidenceScrollDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={VARIATIONS} name="Variation selection">
        <VariationSelect {...variationSelectDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={DEVICE} name="Device continuity">
        <DeviceHandoff {...deviceHandoffDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={NUMBER} name="Bars become a number">
        <BarsFormNumber {...barsFormNumberDefaults} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={WORDS} name="Sound leads the words">
        <WaveformWords {...waveformWordsDefaults} levels={levels.length ? levels : waveformWordsDefaults.levels} />
      </Series.Sequence>
    </Series>
    {sound ? (
      <>
        {cues.flatMap(({ start, cues: list }) =>
          list
            .filter(({ sfx }) => sfx && sfx !== "none")
            .map(({ frame, sfx }) => (
              <Sequence key={`${start}-${frame}`} from={start + frame} layout="none">
                <Audio
                  src={staticFile(`projects/production-motion/assets/sfx/${sfx}.wav`)}
                  volume={sfx === "whoosh" ? 0.24 : 0.36}
                />
              </Sequence>
            )),
        )}
        <Sequence from={total - WORDS} layout="none">
          <Audio src={staticFile("projects/production-motion/assets/sfx/words.wav")} volume={0.61} />
        </Sequence>
      </>
    ) : null}
  </AbsoluteFill>
);

const Root: React.FC = () => (
  <Composition
    id="ProductionProofReelL"
    component={ProductionProofReel}
    defaultProps={{ sound: false, levels: [] }}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={total}
  />
);
registerRoot(Root);
