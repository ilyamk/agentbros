import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont, cyrillicWideFont } from "../../lib/fonts-cyrillic";
import { MaskedLines } from "../text";
import { cutTiming, shapeWipe } from "../transitions";
import { progress, track } from "../timing";
import { ink, paper, signal } from "./palette";
import { PLAY_AFTER, PLAY_HOLD, PLAY_WIPE } from "./reel-layout";

const BUTTON = { x: 1500, y: 540, size: 340, icon: 128 };

const Question: React.FC = () => {
  const frame = useCurrentFrame();
  const press = track(frame, [
    { at: PLAY_HOLD - 10, value: 1 },
    { at: PLAY_HOLD - 4, value: 0.93, curve: "expoOut" },
    { at: PLAY_HOLD, value: 1, curve: "overshoot" },
  ]);
  const appear = progress(frame, 10, 16, "overshoot");
  const triangle = Math.sqrt(3) / 2;
  const h = BUTTON.icon;
  const w = h * triangle;
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink }}>
      <MaskedLines
        lines={["Фигура —", "не украшение"]}
        from={0}
        duration={22}
        step={5}
        lineHeight={1.02}
        style={{
          position: "absolute",
          left: 104,
          top: 370,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 600,
          fontSize: 138,
          letterSpacing: "-0.035em",
        }}
      />
      <svg
        width={BUTTON.size}
        height={BUTTON.size}
        style={{
          position: "absolute",
          left: BUTTON.x - BUTTON.size / 2,
          top: BUTTON.y - BUTTON.size / 2,
          transform: `scale(${appear * press})`,
        }}
      >
        <circle cx={BUTTON.size / 2} cy={BUTTON.size / 2} r={BUTTON.size / 2} fill={ink} />
        <path
          d={`M ${BUTTON.size / 2 - w / 3} ${BUTTON.size / 2 - h / 2} L ${BUTTON.size / 2 + (2 * w) / 3} ${BUTTON.size / 2} L ${BUTTON.size / 2 - w / 3} ${BUTTON.size / 2 + h / 2} Z`}
          fill={signal}
        />
      </svg>
    </AbsoluteFill>
  );
};

const Answer: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: signal, color: ink }}>
    <MaskedLines
      lines={["ОНА НАЧИНАЕТСЯ", "ТАМ, КУДА", "УЖЕ СМОТРЯТ"]}
      from={PLAY_WIPE - 10}
      duration={22}
      step={5}
      lineHeight={1.08}
      style={{
        position: "absolute",
        left: 104,
        top: 210,
        fontFamily: cyrillicWideFont,
        fontWeight: 800,
        fontSize: 136,
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 104,
        bottom: 72,
        fontFamily: cyrillicGroteskFont,
        fontWeight: 500,
        fontSize: 34,
        color: ink,
      }}
    >
      The shape starts where the eye already is.
    </div>
  </AbsoluteFill>
);

/** The play icon itself becomes the wipe: the mask starts at the icon's exact position and size. */
export const PlayWipe: React.FC = () => (
  <AbsoluteFill>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={PLAY_HOLD + PLAY_WIPE}>
        <Question />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={shapeWipe({
          shape: "play",
          originX: BUTTON.x,
          originY: BUTTON.y,
          fromSize: BUTTON.icon,
          curve: "drift",
        })}
        timing={cutTiming(PLAY_WIPE)}
      />
      <TransitionSeries.Sequence durationInFrames={PLAY_WIPE + PLAY_AFTER}>
        <Answer />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>
);
