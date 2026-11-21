import { ContactShadows, Outlines, MeshTransmissionMaterial, PerspectiveCamera, useGLTF } from "@react-three/drei";
import { createPortal } from "@react-three/fiber";
import { ThreeCanvas } from "@remotion/three";
import React, { useLayoutEffect, useMemo } from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { AnimationMixer, Mesh } from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { projectorDemoSource } from "./shot-demo-model";
import {
  cameraCurve,
  cameraOrientation,
  cameraPose,
  clipTime,
  modelDistance,
  modelFit,
  modelShotSchema,
  type ModelShotProps,
} from "./shot-plan";
import { easeInOut, mix, ramp, StudioEnvironment } from "./shared";

export { modelShotSchema };

function findPartNames(object: ReturnType<typeof clone>, name: string): Mesh[] {
  const matches: (typeof object)[] = [];
  object.traverse((node) => {
    if (node.name === name || node.userData.name === name) matches.push(node);
  });
  if (matches.length !== 1) {
    throw new Error(`Expected one GLB node named "${name}", found ${matches.length}.`);
  }
  const meshes: Mesh[] = [];
  matches[0]!.traverse((node) => {
    // A mesh parented to a mesh is the <Outlines> shell drawn on an earlier frame, not part of the model.
    if (node instanceof Mesh && !(node.parent instanceof Mesh)) meshes.push(node);
  });
  if (!meshes.length) throw new Error(`GLB node "${name}" contains no meshes to outline.`);
  return meshes;
}

type StudioLook = "warm" | "graphite" | "blueprint";

const STUDIO = {
  warm: { ground: "#e6ded0", key: "#fff1da", rim: "#e5f0ff", fill: 0.15, environment: 0.92 },
  graphite: { ground: "#171c21", key: "#ffe0b9", rim: "#a6d6f1", fill: 0.11, environment: 0.74 },
  blueprint: { ground: "#0b2631", key: "#a8daef", rim: "#a9ede0", fill: 0.16, environment: 0.82 },
} as const;

const ModelPicture: React.FC<
  ModelShotProps & {
    source: string;
    frame: number;
    aspect: number;
    look?: StudioLook;
  }
> = ({
  model,
  source,
  frame,
  aspect,
  durationInFrames,
  fill,
  orbitDegrees,
  camera,
  clip,
  highlights,
  glass,
  accent,
  look,
}) => {
  // Project assets use self-contained GLB. Decoders which fetch scripts from a CDN are disabled.
  const { scene, animations } = useGLTF(source, false, false);
  const object = useMemo(() => clone(scene), [scene]);
  const fitted = useMemo(() => modelFit(object), [object]);
  // Keyed by the node names, not the array: the props are parsed again every frame, and a new array must not
  // collect the outline shells added on earlier frames.
  const highlightKey = JSON.stringify(highlights?.map(({ node }) => node) ?? []);
  const meshesByNode = useMemo(
    () => new Map((JSON.parse(highlightKey) as string[]).map((node) => [node, findPartNames(object, node)])),
    [object, highlightKey],
  );
  const targets = highlights?.map((highlight) => ({ highlight, meshes: meshesByNode.get(highlight.node)! }));
  const clipName = clip?.name;
  const animation = useMemo(() => {
    if (!clipName) return null;
    const found = animations.filter((candidate) => candidate.name === clipName);
    if (found.length !== 1) throw new Error(`Expected one GLB animation named "${clipName}", found ${found.length}.`);
    const selected = found[0]!;
    if (selected.duration <= 0) throw new Error(`GLB animation "${clipName}" has no duration.`);
    const mixer = new AnimationMixer(object);
    return { mixer, selected };
  }, [animations, clipName, object]);
  const seconds = clip && animation ? clipTime(frame, clip, animation.selected.duration) : 0;
  useLayoutEffect(() => {
    if (!animation) return;
    const action = animation.mixer.clipAction(animation.selected).play();
    action.paused = true;
    // Absolute sample, including the final key. update(0) applies the pose without advancing the mixer.
    action.time = seconds;
    animation.mixer.update(0);
  }, [animation, seconds]);
  useLayoutEffect(
    () => () => {
      animation?.mixer.stopAllAction();
      animation?.mixer.uncacheRoot(object);
    },
    [animation, object],
  );

  const curve = useMemo(() => (camera ? cameraCurve(camera.points) : null), [camera]);
  const progress = easeInOut(ramp(frame, 0, durationInFrames - 1));
  const offset = model?.offset ?? [0, 0, 0];
  const yaw = (((model?.yaw ?? 0) + (camera ? 0 : mix(-0.66, 0.34, progress) * orbitDegrees)) * Math.PI) / 180;
  const fov = 34;
  const distance = modelDistance(fitted.size, aspect, fill, yaw, fov);
  const pose =
    camera && curve
      ? cameraPose(camera, curve, frame, distance)
      : { position: [0, distance * 0.23, distance] as const, target: [0, 0, 0] as const };
  const glassTravel = glass ? easeInOut(ramp(frame, glass.startFrame, glass.endFrame)) : 0;
  const floor = offset[1] - fitted.size.y / 2 - 0.02;
  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[...pose.position]}
        fov={fov}
        near={0.05}
        far={Math.max(50, distance * 4)}
        quaternion={cameraOrientation(pose.position, pose.target)}
      />
      <group position={offset} rotation={[0, yaw, 0]} scale={fitted.scale}>
        <group position={fitted.centre.clone().negate()}>
          <primitive object={object} />
        </group>
      </group>
      {targets?.flatMap(({ highlight, meshes }) => {
        if (frame < highlight.startFrame || frame >= highlight.endFrame) return [];
        return meshes.map((mesh) => (
          <React.Fragment key={`${highlight.node}-${mesh.uuid}`}>
            {createPortal(<Outlines color={accent} thickness={4} angle={0} toneMapped={false} />, mesh)}
          </React.Fragment>
        ));
      })}
      {look ? (
        <mesh position={[0, floor - 0.009, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[150, 150]} />
          <meshBasicMaterial color={STUDIO[look].ground} toneMapped={false} />
        </mesh>
      ) : null}
      {look === "blueprint" ? (
        <gridHelper args={[22, 88, "#2b5865", "#193e49"]} position={[0, floor - 0.005, 0]} />
      ) : null}
      <ContactShadows
        position={[0, look ? floor : floor - 0.01, 0]}
        opacity={look ? 0.72 : 0.58}
        scale={7}
        blur={2.5}
        far={3}
        resolution={256}
        color="#030509"
      />
      {glass ? (
        <mesh position={[mix(-0.5, -3.35, glassTravel), 0.15, fitted.size.z / 2 + 0.36]} rotation={[0, -0.07, 0.02]}>
          <boxGeometry args={[1.48, 1.73, 0.055]} />
          {glass.control ? (
            <meshStandardMaterial transparent opacity={0.36} color="#c8fffc" roughness={glass.roughness} />
          ) : (
            <MeshTransmissionMaterial
              transmission={1}
              thickness={0.19}
              ior={1.38}
              roughness={glass.roughness}
              resolution={256}
              samples={4}
              temporalDistortion={0}
              distortion={0}
              chromaticAberration={0.015}
              color="#bcf2ef"
            />
          )}
        </mesh>
      ) : null}
    </>
  );
};

const ModelShotCanvas: React.FC<{ input: ModelShotProps; studioLook?: StudioLook }> = ({ input, studioLook }) => {
  const props = modelShotSchema.parse(input);
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const source = useMemo(
    () => (props.model ? staticFile(props.model.src) : projectorDemoSource(Boolean(studioLook))),
    [props.model?.src, studioLook],
  );
  const light = studioLook ? STUDIO[studioLook] : undefined;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 48%, ${props.background} 4%, #04070c 92%)` }}>
      <ThreeCanvas width={width} height={height} gl={{ antialias: true, alpha: true }}>
        {light || props.glass ? <color attach="background" args={[light?.ground ?? props.background]} /> : null}
        <StudioEnvironment intensity={light?.environment ?? 1.45} warmth={light?.key} sweep={light ? 0.38 : 0.5} />
        <ambientLight intensity={light?.fill ?? 0.58} />
        <directionalLight
          position={light ? [-3, 6, 4] : [4, 5, 4]}
          color={light?.key ?? "#e4f4ff"}
          intensity={light ? 1.65 : 2.1}
        />
        <directionalLight
          position={light ? [4, 2, -5] : [-3, 1, -4]}
          color={light?.rim ?? "#8eabff"}
          intensity={light ? 2.05 : 1.8}
        />
        <ModelPicture {...props} source={source} frame={frame} aspect={width / height} look={studioLook} />
      </ThreeCanvas>
    </AbsoluteFill>
  );
};

export const ModelShot: React.FC<ModelShotProps> = (input) => <ModelShotCanvas input={input} />;

export const ExhibitModelShot: React.FC<ModelShotProps & { look: StudioLook }> = ({ look, ...input }) => (
  <ModelShotCanvas input={input} studioLook={look} />
);
