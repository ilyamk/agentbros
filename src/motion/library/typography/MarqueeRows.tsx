import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { focalAt, MARQUEE_CURVES, marqueeCopies, marqueeTravel } from "../../text-modes";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { CHIP_GLYPHS, Chip } from "./SentenceBuild";
import { Stage, resolveInk } from "./Stage";

export const marqueeRowsSchema = z.object({
  /** One phrase per row, repeated across it ("phrase" items). */
  rows: z.array(z.string()).min(1).max(8),
  /** "phrase": each row repeats its phrase with a chip between repeats; "tiles": each row is a run of icon tiles. */
  items: z.enum(["phrase", "tiles"]),
  /** Chip glyphs between phrase repeats, one per row in turn; empty for none. Tiles mode: the tiles of every row, in order. */
  chips: z.array(z.enum(CHIP_GLYPHS)),
  /** "outline" draws chips as outlined tiles in the repeat ink (foren); "solid" fills them with `chipColour` (cashfree). */
  chipStyle: z.enum(["outline", "solid"]),
  chipColour: z.string(),
  face: z.enum(FACE_NAMES),
  /** Row height as a share of the frame height (foren: about 0.28 in the frames, three rows filling most of it). */
  rowHeight: z.number().min(0.04).max(0.4),
  /** Each row starts this share of its pattern further along than the one above, so the rows do not line up. */
  rowShift: z.number().min(0).max(1),
  /** "same": every row travels the same way; "alternate": every other row travels against it. */
  direction: z.enum(["same", "alternate"]),
  /** Frame the track starts; its travel as a share of the frame width over `frames` on `curve`, then `drift` (share of the width a frame). */
  at: z.number().int().nonnegative(),
  frames: z.number().int().min(0).max(120),
  distance: z.number().min(-3).max(3),
  curve: z.enum(MARQUEE_CURVES),
  drift: z.number().min(-0.05).max(0.05),
  /** Focal: an item's scale at frame centre (1 for none), blur in px at the edge, and the radius (share of the half width) it falls off over. */
  focalScale: z.number().min(1).max(2),
  focalBlur: z.number().min(0).max(40),
  focalRadius: z.number().min(0.1).max(2),
  ink: z.string(),
  /** Every other repeat, in a secondary ink (foren: mid grey). Same as `ink` for one colour. */
  repeatInk: z.string(),
  /** "transparent" lays the rows over footage. */
  ground: z.string(),
  /** Frame the rows cut off; -1 holds. */
  exitAt: z.number().int(),
  grain: z.number().min(0).max(0.2),
});

export type MarqueeRowsProps = z.infer<typeof marqueeRowsSchema>;

type Item =
  { kind: "text"; text: string; width: number } | { kind: "chip"; glyph: (typeof CHIP_GLYPHS)[number]; width: number };

/**
 * Rows of a repeated phrase (with chips between repeats) or of icon tiles, offset row to row and all on one track that
 * enters moving and brakes to a near hold, or slides at a constant speed. Items may scale and blur by their distance
 * from frame centre. The rows bleed off both edges by design.
 */
export const MarqueeRows: React.FC<MarqueeRowsProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const set = faceStyle(p.face);
  const measured = useTextWidths(
    p.rows.map((row) => faceRun(p.face, row)),
    100,
  );
  if (measured === null || (p.exitAt >= 0 && frame >= p.exitAt))
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const rowH = p.rowHeight * height;
  const size = rowH * (p.items === "tiles" ? 0.62 : 0.78);
  const chipSize = p.items === "tiles" ? rowH * 0.8 : size * 0.78;
  const gap = p.items === "tiles" ? rowH * 0.18 : size * 0.32;
  const ink = resolveInk(p.ink, p.ground);
  const travel = marqueeTravel(frame, {
    at: p.at,
    frames: p.frames,
    distance: p.distance * width,
    curve: p.curve,
    drift: p.drift * width,
  });
  const top0 = (height - rowH * p.rows.length) / 2;
  const centre = width / 2;

  const rowItems = (row: number): Item[] => {
    if (p.items === "tiles")
      return (p.chips.length ? p.chips : (["spark"] as const)).map((glyph) => ({
        kind: "chip" as const,
        glyph,
        width: chipSize,
      }));
    const phrase: Item = {
      kind: "text",
      text: set.textTransform === "uppercase" ? p.rows[row]!.toUpperCase() : p.rows[row]!,
      width: (measured[row]! * size) / 100,
    };
    const chip = p.chips.length ? p.chips[row % p.chips.length]! : null;
    return chip ? [phrase, { kind: "chip", glyph: chip, width: chipSize }] : [phrase];
  };

  return (
    <Stage background={p.ground} grain={p.grain}>
      {p.rows.map((_, row) => {
        const items = rowItems(row);
        const period = items.reduce((sum, item) => sum + item.width + gap, 0);
        const sign = p.direction === "alternate" && row % 2 === 1 ? -1 : 1;
        const offset = sign * travel + p.rowShift * period * row - period * 0.5;
        const copies = marqueeCopies(offset, period, width);
        return (
          <div
            key={row}
            {...intendedOverflow(true, "marquee rows bleed off both edges by design")}
            style={{ position: "absolute", left: 0, top: top0 + row * rowH, width, height: rowH }}
          >
            {copies.flatMap(({ x, copy }) => {
              let left = x;
              const colour = (copy + row) % 2 === 0 ? ink : p.repeatInk;
              return items.map((item, i) => {
                const itemLeft = left;
                left += item.width + gap;
                const focal =
                  p.focalScale > 1 || p.focalBlur > 0
                    ? focalAt((itemLeft + item.width / 2 - centre) / centre, {
                        scale: p.focalScale,
                        blur: p.focalBlur,
                        radius: p.focalRadius,
                      })
                    : { scale: 1, blur: 0 };
                const style: React.CSSProperties = {
                  position: "absolute",
                  left: itemLeft,
                  top: 0,
                  height: rowH,
                  width: item.width,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transform: focal.scale !== 1 ? `scale(${focal.scale})` : undefined,
                  filter: focal.blur > 0.3 ? `blur(${focal.blur.toFixed(2)}px)` : undefined,
                };
                if (item.kind === "text")
                  return (
                    <div key={`${copy}-${i}`} style={{ ...style, justifyContent: "flex-start" }}>
                      <span
                        style={{
                          ...set,
                          textTransform: undefined,
                          fontSize: size,
                          lineHeight: 1,
                          whiteSpace: "pre",
                          color: colour,
                        }}
                      >
                        {item.text}
                      </span>
                    </div>
                  );
                const outline = p.chipStyle === "outline";
                const fill = outline ? (p.ground === "transparent" ? "#00000000" : p.ground) : p.chipColour;
                return (
                  <div key={`${copy}-${i}`} style={style}>
                    <div
                      style={{
                        borderRadius: chipSize * 0.26,
                        boxShadow: outline ? `inset 0 0 0 ${Math.max(2, chipSize * 0.05)}px ${p.repeatInk}` : undefined,
                      }}
                    >
                      <Chip
                        token={{ kind: "chip", glyph: item.glyph }}
                        size={chipSize}
                        colour={fill}
                        ink={outline ? p.repeatInk : resolveInk("auto", p.chipColour)}
                      />
                    </div>
                  </div>
                );
              });
            })}
          </div>
        );
      })}
    </Stage>
  );
};

export const marqueeRowsDefaults: MarqueeRowsProps = {
  rows: ["Pay in any currency", "Settle the same day", "Pay in any currency"],
  items: "phrase",
  chips: ["globe", "bolt", "star"],
  chipStyle: "outline",
  chipColour: "#C6F432",
  face: "grotesk",
  rowHeight: 0.28,
  rowShift: 0.37,
  direction: "same",
  at: 0,
  frames: 25,
  distance: 0.45,
  curve: "expo.out",
  drift: 0.0006,
  focalScale: 1,
  focalBlur: 0,
  focalRadius: 1,
  ink: "#141414",
  repeatInk: "#9A9A96",
  ground: "#F4F3EF",
  exitAt: -1,
  grain: 0.03,
};

/** cashfree's icon row: lime tiles slide 0.43 of the width on circ.out under a sentence, the centre tile about 1.3x. */
export const marqueeRowsFocalPreset: MarqueeRowsProps = {
  ...marqueeRowsDefaults,
  rows: ["tiles"],
  items: "tiles",
  chips: ["bolt", "globe", "chat", "grid", "spark", "cube", "wave", "star"],
  chipStyle: "solid",
  chipColour: "#C6F432",
  rowHeight: 0.14,
  rowShift: 0,
  frames: 20,
  distance: -0.43,
  curve: "circ.out",
  drift: 0,
  focalScale: 1.3,
  focalBlur: 0,
  focalRadius: 0.35,
  ink: "#FFFFFF",
  repeatInk: "#FFFFFF",
  ground: "#0E1110",
};

/** ugc-app's pass: big words track across at a constant speed, sharp only near centre. */
export const marqueeRowsLensPreset: MarqueeRowsProps = {
  ...marqueeRowsDefaults,
  rows: ["better way"],
  chips: [],
  rowHeight: 0.34,
  frames: 0,
  distance: 0,
  curve: "linear",
  drift: -0.012,
  focalScale: 1,
  focalBlur: 18,
  focalRadius: 0.8,
  ink: "#FFFFFF",
  repeatInk: "#FFFFFF",
  ground: "#0B0B0C",
};

export const marqueeRowsCues = (p: MarqueeRowsProps): Cue[] => [
  { frame: p.at, kind: "cut", sfx: "whoosh", weight: "hero", label: "rows enter moving" },
  ...(p.frames > 0
    ? [
        {
          frame: p.at + p.frames,
          kind: "stop" as const,
          sfx: "none" as const,
          weight: "support" as const,
          label: "track brakes to a hold",
        },
      ]
    : []),
  ...(p.exitAt >= 0
    ? [{ frame: p.exitAt, kind: "exit" as const, sfx: "none" as const, weight: "support" as const }]
    : []),
];
