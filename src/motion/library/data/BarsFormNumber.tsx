import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { studioAccent, studioInk, studioPaper } from "../ui/production-surface";

const digits = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
const segment = {
  a: [49, 12, 74, 0],
  b: [87, 49, 60, 90],
  c: [87, 124, 60, 90],
  d: [49, 162, 74, 0],
  e: [11, 124, 60, 90],
  f: [11, 49, 60, 90],
  g: [49, 87, 66, 0],
} as const;
export const barsFormNumberSchema = z.object({
  value: z.string().regex(/^\d{1,4}$/),
  label: z.string().min(1).max(30),
  at: z.number().int().nonnegative(),
  moveFrames: z.number().int().min(10),
  accent: z.string(),
  ground: z.string(),
  ink: z.string(),
});
export type BarsFormNumberProps = z.infer<typeof barsFormNumberSchema>;
export const barsFormNumberDefaults = {
  value: "30",
  label: "Frames per second",
  at: 24,
  moveFrames: 34,
  accent: studioAccent,
  ground: studioInk,
  ink: studioPaper,
} satisfies BarsFormNumberProps;
export const barsFormNumberCues = (p: BarsFormNumberProps): Cue[] => [
  { frame: p.at + p.moveFrames, kind: "land", sfx: "chime", weight: "hero", label: "Number formed" },
];
export const numberSegments = (value: string) =>
  [...value].flatMap((digit, index) =>
    [...digits[Number(digit)]!].map((key) => {
      const [x, y, length, angle] = segment[key as keyof typeof segment];
      return { x: 115 * index + x, y, length, angle };
    }),
  );
export const barMorphProgress = (frame: number, p: BarsFormNumberProps, index: number, count: number) => {
  const offset = Math.round((index / Math.max(1, count - 1)) * p.moveFrames * 0.32);
  return progress(frame, p.at + offset, p.moveFrames - offset, "drift");
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const BarsFormNumber: React.FC<BarsFormNumberProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const u = width / 1920;
  const segments = numberSegments(p.value);
  const land = progress(frame, p.at + p.moveFrames - 8, 8, "drift");
  const count = segments.length;
  const digitWidth = p.value.length * 115 - 16;
  return (
    <AbsoluteFill
      style={{
        background: p.ground,
        color: p.ink,
        display: "grid",
        placeItems: "center",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div style={{ position: "absolute", width: "68%", height: "68%", top: "15%", left: "16%" }}>
        <svg viewBox="-30 -36 480 232" width="100%" height="100%" aria-hidden>
          <path
            d="M0 0v171h414 M0 121h414M0 71h414M0 21h414"
            stroke={p.ink}
            strokeWidth="0.75"
            opacity={0.27 * (1 - land)}
            fill="none"
          />
          {segments.map((s, index) => {
            const t = barMorphProgress(frame, p, index, count);
            const barLength = 26 + ((index * 47 + 17) % 121);
            const x = mix((index + 0.5) * (414 / count), 207 - digitWidth / 2 + s.x, t);
            const y = mix(171 - barLength / 2, s.y, t);
            const length = mix(barLength, s.length, t);
            return (
              <rect
                key={index}
                x={-length / 2}
                y={-5.5}
                width={length}
                height="11"
                rx="4"
                fill={p.accent}
                opacity={mix(0.57 + (index % 3) * 0.18, 1, t)}
                transform={`translate(${x} ${y}) rotate(${mix(-90, s.angle, t)})`}
              />
            );
          })}
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: "16%",
          fontSize: u * 30,
          fontWeight: 650,
          textTransform: "uppercase",
          letterSpacing: "0.15em",
          opacity: land,
        }}
      >
        {p.label}
      </div>
    </AbsoluteFill>
  );
};
