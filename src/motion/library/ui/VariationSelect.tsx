import type React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { ProductionArt, ProductionStage, studioAccent, studioInk } from "./production-surface";

export const variationSelectSchema = z
  .object({
    options: z
      .array(
        z.object({
          title: z.string().min(1).max(25),
          label: z.string().min(1).max(18),
          paper: z.string(),
          src: z.string().optional(),
        }),
      )
      .min(2)
      .max(3),
    selected: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
    selectAt: z.number().int().nonnegative(),
    expandFrames: z.number().int().min(8),
  })
  .refine((p) => p.selected < p.options.length && p.selectAt >= p.at + (p.options.length - 1) * 5 + 11, {
    message: "Choose an existing card after the grid has appeared.",
  });

export type VariationSelectProps = z.infer<typeof variationSelectSchema>;
export const variationSelectDefaults = {
  options: [
    { title: "Atlas of Light", label: "PAPER", paper: "#E8D8B0" },
    { title: "Atlas of Light", label: "FIELD", paper: studioAccent },
    { title: "Atlas of Light", label: "GLASS", paper: "#C4D5EE" },
  ],
  selected: 1,
  at: 5,
  selectAt: 51,
  expandFrames: 25,
} satisfies VariationSelectProps;
export const variationSelectCues = (p: VariationSelectProps): Cue[] => [
  { frame: p.selectAt, kind: "click", sfx: "click", label: "Choose variation" },
  { frame: p.selectAt + p.expandFrames, kind: "land", sfx: "none", label: "Selected card fills the stage" },
];
export const selectionProgress = (frame: number, p: VariationSelectProps) =>
  progress(frame, p.selectAt, p.expandFrames, "drift");
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export const VariationSelect: React.FC<VariationSelectProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const u = width / 1920;
  const select = selectionProgress(frame, p);
  const gap = 2.1;
  const share = (100 - gap * (p.options.length - 1)) / p.options.length;
  return (
    <ProductionStage title="Choose the look" index="04">
      <AbsoluteFill>
        {p.options.map((item, i) => {
          const chosen = p.selected === i;
          const arrival = progress(frame, p.at + i * 5, 11, "expoOut");
          const t = chosen ? select : 0;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${mix(i * (share + gap), 17, t)}%`,
                top: `${mix(24, 3, t)}%`,
                width: `${mix(share, 66, t)}%`,
                transform: `translateY(${(1 - arrival) * u * 36}px) scale(${chosen ? 1 : 1 - select * 0.08})`,
                opacity: arrival * (chosen ? 1 : 1 - select),
                zIndex: chosen ? 2 : 1,
              }}
            >
              <div
                style={{
                  aspectRatio: "800/470",
                  position: "relative",
                  overflow: "hidden",
                  borderRadius: u * 14,
                  boxShadow: "0 22px 50px #101C165E",
                }}
              >
                {item.src ? (
                  <Img src={staticFile(item.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <ProductionArt title={item.title} paper={item.paper} turn={-24 + i * 8} />
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingTop: u * 15,
                  fontSize: u * 24,
                  letterSpacing: "0.08em",
                }}
              >
                {item.label}
                {chosen && select > 0 ? (
                  <span
                    style={{
                      color: studioInk,
                      background: studioAccent,
                      borderRadius: u * 12,
                      padding: `${u * 7}px ${u * 13}px`,
                      opacity: select,
                      fontWeight: 650,
                    }}
                  >
                    Selected
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    </ProductionStage>
  );
};
