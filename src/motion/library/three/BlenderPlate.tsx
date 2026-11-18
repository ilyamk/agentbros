import React, { useEffect, useState } from "react";
import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Freeze,
  Img,
  continueRender,
  delayRender,
  interpolate,
  Easing,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { isVideoPlate, plateFrameSrc } from "./plate-plan";
import { resolveAsset } from "./shared";

export const blenderPlateSchema = z.object({
  /**
   * The Blender render: a frame pattern such as "projects/ID/blender/hero/frame-######.png" (each `#` run is
   * the zero-padded frame number, alpha kept) or a video file (.mp4/.mov/.webm).
   */
  src: z.string(),
  /** File number shown on the block's first frame (blender-run numbers from the scene's first frame). */
  firstFrame: z.number().int().min(0),
  /** Frames in the plate; the last one holds after it. */
  frameCount: z.number().int().positive(),
  fit: z.enum(["cover", "contain"]),
  /** Behind a transparent plate. Any CSS background. */
  background: z.string(),
  headline: z.string(),
  subline: z.string(),
  textColour: z.string(),
  /** Where the type sits: beside the device (left/right) or under it (bottom). */
  textSide: z.enum(["left", "right", "bottom", "none"]),
  /** Frame the type starts to arrive. */
  textAt: z.number().int().min(0),
  /** camera.json written by blender-run beside the frames; needed for `screenOverlay`. */
  camera: z.string().optional(),
  /** An image laid exactly onto the screen corners from camera.json (anchors screen_tl/tr/br/bl). */
  screenOverlay: z.string().optional(),
  /** Anchor prefix in camera.json, e.g. "phone" for multi-device shots. Default "screen". */
  anchorPrefix: z.string().optional(),
});

export type BlenderPlateProps = z.infer<typeof blenderPlateSchema>;

type Anchor = { x: number; y: number; visible: boolean };
type CameraExport = {
  width: number;
  height: number;
  frameStart: number;
  frames: Array<{ frame: number; anchors: Record<string, Anchor> }>;
};

const isVideo = isVideoPlate;

export { plateFrameSrc };

/** Cues of the plate: the move lands on the last rendered frame; type arrives at `textAt`. */
export const blenderPlateCues = (p: BlenderPlateProps) => [
  { frame: p.textAt, kind: "reveal" as const, sfx: "whoosh" as const, weight: "support" as const, label: "type in" },
  {
    frame: Math.max(0, p.frameCount - 1),
    kind: "land" as const,
    sfx: "none" as const,
    weight: "hero" as const,
    label: "move lands",
  },
];

const useCamera = (src?: string) => {
  const [data, setData] = useState<CameraExport | null>(null);
  const [handle] = useState(() => (src ? delayRender(`camera.json ${src}`) : null));
  useEffect(() => {
    if (!src || handle === null) return;
    fetch(resolveAsset(src))
      .then((response) => response.json() as Promise<CameraExport>)
      .then((json) => setData(json))
      .catch(() => setData(null))
      .finally(() => continueRender(handle));
  }, [src, handle]);
  return data;
};

/** CSS matrix3d that maps a w x h box onto four corner points (tl, tr, br, bl). */
const quadMatrix = (w: number, h: number, q: Array<{ x: number; y: number }>) => {
  const [p0, p1, p2, p3] = q as [Anchor, Anchor, Anchor, Anchor];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const hh = (dx1 * sy - sx * dy1) / det;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + hh * p3.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + hh * p3.y;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, p0.x, p0.y, 0, 1];
  return `matrix3d(${m.join(",")})`;
};

export const BlenderPlate: React.FC<BlenderPlateProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const camera = useCamera(p.camera);
  const plateW = camera?.width ?? width;
  const plateH = camera?.height ?? height;
  const scale =
    p.fit === "cover" ? Math.max(width / plateW, height / plateH) : Math.min(width / plateW, height / plateH);
  const offsetX = (width - plateW * scale) / 2;
  const offsetY = (height - plateH * scale) / 2;
  const index = Math.min(frame, p.frameCount - 1);
  const record = camera?.frames[Math.min(index, camera.frames.length - 1)];
  const prefix = p.anchorPrefix ?? "screen";
  const corners = record ? (["tl", "tr", "br", "bl"] as const).map((k) => record.anchors[`${prefix}_${k}`]) : [];
  const overlayReady = p.screenOverlay && corners.length === 4 && corners.every(Boolean);
  const textIn = interpolate(frame, [p.textAt, p.textAt + Math.round(fps * 0.8)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const vertical = height > width;
  const side = p.textSide === "bottom" || (vertical && p.textSide !== "none") ? "bottom" : p.textSide;
  const unit = Math.min(width, height) / 100;
  const plateStyle: React.CSSProperties = {
    position: "absolute",
    left: offsetX,
    top: offsetY,
    width: plateW * scale,
    height: plateH * scale,
  };
  return (
    <AbsoluteFill style={{ background: p.background }}>
      {isVideo(p.src) ? (
        <Freeze frame={index}>
          <Video src={resolveAsset(p.src)} style={plateStyle} muted />
        </Freeze>
      ) : (
        <Img src={resolveAsset(plateFrameSrc(p.src, p.firstFrame + index))} style={plateStyle} />
      )}
      {overlayReady
        ? (() => {
            const q = corners.map((c) => ({ x: offsetX + c!.x * scale, y: offsetY + c!.y * scale }));
            const boxH = 1000;
            const boxW = Math.round(
              (boxH * Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y)) /
                Math.max(1, Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y)),
            );
            return (
              <Img
                src={resolveAsset(p.screenOverlay!)}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: boxW,
                  height: boxH,
                  objectFit: "contain",
                  background: "#000",
                  borderRadius: boxW * 0.11,
                  transformOrigin: "0 0",
                  transform: quadMatrix(boxW, boxH, q),
                }}
              />
            );
          })()
        : null}
      {side !== "none" && (p.headline || p.subline) ? (
        <div
          style={{
            position: "absolute",
            ...(side === "bottom"
              ? { left: unit * 8, right: unit * 8, bottom: height * 0.08, textAlign: "center" as const }
              : { top: "50%", width: width * 0.32, [side]: width * 0.07, transform: "translateY(-50%)" }),
            color: p.textColour,
            fontFamily: primaryFont,
            opacity: textIn,
            translate: `0 ${(1 - textIn) * unit * 2.4}px`,
            filter: `blur(${(1 - textIn) * 8}px)`,
          }}
        >
          <div
            style={{
              fontSize: unit * (vertical ? 7.2 : 6),
              fontWeight: 650,
              letterSpacing: "-0.035em",
              lineHeight: 1.02,
            }}
          >
            {p.headline}
          </div>
          {p.subline ? (
            <div
              style={{
                marginTop: unit * 2,
                fontSize: unit * 2.4,
                fontWeight: 450,
                opacity: 0.62,
                letterSpacing: "-0.01em",
              }}
            >
              {p.subline}
            </div>
          ) : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
