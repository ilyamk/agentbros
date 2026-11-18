import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { primaryFont } from "../../lib/fonts";
import { TextBloom } from "../fx";
import { useFittedFontSize } from "../text";

const WORD = "Better way";

/** TextBloom: a line cuts on at frame 8 with a bloom flash that settles in 3 frames (ugc-app pass-through-type), then rests with a faint glow and chromatic edge. */
export const TextBloomDemo: React.FC = () => {
  const { width } = useVideoConfig();
  const fontSize = useFittedFontSize({
    text: WORD,
    withinWidth: width * 0.7,
    fontFamily: primaryFont,
    fontWeight: 700,
  });
  return (
    <AbsoluteFill style={{ backgroundColor: "#07080C" }}>
      <TextBloom colour="#7FA8FF" radius={22} strength={0.5} fringe={1.6} flashAt={8} flashFrames={3}>
        <Sequence from={8} layout="none">
          <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
            {fontSize === null ? null : (
              <div
                style={{
                  fontFamily: primaryFont,
                  fontWeight: 700,
                  fontSize,
                  color: "#F4F6FF",
                  letterSpacing: "-0.02em",
                  lineHeight: 1,
                }}
              >
                {WORD}
              </div>
            )}
          </AbsoluteFill>
        </Sequence>
      </TextBloom>
    </AbsoluteFill>
  );
};
