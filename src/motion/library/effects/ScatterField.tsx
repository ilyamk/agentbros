import { measureText } from "@remotion/layout-utils";
import React from "react";
import { AbsoluteFill, Img, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { useFittedFontSize } from "../../text";
import type { Cue } from "../types";
import { cornerLanding, cornerPose, popFrames, scatterPositions, type Box } from "./effects-plan";

const itemSchema = z.object({
  /** A word (placed inside the safe zone), or a picture inside public/ (may sit past the frame edges). */
  text: z.string().optional(),
  src: z.string().optional(),
  /** Card fill when there is neither text nor a picture, or behind a picture with transparency. */
  colour: z.string(),
  /** Frame it cuts on; without it the item takes the next slot of `at` + i x `every`. */
  at: z.number().int().min(0).optional(),
});

export const scatterFieldSchema = z.object({
  /** pop: items cut on at seeded spots around the line, one every `every` frames. corners: cards fly in to the four corners, brake, then drift outward. */
  mode: z.enum(["pop", "corners"]),
  /** The held line in the middle; the scatter keeps clear of its box. Empty for none. */
  line: z.string(),
  items: z.array(itemSchema).min(1).max(40),
  at: z.number().int().min(0),
  every: z.number().min(0).max(30),
  /** Card or picture width as a share of the frame width: seeded between the two (abdulah: 0.03-0.06; foren: 0.10-0.13). */
  sizeMin: z.number().min(0.01).max(0.5),
  sizeMax: z.number().min(0.01).max(0.5),
  /** Word size as a share of the frame's short side. */
  wordSize: z.number().min(0.01).max(0.2),
  /** Pictures may sit this far past the frame edges, as a share of the width (0 keeps them inside). */
  bleed: z.number().min(0).max(0.2),
  /** Gap kept between items and around the line, as a share of the short side. */
  gap: z.number().min(0).max(0.2),
  /** Slow push-in of the whole page over the block, linear (abdulah: about 4% over 2 s). */
  creep: z.number().min(0).max(0.3),
  /** corners: frames to fly in (foren: 5-6, power3.out), frames between cards, outward drift in px a frame at 1080. */
  enterFrames: z.number().int().min(2).max(30),
  lag: z.number().int().min(0).max(10),
  drift: z.number().min(0).max(10),
  ground: z.string(),
  ink: z.string(),
  seed: z.string(),
});

export type ScatterFieldProps = z.infer<typeof scatterFieldSchema>;

export const SCATTER_FIELD_FRAMES = 100;

const PALETTE = ["#E9C46A", "#F4A6B7", "#9CC5E8", "#EFE7D6", "#B8D8B0", "#F2B880"];

/** abdulah t19-portrait-pop-field: a held line, a card every 4 frames scattered around it and off the edges, the page creeping in about 4%. */
export const scatterFieldDefaults: ScatterFieldProps = {
  mode: "pop",
  line: "Made by the people who use it",
  items: Array.from({ length: 18 }, (_, i) => ({ colour: PALETTE[i % PALETTE.length]! })),
  at: 8,
  every: 4,
  sizeMin: 0.035,
  sizeMax: 0.065,
  wordSize: 0.045,
  bleed: 0.03,
  gap: 0.02,
  creep: 0.04,
  enterFrames: 6,
  lag: 1,
  drift: 0.6,
  ground: "#F3EFE6",
  ink: "#16130F",
  seed: "scatter",
};

/** foren portrait-cards-drift: four cards fly in to the corners in about 6 frames (power3.out), then drift slowly outward. */
export const scatterFieldCornersPreset: Partial<ScatterFieldProps> = {
  mode: "corners",
  items: PALETTE.slice(0, 4).map((colour) => ({ colour })),
  at: 6,
  sizeMin: 0.13,
  sizeMax: 0.16,
  enterFrames: 6,
  lag: 1,
  drift: 0.6,
  creep: 0,
};

/** Frame each item cuts on (pop) or lands (corners). */
export const scatterFieldFrames = (
  p: Pick<ScatterFieldProps, "mode" | "items" | "at" | "every" | "enterFrames" | "lag">,
): number[] => {
  if (p.mode === "corners") return p.items.map((_, i) => cornerLanding(i, p));
  const slots = popFrames(p.items.length, p.at, p.every);
  return p.items.map((item, i) => item.at ?? slots[i]!);
};

export const scatterFieldCues = (
  p: Pick<ScatterFieldProps, "mode" | "items" | "at" | "every" | "enterFrames" | "lag">,
): Cue[] => {
  const frames = scatterFieldFrames(p);
  if (p.mode === "corners")
    return [
      { frame: Math.max(...frames), kind: "land", sfx: "whoosh", weight: "hero", label: "cards brake in the corners" },
    ];
  return frames.map((frame, i) => ({
    frame,
    kind: "reveal",
    sfx: i === frames.length - 1 ? "pop" : "tick",
    weight: i === frames.length - 1 ? "hero" : "support",
    label: `item ${i + 1}`,
  }));
};

/** Seeded width of item i as a share of the frame width. */
const itemShare = (p: ScatterFieldProps, i: number): number =>
  p.sizeMin + (p.sizeMax - p.sizeMin) * random(`${p.seed}-size-${i}`);

const Card: React.FC<{ item: ScatterFieldProps["items"][number]; w: number; h: number; ink: string; size: number }> = ({
  item,
  w,
  h,
  ink,
  size,
}) => (
  <div
    style={{
      position: "relative",
      width: w,
      height: h,
      borderRadius: Math.min(w, h) * 0.12,
      overflow: "hidden",
      backgroundColor: item.colour,
      boxShadow: `0 ${size * 0.004}px ${size * 0.012}px rgba(0,0,0,0.14)`,
    }}
  >
    {item.src ? (
      <Img src={staticFile(item.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    ) : (
      <div
        style={{
          position: "absolute",
          left: w * 0.3,
          top: h * 0.22,
          width: w * 0.4,
          height: w * 0.4,
          borderRadius: "50%",
          backgroundColor: ink,
          opacity: 0.12,
        }}
      />
    )}
  </div>
);

/**
 * A held line with things scattered around it: words, pictures or cards cut on at seeded, non-overlapping spots that
 * keep clear of the line (each on its own frame, or one every N frames), the page creeping in; or four cards that fly
 * in to the corners, brake without overshoot and drift slowly outward. Words stay inside the safe zone; pictures may
 * sit past the edges.
 */
export const ScatterField: React.FC<ScatterFieldProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const short = Math.min(width, height);
  const lineSize = useFittedFontSize({
    text: p.line || " ",
    withinWidth: width * 0.62,
    fontFamily: primaryFont,
    fontWeight: 600,
  });
  const fontSize = lineSize === null ? 0 : Math.min(lineSize, short * 0.06);
  const lineBox =
    p.line && fontSize > 0
      ? measureText({ text: p.line, fontFamily: primaryFont, fontSize, fontWeight: "600" })
      : { width: 0, height: 0 };
  const avoid: Box | null = p.line
    ? { x: (width - lineBox.width) / 2, y: (height - fontSize * 1.2) / 2, w: lineBox.width, h: fontSize * 1.2 }
    : null;
  const scale = 1 + p.creep * Math.min(1, frame / Math.max(1, durationInFrames - 1));
  const frames = scatterFieldFrames(p);
  const sizes = p.items.map((item, i) => {
    if (item.text) {
      const m = measureText({
        text: item.text,
        fontFamily: primaryFont,
        fontSize: p.wordSize * short,
        fontWeight: "600",
      });
      return { hw: m.width / 2, hh: (p.wordSize * short * 1.1) / 2 };
    }
    const w = itemShare(p, i) * width;
    return { hw: w / 2, hh: (w * 1.25) / 2 };
  });
  const safe: Box = { x: width * 0.08, y: height * 0.08, w: width * 0.84, h: height * 0.84 };
  const bleedBox: Box = {
    x: -p.bleed * width,
    y: -p.bleed * width,
    w: width * (1 + 2 * p.bleed),
    h: height + 2 * p.bleed * width,
  };
  const anyWords = p.items.some((item) => item.text);
  const placed =
    p.mode === "pop"
      ? scatterPositions(sizes, { area: anyWords ? safe : bleedBox, avoid, gap: p.gap * short, seed: p.seed })
      : [];
  const spot: Box = avoid
    ? { x: width * 0.2, y: height * 0.22, w: width * 0.6, h: height * 0.56 }
    : { x: width * 0.2, y: height * 0.2, w: width * 0.6, h: height * 0.6 };
  return (
    <AbsoluteFill style={{ backgroundColor: p.ground, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        {p.line && fontSize > 0 ? (
          <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
            <div
              style={{
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize,
                lineHeight: 1.2,
                color: p.ink,
                whiteSpace: "nowrap",
                letterSpacing: "-0.01em",
              }}
            >
              {p.line}
            </div>
          </AbsoluteFill>
        ) : null}
        {p.items.map((item, i) => {
          const size = sizes[i]!;
          if (p.mode === "corners") {
            const pose = cornerPose(frame, i, {
              at: p.at,
              enterFrames: p.enterFrames,
              lag: p.lag,
              drift: p.drift * (short / 1080),
              spot,
              width,
              height,
            });
            if (!pose.visible) return null;
            return (
              <div key={i} style={{ position: "absolute", left: pose.x - size.hw, top: pose.y - size.hh }}>
                <Card item={item} w={size.hw * 2} h={size.hh * 2} ink={p.ink} size={short} />
              </div>
            );
          }
          if (frame < frames[i]!) return null;
          const at = placed[i]!;
          return item.text ? (
            <div
              key={i}
              style={{
                position: "absolute",
                left: at.x - at.hw,
                top: at.y - at.hh,
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: p.wordSize * short,
                lineHeight: 1.1,
                color: p.ink,
                whiteSpace: "nowrap",
              }}
            >
              {item.text}
            </div>
          ) : (
            <div key={i} style={{ position: "absolute", left: at.x - at.hw, top: at.y - at.hh }}>
              <Card item={item} w={at.hw * 2} h={at.hh * 2} ink={p.ink} size={short} />
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
