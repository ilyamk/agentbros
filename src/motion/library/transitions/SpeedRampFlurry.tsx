import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont, serifNormalFont } from "../../../lib/fonts";
import type { Cue } from "../types";

const flurryItemSchema = z.object({
  /** Words before and after the locked phrase on its line. */
  before: z.string(),
  highlight: z.string(),
  after: z.string(),
  /** Small line above the locked line: a source, a name, a URL. */
  source: z.string(),
  /** Small line below: a byline, a count, a price. */
  meta: z.string(),
  face: z.enum(["sans", "serif", "mono"]),
  ground: z.string(),
  ink: z.string(),
  /** Optional picture under the frame (path inside public/); the locked line still sits on the anchor. */
  image: z.string().optional(),
});

export type FlurryItem = z.infer<typeof flurryItemSchema>;

export const speedRampFlurrySchema = z.object({
  items: z.array(flurryItemSchema).min(2),
  /** Frames each item holds, in order; a falling list (6, 4, 3, 2, 2) is the speed ramp. The last item holds to the end. */
  holds: z.array(z.number().int().min(1)).min(1),
  /** Frame the first item appears. */
  at: z.number().int().min(0),
  /** Marker behind the locked phrase; it never moves, so the eye stays on it while everything else changes. */
  marker: z.string(),
  /** Vertical position of the locked line, 0..1. */
  anchorY: z.number().min(0.2).max(0.8),
});

export type SpeedRampFlurryProps = z.infer<typeof speedRampFlurrySchema>;

/** Start frame of every item. */
export const flurryStarts = (at: number, holds: readonly number[], count: number): number[] => {
  const starts: number[] = [];
  let frame = at;
  for (let i = 0; i < count; i++) {
    starts.push(frame);
    frame += holds[Math.min(i, holds.length - 1)]!;
  }
  return starts;
};

/** A tick on every switch, the hero hit when the flurry stops on its last item. */
export const speedRampFlurryCues = ({
  items,
  holds,
  at,
}: Pick<SpeedRampFlurryProps, "items" | "holds" | "at">): Cue[] => {
  const starts = flurryStarts(at, holds, items.length);
  return starts.map((frame, i) =>
    i === starts.length - 1
      ? { frame, kind: "land", sfx: "impact", weight: "hero", label: "flurry stops" }
      : { frame, kind: "cut", sfx: i === 0 ? "whoosh" : "tick", weight: "support" },
  );
};

const FACE: Record<FlurryItem["face"], { family: string; weight: number; tracking: string }> = {
  sans: { family: primaryFont, weight: 600, tracking: "-0.02em" },
  serif: { family: serifNormalFont, weight: 700, tracking: "-0.01em" },
  mono: { family: "ui-monospace, Menlo, monospace", weight: 500, tracking: "0" },
};

/**
 * A 2–4-frame flurry of screens, posts or headlines with one phrase locked on the same spot of the frame under a
 * marker: everything around it changes on every cut, the phrase never moves. Stops dead on the last item.
 */
export const SpeedRampFlurry: React.FC<SpeedRampFlurryProps> = ({ items, holds, at, marker, anchorY }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  if (frame < at) return null;
  const starts = flurryStarts(at, holds, items.length);
  let index = 0;
  for (let i = 0; i < starts.length; i++) if (frame >= starts[i]!) index = i;
  const item = items[index]!;
  const face = FACE[item.face];
  // Size varies a little with the face, like different sources; the phrase stays centred on the anchor.
  const size = (item.face === "serif" ? 104 : item.face === "mono" ? 80 : 94) * u;
  const y = height * anchorY;
  const small: React.CSSProperties = {
    fontFamily: primaryFont,
    fontWeight: 500,
    fontSize: 36 * u,
    color: item.ink,
    opacity: 0.55,
    whiteSpace: "nowrap",
  };
  // A fixed per-item horizontal shift of the context lines, so consecutive screens never share a layout.
  const shift = (((index * 37) % 5) - 2) * 40 * u;
  return (
    <AbsoluteFill style={{ backgroundColor: item.ground, overflow: "hidden" }}>
      {item.image ? (
        <Img
          src={staticFile(item.image)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.9 }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: y - size * 1.9,
          display: "flex",
          justifyContent: "center",
          transform: `translateX(${shift}px)`,
        }}
      >
        <div style={small}>{item.source}</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: y,
          transform: "translateY(-50%)",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
          alignItems: "baseline",
          fontFamily: face.family,
          fontWeight: face.weight,
          fontSize: size,
          letterSpacing: face.tracking,
          color: item.ink,
          whiteSpace: "pre",
          lineHeight: 1.1,
        }}
      >
        <span style={{ display: "flex", justifyContent: "flex-end", overflow: "hidden" }}>
          <span>{item.before}</span>
        </span>
        <span style={{ position: "relative", color: "#111111" }}>
          <span
            style={{
              position: "absolute",
              left: -0.12 * size,
              right: -0.12 * size,
              top: 0.04 * size,
              bottom: -0.02 * size,
              backgroundColor: marker,
            }}
          />
          <span style={{ position: "relative" }}>{item.highlight}</span>
        </span>
        <span style={{ display: "flex", overflow: "hidden" }}>
          <span>{item.after}</span>
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: y + size * 1.15,
          display: "flex",
          justifyContent: "center",
          transform: `translateX(${-shift}px)`,
        }}
      >
        <div style={small}>{item.meta}</div>
      </div>
    </AbsoluteFill>
  );
};

export const SPEED_RAMP_FLURRY_FRAMES = 60;

export const speedRampFlurryDefaults: SpeedRampFlurryProps = {
  at: 0,
  holds: [12, 5, 4, 3, 3, 2, 2, 2],
  marker: "#FFE14D",
  anchorY: 0.5,
  items: [
    {
      before: "",
      highlight: "Creator ads",
      after: "",
      source: "",
      meta: "",
      face: "sans",
      ground: "#F4F3EF",
      ink: "#141414",
    },
    {
      before: "Why ",
      highlight: "creator ads",
      after: " outsell studio spots",
      source: "The Ledger · Business",
      meta: "By Jordan Ellis · 6 min read",
      face: "serif",
      ground: "#FFFFFF",
      ink: "#141414",
    },
    {
      before: "",
      highlight: "creator ads",
      after: " — my first 30 days",
      source: "412K views · 3 weeks ago",
      meta: "Maya Creates",
      face: "sans",
      ground: "#0F0F10",
      ink: "#F4F4F4",
    },
    {
      before: "How do I start with ",
      highlight: "creator ads",
      after: "?",
      source: "r/freelance · posted by u/sam_k",
      meta: "1.2k upvotes · 248 comments",
      face: "sans",
      ground: "#F6F7F8",
      ink: "#1A1A1B",
    },
    {
      before: "$ grep ",
      highlight: "creator ads",
      after: " briefs.csv",
      source: "terminal — 80×24",
      meta: "5 matches",
      face: "mono",
      ground: "#16181D",
      ink: "#E6E6E6",
    },
    {
      before: "Book ",
      highlight: "creator ads",
      after: " from $45",
      source: "Top rated · 4.9 ★",
      meta: "Delivered in 3 days",
      face: "sans",
      ground: "#EAF6EE",
      ink: "#10301C",
    },
    {
      before: "Brief: 5 ",
      highlight: "creator ads",
      after: " for spring",
      source: "Brightly Co. → you",
      meta: "Hi, here are the details",
      face: "sans",
      ground: "#FFFFFF",
      ink: "#202124",
    },
    {
      before: "",
      highlight: "creator ads",
      after: " that ship.",
      source: "",
      meta: "",
      face: "sans",
      ground: "#F4F3EF",
      ink: "#141414",
    },
  ],
};
