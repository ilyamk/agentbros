import { Check, FileUp } from "lucide-react";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useFittedFontSize } from "../../text";
import { progress } from "../../timing";
import type { Cue } from "../types";

export const stateMorphSchema = z
  .object({
    title: z.string().min(1),
    pending: z.string().min(1),
    result: z.string().min(1),
    detail: z.string().optional(),
    at: z.number().int().nonnegative(),
    readyAt: z.number().int().positive(),
    moveFrames: z.number().int().min(6),
    accent: z.string(),
    ground: z.string(),
  })
  .refine((p) => p.readyAt >= p.at + p.moveFrames, {
    path: ["readyAt"],
    message: "The result must start after the processing state has landed.",
  });

export type StateMorphProps = z.infer<typeof stateMorphSchema>;

export const stateMorphDefaults = {
  title: "Import artwork",
  pending: "Processing",
  result: "Artwork ready",
  detail: "Cover and three pages",
  at: 29,
  readyAt: 62,
  moveFrames: 15,
  accent: "#CFED84",
  ground: "#E9EDDE",
} satisfies StateMorphProps;

export const stateMorphCues = ({ at, readyAt, moveFrames }: StateMorphProps): Cue[] => [
  { frame: at, kind: "click", sfx: "click", label: "Start processing" },
  { frame: readyAt + moveFrames, kind: "land", sfx: "chime", weight: "hero", label: "Result readable" },
];

export const stateMorphPose = (frame: number, p: StateMorphProps) => ({
  close: progress(frame, p.at, p.moveFrames, "drift"),
  open: progress(frame, p.readyAt, p.moveFrames, "expoOut"),
  incoming: progress(frame, p.readyAt + 3, p.moveFrames - 3, "drift"),
});

const mix = (a: number, b: number, amount: number) => a + (b - a) * amount;

export const StateMorph: React.FC<StateMorphProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { close, open, incoming } = stateMorphPose(frame, p);
  const unit = Math.min(width * 0.86, height * 1.27);
  const cardWidth = unit * mix(mix(0.93, 0.43, close), 1, open);
  const cardHeight = unit * mix(mix(0.215, 0.127, close), 0.29, open);
  const press = progress(frame, p.at - 4, 4, "drift") - progress(frame, p.at, 6, "expoOut");
  const fit = { fontFamily: "Arial, sans-serif", fontWeight: 650, letterSpacing: "-0.03em" };
  const titleSize = useFittedFontSize({ ...fit, text: p.title, withinWidth: unit * 0.64 });
  const resultSize = useFittedFontSize({ ...fit, text: p.result, withinWidth: unit * 0.66 });
  const pendingSize = useFittedFontSize({ ...fit, text: p.pending, withinWidth: unit * 0.3 });
  const detailSize = useFittedFontSize({ ...fit, text: p.detail ?? "", withinWidth: unit * 0.66 });
  const row: React.CSSProperties = {
    position: "absolute",
    left: unit * 0.088,
    display: "flex",
    alignItems: "center",
    gap: unit * 0.046,
    whiteSpace: "nowrap",
  };
  return (
    <AbsoluteFill style={{ background: p.ground, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: cardWidth,
          height: cardHeight,
          transform: `translate(-50%, -50%) scale(${1 - press * 0.045})`,
          borderRadius: unit * mix(mix(0.047, 0.0635, close), 0.052, open),
          border: "2px solid #24312C",
          background: "#192620",
          color: "#F4F4E8",
          boxShadow: "0 26px 64px #15281A27, 0 4px 8px #15281A26",
          overflow: "hidden",
          fontFamily: "Arial, sans-serif",
          letterSpacing: "-0.03em",
          fontWeight: 650,
        }}
      >
        <div style={{ ...row, top: "50%", opacity: 1 - Math.min(1, close * 2.5), transform: "translateY(-50%)" }}>
          <FileUp size={unit * 0.058} strokeWidth={1.6} color={p.accent} />
          <span style={{ fontSize: Math.min(unit * 0.057, titleSize ?? 0) }}>{p.title}</span>
        </div>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: unit * 0.024,
            opacity: close ** 2 * (1 - open),
            fontSize: Math.min(unit * 0.036, pendingSize ?? 0),
          }}
        >
          <svg
            aria-hidden
            width={unit * 0.032}
            height={unit * 0.032}
            viewBox="0 0 40 40"
            style={{ transform: `rotate(${Math.max(0, Math.min(frame, p.readyAt) - p.at) * 12}deg)` }}
          >
            <circle cx="20" cy="20" r="15" fill="none" stroke={p.accent} strokeWidth="3" strokeOpacity="0.3" />
            <path d="M20 5a15 15 0 0 1 15 15" fill="none" stroke={p.accent} strokeWidth="3" strokeLinecap="round" />
          </svg>
          {p.pending}
        </div>
        <div
          style={{
            ...row,
            top: "50%",
            transform: `translateY(calc(-50% + ${(1 - incoming) * unit * 0.026}px))`,
            opacity: incoming,
          }}
        >
          <div
            style={{
              width: unit * 0.105,
              height: unit * 0.105,
              display: "grid",
              placeItems: "center",
              background: p.accent,
              color: "#192620",
              borderRadius: "50%",
            }}
          >
            <Check size={unit * 0.055} strokeWidth={2.5} />
          </div>
          <div style={{ lineHeight: 1.12, fontSize: Math.min(unit * 0.065, resultSize ?? 0) }}>
            {p.result}
            {p.detail ? (
              <div
                style={{
                  color: "#C0CCBB",
                  fontSize: Math.min(unit * 0.032, detailSize ?? 0),
                  marginTop: unit * 0.013,
                }}
              >
                {p.detail}
              </div>
            ) : null}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: unit * 0.005,
            background: p.accent,
            opacity: incoming,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
