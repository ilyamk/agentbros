import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";

export const paperFibreSchema = z.object({
  paper: z.string(),
  /** Colour of the fibres and tooth; usually a darker shade of the paper. */
  fibre: z.string(),
  /** Strength of the fibre texture, 0 to 1. */
  texture: z.number().min(0).max(1),
  /** Where the soft window light falls, as a share of the frame. */
  lightX: z.number(),
  lightY: z.number(),
  /** Light falloff depth, 0 to 1: how much darker the far corners are. */
  falloff: z.number().min(0).max(1),
  seed: z.number().int(),
});

export type PaperFibreProps = z.infer<typeof paperFibreSchema>;

/**
 * A real medium instead of a gradient: paper with long fibres and fine tooth, lit by a soft window light that
 * drifts very slowly. The texture is static, as paper is; only the light and the grain live.
 */
export const PaperFibre: React.FC<PaperFibreProps> = ({ paper, fibre, texture, lightX, lightY, falloff, seed }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const id = useId().replaceAll(":", "");
  const lx = (lightX + 0.02 * Math.sin(frame / 70)) * 100;
  const ly = (lightY + 0.015 * Math.cos(frame / 90)) * 100;
  return (
    <AbsoluteFill style={{ backgroundColor: paper, overflow: "hidden" }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, opacity: texture }} aria-hidden>
        <filter id={`fibre-${id}`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.018 0.11" numOctaves={4} seed={seed} result="long" />
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={seed + 1} result="tooth" />
          <feBlend in="long" in2="tooth" mode="multiply" result="mix" />
          <feColorMatrix in="mix" type="luminanceToAlpha" result="a" />
          <feComponentTransfer in="a" result="alpha">
            <feFuncA type="linear" slope={-2.2} intercept={1.25} />
          </feComponentTransfer>
          <feFlood floodColor={fibre} result="ink" />
          <feComposite in="ink" in2="alpha" operator="in" />
        </filter>
        <rect width={width} height={height} filter={`url(#fibre-${id})`} opacity={0.22} />
      </svg>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 85% 85% at ${lx}% ${ly}%, rgba(255,250,240,0.35) 0%, transparent 55%, rgba(40,30,20,${0.22 * falloff}) 100%)`,
        }}
      />
      <FilmGrain seed={`paper-${seed}`} opacity={0.07} />
    </AbsoluteFill>
  );
};
