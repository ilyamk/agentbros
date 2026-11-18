import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { VelocityBlur } from "../../fx";
import { useFittedFontSize } from "../../text";
import type { Cue } from "../types";
import { discEntry, spinPose, symbolIndex } from "./effects-plan";

const symbolSchema = z.object({
  /** One or two characters drawn in the disc. */
  glyph: z.string().min(1).max(3),
  /** Disc fill and glyph colour for this symbol. */
  fill: z.string(),
  ink: z.string(),
});

export const symbolDiscSchema = z.object({
  /** cycle: the disc rides in on a trail, settles, and swaps glyph and fill on cue frames. spin: it enters oversized, spins about its vertical axis and lands face-on. */
  mode: z.enum(["cycle", "spin"]),
  symbols: z.array(symbolSchema).min(1).max(8),
  /** Frames on which the next symbol replaces the current one (steps, no other motion). */
  swaps: z.array(z.number().int().min(0)),
  /** Rest centre as shares of the frame, and the diameter as a share of the frame height (foren: 0.18). */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  size: z.number().min(0.03).max(0.6),
  at: z.number().int().min(0),
  /** cycle: where it comes from (shares of the frame, relative to its rest spot), frames to settle (power3.out, foren: 5) and the drift after, px a frame at 1080. */
  fromX: z.number().min(-2).max(2),
  fromY: z.number().min(-2).max(2),
  settleFrames: z.number().int().min(1).max(30),
  drift: z.number().min(0).max(4),
  /** cycle: a thick trail of the disc's width behind it as it arrives; empty for none. */
  trail: z.string(),
  /** spin: frames to land (polymarket: 20, power2.out), whole turns, entry scale, entry centre as shares of the frame. */
  spinFrames: z.number().int().min(4).max(60),
  turns: z.number().min(0.5).max(6),
  fromScale: z.number().min(1).max(5),
  spinFromX: z.number().min(-0.5).max(1.5),
  spinFromY: z.number().min(-0.5).max(1.5),
  /** Rim thickness as a share of the diameter, seen as the disc turns edge-on. */
  thickness: z.number().min(0).max(0.3),
  /** A line of type beside the disc (foren: text at x 0.06); empty for none. */
  line: z.string(),
  lineX: z.number().min(0).max(1),
  ground: z.string(),
  lineInk: z.string(),
});

export type SymbolDiscProps = z.infer<typeof symbolDiscSchema>;

export const SYMBOL_DISC_FRAMES = 75;

/** foren mirrored-symbol-trail: a pastel disc rides in on a yellow trail from lower right, settles in 5 frames, and swaps symbol and fill after 17 frames. */
export const symbolDiscDefaults: SymbolDiscProps = {
  mode: "cycle",
  symbols: [
    { glyph: "$", fill: "#F5D8A8", ink: "#1D1A16" },
    { glyph: "€", fill: "#BFDDF3", ink: "#1D1A16" },
    { glyph: "£", fill: "#E4D2F2", ink: "#1D1A16" },
  ],
  swaps: [26, 43],
  x: 0.68,
  y: 0.5,
  size: 0.18,
  at: 4,
  fromX: 0.45,
  fromY: 0.55,
  settleFrames: 5,
  drift: 0.35,
  trail: "#F2C94C",
  spinFrames: 20,
  turns: 0.5,
  fromScale: 5,
  spinFromX: 1.05,
  spinFromY: 0.45,
  thickness: 0.08,
  line: "Pay in any currency",
  lineX: 0.06,
  ground: "#FAF8F3",
  lineInk: "#1D1A16",
};

/** polymarket object-into-slot: the disc enters oversized at the right edge, spins about its vertical axis past edge-on, decelerates and lands face-on in 20 frames (power2.out). */
export const symbolDiscSpinPreset: Partial<SymbolDiscProps> = {
  mode: "spin",
  swaps: [],
  at: 6,
  spinFrames: 20,
  turns: 0.5,
  fromScale: 5,
  spinFromX: 1.05,
  spinFromY: 0.42,
  x: 0.5,
  y: 0.5,
  size: 0.16,
  line: "",
  trail: "",
};

export const symbolDiscCues = (
  p: Pick<SymbolDiscProps, "mode" | "swaps" | "at" | "settleFrames" | "spinFrames">,
): Cue[] =>
  p.mode === "spin"
    ? [
        { frame: p.at, kind: "reveal", sfx: "whoosh", weight: "support", label: "disc spins in" },
        { frame: p.at + p.spinFrames, kind: "land", sfx: "click", weight: "hero", label: "disc lands face-on" },
      ]
    : [
        { frame: p.at + p.settleFrames, kind: "land", sfx: "pop", weight: "hero", label: "disc settles" },
        ...p.swaps.map((frame): Cue => ({
          frame,
          kind: "click",
          sfx: "tick",
          weight: "support",
          label: "symbol swaps",
        })),
      ];

const Face: React.FC<{
  d: number;
  fill: string;
  ink: string;
  glyph: string;
  squash: number;
  back: boolean;
  thickness: number;
  angle: number;
  gloss: boolean;
}> = ({ d, fill, ink, glyph, squash, back, thickness, angle, gloss }) => {
  const sin = Math.sin((angle * Math.PI) / 180);
  const rim = d * thickness * Math.abs(sin);
  const faceW = Math.max(1, d * squash);
  // The rim shows on the side the face turns away from.
  const rimShift = (sin >= 0 ? 1 : -1) * rim * (back ? -1 : 1);
  const sheen = 50 + 40 * Math.cos(((angle + 40) * Math.PI) / 180);
  return (
    <div style={{ position: "relative", width: d + rim * 2, height: d }}>
      {rim > 0.5 ? (
        <div
          style={{
            position: "absolute",
            left: (d + rim * 2 - faceW) / 2 + rimShift,
            top: 0,
            width: faceW,
            height: d,
            borderRadius: "50%",
            backgroundColor: fill,
            filter: "brightness(0.68)",
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: (d + rim * 2 - faceW) / 2,
          top: 0,
          width: faceW,
          height: d,
          borderRadius: "50%",
          backgroundColor: fill,
          filter: back ? "brightness(0.85)" : undefined,
          backgroundImage: gloss
            ? `linear-gradient(105deg, rgba(255,255,255,0) ${sheen - 22}%, rgba(255,255,255,0.55) ${sheen}%, rgba(255,255,255,0) ${sheen + 22}%)`
            : undefined,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {back ? null : (
          <div
            style={{
              fontFamily: primaryFont,
              fontWeight: 700,
              fontSize: d * 0.56,
              lineHeight: 1,
              color: ink,
              transform: `scaleX(${squash})`,
            }}
          >
            {glyph}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * A disc carrying a symbol: in `cycle` it rides in on a thick trail, settles (power3.out) and swaps glyph and fill on
 * cue frames with no other motion, drifting slowly; in `spin` it enters oversized and spins about its vertical axis
 * (a 2D squash with a visible rim and a moving sheen, smeared at speed) to land face-on on its spot, ready to hand over
 * to `shared-element-carry`.
 */
export const SymbolDisc: React.FC<SymbolDiscProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const d = p.size * height;
  const unit = Math.min(width, height) / 1080;
  const symbol = p.symbols[symbolIndex(frame, p.swaps, p.symbols.length)]!;
  const lineSize = useFittedFontSize({
    text: p.line || " ",
    withinWidth: Math.max(10, (p.x - p.lineX) * width - d * 0.7),
    fontFamily: primaryFont,
    fontWeight: 600,
  });
  const lineFont = lineSize === null ? 0 : Math.min(lineSize, height * 0.06);
  const line =
    p.line && lineFont > 0 ? (
      <div
        style={{
          position: "absolute",
          left: p.lineX * width,
          top: p.y * height,
          transform: "translateY(-50%)",
          fontFamily: primaryFont,
          fontWeight: 600,
          fontSize: lineFont,
          lineHeight: 1.1,
          color: p.lineInk,
          whiteSpace: "nowrap",
        }}
      >
        {p.line}
      </div>
    ) : null;
  if (p.mode === "spin") {
    const pose = spinPose(frame, {
      at: p.at,
      frames: p.spinFrames,
      turns: p.turns,
      fromScale: p.fromScale,
      from: { x: p.spinFromX * width, y: p.spinFromY * height },
      to: { x: p.x * width, y: p.y * height },
    });
    const size = d * pose.scale;
    const smear = Math.abs(pose.speed) * (Math.PI / 180) * (size / 2) * 0.5;
    return (
      <AbsoluteFill style={{ backgroundColor: p.ground, overflow: "hidden" }}>
        {line}
        {pose.visible ? (
          <VelocityBlur axis="x" speed={pose.landed ? 0 : smear} maxBlur={40 * unit}>
            <div style={{ position: "absolute", left: pose.x - size / 2 - size * p.thickness, top: pose.y - size / 2 }}>
              <Face
                d={size}
                fill={symbol.fill}
                ink={symbol.ink}
                glyph={symbol.glyph}
                squash={pose.squash}
                back={pose.back}
                thickness={p.thickness}
                angle={pose.angle}
                gloss
              />
            </div>
          </VelocityBlur>
        ) : null}
      </AbsoluteFill>
    );
  }
  const entry = discEntry(frame, {
    at: p.at,
    settleFrames: p.settleFrames,
    from: { x: p.fromX, y: p.fromY },
    drift: p.drift * unit,
    width,
    height,
  });
  const cx = p.x * width + entry.dx;
  const cy = p.y * height + entry.dy;
  const tail = { x: p.x * width + p.fromX * width, y: p.y * height + p.fromY * height };
  const length = Math.hypot(cx - tail.x, cy - tail.y);
  const angle = (Math.atan2(cy - tail.y, cx - tail.x) * 180) / Math.PI;
  return (
    <AbsoluteFill style={{ backgroundColor: p.ground, overflow: "hidden" }}>
      {line}
      {entry.visible && p.trail ? (
        <div
          style={{
            position: "absolute",
            left: tail.x,
            top: tail.y - d / 2,
            width: length,
            height: d,
            backgroundColor: p.trail,
            transformOrigin: "0 50%",
            transform: `rotate(${angle}deg)`,
          }}
        />
      ) : null}
      {entry.visible ? (
        <div style={{ position: "absolute", left: cx - d / 2, top: cy - d / 2 }}>
          <Face
            d={d}
            fill={symbol.fill}
            ink={symbol.ink}
            glyph={symbol.glyph}
            squash={1}
            back={false}
            thickness={0}
            angle={0}
            gloss={false}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
