import type React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { trackPoint } from "../../timing";
import type { Cue } from "../types";

export const glassLensSchema = z.object({
  stops: z
    .array(z.object({ at: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
    .min(1)
    .refine(
      (stops) => stops.every((stop, i) => i === 0 || stop.at > stops[i - 1]!.at),
      "Lens stops must ascend in time.",
    ),
  radius: z.number().min(0.05).max(0.35),
  zoom: z.number().min(1.08).max(3),
  src: z.string().optional(),
  ground: z.string(),
});

export type GlassLensProps = z.infer<typeof glassLensSchema>;

export const glassLensDefaults = {
  stops: [
    { at: 0, x: 0.31, y: 0.54 },
    { at: 20, x: 0.31, y: 0.54 },
    { at: 50, x: 0.64, y: 0.47 },
    { at: 94, x: 0.64, y: 0.47 },
  ],
  radius: 0.145,
  zoom: 1.64,
  ground: "#E7EAD8",
} satisfies GlassLensProps;

export const glassLensCues = (p: GlassLensProps): Cue[] =>
  p.stops
    .slice(1)
    .flatMap(({ at, x, y }, i) =>
      x === p.stops[i]!.x && y === p.stops[i]!.y
        ? []
        : [{ frame: at, kind: "land", sfx: "glass", label: "Lens settles" }],
    );

export const lensPose = (frame: number, width: number, height: number, p: GlassLensProps) => {
  const radius = p.radius * Math.min(width, height);
  const point = trackPoint(
    frame,
    p.stops.map((stop) => ({ ...stop, curve: "drift" })),
  );
  return {
    radius,
    x: Math.max(radius, Math.min(width - radius, width * point.x)),
    y: Math.max(radius, Math.min(height - radius, height * point.y)),
  };
};

export const LensArtwork: React.FC<{ title?: string; label?: string }> = ({
  title = "Surface study",
  label = "FIELD NOTES / 03",
}) => (
  <svg width="100%" height="100%" viewBox="0 0 900 700" style={{ position: "absolute", inset: 0 }}>
    <rect x="100" y="110" width="700" height="474" rx="16" fill="#C8D7AD" stroke="#526549" />
    {Array.from({ length: 18 }, (_, i) => {
      const size = 1 - i * 0.044;
      return (
        <path
          key={i}
          d="M 232 320 C 242 184 430 166 588 225 S 740 407 580 475 S 190 467 232 320 Z"
          transform={`translate(490 345) rotate(${i * 2.6 - 9}) scale(${size}) translate(-490 -345)`}
          stroke="#344C35"
          strokeWidth={i % 5 === 0 ? 2 : 0.85}
          fill="none"
        />
      );
    })}
    <path d="M120 147h43m-21-21v42m581 373h46m-23-23v46" fill="none" stroke="#526549" />
    <text
      x="177"
      y="150"
      fill="#263E2A"
      fontFamily="Arial, sans-serif"
      fontWeight="700"
      fontSize="18"
      letterSpacing="2"
    >
      {label}
    </text>
    <text x="128" y="548" fill="#203626" fontFamily="Georgia, serif" fontSize="48" letterSpacing="-2">
      {title}
    </text>
  </svg>
);

/** Children are drawn once on the ground and again inside the concentric lens regions. */
export const GlassLens: React.FC<GlassLensProps & { children?: React.ReactNode }> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { x, y, radius } = lensPose(frame, width, height, p);
  const plate =
    p.children ??
    (p.src ? (
      <Img src={staticFile(p.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    ) : (
      <LensArtwork />
    ));
  const origin = `${x}px ${y}px`;
  return (
    <AbsoluteFill style={{ background: p.ground, overflow: "hidden" }}>
      <AbsoluteFill style={{ isolation: "isolate" }}>{plate}</AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: x - radius,
          top: y - radius,
          width: radius * 2,
          height: radius * 2,
          borderRadius: "50%",
          boxShadow: "0 12px 42px #2038285C",
        }}
      />
      {[
        { share: 1, zoom: 1.12 },
        { share: 0.95, zoom: 1.05 },
        { share: 0.87, zoom: 1 },
      ].map(({ share, zoom }) => (
        <AbsoluteFill key={share} aria-hidden style={{ clipPath: `circle(${radius * share}px at ${origin})` }}>
          <AbsoluteFill style={{ background: p.ground, transformOrigin: origin, transform: `scale(${p.zoom * zoom})` }}>
            {plate}
          </AbsoluteFill>
        </AbsoluteFill>
      ))}
      <div
        style={{
          position: "absolute",
          left: x - radius,
          top: y - radius,
          width: radius * 2,
          height: radius * 2,
          boxSizing: "border-box",
          borderRadius: "50%",
          border: `${Math.max(2, radius * 0.019)}px solid #F6FFDABB`,
          boxShadow: "inset 0 2px 12px #F6FFDAB0, inset 0 -7px 17px #253D3C58",
          background: "linear-gradient(144deg, #FCFFE32E, transparent 31%, transparent 74%, #36564F21)",
        }}
      />
    </AbsoluteFill>
  );
};
