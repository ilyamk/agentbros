import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { FittedLine } from "../text";
import { cutTiming, whipPan } from "../transitions";
import { progress } from "../timing";
import { bone, ink, paper, signal, ultramarine } from "./palette";
import { WHIP_FRAMES as WHIP, WHIP_LAYOUT } from "./reel-layout";

const Word: React.FC<{ text: string; bg: string; fg: string; note: string; align: "flex-start" | "flex-end" }> = ({
  text,
  bg,
  fg,
  note,
  align,
}) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const drift = 1 + frame * 0.0009;
  return (
    <AbsoluteFill
      style={{ backgroundColor: bg, color: fg, alignItems: align, justifyContent: "center", padding: "0 72px" }}
    >
      <div
        style={{
          transform: `scale(${drift})`,
          transformOrigin: align === "flex-start" ? "left center" : "right center",
        }}
      >
        <FittedLine
          text={text}
          withinWidth={width - 144}
          maxFontSize={560}
          fontFamily={cyrillicCondensedFont}
          fontWeight={850}
        >
          {(fontSize) => (
            <div
              style={{
                fontFamily: cyrillicCondensedFont,
                fontWeight: 850,
                fontSize,
                lineHeight: 0.9,
                whiteSpace: "pre",
              }}
            >
              {text}
            </div>
          )}
        </FittedLine>
      </div>
      <div
        style={{
          position: "absolute",
          left: 72,
          bottom: 60,
          fontFamily: cyrillicGroteskFont,
          fontSize: 34,
          fontWeight: 500,
          opacity: progress(frame, 8, 8),
        }}
      >
        {note}
      </div>
    </AbsoluteFill>
  );
};

/** One sentence across three whips. The blur is derived from the curve's speed on each frame, so it peaks mid-move. */
export const WhipSentence: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: ink }}>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={WHIP_LAYOUT.scenes[0]!.frames}>
        <Word text="СМАЗ" bg={ultramarine} fg={bone} note="Blur" align="flex-start" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={whipPan({ direction: "left" })} timing={cutTiming(WHIP)} />
      <TransitionSeries.Sequence durationInFrames={WHIP_LAYOUT.scenes[1]!.frames}>
        <Word text="СЧИТАЕТСЯ" bg={signal} fg={ink} note="is computed" align="flex-start" />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={whipPan({ direction: "left" })} timing={cutTiming(WHIP)} />
      <TransitionSeries.Sequence durationInFrames={WHIP_LAYOUT.scenes[2]!.frames}>
        <Word text="ИЗ СКОРОСТИ" bg={paper} fg={ink} note="from velocity" align="flex-start" />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
