import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { FittedLine } from "../../text";
import { intendedOverflow } from "../overflow";
import {
  BACKDROP_CONTRAST,
  FOREN_COUNTDOWN_HOLD,
  FOREN_COUNTDOWN_STEPS,
  countdownAt,
  mixHex,
  ringField,
  tileFlicker,
} from "./background-plan";

/**
 * One faint layer behind a held word, so the frame is never still and never competes: expanding rings, a grid of tiles
 * lit at seeded random, the word itself at ~200% in low contrast, or a giant blurred numeral counting down on
 * decelerating cue frames and glowing at zero (polymarket field-backdrops, foren countdown-behind-word).
 */
export const wordBackdropSchema = z.object({
  layer: z.enum(["rings", "tiles", "ghost", "countdown"]),
  word: z.string(),
  /** Ground colour, or "transparent" to lay the word and its layer over footage. */
  ground: z.string(),
  ink: z.string(),
  /** Colour of the layer; it is mixed into the ground by `contrast`. */
  layerColour: z.string(),
  /** Contrast of the layer against the ground, 0..1 (polymarket: 0.06-0.12). The countdown uses it for its dimness. */
  contrast: z.number().min(0).max(1),
  seed: z.string(),
  /** Word width as a share of the frame width at most; the size is fitted. */
  wordWidth: z.number().min(0.1).max(0.95),
  fontWeight: z.number().int().min(100).max(900),
  /** Countdown: first frame, the value it starts from, and the step frames after `at` (foren: 0, 2, 4, 7, 11). */
  at: z.number().int().min(0),
  from: z.number().int().min(1).max(999),
  steps: z.array(z.number().int().min(0)).min(1).max(12),
  /** Tiles: grid columns (rows follow the aspect). */
  columns: z.number().int().min(2).max(24),
});

export type WordBackdropProps = z.infer<typeof wordBackdropSchema>;

const Rings: React.FC<{ colour: string; frame: number; width: number; height: number }> = ({
  colour,
  frame,
  width,
  height,
}) => {
  const max = Math.hypot(width, height) / 2;
  const stroke = Math.max(2, Math.min(width, height) * 0.012);
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
      {ringField(frame, { count: 7, period: 120, maxRadius: max }).map((ring, i) => (
        <circle
          key={i}
          cx={width / 2}
          cy={height / 2}
          r={ring.radius}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          opacity={ring.alpha}
        />
      ))}
    </svg>
  );
};

const Tiles: React.FC<{
  colour: string;
  ground: string;
  frame: number;
  width: number;
  height: number;
  columns: number;
  seed: string;
  transparent: boolean;
}> = ({ colour, ground, frame, width, height, columns, seed, transparent }) => {
  const size = width / columns;
  const rows = Math.ceil(height / size);
  const lit = tileFlicker(frame, { columns, rows, seed });
  const gap = size * 0.1;
  const resting = mixHex(ground, colour, 0.35);
  return (
    <AbsoluteFill>
      {lit.map((v, i) => {
        const x = (i % columns) * size;
        const y = Math.floor(i / columns) * size + (height - rows * size) / 2;
        const fill = transparent
          ? { background: colour, opacity: 0.35 + 0.65 * v }
          : { background: v > 0 ? mixHex(resting, colour, v) : resting };
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x + gap / 2,
              top: y + gap / 2,
              width: size - gap,
              height: size - gap,
              borderRadius: size * 0.18,
              ...fill,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

export const WordBackdrop: React.FC<WordBackdropProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const transparent = p.ground === "transparent";
  const ground = transparent ? "#000000" : p.ground;
  // Over footage there is no ground to mix into: the layer is drawn in its own colour at `contrast` opacity instead.
  const faint = transparent ? p.layerColour : mixHex(ground, p.layerColour, p.contrast);
  const layerOpacity = transparent ? p.contrast : 1;
  let layer: React.ReactNode = null;
  if (p.layer === "rings") layer = <Rings colour={faint} frame={frame} width={width} height={height} />;
  if (p.layer === "tiles")
    layer = (
      <Tiles
        colour={faint}
        ground={ground}
        frame={frame}
        width={width}
        height={height}
        columns={p.columns}
        seed={p.seed}
        transparent={transparent}
      />
    );
  if (p.layer === "ghost") {
    const drift = Math.sin(frame / 45) * width * 0.01 - frame * width * 0.0006;
    layer = (
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center" }}
        {...intendedOverflow(true, "ghost word at ~200% is cropped by the frame by design")}
      >
        <FittedLine
          text={p.word}
          withinWidth={width * p.wordWidth * 2}
          fontFamily={primaryFont}
          fontWeight={p.fontWeight}
        >
          {(fontSize) => (
            <div
              style={{
                fontFamily: primaryFont,
                fontWeight: p.fontWeight,
                fontSize,
                lineHeight: 1,
                color: faint,
                whiteSpace: "pre",
                letterSpacing: "-0.03em",
                transform: `translateX(${drift}px)`,
              }}
            >
              {p.word}
            </div>
          )}
        </FittedLine>
      </AbsoluteFill>
    );
  }
  if (p.layer === "countdown") {
    const state = countdownAt(frame, { at: p.at, steps: p.steps, from: p.from });
    const size = height * 0.6;
    const dim = transparent
      ? p.layerColour
      : mixHex(ground, p.layerColour, Math.min(1, p.contrast + state.glow * 0.35));
    layer =
      state.value === null ? null : (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              fontFamily: primaryFont,
              fontWeight: 800,
              fontSize: size,
              lineHeight: 1,
              color: dim,
              opacity: transparent ? Math.min(1, p.contrast + state.glow * 0.35) : 1,
              filter: `blur(${(size * 0.035).toFixed(1)}px)`,
              textShadow: state.glow > 0 ? `0 0 ${size * 0.25 * state.glow}px ${p.layerColour}` : undefined,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {state.value}
          </div>
        </AbsoluteFill>
      );
  }
  return (
    <AbsoluteFill style={{ background: p.ground === "transparent" ? undefined : p.ground, overflow: "hidden" }}>
      <AbsoluteFill style={{ opacity: p.layer === "countdown" ? 1 : layerOpacity }}>{layer}</AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <FittedLine
          text={p.word}
          withinWidth={width * p.wordWidth}
          fontFamily={primaryFont}
          fontWeight={p.fontWeight}
          maxFontSize={height * 0.3}
        >
          {(fontSize) => (
            <div
              style={{
                fontFamily: primaryFont,
                fontWeight: p.fontWeight,
                fontSize,
                lineHeight: 1,
                color: p.ink,
                whiteSpace: "pre",
                letterSpacing: "-0.03em",
              }}
            >
              {p.word}
            </div>
          )}
        </FittedLine>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const wordBackdropDefaults: WordBackdropProps = {
  layer: "rings",
  word: "Every outcome.",
  ground: "#0e1117",
  ink: "#f4f5f7",
  layerColour: "#ffffff",
  contrast: BACKDROP_CONTRAST,
  seed: "field",
  wordWidth: 0.62,
  fontWeight: 700,
  at: 0,
  from: 4,
  steps: [...FOREN_COUNTDOWN_STEPS],
  columns: 12,
};

/** Sound: a countdown ticks on each step and lands on zero; the other layers are beds with no hit. */
export const wordBackdropCues = (p: WordBackdropProps) => {
  if (p.layer !== "countdown") return [];
  const last = p.steps.length - 1;
  return p.steps.map((s, k) => ({
    frame: p.at + s,
    kind: (k === last ? "land" : "click") as "land" | "click",
    sfx: (k === last ? "impact" : "tick") as "impact" | "tick",
    weight: (k === last ? "hero" : "support") as "hero" | "support",
    label: k === last ? "zero" : `step ${k + 1}`,
  }));
};

/** foren: the zero holds this long before the cut out; use it to size the block in a film. */
export const COUNTDOWN_HOLD = FOREN_COUNTDOWN_HOLD;
