import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { curves } from "../../timing";
import { z } from "zod";
import { DemoSceneB, TransitionDemo } from "./demo";

export const LIGHT_BURN_SHAPES = ["sweep", "leak", "edges"] as const;
export type LightBurnShape = (typeof LIGHT_BURN_SHAPES)[number];

type LightBurnOptions = {
  /** Core of the light: near white reads as a flash, amber as film burn. */
  core: string;
  /** Halo colour around the core. */
  halo: string;
  /** Where the light blooms from, as a fraction of the frame width; it sweeps across as it grows. */
  fromX: number;
  /** 0..1, how close the peak gets to a full white-out. */
  intensity: number;
  /**
   * "sweep" (default): a warm front crosses the frame and is cut at its peak. "leak": one to three stepped frames of
   * overexposure with a coloured radial leak, the cut on the frame after the brightest. "edges": the frame brightens
   * from the edges inward, like an overexposed vignette, and the next scene arrives under it, its centre last.
   */
  shape: LightBurnShape;
};

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/** Share of the seam where the burn is cut to the next scene. */
export const LIGHT_BURN_PEAK = 0.55;

/** GSAP's power2.out (a cubic), measured on the edge bloom. */
const power2Out = (t: number) => 1 - (1 - clamp01(t)) ** 3;

/**
 * leak shape: the seam frame index (0-based, of `frames`) and the leak's stepped strength on it. Every frame before the
 * last is a leak frame, brighter each time (steps, no tween); the last frame is the new scene, so the cut sits right
 * after the brightest frame. Pure.
 */
export const leakStep = (p: number, frames: number): { index: number; strength: number; cut: boolean } => {
  const n = Math.max(2, Math.round(frames));
  const index = Math.min(n - 1, Math.floor(clamp01(p) * n));
  const leakFrames = n - 1;
  if (index >= leakFrames) return { index, strength: 0, cut: true };
  return { index, strength: (index + 1) / leakFrames, cut: false };
};

/**
 * edges shape: the radius (share of the half-diagonal) inside which the outgoing scene still shows at progress p; it
 * closes from past the corners to the centre on power2.out, so the edges go first and the centre last. Pure.
 */
export const edgeBloomRadius = (p: number, feather: number): number => (1 + feather) * (1 - power2Out(p));

/** Share of the seam where each shape's cut is perceived: the sweep's peak, the leak's brightest frame, the bloom's half-closed radius. Pure. */
export const lightBurnPeak = (shape: LightBurnShape, transitionFrames: number): number => {
  if (shape === "leak")
    return (Math.max(2, Math.round(transitionFrames)) - 1) / Math.max(2, Math.round(transitionFrames));
  if (shape === "edges") return 1 - Math.cbrt(0.5);
  return LIGHT_BURN_PEAK;
};

const EDGE_FEATHER = 0.8;

const LightBurnPresentation: React.FC<TransitionPresentationComponentProps<LightBurnOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  presentationDurationInFrames,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const { core, halo, fromX, intensity, shape } = passedProps;
  if (shape === "leak") {
    const step = leakStep(p, presentationDurationInFrames);
    if (presentationDirection === "exiting") return step.cut || p >= 1 ? null : <AbsoluteFill>{children}</AbsoluteFill>;
    if (step.cut || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
    // Overexpose the whole frame and lay a coloured radial leak from `fromX`; each frame is one step brighter.
    const s = step.strength * intensity;
    const cx = fromX * width;
    const cy = height * 0.45;
    const r = Math.hypot(width, height) * (0.45 + 0.35 * step.strength);
    return (
      <AbsoluteFill>
        <AbsoluteFill style={{ backgroundColor: core, opacity: 0.35 + 0.6 * s, mixBlendMode: "screen" }} />
        <AbsoluteFill
          style={{
            opacity: s,
            background: `radial-gradient(circle at ${cx}px ${cy}px, ${core} 0px, ${halo} ${r * 0.35}px, rgba(0,0,0,0) ${r}px)`,
            mixBlendMode: "screen",
          }}
        />
      </AbsoluteFill>
    );
  }
  if (shape === "edges") {
    if (presentationDirection === "exiting" || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
    const r = edgeBloomRadius(p, EDGE_FEATHER);
    // Stops are shares of the ray to the farthest corner, so the bloom is an ellipse of the frame's own aspect.
    const inner = Math.max(0, r - EDGE_FEATHER) * 100;
    const outer = r * 100;
    // The next scene shows outside the closing radius; a band of light sits on the front and fades as it closes.
    const mask = `radial-gradient(ellipse farthest-corner at 50% 50%, transparent ${inner}%, black ${outer}%)`;
    const glowMask = `radial-gradient(ellipse farthest-corner at 50% 50%, transparent ${Math.max(0, inner - EDGE_FEATHER * 50)}%, black ${outer}%)`;
    return (
      <AbsoluteFill>
        <AbsoluteFill
          style={{
            backgroundColor: core,
            opacity: intensity * (1 - power2Out(p)) * 0.9,
            maskImage: glowMask,
            WebkitMaskImage: glowMask,
            mixBlendMode: "screen",
          }}
        />
        <AbsoluteFill style={{ maskImage: mask, WebkitMaskImage: mask }}>{children}</AbsoluteFill>
      </AbsoluteFill>
    );
  }
  // Hard cut at the peak: no frame shows a receding white disc or a grey frame-wide phase.
  if (presentationDirection === "exiting") return p < LIGHT_BURN_PEAK ? <AbsoluteFill>{children}</AbsoluteFill> : null;
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const cx = fromX * width;
  const cy = height * 0.55;
  const reach = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
  const front = reach * 0.35;
  if (p < LIGHT_BURN_PEAK) {
    // A narrow front sweeps over the frame; it is cut while the far corner is still the outgoing scene.
    const t = curves.expoIn(clamp01(p / LIGHT_BURN_PEAK)) * 0.8 + clamp01(p / LIGHT_BURN_PEAK) * 0.12;
    const r = -front + (reach + front) * t;
    const stop = (px: number) => `${Math.max(px, 0)}px`;
    return (
      <AbsoluteFill
        style={{
          opacity: intensity,
          background: `radial-gradient(circle at ${cx}px ${cy}px, ${core} ${stop(r - front)}, ${halo} ${stop(r - front * 0.35)}, rgba(0,0,0,0) ${stop(r)})`,
        }}
      />
    );
  }
  // After the cut the flash decays over about three frames, like one overexposed film frame; never a grey hold.
  const decay = (1 - clamp01((p - LIGHT_BURN_PEAK) / 0.2)) ** 2;
  return (
    <AbsoluteFill>
      <AbsoluteFill>{children}</AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: core, opacity: intensity * decay * 0.85, mixBlendMode: "screen" }} />
    </AbsoluteFill>
  );
};

/**
 * A front of warm light sweeps across from `fromX`, burns most of the frame and is cut to the next scene, which decays
 * out of the flash. Pair with `cutTiming(12..20)`; land it on a hit. `shape: "leak"` with `cutTiming(2..4)` is a stepped
 * 1-3 frame leak flash; `shape: "edges"` with `cutTiming(10)` is an edge-in bloom onto a light ground.
 */
export const lightBurn = ({
  core = "#FFF4E2",
  halo = "#FF8A3D",
  fromX = 0.15,
  intensity = 0.9,
  shape = "sweep",
}: Partial<LightBurnOptions> = {}): TransitionPresentation<LightBurnOptions> => ({
  component: LightBurnPresentation,
  props: { core, halo, fromX, intensity, shape },
});

export const lightBurnSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  core: z.string(),
  halo: z.string(),
  fromX: z.number().min(0).max(1),
  intensity: z.number().min(0).max(1),
  transitionFrames: z.number().int().min(2).max(30),
  /** sweep (default), leak (2-4 frames) or edges (about 10 frames). */
  shape: z.enum(LIGHT_BURN_SHAPES).optional(),
});

export type LightBurnProps = z.infer<typeof lightBurnSchema>;

export const LIGHT_BURN_FRAMES = 84;

/** abdulah's leak flash: two stepped leak frames, cut on the third; a green-white leak over a warm overexposure. */
export const leakFlashPreset: Omit<LightBurnProps, "seamFrame"> = {
  core: "#F4FFF0",
  halo: "#7BD88F",
  fromX: 0.7,
  intensity: 0.95,
  transitionFrames: 3,
  shape: "leak",
};

/** flex's edge bloom: dark green brightens from the edges to an off-white ground in 10 frames, power2.out. */
export const edgeBloomPreset: Omit<LightBurnProps, "seamFrame"> = {
  core: "#FFFFFF",
  halo: "#FFFFFF",
  fromX: 0.5,
  intensity: 0.85,
  transitionFrames: 10,
  shape: "edges",
};

export const LightBurnPreview: React.FC<LightBurnProps> = ({ transitionFrames, seamFrame: _seam, ...options }) => (
  <TransitionDemo
    presentation={lightBurn(options)}
    transitionFrames={transitionFrames}
    totalFrames={LIGHT_BURN_FRAMES}
    before={options.shape === "edges" ? <DemoSceneB ground="#1F4D37" ink="#F2F0EA" title="Banking" /> : undefined}
    after={options.shape === "edges" ? <DemoSceneB ground="#F4F1EA" ink="#141414" title="Rebuilt" /> : undefined}
  />
);
