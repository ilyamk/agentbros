import type React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { ProductionArt, ProductionStage, studioAccent, studioInk, studioPaper } from "./production-surface";

export const deviceHandoffSchema = z.object({
  title: z.string().min(1).max(25),
  src: z.string().optional(),
  at: z.number().int().nonnegative(),
  moveFrames: z.number().int().min(8),
  paper: z.string(),
});
export type DeviceHandoffProps = z.infer<typeof deviceHandoffSchema>;
export const deviceHandoffDefaults = {
  title: "Atlas of Light",
  at: 24,
  moveFrames: 35,
  paper: studioAccent,
} satisfies DeviceHandoffProps;
export const deviceHandoffCues = (p: DeviceHandoffProps): Cue[] => [
  { frame: p.at, kind: "reveal", sfx: "whoosh", label: "Pass the screen" },
  { frame: p.at + p.moveFrames, kind: "land", sfx: "tick", label: "Tablet view holds" },
];
export const devicePose = (frame: number, p: DeviceHandoffProps) => {
  const t = progress(frame, p.at, p.moveFrames, "drift");
  return { t, x: 31 + 32 * t, width: 18 + 29 * t, height: 84 - 13 * t, tilt: -9 + 9 * t };
};
export const DeviceHandoff: React.FC<DeviceHandoffProps> = (p) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const u = width / 1920;
  const { t, x, width: deviceWidth, height, tilt } = devicePose(frame, p);
  return (
    <ProductionStage title="Check the next screen" index="05">
      <div
        style={{
          position: "absolute",
          inset: "5% 0",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          borderBottom: "1px solid #BDD3B344",
          pointerEvents: "none",
        }}
      >
        <div style={{ borderRight: "1px solid #BDD3B333" }} />
        <div />
      </div>
      <div
        style={{
          position: "absolute",
          left: `${x}%`,
          top: "48%",
          width: `${deviceWidth}%`,
          height: `${height}%`,
          padding: u * (15 - 4 * t),
          background: "#0C1412",
          border: `${u * 3}px solid #829883`,
          borderRadius: u * (46 - 22 * t),
          transform: `translate(-50%,-50%) perspective(1400px) rotateY(${tilt}deg)`,
          boxShadow: "0 30px 58px #08100AC7",
        }}
      >
        <div
          style={{
            height: "100%",
            position: "relative",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
            background: studioPaper,
            borderRadius: u * (34 - 17 * t),
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: u * 12,
              transform: "translateX(-50%)",
              width: u * (56 - 47 * t),
              height: u * 9,
              borderRadius: u * 10,
              background: studioInk,
            }}
          />
          <div style={{ width: `${86 + 3 * t}%`, aspectRatio: "800/470", borderRadius: u * 11, overflow: "hidden" }}>
            {p.src ? (
              <Img src={staticFile(p.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <ProductionArt title={p.title} paper={p.paper} />
            )}
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: "16%",
          bottom: 0,
          opacity: 1 - t,
          fontSize: u * 25,
          letterSpacing: "0.09em",
        }}
      >
        PHONE VIEW
      </div>
      <div
        style={{
          position: "absolute",
          right: "15%",
          bottom: 0,
          opacity: t,
          color: studioAccent,
          fontSize: u * 25,
          letterSpacing: "0.09em",
        }}
      >
        TABLET VIEW
      </div>
    </ProductionStage>
  );
};
