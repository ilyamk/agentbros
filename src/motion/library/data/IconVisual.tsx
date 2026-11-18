import React from "react";
import { Img, staticFile } from "remotion";
import { z } from "zod";
import { defineItem } from "../types";

export const iconVisualSchema = z.object({
  src: z.string().default(""),
  resourceId: z.string().default(""),
  derivativeId: z.string().default(""),
  placementId: z.string().default("icon-preview"),
  label: z.string().default("A clear visual idea"),
  size: z.number().min(32).max(900).default(320),
  colour: z.string().default("#111111"),
  background: z.string().default("#f7f5ef"),
});
export function IconVisual(props: z.infer<typeof iconVisualSchema>) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 40,
        color: props.colour,
        background: props.background,
      }}
    >
      {props.src ? (
        <Img src={staticFile(props.src)} style={{ width: props.size, height: props.size, objectFit: "contain" }} />
      ) : (
        <svg width={props.size} height={props.size} viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M50 20 65 65 20 50Z" fill="currentColor" />
        </svg>
      )}
      <div style={{ fontFamily: "sans-serif", fontSize: 40, textAlign: "center" }}>{props.label}</div>
    </div>
  );
}
export const iconVisualItem = defineItem({
  id: "icon-visual",
  category: "data",
  title: "Local icon or brand visual",
  description:
    "A locally acquired icon or brand SVG/PNG/WebP with an optional label. Acquire and export through resources:icons or resources:logos, then pass the returned usage fields; no network during render.",
  tags: ["icon", "logo", "brand", "metaphor", "diagram", "local", "svg"],
  component: IconVisual,
  schema: iconVisualSchema,
  defaultProps: iconVisualSchema.parse({}),
  durationInFrames: 90,
  formats: ["vertical", "square", "landscape"],
  importPath: "src/motion/library/data/IconVisual",
  inspiredBy: ["Original project implementation; no external artwork in the preview"],
  cues: () => [
    {
      frame: 0,
      kind: "reveal",
      sfx: "none",
      weight: "hero",
      label: "Static icon: silence unless the scene calls for sound",
    },
  ],
});
