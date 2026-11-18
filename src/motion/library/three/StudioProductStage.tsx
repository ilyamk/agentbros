import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { ContactShadows, Environment, PerspectiveCamera, RoundedBox, useGLTF } from "@react-three/drei";
import { AbsoluteFill, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import {
  StudioEnvironment,
  canvasTexture,
  easeInOut,
  fitDistance,
  mix,
  ramp,
  useFontReady,
  useImageTexture,
} from "./shared";
import { plateSchema } from "./plate-plan";
import { PlateLayer } from "./PlateLayer";
import { isoGrid, truckOffset } from "./three-plan";

export const studioProductStageSchema = z.object({
  /** Screen image: a `staticFile` name (e.g. "images/app.png") or a URL. Empty draws a procedural screen. */
  screenImage: z.string(),
  /** phone and laptop are real models (public/shared/3d); card is a primitive slab. */
  shape: z.enum(["phone", "laptop", "card"]),
  /** Studio HDRI for reflections (public/shared/hdri). Empty uses the built-in softbox environment. */
  hdri: z.enum(["", "studio", "softbox", "warm", "loft"]).optional(),
  headline: z.string(),
  subline: z.string(),
  bodyColour: z.string(),
  accent: z.string(),
  background: z.string(),
  /** Turntable sweep in degrees across the shot. */
  orbitDegrees: z.number().min(0).max(360),
  /** Length of the move in frames; defaults to the composition length. Set it when used inside a longer film. */
  durationInFrames: z.number().int().positive().optional(),
  /** Colour of the studio edge the background falls off to. */
  ground: z.string().optional(),
  /** Share of the frame the product fills at the end of the dolly (default 0.74; ~0.9 for a hero close-up). */
  fill: z.number().min(0.3).max(1.2).optional(),
  /** Accent-coloured light pool on the floor and accent back light (0..1). Off by default: it tints light grounds and the screen. */
  glow: z.number().min(0).max(1).optional(),
  /** `single` (default) is the hero turntable; `array` lays copies flat in an isometric grid and trucks across them (cashfree). */
  layout: z.enum(["single", "array"]).optional(),
  /**
   * Array layout only: the Blender render of the array (scripts/blender/device_array.py with the same columns, rows,
   * screens and truck), played instead of the three.js grid: real glass, metal and contact shadows on every copy.
   */
  plate: plateSchema.optional(),
  /** Array: grid size, one screen per device (cycled; empty strings draw the procedural screen), spacing in device widths. */
  array: z
    .object({
      columns: z.number().int().min(1).max(8),
      rows: z.number().int().min(1).max(8),
      screens: z.array(z.string()),
      spacing: z.number().min(1).max(4).optional(),
    })
    .optional(),
});

export type StudioProductStageProps = z.infer<typeof studioProductStageSchema>;

const SHAPES = {
  phone: { w: 1.51, h: 3.1, d: 0.24, r: 0.08, screenInset: 0.08 },
  laptop: { w: 3.4, h: 2.28, d: 3.2, r: 0, screenInset: 0 },
  card: { w: 3.2, h: 2.0, d: 0.06, r: 0.028, screenInset: 0.05 },
} as const;

/** Normalised GLBs from scripts/blender/prepare_devices.py: metres, display named "screen" with 0..1 UVs. */
const MODELS = {
  phone: { file: "shared/3d/phone.glb", metres: 0.1596, axis: "y" },
  laptop: { file: "shared/3d/laptop.glb", metres: 0.3557, axis: "x" },
} as const;

const HDRIS = {
  studio: "shared/hdri/studio_small_09_2k.hdr",
  softbox: "shared/hdri/studio_small_08_2k.hdr",
  warm: "shared/hdri/brown_photostudio_02_2k.hdr",
  loft: "shared/hdri/photo_studio_loft_hall_2k.hdr",
} as const;

const roundedRectGeometry = (w: number, h: number, r: number) => {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ShapeGeometry(shape, 12);
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i += 1) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geometry;
};

const drawScreen = (w: number, h: number, headline: string, subline: string, accent: string, glowAmount: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, "#101014");
  bg.addColorStop(1, "#050506");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (glowAmount > 0) {
    const glow = ctx.createRadialGradient(w * 0.75, h * 0.18, 0, w * 0.75, h * 0.18, w * 0.9);
    glow.addColorStop(0, `${accent}cc`);
    glow.addColorStop(0.45, `${accent}22`);
    glow.addColorStop(1, "#00000000");
    ctx.globalAlpha = glowAmount;
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  const u = Math.min(w, h) / 100;
  ctx.fillStyle = "#f5f5f7";
  ctx.font = `700 ${u * 11}px ${primaryFont}`;
  ctx.textBaseline = "top";
  const words = headline.split(" ");
  let line = "";
  let y = h * 0.42;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > w * 0.82 && line) {
      ctx.fillText(line, w * 0.09, y);
      y += u * 12.5;
      line = word;
    } else line = test;
  }
  ctx.fillText(line, w * 0.09, y);
  ctx.fillStyle = "#f5f5f7a0";
  ctx.font = `500 ${u * 4.6}px ${primaryFont}`;
  ctx.fillText(subline, w * 0.09, y + u * 16);
  ctx.fillStyle = accent;
  const bw = w * 0.42;
  const bh = u * 11;
  const by = Math.max(h - u * 26, y + u * 26);
  ctx.beginPath();
  ctx.roundRect(w * 0.09, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = "#0a0a0c";
  ctx.font = `600 ${u * 4.4}px ${primaryFont}`;
  ctx.textBaseline = "middle";
  ctx.fillText("Get started", w * 0.09 + u * 5, by + bh / 2);
  for (let i = 0; i < 3; i += 1) {
    ctx.fillStyle = `rgba(255,255,255,${0.08 + i * 0.04})`;
    ctx.beginPath();
    ctx.roundRect(w * 0.09 + i * w * 0.15, h * 0.1, w * 0.12, w * 0.12, w * 0.03);
    ctx.fill();
  }
  return canvas;
};

const Device: React.FC<{ shape: "phone" | "laptop"; screen: THREE.Texture | null; bodyColour: string }> = ({
  shape,
  screen,
  bodyColour,
}) => {
  const model = MODELS[shape];
  const gltf = useGLTF(staticFile(model.file));
  const scene = useMemo(() => {
    const copy = gltf.scene.clone(true);
    copy.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      if (mesh.name === "screen") {
        mesh.material = new THREE.MeshPhysicalMaterial({
          color: screen ? "#000000" : "#050506",
          emissive: "#ffffff",
          emissiveMap: screen,
          emissiveIntensity: screen ? 1 : 0,
          roughness: shape === "phone" ? 0.06 : 0.25,
          specularIntensity: shape === "phone" ? 0.5 : 0.08,
          clearcoat: shape === "phone" ? 0.6 : 0,
          clearcoatRoughness: 0.05,
          envMapIntensity: 0.25,
        });
      } else if (bodyColour && shape === "phone") {
        const material = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (material.metalness > 0.9) material.color = new THREE.Color(bodyColour).multiplyScalar(1.4);
        mesh.material = material;
      }
    });
    const box = new THREE.Box3().setFromObject(copy);
    copy.position.sub(box.getCenter(new THREE.Vector3()));
    return copy;
  }, [gltf.scene, screen, bodyColour, shape]);
  const size = SHAPES[shape];
  const scale = (model.axis === "y" ? size.h : size.w) / model.metres;
  return (
    <group scale={scale}>
      <primitive object={scene} />
    </group>
  );
};

const Hero: React.FC<StudioProductStageProps & { fontReady: boolean }> = (p) => {
  const s = SHAPES[p.shape];
  const image = useImageTexture(p.screenImage || undefined);
  const screen = useMemo(() => {
    if (image && p.shape !== "card") {
      const glb = image.clone();
      glb.flipY = false;
      glb.needsUpdate = true;
      return glb;
    }
    if (image || !p.fontReady) return image;
    const scale = 640;
    const texture = canvasTexture(
      drawScreen(Math.round(s.w * scale), Math.round(s.h * scale), p.headline, p.subline, p.accent, p.glow ?? 0),
    );
    if (p.shape !== "card") texture.flipY = false;
    return texture;
  }, [image, p.fontReady, p.headline, p.subline, p.accent, p.glow, s.w, s.h, p.shape]);
  const sw = s.w - s.screenInset * 2;
  const sh = s.h - s.screenInset * 2;
  const screenGeometry = useMemo(() => roundedRectGeometry(sw, sh, 0.05), [sw, sh]);
  if (p.shape !== "card") return <Device shape={p.shape} screen={screen} bodyColour={p.bodyColour} />;
  return (
    <group>
      <RoundedBox args={[s.w, s.h, s.d]} radius={s.r} smoothness={8} castShadow>
        <meshPhysicalMaterial
          color={p.bodyColour}
          metalness={1}
          roughness={0.22}
          clearcoat={1}
          clearcoatRoughness={0.1}
          envMapIntensity={1.6}
        />
      </RoundedBox>
      <mesh position={[0, 0, s.d / 2 + 0.002]}>
        <primitive object={screenGeometry} attach="geometry" />
        <meshPhysicalMaterial
          map={screen}
          color={screen ? "#ffffff" : "#0b0b0d"}
          roughness={0.2}
          metalness={0}
          clearcoat={0.5}
          clearcoatRoughness={0.08}
          envMapIntensity={0.35}
          emissive="#ffffff"
          emissiveMap={screen}
          emissiveIntensity={0.55}
        />
      </mesh>
    </group>
  );
};

/** Isometric camera: 45 degrees round, 35.26 degrees down, so every device in the grid is seen the same way. */
const ISO = new THREE.Euler(-Math.atan(1 / Math.SQRT2), Math.PI / 4, 0, "YXZ");

const DeviceArray: React.FC<StudioProductStageProps> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = props.durationInFrames ?? compositionFrames;
  const fontReady = useFontReady(`700 64px ${primaryFont}`);
  const array = props.array ?? { columns: 3, rows: 3, screens: [""] };
  const s = SHAPES[props.shape];
  const spacing = (array.spacing ?? 1.35) * Math.max(s.w, s.h);
  const cells = isoGrid(array.columns, array.rows, spacing);
  const aspect = width / height;
  const fov = 20;
  const extent = Math.max(array.columns, array.rows) * spacing;
  const distance = fitDistance(aspect, extent * 0.9, extent * 0.7, fov, props.fill ?? 0.9);
  const visibleH = 2 * distance * Math.tan((fov * Math.PI) / 360);
  const truck = truckOffset(frame, durationInFrames);
  const screens = array.screens.length ? array.screens : [""];
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 50% 40%, ${props.background} 0%, ${props.ground ?? props.background} 80%)`,
      }}
    >
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }} shadows>
        <group rotation={ISO}>
          <PerspectiveCamera
            makeDefault
            position={[truck.x * visibleH * aspect, -truck.y * visibleH, distance]}
            fov={fov}
            near={0.1}
            far={distance * 4}
          />
        </group>
        {props.hdri ? (
          <Environment files={staticFile(HDRIS[props.hdri])} environmentIntensity={1.1} />
        ) : (
          <StudioEnvironment intensity={1.4} />
        )}
        <ambientLight intensity={0.35} />
        <directionalLight position={[4, 10, 3]} intensity={1.6} castShadow />
        {cells.map((cell) => (
          <group key={cell.index} position={[cell.x, 0, cell.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <Hero {...props} screenImage={screens[cell.index % screens.length]!} fontReady={fontReady} />
          </group>
        ))}
        <ContactShadows
          position={[0, -s.d, 0]}
          opacity={0.35}
          scale={extent * 2}
          blur={2.4}
          far={2}
          resolution={512}
          color="#000000"
        />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

export const StudioProductStage: React.FC<StudioProductStageProps> = (props) =>
  props.layout === "array" ? (
    props.plate ? (
      <PlateLayer plate={props.plate} background={props.ground ?? props.background} />
    ) : (
      <DeviceArray {...props} />
    )
  ) : (
    <SingleStage {...props} />
  );

const SingleStage: React.FC<StudioProductStageProps> = (props) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = props.durationInFrames ?? compositionFrames;
  const fontReady = useFontReady(`700 64px ${primaryFont}`);
  const s = SHAPES[props.shape];
  const aspect = width / height;
  const fov = 30;
  const base = fitDistance(aspect, s.w * 1.1, s.h * 1.05, fov, props.fill ?? (props.shape === "laptop" ? 0.52 : 0.74));
  const t = ramp(frame, 0, durationInFrames - 1);
  const dolly = easeInOut(t);
  const camZ = mix(base * 1.28, base * 0.98, dolly);
  const camY = mix(0.9, 0.25, dolly);
  const rise = spring({ frame, fps, config: { damping: 26, stiffness: 70, mass: 1.2 } });
  const orbit = (props.orbitDegrees * Math.PI) / 180;
  const turn = mix(-orbit * 0.6, orbit * 0.4, easeInOut(ramp(frame, 0, durationInFrames - 1)));
  const lift = mix(-0.6, 0, rise);
  const floorY = -(props.shape === "laptop" ? s.h * 0.5 : s.h / 2) - 0.35;
  const glow = props.glow ?? 0;
  const pool = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, props.accent);
      g.addColorStop(0.35, `${props.accent}55`);
      g.addColorStop(1, `${props.accent}00`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
    }
    return canvasTexture(c);
  }, [props.accent]);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 80% at 50% 38%, ${props.background} 0%, ${props.ground ?? "#050507"} 70%)`,
      }}
    >
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }} shadows>
        <PerspectiveCamera
          makeDefault
          position={[0, camY, camZ]}
          fov={fov}
          near={0.1}
          far={100}
          onUpdate={(c) => c.lookAt(0, 0, 0)}
        />
        {props.hdri ? (
          <Environment files={staticFile(HDRIS[props.hdri])} environmentIntensity={1.2} />
        ) : (
          <StudioEnvironment intensity={1.6} />
        )}
        <ambientLight intensity={0.15} />
        <spotLight position={[4, 6, 5]} angle={0.4} penumbra={1} intensity={60} color="#fff3e2" castShadow />
        <directionalLight position={[-5, 2, 2]} intensity={1.4} color="#cfd9ff" />
        <spotLight position={[-3, 1, -4]} angle={0.5} penumbra={1} intensity={90} color="#ffffff" />
        {glow > 0 ? (
          <spotLight position={[0, 4, -6]} angle={0.6} penumbra={1} intensity={80 * glow} color={props.accent} />
        ) : null}
        <group position={[0, lift, 0]} rotation={[mix(0.18, 0.04, rise), turn, mix(-0.12, 0, rise)]}>
          <Hero {...props} fontReady={fontReady} />
        </group>
        {glow > 0 ? (
          <mesh position={[0, floorY - 0.01, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[9, 9]} />
            <meshBasicMaterial map={pool} transparent opacity={0.55 * rise * glow} depthWrite={false} />
          </mesh>
        ) : null}
        <ContactShadows
          position={[0, floorY, 0]}
          opacity={0.75 * rise}
          scale={8}
          blur={2.6}
          far={4}
          resolution={512}
          color="#000000"
        />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
