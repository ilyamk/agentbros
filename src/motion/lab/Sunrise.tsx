import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { FilmGrain } from "../fx";
import { FittedLine, MaskedLine } from "../text";
import { MatchCut } from "../transitions";
import { progress, track } from "../timing";
import { ink, paper, signal } from "./palette";

export const CUT_AT = 44;

const HORIZON = 0.66;
const DUSK = "#1A0E0B";
/** Baseline of ТОЧКУ in this layout, so the dot sits as its full stop. */
const STOP_BASELINE = 943;

const SunGlow: React.FC<{ sunX: number; sunY: number }> = ({ sunX, sunY }) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  const glow = 620 + frame * 1.6;
  return (
    <AbsoluteFill style={{ backgroundColor: DUSK }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle ${glow * 2}px at ${sunX}px ${sunY}px, rgba(255,110,50,0.78) 0%, rgba(214,70,34,0.56) 18%, rgba(150,44,26,0.36) 36%, rgba(90,28,18,0.2) 56%, rgba(48,20,14,0.08) 78%, rgba(26,14,11,0) 100%)`,
        }}
      />
      <AbsoluteFill style={{ top: height * HORIZON, backgroundColor: "#0B0706" }} />
    </AbsoluteFill>
  );
};

/** The dot's radius and centre through the whole shot. It leaves the full stop and never stops moving across the cut. */
const dotTrack = (frame: number, width: number, height: number) => {
  const startD = 112;
  const startX = 72 + width * 0.56 + 34 + startD / 2;
  const startY = STOP_BASELINE - startD / 2;
  const sunD = height * 0.5;
  const sunX = width * 0.66;
  const sunY =
    height * HORIZON -
    sunD / 2 -
    6 -
    track(frame, [
      { at: CUT_AT + 16, value: 0 },
      { at: CUT_AT + 180, value: 50 },
    ]);
  const move = progress(frame, CUT_AT - 13, 30, "inOut");
  return {
    d: startD + (sunD - startD) * move,
    x: startX + (sunX - startX) * move,
    y: startY + (sunY - startY) * move,
    sunX,
    sunY,
  };
};

const Stop: React.FC = () => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const side = 72;
  const lines = ["ПОСТАВИТЬ", "ТОЧКУ"];
  return (
    <AbsoluteFill
      style={{ backgroundColor: ink, color: paper, justifyContent: "flex-end", padding: `0 ${side}px 70px` }}
    >
      {lines.map((line, i) => (
        <FittedLine
          key={line}
          text={line}
          withinWidth={i === 0 ? width - side * 2 : width * 0.56}
          fontFamily={cyrillicCondensedFont}
          fontWeight={800}
        >
          {(fontSize) => (
            <MaskedLine
              reveal={progress(frame, i * 5, 20)}
              lineHeight={0.86}
              style={{ fontFamily: cyrillicCondensedFont, fontWeight: 800, fontSize, marginTop: i ? 14 : 0 }}
            >
              {line}
            </MaskedLine>
          )}
        </FittedLine>
      ))}
    </AbsoluteFill>
  );
};

const Carry: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { d, x, y } = dotTrack(frame, width, height);
  const appear = progress(frame, 14, 14, "overshoot");
  return (
    <>
      <Sequence from={CUT_AT} layout="none">
        <Dawn />
      </Sequence>
      <div
        style={{
          position: "absolute",
          left: x - d / 2,
          top: y - d / 2,
          width: d,
          height: d,
          borderRadius: "50%",
          backgroundColor: signal,
          transform: `scale(${appear})`,
        }}
      />
    </>
  );
};

const Dawn: React.FC = () => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 72,
          top: height * HORIZON + 44,
          fontFamily: cyrillicCondensedFont,
          fontWeight: 800,
          fontSize: 190,
          lineHeight: 0.98,
          color: paper,
        }}
      >
        <MaskedLine reveal={progress(frame, 14, 22)} lineHeight={0.98}>
          И НАЧАТЬ СНАЧАЛА
        </MaskedLine>
      </div>
      <div
        style={{
          position: "absolute",
          right: 72,
          bottom: 60,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 500,
          fontSize: 30,
          color: paper,
          opacity: 0.7 * progress(frame, 30, 16),
        }}
      >
        Then begin again.
      </div>
    </>
  );
};

const Dusk: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { sunX, sunY } = dotTrack(frame + CUT_AT, width, height);
  return <SunGlow sunX={sunX} sunY={sunY} />;
};

/** Match cut: the full stop keeps moving through a 0-frame cut and becomes the sun. Grain holds the dark ramp together. */
export const Sunrise: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: ink }}>
    <MatchCut cutAt={CUT_AT} before={<Stop />} after={<Dusk />} carry={<Carry />} />
    <Sequence from={CUT_AT} layout="none">
      <FilmGrain seed="sunrise" opacity={0.22} frequency={0.72} />
    </Sequence>
  </AbsoluteFill>
);
