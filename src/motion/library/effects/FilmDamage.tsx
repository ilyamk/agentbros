import { loadFont } from "@remotion/google-fonts/PlayfairDisplay";
import { noise2D } from "@remotion/noise";
import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";

export type FilmDamageSettings = {
  /** Master amount of wear, 0 to 1: scales weave, flicker, scratches, dust, hair and burn together. */
  strength?: number;
  /** 0 keeps colour, 1 is a silver black-and-white print. */
  monochrome?: number;
  /** 0 neutral silver, 1 a brown-toned print. */
  sepia?: number;
  weave?: number;
  flicker?: number;
  scratches?: number;
  dust?: number;
  burn?: number;
  vignette?: number;
  grain?: number;
  /** Projector speed: above 1 the flicker runs faster and harder, as if hand-cranked. */
  crank?: number;
  seed?: string;
};

type FilmDamageProps = FilmDamageSettings & { children: React.ReactNode };

/** Gate weave in pixels at 1080 lines: the picture drifts under a fixed aperture, with the odd perforation jump. */
export const weaveAt = (frame: number, seed: string, k: number, crank = 1): [number, number] => {
  const f = frame * crank;
  const x =
    (Math.sin(f * 0.31) * 0.6 + Math.sin(f * 0.113 + 1.3) * 0.8 + (random(`${seed}-wx-${frame}`) - 0.5) * 0.5) *
    1.4 *
    k;
  let y =
    (Math.sin(f * 0.23 + 0.7) * 0.7 + Math.sin(f * 0.071 + 2.1) * 0.9 + (random(`${seed}-wy-${frame}`) - 0.5) * 0.6) *
    1.6 *
    k;
  if (random(`${seed}-jump-${Math.floor(frame / 2)}`) < 0.025 * k) y += 4 * k;
  return [x, y];
};

/** Exposure multiplier around 1: per-frame density flicker plus the projector's slower pulse. */
export const flickerAt = (frame: number, seed: string, k: number, crank = 1): number => {
  const f = frame * crank;
  return (
    1 +
    ((random(`${seed}-fl-${frame}`) - 0.5) * 0.09 + Math.sin(f * 1.9) * 0.025 * crank + Math.sin(f * 0.37) * 0.02) * k
  );
};

const Scratches: React.FC<{
  frame: number;
  seed: string;
  amount: number;
  width: number;
  height: number;
  u: number;
}> = ({ frame, seed, amount, width, height, u }) => {
  const lines: React.ReactNode[] = [];
  for (let i = 0; i < 4; i++) {
    const life = Math.floor((frame + i * 17) / (5 + i * 3));
    if (random(`${seed}-son-${i}-${life}`) < 1 - amount * (0.55 - i * 0.1)) continue;
    const x = random(`${seed}-sx-${i}-${life}`) * width + Math.sin(frame * 0.37 + i) * 3 * u;
    const w = (0.6 + random(`${seed}-sw-${i}-${life}`) * 1.4) * u;
    const dark = random(`${seed}-sd-${i}-${life}`) > 0.62;
    const segments = 9;
    for (let s = 0; s < segments; s++) {
      if (random(`${seed}-ss-${i}-${life}-${s}`) < 0.25) continue;
      lines.push(
        <line
          key={`${i}-${s}`}
          x1={x}
          x2={x + (random(`${seed}-sk-${i}-${life}`) - 0.5) * 2 * u}
          y1={(s / segments) * height}
          y2={((s + 1) / segments) * height}
          stroke={dark ? "rgba(12,10,8,0.55)" : "rgba(250,246,236,0.7)"}
          strokeWidth={w}
        />,
      );
    }
  }
  return <>{lines}</>;
};

const Dust: React.FC<{
  frame: number;
  seed: string;
  amount: number;
  width: number;
  height: number;
  u: number;
  hair: number;
}> = ({ frame, seed, amount, width, height, u, hair }) => {
  const r = (key: string) => random(`${seed}-${key}`);
  const specks: React.ReactNode[] = [];
  const count = Math.floor((2 + r(`dn-${frame}`) * 7) * amount);
  for (let i = 0; i < count; i++) {
    const px = r(`da-${frame}-${i}`) * width;
    const py = r(`db-${frame}-${i}`) * height;
    const c = r(`dc-${frame}-${i}`);
    const rad = (0.8 + c * c * 3.2) * u;
    const white = r(`dw-${frame}-${i}`) < 0.35;
    const m = 5 + Math.floor(c * 4);
    const points = Array.from({ length: m }, (_, j) => {
      const an = (j / m) * Math.PI * 2;
      const rr = rad * (0.6 + r(`dr-${frame}-${i}-${j}`) * 0.7);
      return `${(px + Math.cos(an) * rr).toFixed(1)},${(py + Math.sin(an) * rr).toFixed(1)}`;
    }).join(" ");
    specks.push(
      <polygon
        key={`d${i}`}
        points={points}
        fill={white ? `rgba(240,232,215,${0.55 + c * 0.4})` : `rgba(12,10,8,${0.6 + c * 0.35})`}
      />,
    );
  }
  const hairLife = Math.floor(frame / 11);
  if (r(`h-${hairLife}`) < 0.22 * hair) {
    const hx = r(`hx-${hairLife}`) * width;
    const hy = r(`hy-${hairLife}`) * height;
    const len = (40 + r(`hl-${hairLife}`) * 90) * u;
    const d = Array.from({ length: 21 }, (_, j) => {
      const k = j / 20;
      const x = hx + Math.sin(k * 5 + hairLife) * 14 * u * k + k * len * 0.6;
      const y = hy + k * len + Math.sin(k * 9 + frame * 0.3) * 3 * u;
      return `${j ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    specks.push(<path key="hair" d={d} stroke="rgba(10,8,6,0.75)" strokeWidth={1.2 * u} fill="none" />);
  }
  if (r(`blotch-${frame}`) < 0.012 * amount) {
    specks.push(
      <circle
        key="blotch"
        cx={(0.2 + r(`bx-${frame}`) * 0.6) * width}
        cy={(0.15 + r(`by-${frame}`) * 0.3) * height}
        r={(10 + r(`br-${frame}`) * 18) * u}
        fill="rgba(245,238,222,0.5)"
      />,
    );
  }
  return <>{specks}</>;
};

/**
 * An old projected print over any scene: gate weave, exposure flicker, vertical scratches that live a few frames,
 * dust and the odd hair caught in the gate, edges burning brown, silver or sepia tone, coarse grain.
 * Wrap a shot, not a whole modern film. Keep `<Audio>` outside: the picture is filtered.
 */
export const FilmDamage: React.FC<FilmDamageProps> = ({
  children,
  strength = 0.6,
  monochrome = 1,
  sepia = 0.15,
  weave = 1,
  flicker = 1,
  scratches = 1,
  dust = 1,
  burn = 1,
  vignette = 1,
  grain = 1,
  crank = 1,
  seed = "film-damage",
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = height / 1080;
  const [wx, wy] = weaveAt(frame, seed, strength * weave, crank);
  const exposure = flickerAt(frame, seed, strength * flicker, crank);
  const burnAmount = strength * burn;
  const edge = 0.5 + 0.5 * noise2D(`${seed}-burn`, frame * 0.004, 0);
  const filter = [
    `grayscale(${monochrome})`,
    sepia > 0 ? `sepia(${sepia})` : "",
    "contrast(1.12)",
    `brightness(${exposure.toFixed(4)})`,
    "blur(0.35px)",
  ].join(" ");
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
      <AbsoluteFill style={{ transform: `translate(${(wx * u).toFixed(2)}px, ${(wy * u).toFixed(2)}px)`, filter }}>
        {children}
      </AbsoluteFill>
      {burnAmount > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            mixBlendMode: "multiply",
            opacity: Math.min(1, burnAmount * (0.75 + 0.5 * edge)),
            background: `radial-gradient(ellipse ${92 + edge * 6}% ${88 + edge * 8}% at ${50 + (edge - 0.5) * 4}% 50%, transparent 62%, rgba(120,72,34,0.55) 86%, rgba(60,30,12,0.85) 100%)`,
          }}
        />
      ) : null}
      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: `radial-gradient(ellipse 80% 86% at 50% 50%, transparent 40%, rgba(0,0,0,${0.62 * vignette}) 100%)`,
          }}
        />
      ) : null}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {scratches > 0 ? (
            <Scratches frame={frame} seed={seed} amount={strength * scratches} width={width} height={height} u={u} />
          ) : null}
          {dust > 0 ? (
            <Dust
              frame={frame}
              seed={seed}
              amount={strength * dust}
              width={width}
              height={height}
              u={u}
              hair={strength}
            />
          ) : null}
        </svg>
      </AbsoluteFill>
      {grain > 0 ? (
        <FilmGrain
          seed={`${seed}-grain`}
          opacity={Math.min(0.5, (0.12 + strength * 0.14) * grain)}
          cadence={1}
          frequency={0.72}
        />
      ) : null}
    </AbsoluteFill>
  );
};

export const filmDamageSchema = z.object({
  strength: z.number().min(0).max(1),
  monochrome: z.number().min(0).max(1),
  sepia: z.number().min(0).max(1),
  weave: z.number().min(0).max(3),
  flicker: z.number().min(0).max(3),
  scratches: z.number().min(0).max(2),
  dust: z.number().min(0).max(3),
  burn: z.number().min(0).max(2),
  vignette: z.number().min(0).max(1.5),
  grain: z.number().min(0).max(2),
  crank: z.number().min(0.5).max(3),
  seed: z.string(),
  title: z.string(),
  subtitle: z.string(),
});

export type FilmDamagePreviewProps = z.infer<typeof filmDamageSchema>;

export const filmDamageDefaults: FilmDamagePreviewProps = {
  strength: 0.6,
  monochrome: 1,
  sepia: 0.15,
  weave: 1,
  flicker: 1,
  scratches: 1,
  dust: 1,
  burn: 1,
  vignette: 1,
  grain: 1,
  crank: 1,
  seed: "film-damage",
  title: "The First Train",
  subtitle: "Arriving at the station, 1896",
};

const { fontFamily: serif } = loadFont("normal", { weights: ["700"], subsets: ["latin"] });
const { fontFamily: serifItalic } = loadFont("italic", { weights: ["400"], subsets: ["latin"] });

/** An intertitle card: the content must be a real picture, never a blank ground, or the damage has nothing to age. */
const Intertitle: React.FC<{ title: string; subtitle: string }> = ({ title, subtitle }) => {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(ellipse 70% 70% at 50% 45%, #d9d2c3 0%, #8b8577 70%, #3b3832 100%)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: unit * 0.07,
          border: `${unit * 0.006}px solid #1b1915`,
          outline: `${unit * 0.002}px solid #1b1915`,
          outlineOffset: unit * 0.012,
        }}
      />
      <div
        style={{
          fontFamily: serif,
          fontWeight: 700,
          fontSize: unit * 0.11,
          color: "#16140f",
          textAlign: "center",
          lineHeight: 1.05,
          padding: `0 ${unit * 0.12}px`,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: serifItalic,
          fontStyle: "italic",
          fontSize: unit * 0.042,
          color: "#2a2620",
          marginTop: unit * 0.04,
          textAlign: "center",
          padding: `0 ${unit * 0.12}px`,
        }}
      >
        {subtitle}
      </div>
    </AbsoluteFill>
  );
};

export const FilmDamagePreview: React.FC<FilmDamagePreviewProps> = ({ title, subtitle, ...settings }) => (
  <FilmDamage {...settings}>
    <Intertitle title={title} subtitle={subtitle} />
  </FilmDamage>
);
