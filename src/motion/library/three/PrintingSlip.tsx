import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { PerspectiveCamera } from "@react-three/drei";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { plateSchema } from "./plate-plan";
import { PlateLayer } from "./PlateLayer";
import { canvasTexture, easeInOut, mix, ramp, useFontReady } from "./shared";
import { POLYMARKET_SLIP, curlPoint, slipFlat, slipRowFrames, slipRowsShown, slipUnroll } from "./three-plan";

/**
 * A paper slip with a torn edge that unrolls from a curl as its rows print, tilting and drifting back with a slow sheen
 * (polymarket printing-slip). A bent plane in three.js: the vertices are placed per frame by `curlPoint`, the print is a
 * canvas texture redrawn when a row arrives, the back of the paper is plain. No Blender needed.
 */
export const printingSlipSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  rows: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .min(1)
    .max(16),
  paper: z.string(),
  ink: z.string(),
  background: z.string(),
  /** First frame of the unroll and its length (polymarket: 29 f, power3.out). */
  at: z.number().int().min(0),
  frames: z.number().int().min(4).max(120),
  /** Share of the sheet out before the unroll starts (title and subtitle). */
  header: z.number().min(0.05).max(0.6),
  /** Tilt of the sheet, degrees about x and y, at the start and the end of the shot. */
  tilt: z.object({ fromX: z.number(), toX: z.number(), fromY: z.number(), toY: z.number() }),
  /** How far the sheet drifts back over the shot, in sheet widths. */
  driftBack: z.number().min(0).max(3),
  /** Length of the move in frames; defaults to the composition length. Set it when used inside a longer film. */
  durationInFrames: z.number().int().positive().optional(),
  /**
   * The Blender render of this slip (scripts/blender/printing_slip.py with the same title, rows, `at` and `frames` as
   * `unrollFrames`), played instead of the three.js sheet: real paper bend, thickness, torn edge and a moving light.
   */
  plate: plateSchema.optional(),
});

export type PrintingSlipProps = z.infer<typeof printingSlipSchema>;

const SHEET_W = 1.6;
const PX = 640;
const SEGMENTS = 160;

const drawSlip = (p: PrintingSlipProps, shown: number, length: number) => {
  const w = PX;
  const h = Math.round((PX * length) / SHEET_W);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const tooth = w / 28;
  ctx.fillStyle = p.paper;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h - tooth);
  for (let x = w; x > 0; x -= tooth) {
    ctx.lineTo(x - tooth / 2, h);
    ctx.lineTo(x - tooth, h - tooth);
  }
  ctx.closePath();
  ctx.fill();
  const m = w * 0.09;
  const headerPx = h * p.header;
  ctx.fillStyle = p.ink;
  ctx.textBaseline = "top";
  ctx.font = `700 ${w * 0.08}px ${primaryFont}`;
  ctx.fillText(p.title, m, headerPx * 0.32);
  ctx.globalAlpha = 0.55;
  ctx.font = `500 ${w * 0.046}px ${primaryFont}`;
  ctx.fillText(p.subtitle, m, headerPx * 0.32 + w * 0.09);
  ctx.globalAlpha = 1;
  const rowH = (h - headerPx - tooth * 2) / p.rows.length;
  ctx.textBaseline = "middle";
  for (let i = 0; i < shown; i++) {
    const row = p.rows[i]!;
    const y = headerPx + rowH * (i + 0.5);
    ctx.globalAlpha = 0.6;
    ctx.font = `500 ${w * 0.058}px ${primaryFont}`;
    ctx.textAlign = "left";
    ctx.fillText(row.label, m, y);
    ctx.globalAlpha = 1;
    ctx.font = `700 ${w * 0.066}px ${primaryFont}`;
    ctx.textAlign = "right";
    ctx.fillText(row.value, w - m, y);
  }
  ctx.textAlign = "left";
  return c;
};

const sheetLength = (rows: number) => SHEET_W * (0.9 + rows * 0.17);

const Sheet: React.FC<{ p: PrintingSlipProps; frame: number; fontReady: boolean }> = ({ p, frame, fontReady }) => {
  const length = sheetLength(p.rows.length);
  const unroll = slipUnroll(frame, { at: p.at, frames: p.frames });
  const shown = slipRowsShown(unroll, p.rows.length);
  const flat = length * slipFlat(unroll, p.header);
  const radius = SHEET_W * 0.07;
  const geometry = useMemo(() => new THREE.PlaneGeometry(SHEET_W, length, 1, SEGMENTS), [length]);
  const texture = useMemo(
    () => (fontReady ? canvasTexture(drawSlip(p, shown, length)) : null),
    [fontReady, p, shown, length],
  );
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const v = (1 - uv.getY(i)) * length;
    const { y, z } = curlPoint(v, flat, radius);
    pos.setY(i, y);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return (
    <group position={[0, length * 0.5, 0]}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          map={texture}
          color={texture ? "#ffffff" : p.paper}
          transparent
          alphaTest={0.5}
          roughness={0.62}
          metalness={0}
          side={THREE.FrontSide}
        />
      </mesh>
      <mesh geometry={geometry}>
        <meshStandardMaterial color={p.paper} roughness={0.7} side={THREE.BackSide} />
      </mesh>
    </group>
  );
};

export const PrintingSlip: React.FC<PrintingSlipProps> = (p) =>
  p.plate ? <PlateLayer plate={p.plate} background={p.background} /> : <PrintingSlipLive {...p} />;

const PrintingSlipLive: React.FC<PrintingSlipProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames: compositionFrames } = useVideoConfig();
  const duration = p.durationInFrames ?? compositionFrames;
  const fontReady = useFontReady(`700 64px ${primaryFont}`);
  const t = easeInOut(ramp(frame, 0, Math.max(1, duration - 1)));
  const deg = Math.PI / 180;
  const tan = Math.tan((16 * Math.PI) / 180);
  const distance = Math.max(
    (sheetLength(p.rows.length) * 1.12) / (2 * tan),
    (SHEET_W * 2.4) / (2 * tan * (width / height)),
  );
  const sheen = mix(-3, 3, ramp(frame, 0, Math.max(1, duration - 1)));
  return (
    <AbsoluteFill style={{ background: p.background }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera makeDefault position={[0, 0, distance]} fov={32} near={0.1} far={50} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[2, 3, 4]} intensity={1.6} />
        <pointLight position={[sheen, 1.2, 1.6]} intensity={6} distance={6} color="#ffffff" />
        <group
          position={[0, 0, -p.driftBack * SHEET_W * t]}
          rotation={[mix(p.tilt.fromX, p.tilt.toX, t) * deg, mix(p.tilt.fromY, p.tilt.toY, t) * deg, 0]}
        >
          <Sheet p={p} frame={frame} fontReady={fontReady} />
        </group>
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

export const printingSlipDefaults: PrintingSlipProps = {
  title: "Order summary",
  subtitle: "Printed the moment it ships",
  rows: [
    { label: "Studio plan", value: "$240" },
    { label: "Extra seats x3", value: "$90" },
    { label: "Render hours", value: "$64" },
    { label: "Storage", value: "$12" },
    { label: "Support", value: "$0" },
    { label: "Discount", value: "-$40" },
    { label: "Tax", value: "$31" },
    { label: "Total", value: "$397" },
  ],
  paper: "#f2f1ee",
  ink: "#111111",
  background: "#050505",
  at: 2,
  frames: POLYMARKET_SLIP.frames,
  header: 0.2,
  tilt: { fromX: -18, toX: -24, fromY: 16, toY: 24 },
  driftBack: 0.35,
};

/** Sound: a soft tick per printed row on the frame it arrives; the last one carries the weight. */
export const printingSlipCues = (p: PrintingSlipProps) =>
  slipRowFrames(p.rows.length, { frames: p.frames }).map((f, i, all) => ({
    frame: p.at + f,
    kind: "type" as const,
    sfx: "tick" as const,
    weight: (i === all.length - 1 ? "hero" : "support") as "hero" | "support",
    label: `row ${i + 1}`,
  }));
