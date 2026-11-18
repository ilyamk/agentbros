import { noise3D } from "@remotion/noise";
import React, { useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";

const hex = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "ramp colours must be #rgb or #rrggbb");

export const grainGradientSchema = z.object({
  /** Gradient map from shadows (first) to highlights (last); hex colours only. */
  ramp: z.array(hex).min(2).max(6),
  /** Size of the flowing shapes; larger is broader. */
  scale: z.number().min(0.3).max(3),
  /** Flow speed; 0 is still. */
  speed: z.number().min(0).max(4),
  /** Contrast of the noise before mapping; more gives harder bands. */
  contrast: z.number().min(0.5).max(4),
  /** Grain opacity; 0 removes the grain layer. */
  grain: z.number().min(0).max(0.6),
  seed: z.number().int(),
});

export type GrainGradientProps = z.infer<typeof grainGradientSchema>;

/** The field is computed at 1/DOWNSAMPLE of the frame and scaled up; the shapes are broad, so nothing is lost. */
const DOWNSAMPLE = 6;
const OVERSCAN = 0.03;

const channels = (colour: string): [number, number, number] => {
  const body = colour.slice(1);
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** 256 entries of RGB, blending neighbouring stops with a smoothstep so no band has a hard edge. */
const lookup = (ramp: readonly string[]): Uint8ClampedArray => {
  const stops = ramp.map(channels);
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const position = (i / 255) * (stops.length - 1);
    const lower = Math.min(stops.length - 2, Math.floor(position));
    const t = position - lower;
    const eased = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) table[i * 3 + c] = stops[lower][c] + (stops[lower + 1][c] - stops[lower][c]) * eased;
  }
  return table;
};

export const GrainGradient: React.FC<GrainGradientProps> = ({ ramp, scale, speed, contrast, grain, seed }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const table = useMemo(() => lookup(ramp), [ramp]);
  const w = Math.ceil((width * (1 + OVERSCAN * 2)) / DOWNSAMPLE);
  const h = Math.ceil((height * (1 + OVERSCAN * 2)) / DOWNSAMPLE);

  useLayoutEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    const t = (frame / fps) * speed;
    const longest = Math.max(w, h);
    const breathe = 1 + 0.09 * Math.sin((t / 16) * Math.PI * 2);
    const frequency = (1.35 / scale) * breathe;
    const driftX = t * 0.055;
    const driftY = t * 0.035;
    const image = context.createImageData(w, h);
    const data = image.data;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const u = (px / longest) * frequency - driftX;
        const v = (py / longest) * frequency - driftY;
        const warp = noise3D(`${seed}-warp`, u * 0.7, v * 0.7, t * 0.03);
        const base = noise3D(seed, u + warp * 0.55, v - warp * 0.4, t * 0.05);
        const detail = noise3D(`${seed}-detail`, u * 2.1 + 3.7, v * 2.1 - 1.3, t * 0.08);
        const field = (base * 0.72 + detail * 0.28) * 0.62;
        const shaped = Math.max(0, Math.min(1, 0.5 + field * contrast)) ** 1.6;
        const entry = Math.round(shaped * 255) * 3;
        const offset = (py * w + px) * 4;
        data[offset] = table[entry];
        data[offset + 1] = table[entry + 1];
        data[offset + 2] = table[entry + 2];
        data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [frame, fps, speed, scale, contrast, seed, table, w, h]);

  return (
    <AbsoluteFill style={{ backgroundColor: ramp[0], overflow: "hidden" }}>
      <canvas
        ref={canvas}
        width={w}
        height={h}
        style={{
          position: "absolute",
          left: `${-OVERSCAN * 100}%`,
          top: `${-OVERSCAN * 100}%`,
          width: `${100 + OVERSCAN * 200}%`,
          height: `${100 + OVERSCAN * 200}%`,
          filter: `blur(${(Math.max(width, height) * 0.0035).toFixed(1)}px)`,
        }}
      />
      {grain > 0 ? <FilmGrain seed={`grainient-${seed}`} opacity={grain} cadence={1} frequency={0.85} /> : null}
    </AbsoluteFill>
  );
};
