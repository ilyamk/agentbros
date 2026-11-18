import React from "react";
import { z } from "zod";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { progress, trackPoint } from "../../timing";
import { geist, Ground, Pointer, surface } from "./surface";
import { easeWindow, fanoutPose, gridCells, OUTLINE_FRAMES, statusSchedule, type Rect } from "./ui-plan";

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });

export const uiCardGridSchema = z.object({
  /** `fanout`: cards spring out of one source rect into the grid while the source dissolves. `status`: chips attach to cards in cursor order, then every card is outlined. */
  mode: z.enum(["fanout", "status"]),
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Each card's title and line, or `src`, an image under public/ (a captured card of the real product). */
  cards: z
    .array(z.object({ title: z.string(), body: z.string().optional(), src: z.string().optional() }))
    .min(1)
    .max(12),
  cols: z.number().int().min(1).max(6),
  /** Grid area, shares of the frame. */
  area: rectSchema,
  gap: z.number().min(0).max(0.1),
  /** fanout: the source card's rect (shares) and title; it dissolves as the first card leaves. */
  source: rectSchema.optional(),
  sourceTitle: z.string().optional(),
  /** fanout: frame the first card leaves, frames between cards (postiz ~4), frames each travels, start scale (~0.3). */
  fanAt: z.number().int().min(0),
  fanStep: z.number().min(0),
  fanFrames: z.number().int().min(1),
  fromScale: z.number().min(0.05).max(1),
  /** status: cards in by `cardsAt` within 9 f; chips in this order (card indices) every `chipGap` frames from `chipAt`. */
  cardsAt: z.number().int().min(0),
  chips: z
    .array(
      z.object({
        card: z.number().int().min(0),
        text: z.string(),
        tone: z.enum(["warning", "error", "ok", "neutral"]),
      }),
    )
    .optional(),
  chipAt: z.number().int().min(0),
  chipGap: z.number().int().min(1),
  /** status: frame every card is outlined in its chip's colour (postiz: the last 5 frames); absent never. */
  outlineAt: z.number().int().min(0).optional(),
  /** status: a cursor visits each card just before its chip. */
  cursor: z.boolean(),
  /** A slow push over the whole block, as a scale (postiz: about 1.14, power1.out); 1 for none. */
  push: z.number().min(1).max(1.5),
  ground: z.enum(["preview", "transparent"]),
});

export type UiCardGridProps = z.infer<typeof uiCardGridSchema>;

const CHIP_TONES = { warning: "#F59E0B", error: "#EF4444", ok: "#16A34A", neutral: "#71717A" } as const;

export const cardGridTiming = (p: UiCardGridProps) => {
  const n = p.cards.length;
  const chipOrder = (p.chips ?? []).map((c) => c.card);
  const chipFrames = statusSchedule(n, p.chipAt, p.chipGap, chipOrder);
  const fanLands = p.cards.map((_, i) => p.fanAt + i * p.fanStep + p.fanFrames);
  return { chipFrames, fanLands };
};

export const uiCardGridCues = (p: UiCardGridProps) => {
  const t = cardGridTiming(p);
  if (p.mode === "fanout")
    return [
      { frame: p.fanAt, kind: "hit" as const, sfx: "whoosh" as const, weight: "hero" as const, label: "cards fan out" },
      {
        frame: Math.max(...t.fanLands),
        kind: "land" as const,
        sfx: "none" as const,
        weight: "support" as const,
        label: "grid complete",
      },
    ];
  return [
    { frame: p.cardsAt, kind: "reveal" as const, sfx: "tick" as const, weight: "support" as const, label: "cards in" },
    ...(p.chips ?? []).map((c, k) => ({
      frame: p.chipAt + k * p.chipGap,
      kind: "hit" as const,
      sfx: "pop" as const,
      weight: "support" as const,
      label: `chip on card ${c.card + 1}`,
    })),
    ...(p.outlineAt !== undefined
      ? [
          {
            frame: p.outlineAt,
            kind: "hit" as const,
            sfx: "impact" as const,
            weight: "hero" as const,
            label: "every card outlined",
          },
        ]
      : []),
  ];
};

const CardFace: React.FC<{ card: UiCardGridProps["cards"][number]; s: ReturnType<typeof surface>; u: number }> = ({
  card,
  s,
  u,
}) =>
  card.src ? (
    <Img src={staticFile(card.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  ) : (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: 26 * u,
        display: "flex",
        flexDirection: "column",
        gap: 12 * u,
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 * u }}>
        <div style={{ width: 36 * u, height: 36 * u, borderRadius: 10 * u, background: s.muted, flexShrink: 0 }} />
        <div
          style={{
            fontSize: 26 * u,
            fontWeight: 600,
            color: s.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {card.title}
        </div>
      </div>
      {card.body ? <div style={{ fontSize: 20 * u, color: s.mutedText, lineHeight: 1.35 }}>{card.body}</div> : null}
      {[0.9, 0.7, 0.8].map((w, k) => (
        <div key={k} style={{ height: 12 * u, width: `${w * 100}%`, borderRadius: 6 * u, background: s.muted }} />
      ))}
    </div>
  );

/** A grid of cards: fanned out of one source card, or marked with status chips in cursor order and outlined. */
export const UiCardGrid: React.FC<UiCardGridProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const s = surface(p.tone, p.accent);
  const cells = gridCells(p.cards.length, p.cols, p.area, p.gap);
  const t = cardGridTiming(p);
  const px = (r: Rect): React.CSSProperties => ({
    position: "absolute",
    left: r.x * width,
    top: r.y * height,
    width: r.w * width,
    height: r.h * height,
  });
  const radius = 22 * u;
  const outline = p.outlineAt !== undefined ? progress(frame, p.outlineAt, Math.min(3, OUTLINE_FRAMES), "linear") : 0;
  const pushScale = 1 + (p.push - 1) * easeWindow(frame, 0, durationInFrames, "power2.out");
  const source = p.source ?? { x: 0.38, y: 0.36, w: 0.24, h: 0.28 };

  // The cursor travels to each chip's card, arriving 4 frames before the chip.
  const cursorKeys = (p.chips ?? []).map((c, k) => {
    const cell = cells[c.card] ?? cells[0]!;
    return {
      at: p.chipAt + k * p.chipGap - 4,
      x: (cell.x + cell.w * 0.72) * width,
      y: (cell.y + cell.h * 0.7) * height,
      curve: "expoOut" as const,
    };
  });
  const cursorPt = cursorKeys.length
    ? trackPoint(frame, [{ at: p.chipAt - 20, x: width * 0.9, y: height * 0.95 }, ...cursorKeys])
    : null;

  const content = (
    <div style={{ position: "absolute", inset: 0, transform: `scale(${pushScale})`, transformOrigin: "50% 50%" }}>
      {p.mode === "fanout" ? (
        <>
          {(() => {
            const fade = 1 - progress(frame, p.fanAt - 2, 6, "linear");
            return fade > 0 ? (
              <div
                style={{
                  ...px(source),
                  borderRadius: radius,
                  background: s.card,
                  border: `1px solid ${s.border}`,
                  boxShadow: s.shadow.lg,
                  overflow: "hidden",
                  opacity: fade,
                }}
              >
                <CardFace card={{ title: p.sourceTitle ?? "Source" }} s={s} u={u} />
              </div>
            ) : null;
          })()}
          {p.cards.map((card, i) => {
            const pose = fanoutPose(frame, i, source, cells[i]!, {
              at: p.fanAt,
              step: p.fanStep,
              frames: p.fanFrames,
              fromScale: p.fromScale,
            });
            if (!pose.started) return null;
            const scale = pose.rect.w / cells[i]!.w;
            return (
              <div
                key={i}
                style={{
                  ...px(cells[i]!),
                  left: pose.rect.x * width,
                  top: pose.rect.y * height,
                  transform: `scale(${scale})`,
                  transformOrigin: "0 0",
                  borderRadius: radius,
                  background: s.card,
                  border: `1px solid ${s.border}`,
                  boxShadow: s.shadow.md,
                  overflow: "hidden",
                  opacity: pose.opacity,
                }}
              >
                <CardFace card={card} s={s} u={u} />
              </div>
            );
          })}
        </>
      ) : (
        <>
          {p.cards.map((card, i) => {
            const inP = progress(
              frame,
              p.cardsAt + Math.round((i * 8) / Math.max(1, p.cards.length - 1)),
              6,
              "expoOut",
            );
            const chipAt = t.chipFrames[i]!;
            const chip = (p.chips ?? []).find((c) => c.card === i);
            const chipIn = Number.isFinite(chipAt) ? progress(frame, chipAt, 6, "overshoot") : 0;
            const tone = chip ? CHIP_TONES[chip.tone] : s.border;
            return (
              <div key={i} style={{ ...px(cells[i]!), opacity: inP, transform: `translateY(${(1 - inP) * 20 * u}px)` }}>
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: radius,
                    background: s.card,
                    border: `1px solid ${s.border}`,
                    boxShadow: outline > 0 ? `${s.shadow.md}, 0 0 0 ${3 * u * outline}px ${tone}` : s.shadow.md,
                    overflow: "hidden",
                  }}
                >
                  <CardFace card={card} s={s} u={u} />
                </div>
                {chip && chipIn > 0 ? (
                  <div
                    style={{
                      position: "absolute",
                      right: 18 * u,
                      bottom: 18 * u,
                      display: "flex",
                      alignItems: "center",
                      gap: 8 * u,
                      padding: `${6 * u}px ${14 * u}px`,
                      borderRadius: 999,
                      background: tone,
                      color: "#FFFFFF",
                      fontSize: 20 * u,
                      fontWeight: 600,
                      transform: `scale(${chipIn})`,
                      transformOrigin: "100% 100%",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <div
                      style={{ width: 8 * u, height: 8 * u, borderRadius: 8 * u, background: "rgba(255,255,255,0.9)" }}
                    />
                    {chip.text}
                  </div>
                ) : null}
              </div>
            );
          })}
          {p.cursor && cursorPt && frame >= p.chipAt - 20 ? (
            <Pointer
              x={cursorPt.x}
              y={cursorPt.y}
              frame={frame}
              pressAt={Math.max(
                -99,
                ...(p.chips ?? []).map((_, k) => p.chipAt + k * p.chipGap).filter((f) => f <= frame),
              )}
              size={44 * u}
            />
          ) : null}
        </>
      )}
    </div>
  );
  return p.ground === "transparent" ? (
    <AbsoluteFill style={{ fontFamily: geist, color: s.text }}>{content}</AbsoluteFill>
  ) : (
    <Ground s={s}>{content}</Ground>
  );
};
