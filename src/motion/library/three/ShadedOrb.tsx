import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { FittedLine } from "../../text";
import { plateSchema } from "./plate-plan";
import { PlateLayer } from "./PlateLayer";
import {
  ACE_ORB,
  FLAME_SPHERES,
  orbState,
  sphereField,
  spherePose,
  type FieldSphere,
  type OrbPlan,
} from "./three-plan";

/**
 * A drawn sphere, no WebGL, so it can sit inline in a line of type. `glossy`: a radial-gradient body with a specular
 * highlight that grows, shifts colour, opens two eyes and floods with a second colour from the bottom (ace t05), or
 * carries a mark between two words (cashfree orb-match-cut). `iridescent`: a seeded field of spheres with a conic hue
 * band, radial shading and blur by depth that enters from the edges, leaving the centre clear, and can implode (flame).
 */
export const shadedOrbSchema = z.object({
  mode: z.enum(["glossy", "iridescent"]),
  /** Flat ground behind the orb, or "transparent" to lay it over other layers. */
  ground: z.string(),
  /** First frame of the move. */
  at: z.number().int().min(0),
  // glossy
  /** Orb diameter as a share of the frame's shorter side (ace: 0.4 of the cell). */
  size: z.number().min(0.02).max(1.2),
  colour: z.string(),
  /** Colour it shifts to after growing (ace: towards cyan); same as `colour` for no shift. */
  shiftTo: z.string(),
  /** Bottom-up flood colour; empty for none. */
  flood: z.string(),
  eyes: z.boolean(),
  /** A short mark drawn on the orb (a letter or symbol); empty for none. */
  mark: z.string(),
  /** Words either side of the orb, so it reads as a word in the sentence; empty for none. */
  before: z.string(),
  after: z.string(),
  textColour: z.string(),
  /** Frame offsets of each step after `at`; defaults are ace's at 30 fps. */
  timing: z
    .object({
      grow: z.number().int().min(0),
      shiftAt: z.number().int().min(0),
      shift: z.number().int().min(0),
      eyesAt: z.number().int().min(0),
      eyes: z.number().int().min(0),
      floodAt: z.number().int().min(0),
      flood: z.number().int().min(0),
    })
    .optional(),
  // iridescent
  count: z.number().int().min(1).max(24).optional(),
  seed: z.string().optional(),
  /** Frame (from `at`) the field pulls into a ring and implodes; omit to keep it. */
  collapseAt: z.number().int().min(0).optional(),
  /** Words typed at the clear centre. */
  caption: z.string().optional(),
  /**
   * A Blender render to play instead of the drawn orb (scripts/blender/glossy_orb.py, same timing keys, so the cues
   * still land). The plate replaces the drawing and its words; the ground stays behind a letterboxed `contain` plate.
   */
  plate: plateSchema.optional(),
});

export type ShadedOrbProps = z.infer<typeof shadedOrbSchema>;

export type GlossyOrbProps = {
  /** Diameter in pixels. */
  size: number;
  colour: string;
  /** 0..1 towards `shiftTo`. */
  shift?: number;
  shiftTo?: string;
  /** 0..1 eye opacity. */
  eyes?: number;
  /** 0..1 height of the flood from the bottom. */
  flood?: number;
  floodColour?: string;
  mark?: string;
  markColour?: string;
  style?: React.CSSProperties;
};

/** One glossy orb, static: drive its numbers from the frame (orbState) and place it anywhere, inline included. */
export const GlossyOrb: React.FC<GlossyOrbProps> = ({
  size,
  colour,
  shift = 0,
  shiftTo = colour,
  eyes = 0,
  flood = 0,
  floodColour = colour,
  mark = "",
  markColour = "#ffffff",
  style,
}) => {
  const body = `color-mix(in srgb, ${shiftTo} ${Math.round(shift * 100)}%, ${colour})`;
  const shade = (c: string) =>
    `radial-gradient(circle at 34% 26%, #ffffff 0%, color-mix(in srgb, ${c} 45%, white) 14%, ${c} 46%, color-mix(in srgb, ${c} 72%, black) 100%)`;
  const eyeW = size * 0.055;
  const eyeH = size * 0.17;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        background: shade(body),
        flexShrink: 0,
        ...style,
      }}
    >
      {flood > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: shade(floodColour),
            clipPath: `inset(${(1 - flood) * 100}% 0 0 0)`,
          }}
        />
      ) : null}
      {eyes > 0
        ? [-1, 1].map((side) => (
            <div
              key={side}
              style={{
                position: "absolute",
                left: size / 2 + side * size * 0.12 - eyeW / 2,
                top: size * 0.3,
                width: eyeW,
                height: eyeH,
                borderRadius: eyeW,
                background: "#ffffff",
                opacity: eyes,
                transform: `rotate(${side * -6}deg)`,
              }}
            />
          ))
        : null}
      {mark ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: markColour,
            fontFamily: primaryFont,
            fontWeight: 800,
            fontSize: size * 0.48,
            lineHeight: 1,
          }}
        >
          {mark}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: "16%",
          top: "8%",
          width: "42%",
          height: "26%",
          borderRadius: "50%",
          background: "radial-gradient(ellipse at 50% 50%, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0) 70%)",
          transform: "rotate(-24deg)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          boxShadow: `inset 0 ${-size * 0.06}px ${size * 0.12}px rgba(0,0,0,0.18), inset 0 ${size * 0.02}px ${size * 0.04}px rgba(255,255,255,0.35)`,
        }}
      />
    </div>
  );
};

/** Hue offsets of the bands, far apart so neighbouring bands read as stripes (flame), not a smooth rainbow. */
const BANDS = [0, 140, 40, 200, 90, 260, 10, 150, 50, 210, 100, 270, 0];

/** One iridescent sphere: a conic hue band tilted across a radial shade; `depth` softens and blurs it. */
export const IridescentSphere: React.FC<{
  size: number;
  hue: number;
  tilt: number;
  depth?: number;
  style?: React.CSSProperties;
}> = ({ size, hue, tilt, depth = 0, style }) => {
  const h = (d: number) => `hsl(${(hue + d) % 360} 88% 58%)`;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: [
          "radial-gradient(circle at 32% 26%, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 26%)",
          "radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.28) 100%)",
          `conic-gradient(from ${tilt}deg at 135% 125%, ${BANDS.map(h).join(", ")})`,
        ].join(", "),
        filter: `blur(${(depth * size * 0.035).toFixed(2)}px) saturate(${1 - depth * 0.25})`,
        ...style,
      }}
    />
  );
};

const GlossyScene: React.FC<ShadedOrbProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const plan: OrbPlan = { at: p.at, ...ACE_ORB, ...p.timing };
  const s = orbState(frame, plan);
  const size = Math.min(width, height) * p.size;
  const inline = Boolean(p.before || p.after);
  const orb = (
    <GlossyOrb
      size={size * s.scale}
      colour={p.colour}
      shift={s.shift}
      shiftTo={p.shiftTo}
      eyes={p.eyes ? s.eyes : 0}
      flood={p.flood ? s.flood : 0}
      floodColour={p.flood || p.colour}
      mark={p.mark}
      style={{ opacity: s.scale > 0 ? 1 : 0 }}
    />
  );
  if (!inline) return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>{orb}</AbsoluteFill>;
  const words = [p.before, p.after].filter(Boolean).join("  ");
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <FittedLine text={`${words}  MM`} withinWidth={width * 0.84} fontFamily={primaryFont} fontWeight={700}>
        {(fitted) => {
          const fontSize = Math.min(fitted, size * 0.9);
          const gap = fontSize * 0.28;
          const word = (text: string) => (
            <span
              style={{
                fontFamily: primaryFont,
                fontWeight: 700,
                fontSize,
                color: p.textColour,
                letterSpacing: "-0.02em",
                whiteSpace: "pre",
              }}
            >
              {text}
            </span>
          );
          return (
            <div style={{ display: "flex", alignItems: "center", gap }}>
              {p.before ? word(p.before) : null}
              <div
                style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                {orb}
              </div>
              {p.after ? word(p.after) : null}
            </div>
          );
        }}
      </FittedLine>
    </AbsoluteFill>
  );
};

const IridescentScene: React.FC<ShadedOrbProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const field: FieldSphere[] = sphereField(p.seed ?? "flame", p.count ?? 9);
  const collapseAt = p.collapseAt === undefined ? undefined : p.at + p.collapseAt;
  const captionAt = p.at + FLAME_SPHERES.enter + 1;
  const caption = p.caption ?? "";
  const shown = frame >= captionAt ? caption.slice(0, Math.max(0, Math.floor((frame - captionAt) / 1.5) + 1)) : "";
  const captionOut = collapseAt === undefined ? 1 : Math.max(0, 1 - (frame - collapseAt) / 3);
  return (
    <AbsoluteFill>
      {[...field]
        .sort((a, b) => b.depth - a.depth)
        .map((s, i) => {
          const pose = spherePose(s, frame, { enterAt: p.at, collapseAt });
          const d = s.r * 2 * width * pose.scale;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: pose.x * width - d / 2,
                top: pose.y * height - d / 2,
                opacity: pose.opacity,
                filter:
                  pose.blur > 0
                    ? `blur(${(pose.blur * 14).toFixed(1)}px) drop-shadow(${pose.blur * 6}px 0 0 rgba(255,0,140,0.5)) drop-shadow(${-pose.blur * 6}px 0 0 rgba(0,200,255,0.5))`
                    : undefined,
              }}
            >
              <IridescentSphere size={d} hue={s.hue} tilt={s.tilt} depth={s.depth} />
            </div>
          );
        })}
      {caption ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: captionOut }}>
          {/* Fitted on the whole caption, so the size does not change as it types; capped to sit in the clear centre. */}
          <FittedLine
            text={caption}
            withinWidth={width * 0.36}
            fontFamily={primaryFont}
            fontWeight={600}
            maxFontSize={Math.min(width, height) * 0.045}
          >
            {(fontSize) => (
              <div
                style={{ fontFamily: primaryFont, fontWeight: 600, fontSize, color: p.textColour, whiteSpace: "pre" }}
              >
                {shown}
              </div>
            )}
          </FittedLine>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

export const ShadedOrb: React.FC<ShadedOrbProps> = (p) =>
  p.plate ? (
    <PlateLayer plate={p.plate} background={p.ground === "transparent" ? undefined : p.ground} />
  ) : (
    <AbsoluteFill style={{ background: p.ground === "transparent" ? undefined : p.ground }}>
      {p.mode === "glossy" ? <GlossyScene {...p} /> : <IridescentScene {...p} />}
    </AbsoluteFill>
  );

/** Sound: the orb lands when grown and pops on the flood (glossy); the field lands as the spheres settle (iridescent). */
export const shadedOrbCues = (p: ShadedOrbProps) => {
  if (p.mode === "iridescent") {
    const cues = [
      {
        frame: p.at + FLAME_SPHERES.enter,
        kind: "land" as const,
        sfx: "whoosh" as const,
        weight: "hero" as const,
        label: "spheres settle",
      },
    ];
    if (p.collapseAt !== undefined)
      cues.push({
        frame: p.at + p.collapseAt + FLAME_SPHERES.collapse,
        kind: "land" as const,
        sfx: "whoosh" as const,
        weight: "hero" as const,
        label: "field implodes",
      });
    return cues;
  }
  const t = { ...ACE_ORB, ...p.timing };
  const cues: {
    frame: number;
    kind: "land" | "reveal" | "hit";
    sfx: "pop" | "chime";
    weight: "hero" | "support";
    label: string;
  }[] = [{ frame: p.at + t.grow, kind: "land", sfx: "pop", weight: "hero", label: "orb full size" }];
  if (p.eyes) cues.push({ frame: p.at + t.eyesAt, kind: "reveal", sfx: "pop", weight: "support", label: "eyes open" });
  if (p.flood)
    cues.push({
      frame: p.at + t.floodAt + t.flood,
      kind: "hit",
      sfx: "chime",
      weight: "support",
      label: "colour flood",
    });
  return cues;
};
