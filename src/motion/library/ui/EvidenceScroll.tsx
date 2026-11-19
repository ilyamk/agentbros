import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useFittedLinesFontSize } from "../../text";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { ProductionStage, studioAccent, studioInk, studioPaper } from "./production-surface";

export const evidenceScrollSchema = z
  .object({
    rows: z
      .array(z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(24) }))
      .min(4)
      .max(12),
    target: z.number().int().nonnegative(),
    note: z.string().min(1).max(48),
    at: z.number().int().nonnegative(),
    moveFrames: z.number().int().min(6),
  })
  .refine((p) => p.target < p.rows.length, { path: ["target"], message: "Choose a row in the evidence." });

export type EvidenceScrollProps = z.infer<typeof evidenceScrollSchema>;
export const evidenceScrollDefaults = {
  rows: [
    { label: "Source assets", value: "Ready" },
    { label: "Frame size", value: "1920 × 1080" },
    { label: "Playback", value: "30 fps" },
    { label: "Picture codec", value: "H.264" },
    { label: "Cut timing", value: "Checked" },
    { label: "Final hold", value: "Passed" },
    { label: "Output", value: "Ready" },
  ],
  target: 5,
  note: "The last frame holds.",
  at: 20,
  moveFrames: 35,
} satisfies EvidenceScrollProps;
export const evidenceScrollCues = (p: EvidenceScrollProps): Cue[] => [
  { frame: p.at + p.moveFrames, kind: "stop", sfx: "tick", label: "Evidence ready to read" },
];
export const evidenceScrollPose = (frame: number, p: EvidenceScrollProps) => {
  const distance = Math.max(0, Math.min(p.rows.length - 4, p.target - 1));
  return {
    rowsPassed: distance * progress(frame, p.at, p.moveFrames, "drift"),
    emphasis: progress(frame, p.at + Math.max(0, p.moveFrames - 11), Math.min(11, p.moveFrames), "expoOut"),
  };
};

export const EvidenceScroll: React.FC<EvidenceScrollProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const u = width / 1920;
  const { rowsPassed, emphasis } = evidenceScrollPose(frame, p);
  const rowHeight = u * 113;
  const labelSize = useFittedLinesFontSize({
    lines: p.rows.map(({ label }) => label),
    withinWidth: width * 0.26,
    fontFamily: "Arial, sans-serif",
    fontWeight: 700,
  });
  const valueSize = useFittedLinesFontSize({
    lines: p.rows.map(({ value }) => value),
    withinWidth: width * 0.135,
    fontFamily: "Arial, sans-serif",
  });
  return (
    <ProductionStage title="Read the proof" index="03">
      <AbsoluteFill style={{ display: "grid", gridTemplateColumns: "1.75fr 1fr", gap: u * 70, alignItems: "center" }}>
        <div
          style={{
            background: studioPaper,
            color: studioInk,
            borderRadius: u * 20,
            padding: u * 16,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: u * 23,
              letterSpacing: "0.08em",
              padding: `${u * 19}px ${u * 26}px`,
              borderBottom: "1px solid #9EA992",
            }}
          >
            <span>RENDER CHECK</span>
            <span>STATUS</span>
          </div>
          <div style={{ position: "relative", height: rowHeight * 4, overflow: "hidden" }}>
            <div style={{ transform: `translateY(${-rowsPassed * rowHeight}px)` }}>
              {p.rows.map((row, index) => (
                <div
                  key={index}
                  style={{
                    height: rowHeight,
                    boxSizing: "border-box",
                    gap: u * 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: `0 ${u * 26}px`,
                    position: "relative",
                    borderBottom: "1px solid #BCC8AE",
                    fontSize: u * 30,
                  }}
                >
                  {index === p.target ? (
                    <div
                      style={{
                        position: "absolute",
                        inset: u * 4,
                        background: studioAccent,
                        borderRadius: u * 10,
                        opacity: emphasis,
                      }}
                    />
                  ) : null}
                  <span
                    style={{
                      zIndex: 1,
                      fontSize: Math.min(u * 30, labelSize ?? 0),
                      fontWeight: index === p.target ? 700 : 500,
                    }}
                  >
                    {row.label}
                  </span>
                  <span
                    style={{
                      zIndex: 1,
                      fontSize: Math.min(u * 30, valueSize ?? 0),
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          style={{
            opacity: emphasis,
            transform: `translateX(${(1 - emphasis) * u * 20}px)`,
            borderLeft: `${u * 3}px solid ${studioAccent}`,
            paddingLeft: u * 28,
            color: studioPaper,
            font: `${u * 58}px/1.04 Georgia, serif`,
            letterSpacing: "-0.04em",
          }}
        >
          {p.note}
        </div>
      </AbsoluteFill>
    </ProductionStage>
  );
};
