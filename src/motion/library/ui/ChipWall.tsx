import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { progress } from "../../timing";
import { intendedOverflow } from "../overflow";
import { geist, Ground, surface } from "./surface";
import { PUSH_HALF_LIFE, PUSH_RAMP, chipWallLayout, isolateOpacity, pushProgress } from "./ui-plan";

export const chipWallSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Chip labels, cycled and shuffled over the wall by `seed`; `labels[0]` is the chip that is picked. */
  labels: z.array(z.string()).min(1),
  cols: z.number().int().min(2).max(30),
  rows: z.number().int().min(2).max(30),
  seed: z.string(),
  /** Index of the picked chip (row * cols + col); absent picks the middle. */
  pick: z.number().int().min(0).optional(),
  /** Frame the wall dissolves in (8 f); it then creeps in slowly until the push. */
  inAt: z.number().int().min(0),
  /** The push toward the picked chip: speed ramps over `pushRamp` (3 f), then halves every `pushHalfLife` (7.5 f); firecrawl measured by scale: `chipWallFirecrawlPush`. */
  pushAt: z.number().int().min(0),
  pushFrames: z.number().int().min(6),
  /** Frames the push's speed ramps up over (default 3), and its half-life after (default 7.5); `chipWallFirecrawlPush` sets the measured 6 and 9 over 26 frames. */
  pushRamp: z.number().min(0).max(30).optional(),
  pushHalfLife: z.number().min(1).max(60).optional(),
  /** Scale at the end of the push. */
  pushScale: z.number().min(1).max(8),
  /** Every chip but the picked one fades over `isolateFrames` (firecrawl: about 1.3 s). */
  isolateAt: z.number().int().min(0),
  isolateFrames: z.number().int().min(1),
  /** Badge on the picked chip once it is alone; empty hides it. */
  badge: z.string(),
  ground: z.enum(["preview", "transparent"]),
});

export type ChipWallProps = z.infer<typeof chipWallSchema>;

export const chipWallCues = (p: ChipWallProps) => [
  {
    frame: p.inAt,
    kind: "reveal" as const,
    sfx: "none" as const,
    weight: "support" as const,
    label: "wall dissolves in",
  },
  {
    frame: p.pushAt,
    kind: "hit" as const,
    sfx: "whoosh" as const,
    weight: "hero" as const,
    label: "push into the wall",
  },
  {
    frame: p.isolateAt,
    kind: "reveal" as const,
    sfx: "none" as const,
    weight: "support" as const,
    label: "all but one fade",
  },
  ...(p.badge
    ? [
        {
          frame: p.isolateAt + p.isolateFrames,
          kind: "land" as const,
          sfx: "pop" as const,
          weight: "support" as const,
          label: "picked chip badge",
        },
      ]
    : []),
];

/** A seeded wall of labelled chips that pushes in toward one and fades the rest. */
export const ChipWall: React.FC<ChipWallProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const s = surface(p.tone, p.accent);
  const pick = Math.min(p.pick ?? Math.floor(p.rows / 2) * p.cols + Math.floor(p.cols / 2), p.cols * p.rows - 1);
  const chips = chipWallLayout(p.labels, p.cols, p.rows, p.seed, pick);
  // At rest the wall fits inside 92% of the frame; the push carries the picked chip to the centre.
  const slotW = (width * 0.92) / p.cols;
  const slotH = Math.min((height * 0.92) / p.rows, slotW * 0.42);
  const wallW = slotW * p.cols;
  const wallH = slotH * p.rows;
  const left = (width - wallW) / 2;
  const top = (height - wallH) / 2;
  const chipH = slotH * 0.62;
  const font = chipH * 0.42;
  const pc = { x: left + (chips[pick]!.col + 0.5) * slotW, y: top + (chips[pick]!.row + 0.5) * slotH };
  const creep = 1 + 0.04 * progress(frame, p.inAt, Math.max(1, p.pushAt - p.inAt), "linear");
  const push = pushProgress(frame, p.pushAt, p.pushFrames, p.pushRamp ?? PUSH_RAMP, p.pushHalfLife ?? PUSH_HALF_LIFE);
  const scale = creep * (1 + (p.pushScale - 1) * push);
  const cx = pc.x + (width / 2 - pc.x) * push;
  const cy = pc.y + (height / 2 - pc.y) * push;
  const inP = progress(frame, p.inAt, 8, "linear");
  const pushing = frame >= p.pushAt;
  const badgeIn = progress(frame, p.isolateAt + p.isolateFrames, 8, "overshoot");

  const wall = (
    <div style={{ position: "absolute", inset: 0, opacity: inP }}>
      {chips.map((c, i) => {
        const isPick = i === pick;
        const o = isPick ? 1 : isolateOpacity(frame, p.isolateAt, p.isolateFrames, p.seed, i);
        if (o <= 0) return null;
        const x = cx + (left + (c.col + 0.5) * slotW - pc.x) * scale;
        const y = cy + (top + (c.row + 0.5) * slotH - pc.y) * scale;
        return (
          <div
            key={i}
            {...intendedOverflow(
              pushing && !isPick,
              "chip-wall: the push carries the wall past the frame edges until the isolate fades it",
            )}
            style={{
              position: "absolute",
              left: x,
              top: y,
              maxWidth: isPick ? undefined : slotW * 0.94,
              height: chipH,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transformOrigin: "50% 50%",
              opacity: o,
              display: "flex",
              alignItems: "center",
              gap: font * 0.5,
              padding: `0 ${font * 0.6}px`,
              boxSizing: "border-box",
              borderRadius: chipH / 2,
              background: s.card,
              border: `1px solid ${s.border}`,
              boxShadow: s.shadow.xs,
              fontSize: font,
              fontWeight: 500,
              color: s.text,
              whiteSpace: "nowrap",
            }}
          >
            <div
              style={{
                width: font * 0.9,
                height: font * 0.9,
                borderRadius: font * 0.25,
                background: isPick ? s.accent : s.muted,
                flexShrink: 0,
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
            {isPick && p.badge && badgeIn > 0 ? (
              <span
                style={{
                  marginLeft: "auto",
                  padding: `${font * 0.08}px ${font * 0.4}px`,
                  borderRadius: 999,
                  background: s.accentSoft,
                  color: s.accent,
                  fontSize: font * 0.75,
                  transform: `scale(${badgeIn})`,
                }}
              >
                {p.badge}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
  return p.ground === "transparent" ? (
    <AbsoluteFill style={{ fontFamily: geist, color: s.text }}>{wall}</AbsoluteFill>
  ) : (
    <Ground s={s}>{wall}</Ground>
  );
};
