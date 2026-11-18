import React from "react";
import { AbsoluteFill, Easing, useVideoConfig } from "remotion";
import { FilmGrain } from "../../fx";

export type Safe = { top: number; bottom: number; side: number; width: number; height: number; vertical: boolean };

/** Safe area of the composition: vertical keeps clear of platform chrome (top 200, bottom 300, sides 60). */
export const useSafeArea = (): Safe => {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const top = vertical ? 200 : Math.round(height * 0.09);
  const bottom = vertical ? 300 : Math.round(height * 0.09);
  const side = vertical ? 60 : Math.round(width * 0.075);
  return { top, bottom, side, width: width - side * 2, height: height - top - bottom, vertical };
};

type StageProps = {
  /** CSS colour of the ground; "transparent" makes the item an overlay with no ground and no grain. */
  background: string;
  grain?: number;
  children: React.ReactNode;
};

/**
 * A flat ground: one solid colour and a trace of grain. No pooled light and no vignette: the reference films set type on
 * flat paper, flat brand colour or flat black, and swap the ground on the cut instead of lighting it.
 */
export const Stage: React.FC<StageProps> = ({ background, grain = 0.04, children }) => {
  if (background === "transparent") return <AbsoluteFill>{children}</AbsoluteFill>;
  return (
    <AbsoluteFill style={{ backgroundColor: background }}>
      {children}
      {grain > 0 ? <FilmGrain seed="typography" opacity={grain} /> : null}
    </AbsoluteFill>
  );
};

export const ARRIVE = Easing.bezier(0.16, 1, 0.3, 1);
export const EXIT = Easing.bezier(0.6, 0, 0.9, 0.35);
export const STATE = Easing.bezier(0.65, 0, 0.35, 1);

/** Relative luminance (0 dark to 1 light) of a #rgb or #rrggbb colour; 0.5 for anything else. */
export const luminance = (colour: string): number => {
  const hex = colour.trim().replace("#", "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) return 0.5;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const value = Number.parseInt(full, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
};

/** The ink that reads on a ground: `light` on dark or saturated grounds, `dark` on paper. */
export const inkOn = (ground: string, light = "#FAFAF7", dark = "#111111"): string =>
  luminance(ground) > 0.4 ? dark : light;

/** Resolve "auto" to the ink for the ground. */
export const resolveInk = (ink: string, ground: string): string => (ink === "auto" ? inkOn(ground) : ink);

export type PulseTiming = {
  /** First beat, in frames. */
  at: number;
  /** Explicit beat frames from the audio map; when non-empty they win over `bpm`. */
  beatFrames: readonly number[];
  bpm: number;
  /** Beats between two steps (0.5 = every half beat). */
  beatsPerStep: number;
  /** Step index from which the interval shrinks; -1 never. */
  accelerateFrom: number;
  /** Each accelerated interval is this share of the previous one. */
  accelerateRatio: number;
};

/**
 * Frame of each of `count` steps. Even steps sit on absolute beat times (`at + i * interval`, rounded once) so they do
 * not drift; accelerated steps shrink geometrically to no less than two frames.
 */
export const pulseFrames = (count: number, timing: PulseTiming, fps: number): number[] => {
  if (timing.beatFrames.length > 0) {
    const given = timing.beatFrames.slice(0, count);
    while (given.length < count) given.push((given.at(-1) ?? timing.at) + 8);
    return given;
  }
  const interval = (60 / timing.bpm) * fps * timing.beatsPerStep;
  const frames: number[] = [];
  let time = timing.at;
  let step = interval;
  for (let index = 0; index < count; index++) {
    if (timing.accelerateFrom < 0 || index <= timing.accelerateFrom) {
      time = timing.at + index * interval;
    } else {
      step = Math.max(2, step * timing.accelerateRatio);
      time += step;
    }
    frames.push(Math.round(time));
  }
  return frames;
};
