import React, { useMemo } from "react";
import { ThreeCanvas } from "@remotion/three";
import { ContactShadows, Environment, Lightformer, PerspectiveCamera } from "@react-three/drei";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { z } from "zod";
import { displayFont } from "../../../lib/fonts";
import { easeInOut, fitDistance, mix, ramp } from "./shared";

export const extrudedMarkSchema = z.object({
  /** One or more SVG path `d` strings, drawn in a square viewBox of `viewBox` units, y down. */
  paths: z.array(z.string()).min(1),
  viewBox: z.number().positive(),
  finish: z.enum(["chrome", "gold", "graphite", "glass"]),
  /** Depth of the extrusion as a fraction of the mark's width. */
  depth: z.number().min(0.02).max(0.5),
  wordmark: z.string(),
  background: z.string(),
  accent: z.string(),
  /** Length of the move in frames; defaults to the composition length. Set it when used inside a longer film. */
  durationInFrames: z.number().int().positive().optional(),
  /** Colour of the studio edge the background falls off to. */
  ground: z.string().optional(),
});

export type ExtrudedMarkProps = z.infer<typeof extrudedMarkSchema>;

const FINISHES = {
  chrome: { color: "#e8eaee", metalness: 1, roughness: 0.16, transmission: 0 },
  gold: { color: "#e2b866", metalness: 1, roughness: 0.2, transmission: 0 },
  graphite: { color: "#3a3b40", metalness: 0.9, roughness: 0.32, transmission: 0 },
  glass: { color: "#ffffff", metalness: 0, roughness: 0.04, transmission: 1 },
} as const;

/** Chrome needs contrast: thin bright strips on black, so bevels and faces pick up hard-edged bands. */
const StripEnvironment: React.FC<{ sweep: number; accent: string }> = ({ sweep, accent }) => (
  <Environment resolution={256} frames={Infinity}>
    <color attach="background" args={["#000000"]} />
    {[-6, -2.5, 1.5, 5].map((x, i) => (
      <Lightformer
        key={x}
        form="rect"
        intensity={i % 2 ? 2.2 : 3.5}
        position={[x, 0, 6]}
        rotation-y={Math.PI}
        scale={[0.35 + (i % 2) * 0.5, 14, 1]}
      />
    ))}
    <Lightformer form="rect" intensity={4} position={[0, 6, 2]} rotation-x={Math.PI / 2} scale={[14, 0.6, 1]} />
    <Lightformer
      form="rect"
      intensity={1.2}
      color={accent}
      position={[0, -5, 3]}
      rotation-x={-Math.PI / 2}
      scale={[14, 1.2, 1]}
    />
    <Lightformer form="rect" intensity={2.5} position={[-6, 1, -2]} rotation-y={Math.PI / 2} scale={[6, 0.4, 1]} />
    <Lightformer
      form="rect"
      intensity={2.5}
      color="#cfe0ff"
      position={[6, -1, -2]}
      rotation-y={-Math.PI / 2}
      scale={[6, 0.4, 1]}
    />
    <Lightformer
      form="rect"
      intensity={9}
      position={[mix(-9, 9, sweep), 0, 5.5]}
      rotation-y={Math.PI}
      rotation-z={0.35}
      scale={[1.6, 16, 1]}
    />
  </Environment>
);

const useMarkGeometry = (paths: string[], viewBox: number, depth: number) =>
  useMemo(() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
    const data = new SVGLoader().parse(svg);
    const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p));
    const size = 2 / viewBox;
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: depth * viewBox,
      bevelEnabled: true,
      bevelThickness: viewBox * 0.012,
      bevelSize: viewBox * 0.01,
      bevelSegments: 6,
      curveSegments: 24,
    });
    geometry.center();
    geometry.scale(size, -size, -size);
    geometry.computeVertexNormals();
    return geometry;
  }, [paths, viewBox, depth]);

export const ExtrudedMark: React.FC<ExtrudedMarkProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames: compositionFrames } = useVideoConfig();
  const durationInFrames = p.durationInFrames ?? compositionFrames;
  const geometry = useMarkGeometry(p.paths, p.viewBox, p.depth);
  const finish = FINISHES[p.finish];
  const fov = 28;
  const aspect = width / height;
  const dist = fitDistance(aspect, 2.2, 2.6, fov, 0.62);
  const settle = spring({ frame: frame - 4, fps, config: { damping: 18, stiffness: 55, mass: 1.3 } });
  const rotY = mix(-Math.PI * 0.85, -0.22, settle);
  const rotX = mix(0.6, 0.1, settle);
  const scale = mix(0.55, 1, settle);
  const sweep = easeInOut(ramp(frame, 40, durationInFrames - 15));
  const camZ = mix(dist * 1.08, dist * 0.96, easeInOut(ramp(frame, 0, durationInFrames - 1)));
  const markY = p.wordmark ? 0.25 : 0;
  const word = interpolate(frame, [52, 78], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeInOut,
  });
  const wordSize = Math.min(width, height) * 0.05;
  return (
    <AbsoluteFill
      style={{ background: `radial-gradient(90% 70% at 50% 45%, ${p.background} 0%, ${p.ground ?? "#040405"} 75%)` }}
    >
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera
          makeDefault
          position={[0, 0.15, camZ]}
          fov={fov}
          near={0.1}
          far={100}
          onUpdate={(c) => c.lookAt(0, 0, 0)}
        />
        <StripEnvironment sweep={sweep} accent={p.accent} />
        <ambientLight intensity={0.1} />
        <pointLight position={[1.6, 1.4, 2.2]} intensity={14} distance={9} decay={2} color="#fff4e8" />
        <spotLight position={[-4, 2, -4]} angle={0.6} penumbra={1} intensity={160} color={p.accent} />
        <spotLight position={[4, -1, -3]} angle={0.6} penumbra={1} intensity={90} color="#ffffff" />
        <group position={[0, markY, 0]} rotation={[rotX, rotY, 0]} scale={scale}>
          <mesh geometry={geometry}>
            <meshPhysicalMaterial
              color={finish.color}
              metalness={finish.metalness}
              roughness={finish.roughness}
              transmission={finish.transmission}
              thickness={0.6}
              ior={1.45}
              clearcoat={1}
              clearcoatRoughness={0.05}
              envMapIntensity={1.4}
              attenuationColor={p.accent}
              attenuationDistance={2.5}
            />
          </mesh>
        </group>
        <ContactShadows
          position={[0, markY - 1.35, 0]}
          opacity={0.6 * settle}
          scale={6}
          blur={2.8}
          far={3}
          resolution={512}
        />
      </ThreeCanvas>
      {p.wordmark ? (
        <AbsoluteFill
          style={{
            justifyContent: "flex-end",
            alignItems: "center",
            paddingBottom: height * (aspect < 1 ? 0.3 : 0.14),
          }}
        >
          <div
            style={{
              fontFamily: displayFont,
              fontWeight: 600,
              fontSize: wordSize,
              letterSpacing: `${mix(0.5, 0.22, word)}em`,
              color: "#f2f2f4",
              opacity: word,
              transform: `translateY(${mix(wordSize * 0.4, 0, word)}px)`,
              filter: `blur(${mix(8, 0, word)}px)`,
              textTransform: "uppercase",
              paddingLeft: "0.22em",
            }}
          >
            {p.wordmark}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
