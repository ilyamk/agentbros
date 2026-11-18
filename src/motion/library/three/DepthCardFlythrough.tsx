import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { PerspectiveCamera, RoundedBox } from "@react-three/drei";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { StudioEnvironment, canvasTexture, easeInOut, mix, ramp, useFontReady, useImageTexture } from "./shared";
import { plateSchema } from "./plate-plan";
import { PlateLayer } from "./PlateLayer";
import { FLEX_FAN, fanAngles } from "./three-plan";

const cardSchema = z.object({
  title: z.string(),
  label: z.string(),
  /** Optional `staticFile` name or URL; empty draws a procedural card. */
  image: z.string(),
  colour: z.string(),
});

export const depthCardFlythroughSchema = z.object({
  cards: z.array(cardSchema).min(2).max(12),
  /** Distance between cards along the camera path. */
  spacing: z.number().min(1).max(8),
  background: z.string(),
  /** Length of the move in frames; defaults to the composition length. Set it when used inside a longer film. */
  durationInFrames: z.number().int().positive().optional(),
  /** `fly` (default) flies past the cards; `fan` holds the first card and fans `fan.copies` copies of it about one corner. */
  mode: z.enum(["fly", "fan"]).optional(),
  /** Fan (flex): copies, total spread in degrees, frames for the whole fan (sine.inOut), per-copy delay, first frame. */
  fan: z
    .object({
      copies: z.number().int().min(2).max(24),
      spread: z.number().min(5).max(180),
      frames: z.number().int().min(2),
      delay: z.number().min(0).max(10),
      at: z.number().int().min(0),
    })
    .optional(),
  /**
   * Fan mode only: the Blender render of the fan (scripts/blender/card_fan.py with the same copies, spread, frames as
   * `fanFrames`, delay and at), played instead of the three.js stack: brushed metal, specular sweep, depth of field.
   */
  plate: plateSchema.optional(),
});

export type DepthCardFlythroughProps = z.infer<typeof depthCardFlythroughSchema>;
type Card = z.infer<typeof cardSchema>;

const CARD_W = 2.4;
const CARD_H = 1.5;

const drawCard = (card: Card, index: number) => {
  const w = 960;
  const h = 600;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = "#0d0e12";
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w * 0.85, h * 0.1, 0, w * 0.85, h * 0.1, w);
  g.addColorStop(0, `${card.colour}ee`);
  g.addColorStop(0.5, `${card.colour}33`);
  g.addColorStop(1, `${card.colour}00`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 2;
  for (let x = 0; x < w; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `500 30px ${primaryFont}`;
  ctx.textBaseline = "top";
  ctx.fillText(`${String(index + 1).padStart(2, "0")}  ${card.label.toUpperCase()}`, 56, 52);
  ctx.fillStyle = "#f4f4f6";
  ctx.font = `700 92px ${primaryFont}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(card.title, 52, h - 64);
  return c;
};

const CardMesh: React.FC<{ card: Card; index: number; fontReady: boolean }> = ({ card, index, fontReady }) => {
  const image = useImageTexture(card.image || undefined);
  const texture = useMemo(
    () => image ?? (fontReady ? canvasTexture(drawCard(card, index)) : null),
    [image, fontReady, card, index],
  );
  return (
    <group>
      <RoundedBox args={[CARD_W + 0.06, CARD_H + 0.06, 0.04]} radius={0.06} smoothness={4}>
        <meshPhysicalMaterial color="#1b1c22" metalness={0.6} roughness={0.25} clearcoat={1} />
      </RoundedBox>
      <mesh position={[0, 0, 0.022]}>
        <planeGeometry args={[CARD_W, CARD_H]} />
        <meshStandardMaterial
          map={texture}
          roughness={0.35}
          metalness={0}
          emissive="#ffffff"
          emissiveMap={texture}
          emissiveIntensity={0.35}
        />
      </mesh>
    </group>
  );
};

/** Fan defaults (flex t06): a dozen copies over 53 frames, 2 frames apart. */
export const FAN_DEFAULTS = {
  copies: FLEX_FAN.copies,
  spread: 70,
  frames: FLEX_FAN.frames,
  delay: FLEX_FAN.delay,
  at: 0,
} as const;

const FanStack: React.FC<DepthCardFlythroughProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fontReady = useFontReady(`700 92px ${primaryFont}`);
  const fan = { ...FAN_DEFAULTS, ...p.fan };
  const angles = fanAngles(frame, fan);
  const vertical = width < height;
  const settle = easeInOut(ramp(frame, fan.at, fan.at + fan.frames));
  // The pivot is the card's bottom-left corner; the stack sits so the open fan is centred.
  const pivot: [number, number] = [-CARD_W * 0.42, -CARD_H * (vertical ? 0.2 : 0.62)];
  return (
    <AbsoluteFill style={{ background: `radial-gradient(100% 80% at 50% 40%, ${p.background} 0%, #030304 80%)` }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera
          makeDefault
          position={[mix(0.6, 0.2, settle), mix(-0.3, 0, settle), vertical ? 7.4 : 5.6]}
          fov={vertical ? 50 : 40}
          near={0.1}
          far={50}
          onUpdate={(c) => c.lookAt(0, 0, 0)}
        />
        <StudioEnvironment intensity={0.9} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[3, 4, 5]} intensity={1.2} />
        <group position={[pivot[0], pivot[1], 0]} rotation={[-0.18, 0.28, 0]}>
          {angles.map((angle, i) => (
            <group key={i} position={[0, 0, i * 0.012]} rotation={[0, 0, (angle * Math.PI) / 180]}>
              <group position={[CARD_W / 2, CARD_H / 2, 0]}>
                <CardMesh card={p.cards[0]!} index={0} fontReady={fontReady} />
              </group>
            </group>
          ))}
        </group>
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

export const DepthCardFlythrough: React.FC<DepthCardFlythroughProps> = (p) =>
  p.mode === "fan" ? (
    p.plate ? (
      <PlateLayer plate={p.plate} background={p.background} />
    ) : (
      <FanStack {...p} />
    )
  ) : (
    <FlyThrough {...p} />
  );

const FlyThrough: React.FC<DepthCardFlythroughProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = p.durationInFrames ?? compositionFrames;
  const fontReady = useFontReady(`700 92px ${primaryFont}`);
  const aspect = width / height;
  const vertical = aspect < 1;
  const n = p.cards.length;
  const lateral = vertical ? 0.55 : 1.5;
  const layout = p.cards.map((_, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    return {
      x: i === n - 1 ? 0 : side * lateral * (0.7 + ((i * 37) % 5) * 0.08),
      y: i === n - 1 ? 0 : (((i * 53) % 7) / 7 - 0.5) * (vertical ? 1.6 : 0.8),
      z: -i * p.spacing,
      ry: i === n - 1 ? 0 : -side * 0.32,
    };
  });
  const travel = easeInOut(ramp(frame, 0, durationInFrames - 12));
  const viewDist = vertical ? 4.6 : 3.4;
  const lastZ = layout[n - 1].z;
  const camZ = mix(viewDist + 2.5, lastZ + viewDist, travel);
  const camX = Math.sin(travel * Math.PI * 1.2) * (vertical ? 0.2 : 0.45) * (1 - travel);
  const passing = (i: number) => {
    if (i === n - 1) return 0;
    const near = 1 - (camZ - layout[i].z) / (p.spacing * 1.2);
    return Math.sign(layout[i].x || 1) * easeInOut(near) * (vertical ? 2.4 : 3);
  };
  return (
    <AbsoluteFill style={{ background: `radial-gradient(100% 80% at 50% 40%, ${p.background} 0%, #030304 80%)` }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera
          makeDefault
          position={[camX, 0.15, camZ]}
          rotation={[-0.03, camX * 0.08, 0]}
          fov={vertical ? 58 : 42}
          near={0.1}
          far={200}
        />
        <fog attach="fog" args={["#050507", p.spacing * 2.5, p.spacing * 5]} />
        <StudioEnvironment intensity={0.9} />
        <ambientLight intensity={0.25} />
        <directionalLight position={[3, 4, 5]} intensity={1.2} />
        {p.cards.map((card, i) => (
          <group
            key={`${card.title}-${i}`}
            position={[layout[i].x + passing(i), layout[i].y, layout[i].z]}
            rotation={[0, layout[i].ry, 0]}
          >
            <CardMesh card={card} index={i} fontReady={fontReady} />
          </group>
        ))}
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
