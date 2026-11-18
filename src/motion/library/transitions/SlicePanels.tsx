import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill } from "remotion";
import { z } from "zod";
import { easeFamily } from "../../ease-family";
import { curves } from "../../timing";
import { DemoSceneA, DemoSceneB, TransitionDemo } from "./demo";

type SliceDirection = "up" | "down" | "left" | "right";

export const SLICE_CURVES = ["expo.out", "power3.out", "power2.inOut"] as const;
export type SliceCurve = (typeof SLICE_CURVES)[number];

type SlicePanelsOptions = {
  /** Panels the next scene arrives in. Each is a full render of the scene, so keep it at 6 or fewer. 1 is a single rising sheet. */
  count: number;
  direction: SliceDirection;
  /** Share of the transition between the first and the last panel starting (0..0.7). */
  spread: number;
  /** Darkening of the outgoing scene as it is covered, 0..1. */
  shade: number;
  /** Ease of each panel: expo.out (default) or flex's power3.out sheet with a long tail. */
  curve: SliceCurve;
  /** Share of the frame a panel has covered when the seam ends (1 by default); below 1 the cut lands before the sheet is full. */
  reach: number;
  /** "slide": the panel carries the next scene with it (default). "clip": the scene stays put and a flat edge uncovers it, like a sheet of the next ground. */
  motion: "slide" | "clip";
  /** How far the outgoing scene sinks back (scale) while covered. */
  sink: number;
};

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/** Eased cover of one panel at its own progress t, scaled by `reach`. Pure. */
export const sliceCover = (t: number, curve: SliceCurve, reach: number): number => {
  const x = clamp01(t);
  const e = curve === "expo.out" ? curves.expoOut(x) : easeFamily[curve](x);
  return e * clamp01(reach);
};

/** Share of the seam where a single sheet covers half the frame: its perceived cut. Pure. */
export const sheetPeak = (curve: SliceCurve, reach: number): number => {
  if (clamp01(reach) <= 0.5) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sliceCover(mid, curve, reach) < 0.5) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

const SlicePanelsPresentation: React.FC<TransitionPresentationComponentProps<SlicePanelsOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const { count, direction, spread, shade, curve, reach, motion, sink: sinkBy } = passedProps;
  if (presentationDirection === "exiting") {
    if (p <= 0 || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
    const sink = curves.drift(p);
    return (
      <AbsoluteFill style={{ transform: `scale(${1 - sinkBy * sink})`, filter: `brightness(${1 - shade * sink})` }}>
        {children}
      </AbsoluteFill>
    );
  }
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const columns = direction === "up" || direction === "down";
  const sign = direction === "up" || direction === "left" ? 1 : -1;
  const each = count > 1 ? 1 - spread : 1;
  return (
    <AbsoluteFill>
      {Array.from({ length: count }, (_, i) => {
        const start = count > 1 ? (spread * i) / (count - 1) : 0;
        const t = sliceCover((p - start) / each, curve, reach);
        const a = (i / count) * 100;
        const b = ((i + 1) / count) * 100;
        const edge = columns ? (sign > 0 ? "to bottom" : "to top") : sign > 0 ? "to right" : "to left";
        if (t <= 0) return null;
        if (motion === "clip") {
          // The scene stays still; a flat edge uncovers it from the leading side, with a soft shadow just above it.
          const hidden = (1 - t) * 100;
          const inset = columns
            ? sign > 0
              ? `${hidden}% ${100 - b}% 0% ${a}%`
              : `0% ${100 - b}% ${hidden}% ${a}%`
            : sign > 0
              ? `${a}% 0% ${100 - b}% ${hidden}%`
              : `${a}% ${hidden}% ${100 - b}% 0%`;
          const shadow: React.CSSProperties = columns
            ? { left: `${a}%`, width: `${b - a}%`, height: "8%", [sign > 0 ? "bottom" : "top"]: `${100 - hidden}%` }
            : { top: `${a}%`, height: `${b - a}%`, width: "8%", [sign > 0 ? "right" : "left"]: `${100 - hidden}%` };
          return (
            <AbsoluteFill key={i}>
              <div
                style={{
                  position: "absolute",
                  ...shadow,
                  opacity: 0.6 * (1 - t),
                  background: `linear-gradient(${edge}, rgba(0,0,0,0), rgba(0,0,0,0.3))`,
                }}
              />
              <AbsoluteFill style={{ clipPath: `inset(${inset})` }}>{children}</AbsoluteFill>
            </AbsoluteFill>
          );
        }
        const offset = (1 - t) * 100 * sign;
        const clip = columns
          ? `polygon(${a}% 0%, ${b}% 0%, ${b}% 100%, ${a}% 100%)`
          : `polygon(0% ${a}%, 100% ${a}%, 100% ${b}%, 0% ${b}%)`;
        const move = columns ? `translateY(${offset}%)` : `translateX(${offset}%)`;
        const shadowPos: React.CSSProperties = columns
          ? { left: `${a}%`, width: `${b - a}%`, height: "12%", [sign > 0 ? "bottom" : "top"]: "100%" }
          : { top: `${a}%`, height: `${b - a}%`, width: "12%", [sign > 0 ? "right" : "left"]: "100%" };
        return (
          <AbsoluteFill key={i} style={{ transform: move }}>
            <AbsoluteFill style={{ clipPath: clip }}>{children}</AbsoluteFill>
            <div
              style={{
                position: "absolute",
                ...shadowPos,
                opacity: 1 - t * 0.6,
                background: `linear-gradient(${edge}, rgba(0,0,0,0), rgba(0,0,0,0.38))`,
              }}
            />
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};

/** Share of the seam where the panels read as the new scene (the middle panel lands), for the default spread. */
export const SLICE_PANELS_PEAK = 0.55;

/**
 * The next scene slides in as staggered panels over a sinking, darkening outgoing scene. Pair with `cutTiming(16..24)`.
 * `count: 1` with `motion: "clip"`, `curve: "power3.out"` is flex's rising sheet: 6% to 55% of the height in 4 frames,
 * then a long tail (`cutTiming(22)`), with `reach` below 1 to cut before it is full.
 */
export const slicePanels = ({
  count = 5,
  direction = "up",
  spread = 0.38,
  shade = 0.55,
  curve = "expo.out",
  reach = 1,
  motion = "slide",
  sink = 0.06,
}: Partial<SlicePanelsOptions> = {}): TransitionPresentation<SlicePanelsOptions> => ({
  component: SlicePanelsPresentation,
  props: {
    count: Math.max(1, Math.round(count)),
    direction,
    spread: Math.min(Math.max(spread, 0), 0.7),
    shade,
    curve,
    reach: clamp01(reach),
    motion,
    sink,
  },
});

export const slicePanelsSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  count: z.number().int().min(1).max(6),
  direction: z.enum(["up", "down", "left", "right"]),
  spread: z.number().min(0).max(0.7),
  shade: z.number().min(0).max(1),
  transitionFrames: z.number().int().min(10).max(32),
  /** Sheet options (all optional; the defaults are the staggered panels): curve, reach, motion and sink. */
  curve: z.enum(SLICE_CURVES).optional(),
  reach: z.number().min(0.5).max(1).optional(),
  motion: z.enum(["slide", "clip"]).optional(),
  sink: z.number().min(0).max(0.2).optional(),
});

export type SlicePanelsProps = z.infer<typeof slicePanelsSchema>;

export const SLICE_PANELS_FRAMES = 90;

/** flex's rising sheet: one flat sheet of the next ground over a still plate, power3.out with a long tail. */
export const sheetCoverPreset: Omit<SlicePanelsProps, "seamFrame"> = {
  count: 1,
  direction: "up",
  spread: 0,
  shade: 0,
  transitionFrames: 22,
  curve: "power3.out",
  reach: 1,
  motion: "clip",
  sink: 0,
};

/** Perceived cut of a slice-panels seam: the default panels' middle landing, or a single sheet crossing half the frame. */
export const slicePanelsPeak = (props: Pick<SlicePanelsProps, "count" | "curve" | "reach">): number =>
  props.count === 1 ? sheetPeak(props.curve ?? "expo.out", props.reach ?? 1) : SLICE_PANELS_PEAK;

export const SlicePanelsPreview: React.FC<SlicePanelsProps> = ({ transitionFrames, seamFrame: _seam, ...options }) => (
  <TransitionDemo
    presentation={slicePanels(options)}
    transitionFrames={transitionFrames}
    totalFrames={SLICE_PANELS_FRAMES}
    before={options.count === 1 ? <DemoSceneA /> : undefined}
    after={options.count === 1 ? <DemoSceneB ground="#1F4D37" ink="#F2F0EA" title="One sheet" /> : undefined}
  />
);
