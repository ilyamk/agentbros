import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { shake } from "../../camera-math";
import { DemoSceneA } from "../transitions/demo";

export type SnapSettle = {
  /** Frames for the punch to close most of the gap. */ tau: number;
  /** Ring frequency in radians per frame; higher gives a tighter wobble. */ omega: number;
};

const settle = (t: number, { tau, omega }: SnapSettle) => (t <= 0 ? 0 : 1 - Math.exp(-t / tau) * Math.cos(omega * t));

/** Zoom level at `frame`: each beat punches from the previous level to the next and rings out once. */
export const snapScale = (
  frame: number,
  beats: readonly number[],
  levels: readonly number[],
  spring: SnapSettle = { tau: 3.2, omega: 0.42 },
): number =>
  beats.reduce(
    (scale, at, i) => scale + ((levels[i + 1] ?? levels[i] ?? 1) - (levels[i] ?? 1)) * settle(frame - at, spring),
    levels[0] ?? 1,
  );

type SnapZoomProps = {
  beats: readonly number[];
  /** One more level than beats: the resting scale, then the scale after each beat. */
  levels: readonly number[];
  /** Point the punch closes on, as a fraction of the frame. */
  originX: number;
  originY: number;
  handheld?: number;
  children: React.ReactNode;
};

/** Wraps any scene: snap-zoom punches on beats with a brief blur and a settle, plus optional handheld micro-shake. */
export const SnapZoom: React.FC<SnapZoomProps> = ({ beats, levels, originX, originY, handheld = 0, children }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const scale = snapScale(frame, beats, levels);
  const speed = Math.abs(snapScale(frame + 0.5, beats, levels) - snapScale(frame - 0.5, beats, levels)) * width * 0.5;
  const blur = Math.min(speed * 0.04, 14);
  const hand =
    handheld > 0
      ? shake(frame, { seed: "snap", amplitude: 6 * handheld, rollAmplitude: 0.15 * handheld, frequency: 0.11 })
      : { x: 0, y: 0, roll: 0 };
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${hand.x}px, ${hand.y}px) rotate(${hand.roll}deg) scale(${scale})`,
          transformOrigin: `${originX * 100}% ${originY * 100}%`,
          filter: blur > 0.4 ? `blur(${blur}px)` : undefined,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const snapZoomSchema = z.object({
  beats: z.array(z.number().int().min(0)),
  levels: z.array(z.number().min(0.5).max(4)),
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
  handheld: z.number().min(0).max(1),
});

export type SnapZoomPreviewProps = z.infer<typeof snapZoomSchema>;

export const SNAP_ZOOM_FRAMES = 96;

export const SnapZoomPreview: React.FC<SnapZoomPreviewProps> = ({ beats, levels, originX, originY, handheld }) => (
  <SnapZoom beats={beats} levels={levels} originX={originX} originY={originY} handheld={handheld}>
    <DemoSceneA />
  </SnapZoom>
);
