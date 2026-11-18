import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { Shutter } from "../../fx";
import { curves } from "../../timing";
import { heroMove, type HeroKey } from "../typography/HeroWord";
import { axesFor } from "../typography/faces";
import { useSharedFit } from "../typography/fit";
import type { Cue } from "../types";

export type Ground = { ground: string; ink: string; accent?: string };

/** The perceived cut of `groundSwap()` sits at the start of its seam. */
export const GROUND_SWAP_PEAK = 0;

type GroundSwapOptions = { kick: number };

const GroundSwapPresentation: React.FC<TransitionPresentationComponentProps<GroundSwapOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  if (presentationDirection === "exiting") return p <= 0 ? <AbsoluteFill>{children}</AbsoluteFill> : null;
  const scale = 1 + passedProps.kick * (1 - curves.expoOut(Math.min(p, 1)));
  return <AbsoluteFill style={{ transform: scale !== 1 ? `scale(${scale})` : undefined }}>{children}</AbsoluteFill>;
};

/**
 * A hard cut for TransitionSeries: the incoming scene (on its own ground) replaces the outgoing one on the first frame
 * of the seam, then settles from `kick` over-scale. Pair with `cutTiming(4..6)`; the seam length is only the settle.
 */
export const groundSwap = ({
  kick = 0.035,
}: Partial<GroundSwapOptions> = {}): TransitionPresentation<GroundSwapOptions> => ({
  component: GroundSwapPresentation,
  props: { kick },
});

export type GroundSwapShot = Ground & { index: number; local: number; from: number };

/** Which shot is on screen: the last cut at or before `frame`. */
export const groundShotAt = (frame: number, cuts: readonly number[], grounds: readonly Ground[]): GroundSwapShot => {
  let index = 0;
  for (let i = 0; i < cuts.length; i++) if (frame >= cuts[i]!) index = i;
  const from = cuts[index] ?? 0;
  return { ...grounds[index % grounds.length]!, index, local: frame - from, from };
};

/** Cues of a ground-swap sequence: a hard cut on every cut after the first; the first cut is the hero. */
export const groundSwapCues = (cuts: readonly number[], heroIndex = 1): Cue[] =>
  cuts.slice(1).map((frame, i) => ({
    frame,
    kind: "cut",
    sfx: i + 1 === heroIndex ? "impact" : "tick",
    weight: i + 1 === heroIndex ? "hero" : "support",
    label: `ground ${i + 2}`,
  }));

type GroundSwapProps = {
  /** Frames where a new shot starts, ascending; the first is usually 0. */
  cuts: number[];
  /** One ground per shot, cycled. Swap between light, the accent and ink: the references' main cut device. */
  grounds: Ground[];
  /** Over-scale the shot settles from after each cut, 0 for none. Keep under 0.05. */
  kick?: number;
  children: (shot: GroundSwapShot) => React.ReactNode;
};

/**
 * Hard cuts that swap the whole ground colour, with no flash, ring or crossfade. Each shot gets its ground, ink and
 * local frame; content renders through the `children` function.
 */
export const GroundSwap: React.FC<GroundSwapProps> = ({ cuts, grounds, kick = 0.035, children }) => {
  const frame = useCurrentFrame();
  const shot = groundShotAt(frame, cuts, grounds);
  const settle =
    shot.index === 0
      ? 1
      : interpolate(shot.local, [0, 6], [0, 1], { extrapolateRight: "clamp", easing: curves.expoOut });
  const scale = 1 + kick * (1 - settle);
  return (
    <AbsoluteFill style={{ backgroundColor: shot.ground }}>
      <AbsoluteFill style={{ transform: scale !== 1 ? `scale(${scale})` : undefined }}>{children(shot)}</AbsoluteFill>
    </AbsoluteFill>
  );
};

type HeroWordMotion = {
  /** Scale keyframes (1 is the fitted size), e.g. shrink on a beat, settle, re-grow into the next cut. */
  scaleKeys?: readonly HeroKey[];
  /** Vertical offset keyframes as a share of the frame height (positive is down), e.g. drift carried across the cut. */
  yKeys?: readonly HeroKey[];
  /** Frame windows `[from, to)` of true sub-frame blur. The word then renders as a centred full-frame layer. */
  blurWindows?: readonly (readonly [number, number])[];
  blurSamples?: number;
  /** The shot's ground (`shot.ground`). Blurred frames then average exactly under it instead of lifting the word's colour. */
  ground?: string;
};

/**
 * A word set to a share of the frame width (up to 0.95), in the shot's ink. `fitTo` sizes it by another string, e.g. a
 * counter's final value. Keyframes and blur windows run on the composition's frame.
 */
export const HeroWord: React.FC<
  {
    text: string;
    ink: string;
    widthShare: number;
    fitTo?: string;
    fontFamily?: string;
    weight?: number;
    maxSize?: number;
    tracking?: string;
    style?: React.CSSProperties;
  } & HeroWordMotion
> = ({
  text,
  fitTo,
  ink,
  widthShare,
  fontFamily = primaryFont,
  weight = 700,
  maxSize = 900,
  tracking = "-0.05em",
  style,
  scaleKeys,
  yKeys,
  blurWindows,
  blurSamples = 20,
  ground,
}) => {
  const { width, height } = useVideoConfig();
  // Variable faces (wide Archivo at wdth 125) are measured with their axes, or they overflow their width share.
  const axes = typeof style?.fontVariationSettings === "string" ? style.fontVariationSettings : axesFor(fontFamily);
  const run = {
    text: fitTo ?? text,
    fontFamily,
    fontWeight: weight,
    letterSpacing: tracking,
    ...(axes ? { additionalStyles: { fontVariationSettings: axes } } : {}),
  };
  const size = useSharedFit([run], width * Math.min(widthShare, 0.95), maxSize);
  const moving = Boolean(scaleKeys?.length || yKeys?.length);
  const Word: React.FC = () => {
    const frame = useCurrentFrame();
    const move = moving ? heroMove(frame, { at: 0, scaleKeys, yKeys }) : null;
    return (
      <div
        style={{
          fontFamily,
          fontWeight: weight,
          fontSize: size ?? maxSize * 0.5,
          letterSpacing: tracking,
          lineHeight: 0.92,
          color: ink,
          whiteSpace: "pre",
          textAlign: "center",
          ...style,
          fontVariationSettings: axes,
          ...(move ? { transform: `translateY(${move.y * height}px) scale(${move.scale})` } : {}),
        }}
      >
        {text}
      </div>
    );
  };
  if (!blurWindows?.length) return <Word />;
  return (
    <Shutter windows={blurWindows} samples={blurSamples} shutterAngle={180} ground={ground}>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Word />
      </AbsoluteFill>
    </Shutter>
  );
};

/** Text in which `[bracketed]` parts are set in the accent colour, e.g. "Search [250M+] people". */
export const AccentLine: React.FC<{ text: string; ink: string; accent: string; style?: React.CSSProperties }> = ({
  text,
  ink,
  accent,
  style,
}) => (
  <div style={{ color: ink, ...style }}>
    {text.split(/(\[[^\]]+\])/).map((part, i) =>
      part.startsWith("[") ? (
        <span key={i} style={{ color: accent }}>
          {part.slice(1, -1)}
        </span>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    )}
  </div>
);

export const groundSwapSchema = z.object({
  words: z.array(z.string()).min(2),
  cuts: z.array(z.number().int().min(0)).min(2),
  grounds: z.array(z.object({ ground: z.string(), ink: z.string(), accent: z.string().optional() })).min(2),
  kick: z.number().min(0).max(0.08),
});

export type GroundSwapPreviewProps = z.infer<typeof groundSwapSchema>;

export const GROUND_SWAP_FRAMES = 90;

/** Preview: a small lead-in sentence on paper, then one hero word per cut, each on a swapped ground. */
export const GroundSwapPreview: React.FC<GroundSwapPreviewProps> = ({ words, cuts, grounds, kick }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <GroundSwap cuts={cuts} grounds={grounds} kick={kick}>
      {(shot) => (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          {shot.index === 0 ? (
            <AccentLine
              text={words[0]!}
              ink={shot.ink}
              accent={shot.accent ?? shot.ink}
              style={{
                fontFamily: primaryFont,
                fontWeight: 500,
                fontSize: 64 * u,
                letterSpacing: "-0.02em",
                textAlign: "center",
                maxWidth: width * 0.7,
                lineHeight: 1.12,
              }}
            />
          ) : (
            <HeroWord
              text={words[shot.index % words.length]!}
              ink={shot.ink}
              widthShare={height > width ? 0.84 : 0.72}
            />
          )}
        </AbsoluteFill>
      )}
    </GroundSwap>
  );
};
