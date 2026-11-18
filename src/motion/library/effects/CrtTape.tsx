import { loadFont } from "@remotion/google-fonts/GeistMono";
import React, { useId } from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import type { Cue } from "../types";
import { FilmGrain } from "../../fx";

export type CrtTapeSettings = {
  /** Depth of the dark scanline gaps, 0 to 0.5; period 3 px at 1080 lines. */
  scan?: number;
  /** RGB aperture grille, 0 to 0.2. */
  grille?: number;
  /** Horizontal chroma smear in pixels at 1080 lines: tape colour bandwidth is a fraction of its luma. */
  bleed?: number;
  /** Red shifted right, in pixels at 1080 lines. */
  redShift?: number;
  /** Phosphor glow: bright areas spill into their surroundings. Renders the children a second time. */
  glow?: number;
  /** Corner darkening, 0 to 0.6. No curved black bezel. */
  corner?: number;
  noise?: number;
  /** Frames of the power-on (a dot stretches into a line, then opens); 0 starts with the picture on. */
  powerOn?: number;
  /** Steady tape tracking error, 0 to 1. Prefer `tearAt` bursts. */
  track?: number;
  /** Frames where a tracking burst tears the picture for `tearFrames`. */
  tearAt?: number[];
  tearFrames?: number;
  seed?: string;
};

type CrtTapeProps = CrtTapeSettings & { children: React.ReactNode };

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Tracking amount at a frame: the steady error plus any burst, which hits at full and decays. */
export const trackAt = (frame: number, track: number, tearAt: number[], tearFrames: number): number => {
  let k = track;
  for (const t of tearAt) {
    const d = frame - t;
    if (d >= 0 && d < tearFrames) k = Math.max(k, 1 - (d / tearFrames) ** 2);
  }
  return k;
};

/** Chroma bleed: red smeared and shifted right, blue smeared, green (most of luma) kept sharp, summed back. */
const BleedFilter: React.FC<{ id: string; bleed: number; shift: number }> = ({ id, bleed, shift }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-2%" y="0" width="104%" height="100%" colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feGaussianBlur in="r" stdDeviation={`${bleed * 0.5} 0`} result="rb" />
      <feOffset in="rb" dx={shift} result="rs" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feGaussianBlur in="b" stdDeviation={`${bleed * 0.4} 0`} result="bb" />
      <feComposite in="rs" in2="g" operator="arithmetic" k2={1} k3={1} result="rg" />
      <feComposite in="rg" in2="bb" operator="arithmetic" k2={1} k3={1} />
    </filter>
  </svg>
);

/** Line-by-line horizontal tearing: noise that varies only down the frame drives an x-only displacement. */
const TearFilter: React.FC<{ id: string; amount: number; seed: number; width: number; height: number }> = ({
  id,
  amount,
  seed,
  width,
  height,
}) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-5%" y="0" width="110%" height="100%" colorInterpolationFilters="sRGB">
      <feTurbulence
        type="fractalNoise"
        baseFrequency={`0 ${(0.9 * 1080) / height / 2}`}
        numOctaves={2}
        seed={seed}
        result="n"
      />
      <feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 0 0 0 0.5  0 0 0 0 0  0 0 0 0 1" result="nx" />
      <feDisplacementMap
        in="SourceGraphic"
        in2="nx"
        scale={amount * width * 0.03}
        xChannelSelector="R"
        yChannelSelector="G"
      />
    </filter>
  </svg>
);

/**
 * A picture played off videotape on a CRT: chroma smeared with red shifted right, scanlines and an RGB grille,
 * phosphor glow on brights, darker corners, signal noise; optional power-on and tracking tears on cue.
 * Wrap a shot that is meant to be a screen or a tape (an archive clip, a found recording), not a whole film.
 */
export const CrtTape: React.FC<CrtTapeProps> = ({
  children,
  scan = 0.18,
  grille = 0.06,
  bleed = 7,
  redShift = 2,
  glow = 0.35,
  corner = 0.28,
  noise = 0.05,
  powerOn = 0,
  track = 0,
  tearAt = [],
  tearFrames = 10,
  seed = "crt",
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ids = useId().replaceAll(":", "");
  const u = height / 1080;
  const tracking = trackAt(frame, track, tearAt, tearFrames);
  const p = powerOn > 0 ? Math.min(1, frame / powerOn) : 1;
  const sx = p < 1 ? smooth(0, 0.3, p) : 1;
  const sy = p < 1 ? Math.max(0.003, smooth(0.3, 1, p)) : 1;
  const boost = p < 1 ? (1 - sy) ** 3 : 0;
  const jitterY = tracking > 0 ? (random(`${seed}-jy-${frame}`) - 0.5) * 0.012 * tracking * height : 0;
  const bandY = random(`${seed}-band-${frame}`) * 0.7 + 0.15;
  const period = Math.max(2, 3 * u);
  const filters = [
    `url(#bleed-${ids})`,
    tracking > 0 ? `url(#tear-${ids})` : "",
    `saturate(1.05) contrast(1.08) brightness(${(1.04 + boost * 1.5).toFixed(3)})`,
  ].join(" ");
  const picture = (
    <AbsoluteFill style={{ transform: `translateY(${jitterY.toFixed(2)}px) scale(${sx}, ${sy})`, filter: filters }}>
      {children}
    </AbsoluteFill>
  );
  const g = 255 * (1 - grille);
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
      <BleedFilter id={`bleed-${ids}`} bleed={bleed * u} shift={redShift * u} />
      {tracking > 0 ? (
        <TearFilter
          id={`tear-${ids}`}
          amount={tracking}
          seed={Math.floor(random(`${seed}-tear-${frame}`) * 1e5)}
          width={width}
          height={height}
        />
      ) : null}
      {picture}
      {glow > 0 ? (
        <AbsoluteFill
          style={{ mixBlendMode: "screen", opacity: glow, filter: `brightness(0.9) contrast(2.2) blur(${10 * u}px)` }}
        >
          {picture}
        </AbsoluteFill>
      ) : null}
      {tracking > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            opacity: 0.75 * tracking,
            maskImage: `linear-gradient(180deg, transparent ${(bandY - 0.07) * 100}%, black ${bandY * 100}%, transparent ${(bandY + 0.07) * 100}%)`,
            WebkitMaskImage: `linear-gradient(180deg, transparent ${(bandY - 0.07) * 100}%, black ${bandY * 100}%, transparent ${(bandY + 0.07) * 100}%)`,
          }}
        >
          <FilmGrain seed={`${seed}-band`} opacity={1} cadence={1} frequency={0.5} />
        </AbsoluteFill>
      ) : null}
      {noise > 0 ? <FilmGrain seed={`${seed}-noise`} opacity={noise} cadence={1} frequency={0.9} /> : null}
      {scan > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            mixBlendMode: "multiply",
            backgroundImage: `repeating-linear-gradient(180deg, rgba(0,0,0,0) 0px, rgba(0,0,0,${scan * 1.6}) ${period * 0.5}px, rgba(0,0,0,0) ${period}px)`,
          }}
        />
      ) : null}
      {grille > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            mixBlendMode: "multiply",
            backgroundImage: `repeating-linear-gradient(90deg, rgb(255,${g},${g}) 0px, rgb(255,${g},${g}) ${u}px, rgb(${g},255,${g}) ${u}px, rgb(${g},255,${g}) ${2 * u}px, rgb(${g},${g},255) ${2 * u}px, rgb(${g},${g},255) ${3 * u}px)`,
          }}
        />
      ) : null}
      {corner > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: `radial-gradient(ellipse 75% 75% at 50% 50%, transparent 55%, rgba(0,0,0,${corner * 1.6}) 100%)`,
          }}
        />
      ) : null}
      {boost > 0.001 ? (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
          <div
            style={{
              width: width * sx,
              height: Math.max(2, 4 * u),
              background: "rgb(220,230,255)",
              opacity: boost,
              boxShadow: `0 0 ${24 * u}px ${8 * u}px rgba(200,215,255,${boost * 0.8})`,
            }}
          />
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

export const crtTapeSchema = z.object({
  scan: z.number().min(0).max(0.5),
  grille: z.number().min(0).max(0.2),
  bleed: z.number().min(0).max(16),
  redShift: z.number().min(0).max(8),
  glow: z.number().min(0).max(1),
  corner: z.number().min(0).max(0.6),
  noise: z.number().min(0).max(0.3),
  powerOn: z.number().int().min(0).max(60),
  track: z.number().min(0).max(1),
  tearAt: z.array(z.number().int().min(0)),
  tearFrames: z.number().int().min(1).max(30),
  seed: z.string(),
  channel: z.string(),
  headline: z.string(),
});

export type CrtTapePreviewProps = z.infer<typeof crtTapeSchema>;

export const crtTapeDefaults: CrtTapePreviewProps = {
  scan: 0.18,
  grille: 0.06,
  bleed: 7,
  redShift: 2,
  glow: 0.35,
  corner: 0.28,
  noise: 0.05,
  powerOn: 18,
  track: 0,
  tearAt: [72],
  tearFrames: 10,
  seed: "crt",
  channel: "CH 03",
  headline: "Recorded 14 March 1989",
};

export const crtTapeCues = (props: CrtTapePreviewProps): Cue[] => [
  ...(props.powerOn > 0
    ? [
        {
          frame: props.powerOn,
          kind: "reveal" as const,
          sfx: "sub-drop" as const,
          weight: "hero" as const,
          label: "picture opens after power-on",
        },
      ]
    : []),
  ...props.tearAt.map((frame) => ({
    frame,
    kind: "hit" as const,
    sfx: "whoosh" as const,
    weight: "support" as const,
    label: "tracking tear",
  })),
];

const { fontFamily: mono } = loadFont("normal", { weights: ["500", "700"], subsets: ["latin"] });

const TapePlate: React.FC<{ channel: string; headline: string }> = ({ channel, headline }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  const bars = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];
  return (
    <AbsoluteFill style={{ background: "#0d1630" }}>
      <AbsoluteFill style={{ flexDirection: "row", height: "42%" }}>
        {bars.map((c) => (
          <div key={c} style={{ flex: 1, background: c }} />
        ))}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: unit * 0.07,
          top: unit * 0.06,
          fontFamily: mono,
          fontWeight: 700,
          fontSize: unit * 0.06,
          color: "#f4f4f4",
          textShadow: "0 0 8px rgba(255,255,255,0.6)",
        }}
      >
        {channel}
      </div>
      <div
        style={{
          position: "absolute",
          left: unit * 0.07,
          right: unit * 0.07,
          top: height * 0.55,
          fontFamily: mono,
          fontWeight: 700,
          fontSize: unit * 0.065,
          color: "#ffe14d",
          lineHeight: 1.15,
        }}
      >
        {headline}
      </div>
      <div
        style={{
          position: "absolute",
          left: unit * 0.07,
          bottom: unit * 0.07,
          fontFamily: mono,
          fontWeight: 500,
          fontSize: unit * 0.04,
          color: "#f4f4f4",
        }}
      >
        PLAY ▶ {String(Math.floor(frame / 30)).padStart(2, "0")}:{String(frame % 30).padStart(2, "0")}
      </div>
    </AbsoluteFill>
  );
};

export const CrtTapePreview: React.FC<CrtTapePreviewProps> = ({ channel, headline, ...settings }) => (
  <CrtTape {...settings}>
    <TapePlate channel={channel} headline={headline} />
  </CrtTape>
);
