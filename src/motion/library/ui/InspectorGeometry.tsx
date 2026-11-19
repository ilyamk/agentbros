import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { ProductionArt, ProductionStage, studioAccent, studioInk, studioPaper } from "./production-surface";

export const inspectorGeometrySchema = z.object({
  title: z.string().min(1).max(25),
  control: z.string().min(1).max(22),
  from: z.number().min(0).max(100),
  to: z.number().min(0).max(100),
  at: z.number().int().nonnegative(),
  moveFrames: z.number().int().min(4),
  accent: z.string(),
});

export type InspectorGeometryProps = z.infer<typeof inspectorGeometrySchema>;
export const inspectorGeometryDefaults = {
  title: "Atlas of Light",
  control: "Corner radius",
  from: 12,
  to: 76,
  at: 23,
  moveFrames: 27,
  accent: studioAccent,
} satisfies InspectorGeometryProps;
export const inspectorGeometryCues = (p: InspectorGeometryProps): Cue[] => [
  { frame: p.at, kind: "click", sfx: "click", label: "Move control" },
  { frame: p.at + p.moveFrames, kind: "land", sfx: "tick", label: "Geometry settles" },
];
export const inspectorValue = (frame: number, p: InspectorGeometryProps) =>
  p.from + (p.to - p.from) * progress(frame, p.at, p.moveFrames, "drift");

export const InspectorGeometry: React.FC<InspectorGeometryProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const value = inspectorValue(frame, p);
  const active = frame >= p.at - 2 && frame < p.at + p.moveFrames;
  const u = width / 1920;
  return (
    <ProductionStage title="Design the frame" index="01">
      <AbsoluteFill
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2.05fr) minmax(0, 1fr)",
          gap: u * 40,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            position: "relative",
            display: "grid",
            placeItems: "center",
            border: "1px solid #B1C0A44D",
            background:
              "repeating-linear-gradient(0deg, #EBF6DF0C 0px 1px, transparent 1px 32px), repeating-linear-gradient(90deg, #EBF6DF0C 0px 1px, transparent 1px 32px), #1D2D26",
            borderRadius: u * 20,
          }}
        >
          <div style={{ width: "83%", aspectRatio: "800/470", position: "relative" }}>
            <ProductionArt title={p.title} paper={p.accent} radius={value} />
            <div
              style={{ position: "absolute", inset: -u * 9, border: `2px solid ${p.accent}`, borderRadius: u * 6 }}
            />
            {[
              ["0%", "0%"],
              ["100%", "0%"],
              ["0%", "100%"],
              ["100%", "100%"],
            ].map(([x, y]) => (
              <div
                key={`${x}${y}`}
                style={{
                  position: "absolute",
                  left: x,
                  top: y,
                  width: u * 13,
                  height: u * 13,
                  background: studioInk,
                  border: `2px solid ${p.accent}`,
                  transform: "translate(-50%,-50%)",
                }}
              />
            ))}
          </div>
        </div>
        <div
          style={{
            alignSelf: "center",
            background: studioPaper,
            color: studioInk,
            borderRadius: u * 24,
            padding: u * 39,
          }}
        >
          <div style={{ fontSize: u * 23, opacity: 0.68, letterSpacing: "0.08em", paddingBottom: u * 33 }}>
            FRAME PROPERTIES
          </div>
          <div
            style={{ display: "flex", justifyContent: "space-between", gap: u * 10, fontSize: u * 29, fontWeight: 650 }}
          >
            <span>{p.control}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(value)} px</span>
          </div>
          <div
            style={{
              position: "relative",
              marginTop: u * 36,
              height: u * 10,
              borderRadius: u * 8,
              background: "#C2CFB6",
            }}
          >
            <div style={{ width: `${value}%`, height: "100%", borderRadius: "inherit", background: "#55734E" }} />
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: `${value}%`,
                width: u * 29,
                height: u * 29,
                background: studioInk,
                border: `${u * 4}px solid ${p.accent}`,
                borderRadius: "50%",
                transform: `translate(-50%,-50%) scale(${active ? 1.26 : 1})`,
              }}
            />
            {active ? (
              <svg
                viewBox="0 0 40 47"
                width={u * 39}
                height={u * 45}
                style={{ position: "absolute", left: `calc(${value}% + ${u * 7}px)`, top: u * 5 }}
              >
                <path d="M3 2v33l10-8 7 15 6-4-7-14 15-2z" fill="#FFF" stroke={studioInk} strokeWidth="2.5" />
              </svg>
            ) : null}
          </div>
        </div>
      </AbsoluteFill>
    </ProductionStage>
  );
};
