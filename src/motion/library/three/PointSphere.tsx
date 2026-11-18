import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { FittedLine } from "../../text";
import { mixHex } from "../backgrounds/background-plan";
import {
  FLEX_PULL_OUT,
  isLand,
  project,
  pullOut,
  rotate,
  sphereArcs,
  spherePoints,
  tintAt,
  type Vec3,
} from "./three-plan";

/**
 * Seeded short strokes (flex) or dots (flame's globe) on a sphere, projected in SVG every frame: a slow turn, a pull-out
 * from close, a two-colour tint that drifts, optional procedural land and a thin ring. No WebGL, so strokes keep their
 * width and the back half can fade by depth.
 */
export const pointSphereSchema = z.object({
  marks: z.enum(["strokes", "dots"]),
  count: z.number().int().min(20).max(2000),
  seed: z.string(),
  /** Flat ground, or "transparent" to lay the sphere over other layers. */
  ground: z.string(),
  /** Tint from the top of the sphere (colourA) to the bottom (colourB); `drift` shifts it over time. */
  colourA: z.string(),
  colourB: z.string(),
  drift: z.number().min(0).max(1),
  /** Radius as a share of the frame's shorter side. */
  radius: z.number().min(0.1).max(0.9),
  /** Turn in degrees per second, and the tilt of the axis towards the viewer. */
  spin: z.number().min(-120).max(120),
  tilt: z.number().min(-60).max(60),
  /** Pull-out: from `from` times the size to rest over `frames`, circ.out (flex) or expo.out (flame). */
  pullOut: z.object({
    at: z.number().int().min(0),
    frames: z.number().int().min(0),
    from: z.number().min(1).max(4),
    ease: z.enum(["circ.out", "expo.out"]),
  }),
  /** Keep only marks on procedural land: a dotted globe of invented continents. */
  land: z.boolean(),
  /** A thin circle round the sphere (flame). */
  ring: z.boolean(),
  /** Text centred over the sphere, word by word `wordEvery` frames apart from 5 frames after the pull-out starts, re-centring. */
  text: z.string(),
  textColour: z.string(),
  wordEvery: z.number().int().min(0).max(30),
  /** Stroke width or dot radius as a share of the sphere radius. */
  weight: z.number().min(0.001).max(0.03),
});

export type PointSphereProps = z.infer<typeof pointSphereSchema>;

type Mark = { points: Vec3[] };

export const PointSphere: React.FC<PointSphereProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const marks: Mark[] = useMemo(() => {
    const raw =
      p.marks === "strokes"
        ? sphereArcs(p.seed, p.count, { length: 0.45, samples: 7 })
        : spherePoints(p.seed, p.count).map((q) => [q]);
    return raw.filter((pts) => !p.land || isLand(pts[0]!, p.seed)).map((points) => ({ points }));
  }, [p.marks, p.seed, p.count, p.land]);
  const scale = pullOut(frame, p.pullOut);
  const r = Math.min(width, height) * p.radius * scale;
  const yaw = ((p.spin * frame) / fps) * (Math.PI / 180);
  const pitch = (p.tilt * Math.PI) / 180;
  const cx = width / 2;
  const cy = height / 2;
  const stroke = Math.max(1, r * p.weight);
  const items = marks.map((m, i) => {
    const rotated = m.points.map((q) => rotate(q, yaw, pitch));
    const projected = rotated.map((q) => project(q, { cx, cy, radius: r }));
    const depth = projected.reduce((s, q) => s + q.depth, 0) / projected.length;
    const colour = mixHex(p.colourA, p.colourB, tintAt(m.points[0]!, frame, p.drift));
    const opacity = 0.18 + 0.82 * depth ** 1.5;
    if (projected.length === 1) {
      const q = projected[0]!;
      return <circle key={i} cx={q.x} cy={q.y} r={stroke * q.scale} fill={colour} opacity={opacity} />;
    }
    const d = projected.map((q, k) => `${k ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
    return (
      <path
        key={i}
        d={d}
        stroke={colour}
        strokeWidth={stroke * projected[0]!.scale}
        strokeLinecap="round"
        fill="none"
        opacity={opacity}
      />
    );
  });
  const words = p.text ? p.text.split(" ") : [];
  const textAt = p.pullOut.at + 5;
  return (
    <AbsoluteFill style={{ background: p.ground === "transparent" ? undefined : p.ground }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {items}
        {p.ring ? (
          <circle
            cx={cx}
            cy={cy}
            r={r * 1.12}
            fill="none"
            stroke={p.colourB}
            strokeOpacity={0.5}
            strokeWidth={Math.max(1, r * 0.004)}
          />
        ) : null}
      </svg>
      {words.length ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <FittedLine
            text={p.text}
            withinWidth={Math.min(width * 0.8, r * 2.2)}
            fontFamily={primaryFont}
            fontWeight={500}
            maxFontSize={Math.min(width, height) * 0.09}
          >
            {(fontSize) => (
              <div
                style={{
                  fontFamily: primaryFont,
                  fontWeight: 500,
                  fontSize,
                  color: p.textColour,
                  letterSpacing: "-0.02em",
                  whiteSpace: "pre",
                }}
              >
                {words.map((w, k) => {
                  const at = textAt + k * p.wordEvery;
                  // Only words already in are laid out, so the line re-centres as it grows (flex).
                  if (frame < at) return null;
                  return (
                    <span key={k} style={{ opacity: Math.min(1, (frame - at + 1) / 3) }}>
                      {k ? " " : ""}
                      {w}
                    </span>
                  );
                })}
              </div>
            )}
          </FittedLine>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

export const pointSphereDefaults: PointSphereProps = {
  marks: "strokes",
  count: 260,
  seed: "flex",
  ground: "#0c1f16",
  colourA: "#9be8b8",
  colourB: "#2f8a5c",
  drift: 0.2,
  radius: 0.4,
  spin: 9,
  tilt: 14,
  pullOut: { at: 0, frames: FLEX_PULL_OUT.frames, from: FLEX_PULL_OUT.from, ease: "circ.out" },
  land: false,
  ring: false,
  text: "170+ countries",
  textColour: "#eef6f0",
  wordEvery: 9,
  weight: 0.006,
};

/** Sound: the pull-out settling, then each word of the text. */
export const pointSphereCues = (p: PointSphereProps) => [
  {
    frame: p.pullOut.at,
    kind: "reveal" as const,
    sfx: "whoosh" as const,
    weight: "support" as const,
    label: "sphere pulls out",
  },
  ...(p.text ? p.text.split(" ") : []).map((_, k) => ({
    frame: p.pullOut.at + 5 + k * p.wordEvery,
    kind: "type" as const,
    sfx: "none" as const,
    weight: (k === 0 ? "hero" : "support") as "hero" | "support",
    label: `word ${k + 1}`,
  })),
];
