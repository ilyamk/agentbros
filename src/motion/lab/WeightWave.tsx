import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { Glyphs, useFittedFontSize } from "../text";
import { glyphWeight, splitGraphemes } from "../text-split";
import { progress, track } from "../timing";
import { ink, paper } from "./palette";

const WORD = "ТЯЖЕЛЕЕ";
const THIN = 90;
const HEAVY = 900;
const PEAK = 1000;

/** Variable weight as the event. The word is fitted at peak weight, so the wave can never overflow the frame. */
export const WeightWave: React.FC = () => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const side = 60;
  const fontSize = useFittedFontSize({
    text: WORD,
    withinWidth: width - side * 2,
    fontFamily: cyrillicCondensedFont,
    fontWeight: PEAK,
  });
  const count = splitGraphemes(WORD).length;
  const front = track(frame, [
    { at: 6, value: -1.5 },
    { at: 44, value: count + 1.5, curve: "drift" },
  ]);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink, justifyContent: "center", paddingLeft: side }}>
      {fontSize === null ? null : (
        <Glyphs
          text={WORD}
          style={{ fontFamily: cyrillicCondensedFont, fontSize, lineHeight: 1 }}
          glyph={({ index }) => {
            const passed = progress(front - index, 0, 1.5, "drift");
            const settled = THIN + (HEAVY - THIN) * passed;
            return { fontWeight: Math.max(settled, glyphWeight(index, front, 1.8, THIN, PEAK)) };
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: side,
          right: side,
          bottom: 56,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: cyrillicGroteskFont,
          fontSize: 34,
          fontWeight: 500,
        }}
      >
        <span>Вес — тоже движение.</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          wght{" "}
          {String(
            Math.round(
              track(frame, [
                { at: 6, value: THIN },
                { at: 44, value: HEAVY, curve: "drift" },
              ]),
            ),
          ).padStart(3, "0")}
        </span>
      </div>
    </AbsoluteFill>
  );
};
