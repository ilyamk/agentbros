import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { Shutter } from "../fx";
import { useFittedFontSize } from "../text";
import { progress, track, velocity } from "../timing";
import { ink, signal } from "./palette";

const WORD = "СКОРОСТЬ";
const SAMPLES = 16;
const ANGLE = 220;

const Stage: React.FC<{ fontSize: number }> = ({ fontSize }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const id = useId().replaceAll(":", "");
  const position = (f: number) =>
    track(f, [
      { at: 2, value: -width * 1.25 },
      { at: 16, value: 0, curve: "expoOut" },
      { at: 40, value: 26 },
      { at: 54, value: width * 1.3, curve: "expoIn" },
    ]);
  // Each sample is blurred by the gap to the next, so sixteen samples read as a continuous streak.
  const sampleGap = (Math.abs(velocity(position, frame)) * ANGLE) / 360 / SAMPLES;
  return (
    <AbsoluteFill style={{ backgroundColor: signal }}>
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id={id} x="-10%" width="120%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={`${sampleGap * 0.6} 0`} />
        </filter>
      </svg>
      <div
        style={{
          position: "absolute",
          left: 72,
          top: height / 2 - fontSize * 0.5,
          transform: `translateX(${position(frame)}px)`,
          filter: sampleGap > 0.5 ? `url(#${id})` : undefined,
          fontFamily: cyrillicCondensedFont,
          fontWeight: 900,
          fontSize,
          lineHeight: 1,
          color: ink,
          whiteSpace: "pre",
          letterSpacing: "-0.005em",
        }}
      >
        {WORD}
      </div>
    </AbsoluteFill>
  );
};

/** True sub-frame blur, mounted only while the word is moving. */
export const ShutterStop: React.FC = () => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  // Fitted once outside the shutter, because the samples mount and unmount with its windows.
  const fontSize = useFittedFontSize({
    text: WORD,
    withinWidth: width - 144,
    fontFamily: cyrillicCondensedFont,
    fontWeight: 900,
    letterSpacing: "-0.005em",
  });
  if (fontSize === null) return null;
  return (
    <AbsoluteFill>
      <Shutter
        windows={[
          [0, 22],
          [38, 56],
        ]}
        samples={SAMPLES}
        shutterAngle={ANGLE}
      >
        <Stage fontSize={fontSize} />
      </Shutter>
      <div
        style={{
          position: "absolute",
          left: 72,
          bottom: 60,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 500,
          fontSize: 34,
          color: ink,
          opacity: progress(frame, 16, 8) - progress(frame, 38, 6),
        }}
      >
        Настоящий затвор: шестнадцать проб на кадр.
      </div>
    </AbsoluteFill>
  );
};
