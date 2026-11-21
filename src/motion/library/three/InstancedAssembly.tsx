import React, { useLayoutEffect, useRef } from "react";
import { ContactShadows, PerspectiveCamera, RoundedBox } from "@react-three/drei";
import { ThreeCanvas } from "@remotion/three";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { Color, Object3D, type InstancedMesh } from "three";
import { assemblyCues, assemblySchema, cameraOrientation, type AssemblyProps } from "./shot-plan";
import { easeInOut, fitDistance, mix, ramp, StudioEnvironment } from "./shared";

export { assemblySchema };

const AssemblyCanvas: React.FC<{ input: AssemblyProps; studio?: boolean }> = ({ input, studio = false }) => {
  const props = assemblySchema.parse(input);
  const { groupCount, unitsPerGroup, durationInFrames, accent, background, seed } = props;
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cues = assemblyCues(props);
  const groupColumns = width < height ? Math.min(groupCount, 2) : Math.min(groupCount, 4);
  const groupRows = Math.ceil(groupCount / groupColumns);
  const unitColumns = Math.ceil(Math.sqrt(unitsPerGroup * 1.4));
  const unitRows = Math.ceil(unitsPerGroup / unitColumns);
  const strideX = unitColumns * 0.36 + 0.38;
  const strideZ = unitRows * 0.36 + 0.42;
  const distance = fitDistance(
    width / height,
    groupColumns * strideX,
    groupRows * strideZ + 1.5,
    34,
    studio ? 0.86 : 0.69,
  );
  const flight = easeInOut(ramp(frame, 0, durationInFrames - 1));
  const count = groupCount * unitsPerGroup;
  const units = Array.from({ length: count }, (_, index) => {
    const group = Math.floor(index / unitsPerGroup);
    const slot = index % unitsPerGroup;
    const rx = random(`${seed}-x-${index}`) - 0.5;
    const rz = random(`${seed}-z-${index}`) - 0.5;
    const land = cues[group]! - Math.floor((unitsPerGroup - 1 - slot) * (studio ? 1.45 : 0.72));
    const t = easeInOut(ramp(frame, land - 31, land));
    const present = ramp(frame, land - 32, land - 23);
    const x =
      ((group % groupColumns) - (groupColumns - 1) / 2) * strideX +
      ((slot % unitColumns) - (unitColumns - 1) / 2) * 0.36;
    const z =
      (Math.floor(group / groupColumns) - (groupRows - 1) / 2) * strideZ +
      (Math.floor(slot / unitColumns) - (unitRows - 1) / 2) * 0.36;
    return {
      position: [mix(x + rx * 2.2, x, t), mix(1.6 + Math.abs(rz), -0.015, t), mix(z + rz * 2.1, z, t)] as const,
      rotation: [rx * 3 * (1 - t), 0, rz * 2.4 * (1 - t)] as const,
      scale: Math.max(0.001, present),
      colour: studio
        ? slot === 0 || slot === unitsPerGroup - 1
          ? accent
          : "#b1b6ad"
        : slot === 0 || slot === unitsPerGroup - 1
          ? accent
          : "#b3c3db",
    };
  });
  const dolly = studio ? mix(0.83, 1.04, flight) : 1;
  const view = [mix(studio ? 0.75 : -0.8, 0.56, flight), distance * 0.73 * dolly, distance * 0.81 * dolly] as const;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 48%, ${background}, #070a14 91%)` }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        <PerspectiveCamera makeDefault position={[...view]} fov={34} quaternion={cameraOrientation(view, [0, 0, 0])} />
        {studio ? <color attach="background" args={["#e4dbcb"]} /> : null}
        <StudioEnvironment intensity={studio ? 1.025 : 1.24} warmth={studio ? "#ffd9a5" : undefined} />
        <directionalLight position={[3, 5, 2]} intensity={studio ? 1.78 : 2.4} color={studio ? "#ffe6be" : "#e1eeff"} />
        <ambientLight intensity={studio ? 0.24 : 0.52} />
        {cues.map((cue, index) => {
          const x = ((index % groupColumns) - (groupColumns - 1) / 2) * strideX;
          const z = (Math.floor(index / groupColumns) - (groupRows - 1) / 2) * strideZ;
          if (studio)
            return (
              <group key={index} position={[x, -0.24, z]}>
                <RoundedBox args={[strideX - 0.18, 0.105, strideZ - 0.19]} radius={0.038} smoothness={3}>
                  <meshStandardMaterial color="#272c2c" metalness={0.48} roughness={0.34} />
                </RoundedBox>
                <RoundedBox
                  position={[0, 0.065, 0]}
                  args={[strideX - 0.235, 0.045, strideZ - 0.23]}
                  radius={0.016}
                  smoothness={3}
                >
                  <meshStandardMaterial
                    color={frame >= cue ? "#726449" : "#434746"}
                    metalness={0.55}
                    roughness={0.36}
                  />
                </RoundedBox>
              </group>
            );
          return (
            <mesh key={index} position={[x, -0.22, z]}>
              <boxGeometry args={[strideX - 0.25, 0.08, strideZ - 0.28]} />
              <meshStandardMaterial color={frame >= cue ? "#364a7e" : "#172645"} metalness={0.48} roughness={0.44} />
            </mesh>
          );
        })}
        <AssemblyUnits count={count} units={units} />
        {studio ? (
          <mesh position={[0, -0.331, 0]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[100, 100]} />
            <meshBasicMaterial color="#e4dbcb" toneMapped={false} />
          </mesh>
        ) : null}
        <ContactShadows
          position={[0, studio ? -0.326 : -0.27, 0]}
          opacity={studio ? 0.82 : 0.63}
          scale={10}
          blur={2.6}
          far={4}
          resolution={256}
        />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

type UnitPose = {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: number;
  colour: string;
};

const AssemblyUnits: React.FC<{ count: number; units: UnitPose[] }> = ({ count, units }) => {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const instances = mesh.current;
    if (!instances) return;
    const transform = new Object3D();
    const colour = new Color();
    for (const [index, unit] of units.entries()) {
      transform.position.set(...unit.position);
      transform.rotation.set(...unit.rotation);
      transform.scale.setScalar(unit.scale);
      transform.updateMatrix();
      instances.setMatrixAt(index, transform.matrix);
      instances.setColorAt(index, colour.set(unit.colour));
    }
    instances.instanceMatrix.needsUpdate = true;
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
  }, [units]);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <cylinderGeometry args={[0.142, 0.142, 0.32, 24]} />
      <meshStandardMaterial metalness={0.46} roughness={0.27} />
    </instancedMesh>
  );
};

export const InstancedAssembly: React.FC<AssemblyProps> = (input) => <AssemblyCanvas input={input} />;

export const ExhibitAssembly: React.FC<AssemblyProps> = (input) => <AssemblyCanvas input={input} studio />;
