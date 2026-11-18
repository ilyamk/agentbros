import React, { useEffect, useState } from "react";
import { Environment, Lightformer } from "@react-three/drei";
import { continueRender, delayRender, staticFile } from "remotion";
import * as THREE from "three";

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const ramp = (frame: number, start: number, end: number) => clamp01((frame - start) / (end - start));

/** Distance at which an object of the given size fills `fill` of the frame, for either aspect. */
export const fitDistance = (aspect: number, objectWidth: number, objectHeight: number, fovDeg: number, fill = 0.7) => {
  const tan = Math.tan((fovDeg * Math.PI) / 360);
  const byHeight = objectHeight / (2 * tan * fill);
  const byWidth = objectWidth / (2 * tan * aspect * fill);
  return Math.max(byHeight, byWidth);
};

/** Resolves a `staticFile` name or an absolute/data URL. */
export const resolveAsset = (src: string) => (/^(https?:|data:|\/)/.test(src) ? src : staticFile(src));

/** Holds the render until a web font face is ready, so canvases never rasterise a fallback face. */
export const useFontReady = (font: string) => {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender(`Font ${font}`));
  useEffect(() => {
    let live = true;
    document.fonts
      .load(font)
      .catch(() => undefined)
      .then(() => {
        if (!live) return;
        setReady(true);
        continueRender(handle);
      });
    return () => {
      live = false;
    };
  }, [font, handle]);
  return ready;
};

/** Loads an image texture through delayRender; returns null while loading or when no source is given. */
export const useImageTexture = (src: string | undefined) => {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  const [handle] = useState(() => (src ? delayRender(`Texture ${src}`) : null));
  useEffect(() => {
    if (!src || handle === null) return;
    new THREE.TextureLoader().load(
      resolveAsset(src),
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        setTexture(tex);
        continueRender(handle);
      },
      undefined,
      () => continueRender(handle),
    );
  }, [src, handle]);
  return texture;
};

export const canvasTexture = (canvas: HTMLCanvasElement) => {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
};

/**
 * Offline studio reflections: softboxes as Lightformers rendered into a cube map. No HDRI download.
 * `sweep` (0..1) moves a narrow strip across the reflections; pass a frame-driven value with `live`.
 */
export const StudioEnvironment: React.FC<{ sweep?: number; live?: boolean; warmth?: string; intensity?: number }> = ({
  sweep = 0.5,
  live = false,
  warmth = "#fff4e6",
  intensity = 1,
}) => (
  <Environment resolution={256} frames={live ? Infinity : 1}>
    <color attach="background" args={["#050507"]} />
    <Lightformer
      form="rect"
      intensity={3 * intensity}
      color={warmth}
      position={[0, 5, -2]}
      rotation-x={Math.PI / 2}
      scale={[10, 4, 1]}
    />
    <Lightformer
      form="rect"
      intensity={2 * intensity}
      position={[-5, 1, 1]}
      rotation-y={Math.PI / 2}
      scale={[8, 2.2, 1]}
    />
    <Lightformer
      form="rect"
      intensity={1.2 * intensity}
      color="#dfe8ff"
      position={[5, 0.5, 0]}
      rotation-y={-Math.PI / 2}
      scale={[6, 1.2, 1]}
    />
    <Lightformer
      form="rect"
      intensity={0.5 * intensity}
      color="#e9ecf5"
      position={[-3, 3, 7]}
      rotation-y={Math.PI}
      scale={[5, 3, 1]}
    />
    <Lightformer form="ring" intensity={1.5 * intensity} position={[2, 2.5, 5]} scale={1.6} />
    <Lightformer
      form="rect"
      intensity={6 * intensity}
      position={[mix(-7, 7, sweep), 0.5, 4]}
      rotation-y={Math.PI}
      scale={[0.5, 12, 1]}
    />
  </Environment>
);
