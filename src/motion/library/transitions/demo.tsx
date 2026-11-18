import { TransitionSeries } from "@remotion/transitions";
import type { TransitionPresentation } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { cutTiming } from "../../transitions";
import type { Cue } from "../types";

/** Preview scenes shared by the transition and camera items. Not for films: they only make a move visible. */

export const DEMO = {
  night: "#0A0C12",
  nightSurface: "#151925",
  nightLine: "rgba(255,255,255,0.08)",
  chalk: "#F2F0EA",
  muted: "rgba(242,240,234,0.56)",
  indigo: "#2F4BFF",
  paper: "#F3F2EE",
  ink: "#121212",
  inkMuted: "rgba(18,18,18,0.56)",
  ember: "#FF5A2C",
};

const useUnit = () => {
  const { width, height } = useVideoConfig();
  return { width, height, u: Math.min(width, height) / 1080, vertical: height > width };
};

const BARS = [0.34, 0.52, 0.41, 0.66, 0.58, 0.81, 0.74, 0.96];

/** Product card on a light ground: plain headline, one flat chart with a single accent bar. Drifts slowly so a frozen frame never reads as a still. */
export const DemoSceneA: React.FC<{ title?: string; kicker?: string }> = ({
  title = "Ship in hours.",
  kicker = "Deploys that used to take a sprint.",
}) => {
  const frame = useCurrentFrame();
  const { u, vertical, width, height } = useUnit();
  const drift = 1 + frame * 0.0006;
  const cardW = (vertical ? 820 : 760) * u;
  const cardH = cardW * 0.62;
  const cardLeft = vertical ? (width - cardW) / 2 : width * 0.52;
  const cardTop = vertical ? height * 0.5 : (height - cardH) / 2;
  return (
    <AbsoluteFill style={{ backgroundColor: DEMO.paper, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: vertical ? 90 * u : width * 0.08,
          top: vertical ? height * 0.16 : height * 0.36,
          width: vertical ? width - 180 * u : width * 0.4,
          transform: `scale(${drift})`,
          transformOrigin: "0 50%",
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: (vertical ? 150 : 132) * u,
            lineHeight: 0.95,
            letterSpacing: -4 * u,
            color: DEMO.ink,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: primaryFont,
            fontWeight: 500,
            fontSize: 32 * u,
            color: DEMO.inkMuted,
            marginTop: 30 * u,
            maxWidth: 620 * u,
          }}
        >
          {kicker}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: cardLeft,
          top: cardTop,
          width: cardW,
          height: cardH,
          borderRadius: 28 * u,
          background: "#FFFFFF",
          border: `${Math.max(1, 2 * u)}px solid rgba(18,18,18,0.08)`,
          padding: 44 * u,
          boxSizing: "border-box",
          transform: `scale(${drift})`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: primaryFont,
            color: DEMO.inkMuted,
            fontSize: 26 * u,
            fontWeight: 500,
          }}
        >
          <span>Deploy time</span>
          <span style={{ color: DEMO.indigo, fontWeight: 700 }}>−92%</span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 44 * u,
            right: 44 * u,
            bottom: 44 * u,
            height: cardH * 0.58,
            display: "flex",
            alignItems: "flex-end",
            gap: 18 * u,
          }}
        >
          {BARS.map((bar, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${bar * 100}%`,
                borderRadius: 6 * u,
                background: i === BARS.length - 1 ? DEMO.indigo : "rgba(18,18,18,0.12)",
              }}
            />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** One hero statement on a swapped ground (ink by default): the opposite pole of scene A. */
export const DemoSceneB: React.FC<{ title?: string; ground?: string; ink?: string }> = ({
  title = "Not weeks",
  ground = DEMO.ink,
  ink = DEMO.chalk,
}) => {
  const frame = useCurrentFrame();
  const { u, vertical, width } = useUnit();
  const drift = 1.03 - frame * 0.0005;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: ground,
        overflow: "hidden",
        justifyContent: "center",
        alignItems: vertical ? "center" : "flex-start",
        paddingLeft: vertical ? 0 : width * 0.08,
      }}
    >
      <div
        style={{
          transform: `scale(${drift})`,
          transformOrigin: vertical ? "50% 50%" : "0 50%",
          textAlign: vertical ? "center" : "left",
        }}
      >
        <div
          style={{
            fontFamily: displayFont,
            fontWeight: 700,
            fontSize: (vertical ? 180 : 290) * u,
            lineHeight: 0.9,
            letterSpacing: -8 * u,
            color: ink,
          }}
        >
          {title}.
        </div>
        <div
          style={{
            display: "flex",
            gap: 18 * u,
            marginTop: 50 * u,
            justifyContent: vertical ? "center" : "flex-start",
          }}
        >
          {["Preview", "Rollback", "Ship"].map((tag, i) => (
            <div
              key={tag}
              style={{
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: 30 * u,
                padding: `${16 * u}px ${30 * u}px`,
                borderRadius: 999,
                background: i === 2 ? ink : `color-mix(in srgb, ${ink} 12%, transparent)`,
                color: i === 2 ? ground : ink,
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

type TransitionDemoProps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  presentation: TransitionPresentation<any>;
  transitionFrames: number;
  /** Composition length; both scenes share the rest, so changing the transition length never changes the total. */
  totalFrames: number;
  before?: React.ReactNode;
  after?: React.ReactNode;
};

/** First frame of the seam in a TransitionDemo of this length. */
export const demoSeamStart = (totalFrames: number, transitionFrames: number): number =>
  Math.ceil((totalFrames + transitionFrames) / 2) - transitionFrames;

/**
 * Frame of the perceived cut, relative to a block's start, for a transition that starts at `transitionStart` and lasts
 * `transitionFrames`: pass it as a transition block's `seamFrame`.
 */
export const seamFrameOf = (transitionStart: number, transitionFrames: number, peakAt: number): number =>
  transitionStart + Math.round(peakAt * transitionFrames);

/**
 * The hero cut cue of a transition block. With `seamFrame` (frames from the block's start to the perceived cut) the cue
 * sits there, which is where sfx:cues places it in a film; without it, at `peakAt` of the preview's centred seam.
 */
export const demoCutCue = (
  totalFrames: number,
  transitionFrames: number,
  peakAt: number,
  sfx: Cue["sfx"],
  label: string,
  seamFrame?: number,
): Cue[] => [
  {
    frame: seamFrame ?? seamFrameOf(demoSeamStart(totalFrames, transitionFrames), transitionFrames, peakAt),
    kind: "cut",
    sfx,
    weight: "hero",
    label,
  },
];

/** Scene A, the transition, scene B, with the transition centred in the composition. */
export const TransitionDemo: React.FC<TransitionDemoProps> = ({
  presentation,
  transitionFrames,
  totalFrames,
  before,
  after,
}) => {
  const first = Math.ceil((totalFrames + transitionFrames) / 2);
  const second = totalFrames + transitionFrames - first;
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={first}>{before ?? <DemoSceneA />}</TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={presentation} timing={cutTiming(transitionFrames)} />
      <TransitionSeries.Sequence durationInFrames={second}>{after ?? <DemoSceneB />}</TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
