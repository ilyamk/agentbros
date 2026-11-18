import React from "react";
import { AbsoluteFill, Composition, Img, registerRoot, staticFile } from "remotion";
import { StyledCaptions } from "../../src/motion/library/captions/Captions";
import { CAPTION_PRESET_IDS, CAPTION_PRESETS, captionStyleSchema } from "../../src/motion/library/captions/style";
import words from "./caption-qa-words.json";

/**
 * QA only: every caption preset over real interview frames (served from `--public-dir out/qa/captions-pro/public`)
 * with the recording's own transcript, 0.7–12 s. Source: "Interview on extreme weather with physical geographer
 * Hannah Cloke – The Royal Society", The Royal Society, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0),
 * via Wikimedia Commons; see CREDITS.md.
 */
const FOOTAGE = ["yellow", "white", "wide"] as const;

/** `legibility` and `positions`: levels and positions chosen from the footage by `chooseLevel`, passed as input props, as `captions:place` records them. */
const Qa: React.FC<{ preset: string; footage: string; legibility?: unknown[]; positions?: unknown[] }> = ({ preset, footage, legibility = [], positions = [] }) => {
  const props = captionStyleSchema.parse({ ...CAPTION_PRESETS[preset as keyof typeof CAPTION_PRESETS], words, startOffsetSec: 0.7, legibility, positions });
  return (
    <AbsoluteFill>
      <Img src={staticFile(`footage/${footage}.jpg`)} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover" }} />
      <StyledCaptions {...props} />
    </AbsoluteFill>
  );
};

registerRoot(() => (
  <>
    {CAPTION_PRESET_IDS.flatMap((preset) =>
      FOOTAGE.map((footage) => (
        <Composition key={`${preset}-${footage}`} id={`QA-${preset}-${footage}`} component={Qa} width={1080} height={1920} fps={30} durationInFrames={340} defaultProps={{ preset, footage }} />
      )),
    )}
  </>
));
