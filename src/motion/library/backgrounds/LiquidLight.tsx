import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { UGC_LIQUID_FRAMES, liquidLight, liquidRadius } from "./background-plan";

/**
 * A soft light growing from a frame corner: a dark core, a glowing rim that bends with noise and splits slightly into
 * colour at its edge, like light refracted through liquid glass (ugc-app corner-liquid-light). Computed per frame on a
 * small canvas from `liquidLight`, a pure function of the frame, then scaled up and softened.
 */
export const liquidLightSchema = z.object({
  /** The corner the light grows from. */
  corner: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]),
  /** Light colour; the rim fringes towards red outside and blue inside whatever the colour. */
  colour: z.string().regex(/^#[0-9a-f]{6}$/i, "#rrggbb"),
  /** Ground colour, or "transparent" to add the light over other layers (screen blend). */
  ground: z.string(),
  /** Radius at rest as a share of the frame diagonal. */
  size: z.number().min(0.05).max(1.2),
  /** Rim width as a share of the diagonal. */
  rim: z.number().min(0.01).max(0.2),
  /** First frame and growth length (ugc-app: ~17 f, expo.out). */
  at: z.number().int().min(0),
  frames: z.number().int().min(1).max(120),
  intensity: z.number().min(0).max(2),
  seed: z.string(),
});

export type LiquidLightProps = z.infer<typeof liquidLightSchema>;

const DOWNSAMPLE = 6;

const rgb = (hex: string): [number, number, number] => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

export const LiquidLight: React.FC<LiquidLightProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const w = Math.ceil(width / DOWNSAMPLE);
  const h = Math.ceil(height / DOWNSAMPLE);

  useLayoutEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const r = liquidRadius(frame, { at: p.at, frames: p.frames, size: p.size });
    const image = context.createImageData(w, h);
    const data = image.data;
    const diag = Math.hypot(w, h);
    const ox = p.corner.endsWith("right") ? w : 0;
    const oy = p.corner.startsWith("bottom") ? h : 0;
    const base = rgb(p.colour);
    const t = frame / fps;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const dx = px - ox;
        const dy = py - oy;
        const [lr, lg, lb] = liquidLight(Math.hypot(dx, dy) / diag, Math.atan2(dy, dx), r, t, p.seed, p.rim);
        const o = (py * w + px) * 4;
        const k = p.intensity;
        data[o] = Math.min(255, base[0] * lr * k + 255 * Math.max(0, lr - 0.8) * k);
        data[o + 1] = Math.min(255, base[1] * lg * k + 255 * Math.max(0, lg - 0.8) * k);
        data[o + 2] = Math.min(255, base[2] * lb * k + 255 * Math.max(0, lb - 0.8) * k);
        data[o + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [frame, fps, p.at, p.frames, p.size, p.rim, p.corner, p.colour, p.intensity, p.seed, w, h]);

  return (
    <AbsoluteFill style={{ background: p.ground === "transparent" ? undefined : p.ground, overflow: "hidden" }}>
      <canvas
        ref={canvas}
        width={w}
        height={h}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          mixBlendMode: "screen",
          filter: `blur(${(Math.max(width, height) * 0.004).toFixed(1)}px)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const liquidLightDefaults: LiquidLightProps = {
  corner: "bottom-right",
  colour: "#3a8dff",
  ground: "#030406",
  size: 0.3,
  rim: 0.035,
  at: 4,
  frames: UGC_LIQUID_FRAMES,
  intensity: 1,
  seed: "ugc",
};

/** Sound: the light's arrival, at the start of its growth. */
export const liquidLightCues = (p: LiquidLightProps) => [
  {
    frame: p.at,
    kind: "reveal" as const,
    sfx: "riser" as const,
    weight: "support" as const,
    label: "light rises in the corner",
  },
];
