import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { FittedLine } from "../text";
import { activeCue, beatGrid, cuePulse } from "../timing";
import { ink, paper, signal } from "./palette";

const BPM = 120;
const WORDS = [
  { text: "НА", bg: ink, fg: paper },
  { text: "БИТ,", bg: signal, fg: ink },
  { text: "А", bg: ink, fg: paper },
  { text: "НЕ", bg: ink, fg: paper },
  { text: "ОКОЛО.", bg: paper, fg: ink },
] as const;

/** Beat cues from BPM: each word cuts in on its frame with a small accent, and the ruler shows the same cues. */
export const BeatLine: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const cues = beatGrid(fps, BPM, WORDS.length + 1);
  const cue = activeCue(cues, frame) ?? cues.at(-1)!;
  const index = Math.min(cues.indexOf(cue), WORDS.length - 1);
  const word = WORDS[index]!;
  const accent = 1 + 0.05 * cuePulse(cue, frame, 8);
  const side = 72;
  const rulerWidth = width - side * 2;
  const playhead = Math.min(frame / cues.at(-1)!.to, 1);
  return (
    <AbsoluteFill style={{ backgroundColor: word.bg, color: word.fg, alignItems: "center", justifyContent: "center" }}>
      <div style={{ transform: `scale(${accent})`, marginTop: -60 }}>
        <FittedLine
          key={word.text}
          text={word.text}
          withinWidth={rulerWidth}
          maxFontSize={760}
          fontFamily={cyrillicCondensedFont}
          fontWeight={900}
        >
          {(fontSize) => (
            <div style={{ fontFamily: cyrillicCondensedFont, fontWeight: 900, fontSize, lineHeight: 0.9 }}>
              {word.text}
            </div>
          )}
        </FittedLine>
      </div>
      <div
        style={{
          position: "absolute",
          left: side,
          width: rulerWidth,
          bottom: 60,
          height: 62,
          fontFamily: cyrillicGroteskFont,
          fontSize: 26,
          fontWeight: 500,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 2,
            backgroundColor: word.fg,
            opacity: 0.35,
          }}
        />
        {cues.map((c) => {
          const hit = cuePulse(c, frame, 10);
          return (
            <div
              key={c.id}
              style={{
                position: "absolute",
                left: (c.from / cues.at(-1)!.to) * rulerWidth,
                bottom: 0,
                width: 4,
                marginLeft: -2,
                height: 22 + hit * 26,
                backgroundColor: word.fg,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 12,
                  bottom: 24,
                  whiteSpace: "pre",
                  fontVariantNumeric: "tabular-nums",
                  opacity: frame >= c.from ? 1 : 0.4,
                }}
              >
                {c.from}
              </div>
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            left: playhead * rulerWidth,
            bottom: -5,
            width: 12,
            height: 12,
            marginLeft: -6,
            borderRadius: 6,
            backgroundColor: word.fg,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
