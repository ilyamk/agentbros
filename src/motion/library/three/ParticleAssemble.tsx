import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { PerspectiveCamera } from "@react-three/drei";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { z } from "zod";
import { displayFont } from "../../../lib/fonts";
import { canvasTexture, clamp01, easeInOut, mix, ramp, useFontReady } from "./shared";

export const particleAssembleSchema = z.object({
  word: z.string().min(1),
  count: z.number().int().min(2000).max(60000),
  colourA: z.string(),
  colourB: z.string(),
  background: z.string(),
  seed: z.string(),
  /** Frame by which every particle has landed. */
  landFrame: z.number().int().min(20),
  /** Length of the move in frames; defaults to the composition length. Set it when used inside a longer film. */
  durationInFrames: z.number().int().positive().optional(),
});

export type ParticleAssembleProps = z.infer<typeof particleAssembleSchema>;

const sampleWord = (word: string, count: number, seed: string, aspect: number) => {
  const w = 1600;
  const h = 600;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new Float32Array(count * 3);
  let size = 420;
  ctx.font = `700 ${size}px ${displayFont}`;
  const measured = ctx.measureText(word).width;
  size = Math.min(size, (size * w * 0.92) / measured);
  ctx.font = `700 ${size}px ${displayFont}`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(word, w / 2, h / 2);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const filled: number[] = [];
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) if (pixels[(y * w + x) * 4 + 3] > 128) filled.push(x, y);
  const out = new Float32Array(count * 3);
  const n = filled.length / 2;
  const span = aspect < 1 ? 3.2 : 6;
  for (let i = 0; i < count; i += 1) {
    const k = Math.floor(random(`${seed}-pick-${i}`) * n) * 2;
    const jx = (random(`${seed}-jx-${i}`) - 0.5) * 2;
    const jy = (random(`${seed}-jy-${i}`) - 0.5) * 2;
    out[i * 3] = ((filled[k] + jx - w / 2) / w) * span;
    out[i * 3 + 1] = (-(filled[k + 1] + jy - h / 2) / w) * span;
    out[i * 3 + 2] = (random(`${seed}-jz-${i}`) - 0.5) * 0.06;
  }
  return out;
};

const dotTexture = () => {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return canvasTexture(c);
};

const Field: React.FC<ParticleAssembleProps & { aspect: number }> = (p) => {
  const frame = useCurrentFrame();
  const { durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = p.durationInFrames ?? compositionFrames;
  const targets = useMemo(() => sampleWord(p.word, p.count, p.seed, p.aspect), [p.word, p.count, p.seed, p.aspect]);
  const seeds = useMemo(() => {
    const s = new Float32Array(p.count * 5);
    for (let i = 0; i < p.count; i += 1) {
      s[i * 5] = random(`${p.seed}-r-${i}`);
      s[i * 5 + 1] = random(`${p.seed}-a-${i}`) * Math.PI * 2;
      s[i * 5 + 2] = random(`${p.seed}-y-${i}`) - 0.5;
      s[i * 5 + 3] = random(`${p.seed}-d-${i}`);
      s[i * 5 + 4] = random(`${p.seed}-p-${i}`) * Math.PI * 2;
    }
    return s;
  }, [p.count, p.seed]);
  const sprite = useMemo(dotTexture, []);
  const colourA = useMemo(() => new THREE.Color(p.colourA), [p.colourA]);
  const colourB = useMemo(() => new THREE.Color(p.colourB), [p.colourB]);
  const { positions, colours } = useMemo(() => {
    const pos = new Float32Array(p.count * 3);
    const col = new Float32Array(p.count * 3);
    const span = p.aspect < 1 ? 3.2 : 6;
    const tmp = new THREE.Color();
    const shimmerX = mix(-span * 0.7, span * 0.7, ramp(frame, p.landFrame, durationInFrames - 1));
    for (let i = 0; i < p.count; i += 1) {
      const r = seeds[i * 5];
      const a = seeds[i * 5 + 1];
      const yy = seeds[i * 5 + 2];
      const delay = seeds[i * 5 + 3];
      const phase = seeds[i * 5 + 4];
      const tx = targets[i * 3];
      const ty = targets[i * 3 + 1];
      const tz = targets[i * 3 + 2];
      const start = 4 + delay * (p.landFrame * 0.45);
      const t = easeInOut(ramp(frame, start, start + p.landFrame * 0.55));
      const radius = 1.2 + r * r * 5.5;
      const swirl = a + frame * 0.012 * (1.6 - r) + t * 1.4;
      const cx = Math.cos(swirl) * radius;
      const cz = Math.sin(swirl) * radius * 0.7 - 1.2;
      const cy = yy * 1.4 * (0.4 + r) + Math.sin(swirl * 2 + phase) * 0.15;
      const wobble = (1 - t) * 0.12;
      pos[i * 3] = mix(cx, tx, t) + Math.sin(frame * 0.05 + phase) * wobble;
      pos[i * 3 + 1] = mix(cy, ty, t) + Math.cos(frame * 0.043 + phase) * wobble;
      pos[i * 3 + 2] = mix(cz, tz, t);
      const along = clamp01(tx / span + 0.5);
      tmp.copy(colourA).lerp(colourB, along);
      const flash = Math.exp(-(((tx - shimmerX) / 0.35) ** 2)) * t;
      const energy = mix(0.55, 1, t) + flash * 1.4;
      col[i * 3] = tmp.r * energy;
      col[i * 3 + 1] = tmp.g * energy;
      col[i * 3 + 2] = tmp.b * energy;
    }
    return { positions: pos, colours: col };
  }, [frame, seeds, targets, p.count, p.aspect, p.landFrame, colourA, colourB, durationInFrames]);
  return (
    <points key={p.count}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colours, 3]} />
      </bufferGeometry>
      <pointsMaterial
        map={sprite}
        size={p.aspect < 1 ? 0.034 : 0.04}
        sizeAttenuation
        vertexColors
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
};

export const ParticleAssemble: React.FC<ParticleAssembleProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = p.durationInFrames ?? compositionFrames;
  const ready = useFontReady(`700 200px ${displayFont}`);
  const aspect = width / height;
  const push = easeInOut(ramp(frame, 0, durationInFrames - 1));
  const camZ = mix(aspect < 1 ? 9.5 : 7.8, aspect < 1 ? 8.2 : 6.6, push);
  const orbit = mix(0.5, 0, easeInOut(ramp(frame, 0, p.landFrame + 10)));
  return (
    <AbsoluteFill style={{ background: `radial-gradient(80% 60% at 50% 50%, ${p.background} 0%, #020203 80%)` }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera
          makeDefault
          position={[Math.sin(orbit) * camZ, mix(1.2, 0, push), Math.cos(orbit) * camZ]}
          fov={35}
          near={0.1}
          far={100}
          onUpdate={(c) => c.lookAt(0, 0, 0)}
        />
        {ready ? <Field {...p} aspect={aspect} /> : null}
      </ThreeCanvas>
    </AbsoluteFill>
  );
};
