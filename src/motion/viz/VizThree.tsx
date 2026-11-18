import { Line } from "@react-three/drei";
import { vizPathPoints, vizClippedPathPoints } from "./paths";
import { VizTextureMaterial } from "./VizTextureMaterial";
import { vizProjection, vizCameraState, vizLighting, vizElementState, vizObjectGeometry } from "./state";
import React, { useLayoutEffect } from "react";
import { useThree } from "@react-three/fiber";
import { OrthographicCamera } from "three";
import { ThreeCanvas } from "@remotion/three";
import type { VizPlan } from "../../types/viz";
import { useCurrentFrame, interpolate } from "remotion";

const FrameCamera: React.FC<{ zoom: number; panX: number; position: [number, number, number] }> = ({
  zoom,
  panX,
  position,
}) => {
  const { camera } = useThree();
  useLayoutEffect(() => {
    if (camera instanceof OrthographicCamera) {
      camera.zoom = 200 * zoom;
      camera.position.set(position[0] - panX / 200, position[1], position[2]);
      camera.lookAt(-panX / 200, 0, 0);
      camera.updateProjectionMatrix();
    }
  }, [camera, zoom, panX, position]);
  return null;
};
export const VizThree: React.FC<{ plan: VizPlan }> = ({ plan }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, Math.min(90, plan.spec.durationFrames - 30)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const camera = vizCameraState(plan, frame);
  const lighting = vizLighting(plan);
  const scale = 200;
  const extent = plan.height / scale;
  const material = {
    metalness: plan.spec.material === "metal" ? 0.9 : 0,
    roughness: plan.spec.material === "paper" ? 0.9 : plan.spec.material === "metal" ? 0.25 : 0.45,
    transparent: plan.spec.material === "glass",
    opacity: plan.spec.material === "glass" ? 0.45 : 1,
  };
  return (
    <ThreeCanvas
      width={plan.width}
      height={plan.height}
      orthographic
      camera={{ position: vizProjection(plan).position, zoom: scale, near: 0.1, far: 100 }}
      style={{ position: "absolute", inset: 0 }}
    >
      <FrameCamera {...camera} position={vizProjection(plan).position} />
      <ambientLight intensity={lighting.ambient} />
      <directionalLight position={[4, 6, 10]} intensity={lighting.key} />
      {plan.primitives
        .filter((p) => p.kind === "rect" || p.kind === "circle")
        .map((p) => {
          const geometry = vizObjectGeometry(plan, p);
          const state = vizElementState(plan, p, frame);
          const { width: w, height: h, x, y } = geometry;
          return (
            <mesh key={p.id} position={[x, y, geometry.z]} scale={[1, state.progress, 1]}>
              <boxGeometry args={[w, h, geometry.depth]} />
              {plan.spec.textures ? (
                <VizTextureMaterial plan={plan} colour={state.fill} opacity={state.opacity * material.opacity} />
              ) : (
                <meshPhysicalMaterial
                  transmission={plan.spec.material === "glass" ? 0.8 : 0}
                  thickness={0.2}
                  ior={1.45}
                  color={state.fill}
                  {...material}
                  transparent
                  opacity={state.opacity * material.opacity}
                />
              )}
            </mesh>
          );
        })}
      {plan.primitives
        .filter((p) => p.kind === "path")
        .map((p) => {
          const state = vizElementState(plan, p, frame),
            points = vizClippedPathPoints(vizPathPoints(plan, p), state.progress);
          return points.length > 1 ? (
            <Line
              key={p.id}
              points={points}
              color={state.fill}
              lineWidth={p.strokeWidth ?? 5}
              transparent
              opacity={state.opacity}
              depthTest
            />
          ) : null;
        })}
    </ThreeCanvas>
  );
};
