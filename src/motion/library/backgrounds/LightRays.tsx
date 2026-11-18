import { noise2D } from "@remotion/noise";
import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";

export const lightRaysSchema = z.object({
  ground: z.string(),
  light: z.string(),
  /** Mixed into a seeded minority of the rays. */
  tint: z.string(),
  /** Source position as a share of the frame; `sourceY` below 0 sits above the top edge. */
  sourceX: z.number(),
  sourceY: z.number(),
  rays: z.number().int().min(4).max(40),
  /** Half-angle of the fan, degrees. */
  spread: z.number().min(5).max(80),
  intensity: z.number().min(0).max(1.5),
  /** Floating motes inside the beams; 0 removes them. */
  dust: z.number().int().min(0).max(160),
  seed: z.string(),
});

export type LightRaysProps = z.infer<typeof lightRaysSchema>;

const alpha = (colour: string, amount: number): string =>
  `color-mix(in srgb, ${colour} ${(Math.max(0, Math.min(1, amount)) * 100).toFixed(1)}%, transparent)`;

type Ray = { angle: number; width: number; tinted: boolean; key: string };

const fan = (seed: string, rays: number, spread: number): Ray[] => {
  const spacing = (spread * 2) / rays;
  return Array.from({ length: rays }, (_, i) => ({
    angle: -spread + (i + 0.5) * spacing + (random(`${seed}-jitter-${i}`) - 0.5) * spacing * 0.55,
    width: spacing * (0.3 + random(`${seed}-width-${i}`) * 0.45),
    tinted: random(`${seed}-tint-${i}`) < 0.24,
    key: `${seed}-ray-${i}`,
  }));
};

/** A soft wedge: the stops climb and fall on a smooth shoulder instead of hard edges. */
const wedge = (ray: Ray, colour: string, strength: number, x: number, y: number): string => {
  const centre = 90 + ray.angle;
  const half = ray.width / 2;
  const shoulder = half * 0.9;
  const stops = [
    `transparent ${(centre - half - shoulder).toFixed(3)}deg`,
    `${alpha(colour, strength * 0.4)} ${(centre - half * 0.55).toFixed(3)}deg`,
    `${alpha(colour, strength)} ${centre.toFixed(3)}deg`,
    `${alpha(colour, strength * 0.4)} ${(centre + half * 0.55).toFixed(3)}deg`,
    `transparent ${(centre + half + shoulder).toFixed(3)}deg`,
  ];
  return `conic-gradient(from 90deg at ${x}px ${y}px, transparent 0deg, ${stops.join(", ")}, transparent 360deg)`;
};

export const LightRays: React.FC<LightRaysProps> = ({
  ground,
  light,
  tint,
  sourceX,
  sourceY,
  rays,
  spread,
  intensity,
  dust,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const t = frame / fps;
  const x = sourceX * width;
  const y = sourceY * height;
  const reach = Math.hypot(Math.max(x, width - x), height - y);
  const breath = 0.88 + 0.12 * noise2D(`${seed}-breath`, t * 0.18, 0.3);

  const layers = fan(seed, rays, spread).map((ray) => {
    const shimmer = 0.58 + 0.42 * noise2D(ray.key, t * 0.22, 0.7);
    const centred = 1 - 0.6 * (ray.angle / spread) ** 2;
    return wedge(ray, ray.tinted ? tint : light, Math.min(1, 0.95 * intensity * shimmer * centred), x, y);
  });

  const motes = Array.from({ length: dust }, (_, i) => {
    const key = `${seed}-mote-${i}`;
    const angle = ((random(`${key}-a`) * 2 - 1) * spread * 0.9 * Math.PI) / 180;
    const distance = reach * (0.12 + 0.7 * random(`${key}-d`));
    const life = 4 + random(`${key}-life`) * 4;
    const phase = ((t + random(`${key}-p`) * life) % life) / life;
    const drift = t * 6;
    const mx = x + Math.sin(angle) * distance + noise2D(`${key}-x`, t * 0.12, 0) * width * 0.03;
    const my = y + Math.cos(angle) * distance + drift + noise2D(`${key}-y`, t * 0.1, 0) * height * 0.015;
    const fade = Math.sin(phase * Math.PI);
    const radius = (0.8 + random(`${key}-r`) * 2.2) * (width / 1080);
    return { mx, my: ((my - y) % (reach * 0.85)) + y, fade, radius, key };
  });

  const core = Math.min(width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: ground, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse ${(width * 0.75).toFixed(0)}px ${(height * 0.5).toFixed(0)}px at ${x}px ${y}px, ${alpha(light, 0.2 * intensity * breath)} 0%, ${alpha(light, 0.05 * intensity * breath)} 45%, transparent 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: layers.join(", "),
          mixBlendMode: "screen",
          filter: `blur(${(width * 0.0045).toFixed(1)}px)`,
          maskImage: `radial-gradient(circle ${reach.toFixed(0)}px at ${x}px ${y}px, black 0%, rgba(0,0,0,0.85) 30%, rgba(0,0,0,0.35) 70%, transparent 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          background: `radial-gradient(circle ${(core * 0.12).toFixed(0)}px at ${x}px ${y}px, ${alpha("#ffffff", 0.9 * intensity * breath)} 0%, ${alpha(light, 0.45 * intensity * breath)} 30%, transparent 100%)`,
        }}
      />
      {dust > 0 ? (
        <svg
          width={width}
          height={height}
          style={{ position: "absolute", inset: 0, mixBlendMode: "screen" }}
          aria-hidden
        >
          {motes.map((m) => (
            <circle
              key={m.key}
              cx={m.mx}
              cy={m.my}
              r={m.radius}
              fill={light}
              opacity={Math.min(1, 0.7 * m.fade * intensity)}
            />
          ))}
        </svg>
      ) : null}
      <FilmGrain seed={seed} opacity={0.06} />
    </AbsoluteFill>
  );
};
