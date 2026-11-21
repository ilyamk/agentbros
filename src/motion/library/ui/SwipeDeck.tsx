import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useFittedFontSize } from "../../text";
import { progress } from "../../timing";
import type { Cue } from "../types";

const deckCardSchema = z.object({
  title: z.string().min(1),
  label: z.string().optional(),
  paper: z.string(),
  ink: z.string(),
  src: z.string().optional(),
});

export const swipeDeckSchema = z
  .object({
    cards: z.array(deckCardSchema).min(2).max(10),
    at: z.number().int().nonnegative(),
    step: z.number().int().positive(),
    moveFrames: z.number().int().min(8),
    direction: z.enum(["left", "right"]),
    ground: z.string(),
  })
  .refine((p) => p.step >= p.moveFrames, {
    path: ["step"],
    message: "Each card must finish leaving before the next move.",
  });

export type SwipeDeckProps = z.infer<typeof swipeDeckSchema>;

export const swipeDeckDefaults = {
  cards: [
    { title: "Light", label: "01 / Field notes", paper: "#D7E9A5", ink: "#1E3323" },
    { title: "Form", label: "02 / Field notes", paper: "#C5D2EC", ink: "#1C2C4E" },
    { title: "Surface", label: "03 / Field notes", paper: "#F1D7AE", ink: "#513720" },
  ],
  at: 27,
  step: 32,
  moveFrames: 19,
  direction: "left",
  ground: "#252C24",
} satisfies SwipeDeckProps;

export const swipeDeckCues = (p: SwipeDeckProps): Cue[] =>
  p.cards.slice(1).map((_, i) => ({
    frame: p.at + i * p.step + p.moveFrames,
    kind: "land",
    sfx: "tick",
    weight: "support",
    label: "Next card lands",
  }));

export const swipeDeckPose = (frame: number, index: number, p: SwipeDeckProps) => {
  const moves = p.cards.length - 1;
  const active = Math.min(moves, Math.max(0, Math.floor((frame - p.at) / p.step)));
  const start = p.at + active * p.step;
  const departing = active < moves && frame >= start;
  const advance = departing ? progress(frame, start, p.moveFrames, "drift") : 0;
  const exit = index === active && departing ? advance : 0;
  const depth = Math.max(0, index - active - advance);
  return { depth, exit, show: index >= active && depth < 3 && exit < 1 };
};

type DeckCard = z.infer<typeof deckCardSchema>;

const DeckArtwork: React.FC<{ card: DeckCard; index: number; width: number }> = ({ card, index, width }) => {
  const fit = useFittedFontSize({
    text: card.title,
    withinWidth: width * 0.85,
    fontFamily: "Georgia, serif",
    letterSpacing: "-0.045em",
  });
  return (
    <AbsoluteFill style={{ color: card.ink, padding: width * 0.075, fontFamily: "Arial, sans-serif" }}>
      <svg viewBox="0 0 700 410" width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: 0.74 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <ellipse
            key={i}
            cx={518 - i * 6}
            cy={180 + i * 3}
            rx={220 - i * 12}
            ry={110 - i * 6}
            transform={`rotate(${index * 24 - 24} 490 190)`}
            fill="none"
            stroke={card.ink}
            strokeWidth={i === 9 ? 2 : 1}
          />
        ))}
      </svg>
      <div style={{ fontSize: width * 0.035, letterSpacing: "0.09em", fontWeight: 700 }}>{card.label}</div>
      <div
        style={{
          marginTop: "auto",
          fontFamily: "Georgia, serif",
          fontSize: Math.min(width * 0.142, fit ?? 0),
          letterSpacing: "-0.045em",
          lineHeight: 0.98,
        }}
      >
        {card.title}
      </div>
    </AbsoluteFill>
  );
};

export const SwipeDeck: React.FC<SwipeDeckProps & { children?: (index: number) => React.ReactNode }> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cardWidth = Math.min(width * 0.82, height * 1.18);
  const sign = p.direction === "left" ? -1 : 1;
  const offscreen = width / 2 + cardWidth * 0.65 + 46;
  return (
    <AbsoluteFill style={{ background: p.ground, overflow: "hidden" }}>
      {p.cards.map((card, index) => {
        const { depth, exit, show } = swipeDeckPose(frame, index, p);
        if (!show) return null;
        const x = sign * (offscreen * exit ** 1.48 - cardWidth * depth * 0.038);
        const y = -cardWidth * (depth * 0.064 + 0.093 * exit);
        const angle = sign * (exit * 19 - depth * 3.2);
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: "50%",
              top: "52%",
              width: cardWidth,
              height: cardWidth * 0.615,
              background: card.paper,
              overflow: "hidden",
              borderRadius: cardWidth * 0.032,
              boxShadow: "0 15px 46px #0F15144D",
              transform: `translate(-50%, -50%) translate(${x}px,${y}px) rotate(${angle}deg) scale(${1 - depth * 0.073})`,
              opacity: Math.min(1, 3 - depth),
              zIndex: p.cards.length - index,
            }}
          >
            {p.children ? (
              p.children(index)
            ) : card.src ? (
              <Img src={staticFile(card.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <DeckArtwork card={card} index={index} width={cardWidth} />
            )}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
