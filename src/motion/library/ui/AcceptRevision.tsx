import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { ProductionArt, ProductionStage, studioAccent, studioInk, studioPaper } from "./production-surface";

export const acceptRevisionSchema = z.object({
  /** "transparent" lays the block over footage (timeline:edit add-overlay); the default paints the studio ground. */
  ground: z.enum(["studio", "transparent"]).optional(),
  title: z.string().min(1).max(25),
  field: z.string().min(1).max(22),
  before: z.number().min(0.5).max(1.2),
  after: z.number().min(0.5).max(1.2),
  acceptAt: z.number().int().min(4),
  updateFrames: z.number().int().min(6),
});
export type AcceptRevisionProps = z.infer<typeof acceptRevisionSchema>;
export const acceptRevisionDefaults = {
  title: "Atlas of Light",
  field: "titleScale",
  before: 0.64,
  after: 1.14,
  acceptAt: 32,
  updateFrames: 20,
} satisfies AcceptRevisionProps;
export const revisionPose = (frame: number, p: AcceptRevisionProps) => {
  const amount = progress(frame, p.acceptAt, p.updateFrames, "drift");
  return { accepted: frame >= p.acceptAt, titleScale: p.before + (p.after - p.before) * amount };
};
export const acceptRevisionCues = (p: AcceptRevisionProps): Cue[] => [
  { frame: p.acceptAt, kind: "click", sfx: "click", label: "Accept revision" },
  { frame: p.acceptAt + p.updateFrames, kind: "land", sfx: "chime", label: "Preview updated" },
];
export const AcceptRevision: React.FC<AcceptRevisionProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const { accepted, titleScale } = revisionPose(frame, p);
  const u = width / 1920;
  const press = progress(frame, p.acceptAt - 4, 4, "drift") - progress(frame, p.acceptAt, 5, "expoOut");
  const live = progress(frame, p.acceptAt + 4, p.updateFrames - 4, "drift");
  return (
    <ProductionStage
      title="Approve the revision"
      index="02"
      ground={p.ground === "transparent" ? "transparent" : undefined}
    >
      <AbsoluteFill style={{ display: "grid", gridTemplateColumns: "1fr 1.35fr", alignItems: "center", gap: u * 56 }}>
        <div style={{ background: studioPaper, color: studioInk, borderRadius: u * 26, padding: u * 42 }}>
          <div style={{ fontSize: u * 25, letterSpacing: "0.08em", marginBottom: u * 35 }}>PROPOSED CHANGE</div>
          {[
            [p.before, "#F2DCD7", "#6F3635", "−"],
            [p.after, "#D6E8BA", "#304D37", "+"],
          ].map(([value, ground, ink, sign]) => (
            <div
              key={sign}
              style={{
                padding: `${u * 17}px ${u * 24}px`,
                background: String(ground),
                color: String(ink),
                font: `${u * 28}px Menlo, monospace`,
                whiteSpace: "nowrap",
              }}
            >
              {sign} {p.field}: {Number(value).toFixed(2)}
            </div>
          ))}
          <div
            style={{
              marginTop: u * 32,
              display: "inline-flex",
              alignItems: "center",
              minWidth: u * 230,
              justifyContent: "center",
              padding: u * 18,
              borderRadius: u * 14,
              background: accepted ? "#D4E5AF" : studioInk,
              color: accepted ? studioInk : studioPaper,
              fontWeight: 650,
              fontSize: u * 24,
              transform: `scale(${1 - press * 0.05})`,
            }}
          >
            {accepted ? "✓ Accepted" : "Accept change"}
          </div>
        </div>
        <div style={{ position: "relative", border: "1px solid #B1C0A482", borderRadius: u * 24, padding: u * 19 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: u * 12,
              paddingBottom: u * 23,
              fontSize: u * 24,
            }}
          >
            <span>Live preview</span>
            <span style={{ color: studioAccent, opacity: live }}>Updated</span>
          </div>
          <div style={{ aspectRatio: "800 / 470" }}>
            <ProductionArt title={p.title} titleScale={titleScale} radius={44} />
          </div>
        </div>
      </AbsoluteFill>
    </ProductionStage>
  );
};
