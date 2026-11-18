import { loadFont } from "@remotion/google-fonts/Archivo";
import React, { useId } from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import type { TextureKind } from "./presets";

export const TEXTURE_KINDS = ["paper", "halftone", "scanlines"] as const satisfies readonly TextureKind[];
const BLEND_MODES = ["multiply", "overlay", "soft-light", "screen", "normal"] as const;
type BlendMode = (typeof BLEND_MODES)[number];

export type TextureOverlayProps = {
  kind: TextureKind;
  /** Strength, 0 to 1. Paper reads at 0.3 to 0.5, halftone at 0.15 to 0.3, scan lines at 0.2 to 0.4. */
  opacity: number;
  /** How the texture meets the picture; multiply darkens like ink, screen lightens like light. Default per kind. */
  blendMode?: BlendMode;
  /** Size of the texture's features, 1 = tuned for a 1080 px frame. */
  scale?: number;
  /** Frames each texture state holds; 0 keeps it still (paper does not move). Above 0 it boils on film time. */
  cadence?: number;
  /** Colour of the fibres, dots or lines. */
  ink?: string;
  seed?: string;
};

const DEFAULT_BLEND: Record<TextureKind, BlendMode> = { paper: "multiply", halftone: "multiply", scanlines: "overlay" };

/** Turbulence seed for a frame: fixed when `cadence` is 0, otherwise a new seeded state every `cadence` frames. */
export const textureSeed = (seed: string, frame: number, cadence: number): number =>
  Math.floor(random(`${seed}-${cadence > 0 ? Math.floor(frame / cadence) : 0}`) * 10000);

/** Top edge, in pixels, of the slow bright band that rolls down a scan-line screen. Wraps past the bottom. */
export const scanBandAt = (frame: number, height: number, framesPerPass = 150): number => {
  const travel = height * 1.5;
  return (((frame / framesPerPass) * travel) % travel) - height * 0.25;
};

/**
 * A printed or displayed material over the whole frame, drawn procedurally per frame (no image files): paper fibre and
 * tooth, an offset halftone dot screen, or CRT scan lines with a slow rolling band. Pure function of the frame;
 * place it above the picture (FilmFinish does it for `texture`).
 */
export const TextureOverlay: React.FC<TextureOverlayProps> = ({
  kind,
  opacity,
  blendMode,
  scale = 1,
  cadence = 0,
  ink,
  seed = "texture",
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const id = useId().replaceAll(":", "");
  const u = (Math.min(width, height) / 1080) * scale;
  const turbulence = textureSeed(seed, frame, cadence);
  const mode = blendMode ?? DEFAULT_BLEND[kind];
  if (opacity <= 0) return null;
  const shell: React.CSSProperties = { pointerEvents: "none", mixBlendMode: mode, opacity };

  if (kind === "scanlines") {
    const pitch = Math.max(2, 4 * u);
    const colour = ink || "#000000";
    const band = scanBandAt(frame, height);
    // Seeded brightness flicker of a few percent, held for two frames like a real field.
    const flicker = 0.94 + 0.06 * random(`${seed}-flicker-${Math.floor(frame / 2)}`);
    return (
      <AbsoluteFill style={shell}>
        <AbsoluteFill
          style={{
            background: `repeating-linear-gradient(0deg, ${colour} 0px, ${colour} ${pitch * 0.42}px, transparent ${pitch * 0.42}px, transparent ${pitch}px)`,
            opacity: flicker,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: band,
            height: height * 0.22,
            background: "linear-gradient(180deg, transparent, rgba(255,255,255,0.55) 50%, transparent)",
          }}
        />
      </AbsoluteFill>
    );
  }

  if (kind === "halftone") {
    const cell = 9 * u;
    const colour = ink || "#1b1a17";
    return (
      <AbsoluteFill style={shell}>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
          <defs>
            <pattern
              id={`dots-${id}`}
              width={cell}
              height={cell}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(15)"
            >
              <circle cx={cell / 2} cy={cell / 2} r={cell * 0.34} fill={colour} />
            </pattern>
            {/* Ink density varies across the sheet, as on a press: low-frequency noise masks the screen. */}
            <filter id={`density-${id}`} x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency={0.0024 / scale} numOctaves={2} seed={turbulence} />
              <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.4 0 0 0 -0.55" />
            </filter>
            <mask id={`mask-${id}`}>
              <rect width={width} height={height} fill="#fff" filter={`url(#density-${id})`} />
            </mask>
          </defs>
          <rect width={width} height={height} fill={`url(#dots-${id})`} mask={`url(#mask-${id})`} />
        </svg>
      </AbsoluteFill>
    );
  }

  const colour = ink || "#3a2f22";
  return (
    <AbsoluteFill style={shell}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
        <filter id={`paper-${id}`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={`${0.045 / scale} ${0.06 / scale}`}
            numOctaves={3}
            seed={turbulence}
            result="fibre"
          />
          <feTurbulence
            type="fractalNoise"
            baseFrequency={0.85 / scale}
            numOctaves={2}
            seed={turbulence + 1}
            result="tooth"
          />
          <feBlend in="fibre" in2="tooth" mode="multiply" result="mix" />
          <feColorMatrix in="mix" type="luminanceToAlpha" result="a" />
          <feComponentTransfer in="a" result="alpha">
            <feFuncA type="linear" slope={-1.5} intercept={0.8} />
          </feComponentTransfer>
          <feFlood floodColor={colour} result="ink" />
          <feComposite in="ink" in2="alpha" operator="in" />
        </filter>
        <rect width={width} height={height} filter={`url(#paper-${id})`} />
      </svg>
    </AbsoluteFill>
  );
};

export const textureOverlaySchema = z.object({
  kind: z.enum(TEXTURE_KINDS),
  opacity: z.number().min(0).max(1),
  blendMode: z.enum(BLEND_MODES),
  scale: z.number().min(0.25).max(4),
  cadence: z.number().int().min(0).max(24),
  /** Empty for the kind's own ink (warm brown fibre, near-black dots, black lines). */
  ink: z.string(),
  seed: z.string(),
  /** Preview only: show paper, halftone and scan lines in turn over a sample plate. */
  cycle: z.boolean(),
});

export type TextureOverlayPreviewProps = z.infer<typeof textureOverlaySchema>;

export const TEXTURE_OVERLAY_FRAMES = 120;

const { fontFamily: plateFont } = loadFont("normal", { weights: ["800"], subsets: ["latin"] });

/** A flat two-colour poster: big type on raw paper beside a vermilion field and a black disc, where texture shows. */
const PosterPlate: React.FC<{ word: string }> = ({ word }) => {
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const u = Math.min(width, height) / 1080;
  return (
    <AbsoluteFill style={{ backgroundColor: "#ECE6D9" }}>
      <div
        style={{
          position: "absolute",
          left: vertical ? 0 : width * 0.58,
          top: vertical ? height * 0.56 : 0,
          right: 0,
          bottom: 0,
          backgroundColor: "#D8431F",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 300 * u,
          height: 300 * u,
          borderRadius: "50%",
          backgroundColor: "#141210",
          left: vertical ? width * 0.54 : width * 0.7,
          top: vertical ? height * 0.68 : height * 0.5,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 80 * u,
          top: vertical ? height * 0.2 : height * 0.18,
          fontFamily: plateFont,
          fontWeight: 800,
          fontSize: (vertical ? 190 : 210) * u,
          lineHeight: 0.86,
          letterSpacing: "-0.04em",
          color: "#141210",
          whiteSpace: "pre-line",
        }}
      >
        {word}
      </div>
      <div
        style={{
          position: "absolute",
          left: 84 * u,
          bottom: vertical ? height * 0.47 : 80 * u,
          fontFamily: plateFont,
          fontWeight: 800,
          fontSize: 30 * u,
          letterSpacing: "0.18em",
          color: "#141210",
          opacity: 0.7,
        }}
      >
        ISSUE 07 — SPRING
      </div>
    </AbsoluteFill>
  );
};

const CYCLE_LABEL: Record<TextureKind, string> = {
  paper: "Printed\nmatter.",
  halftone: "Dot\nscreen.",
  scanlines: "Live\nsignal.",
};

/** Library preview: the overlay over a poster plate; with `cycle` it shows each kind for a third of the clip. */
export const TextureOverlayPreview: React.FC<TextureOverlayPreviewProps> = ({
  cycle,
  kind,
  opacity,
  blendMode,
  ink,
  ...rest
}) => {
  const frame = useCurrentFrame();
  const shown: TextureKind = cycle
    ? TEXTURE_KINDS[Math.min(2, Math.floor(frame / (TEXTURE_OVERLAY_FRAMES / 3)))]!
    : kind;
  const cycled = cycle && shown !== kind;
  return (
    <AbsoluteFill>
      <PosterPlate word={CYCLE_LABEL[shown]} />
      <TextureOverlay
        kind={shown}
        opacity={cycled ? (shown === "halftone" ? 0.24 : shown === "paper" ? 0.4 : 0.35) : opacity}
        blendMode={cycled ? undefined : blendMode}
        ink={ink || undefined}
        {...rest}
      />
    </AbsoluteFill>
  );
};
