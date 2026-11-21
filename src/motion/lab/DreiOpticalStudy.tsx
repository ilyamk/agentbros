import { ContactShadows, MeshTransmissionMaterial, PerspectiveCamera, RoundedBox } from "@react-three/drei";
import { ThreeCanvas } from "@remotion/three";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { cameraOrientation } from "../library/three/shot-plan";
import { easeInOut, mix, ramp, StudioEnvironment } from "../library/three/shared";

export const DreiOpticalStudy = ({ control }: { control: boolean }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const drift = easeInOut(ramp(frame, 0, 128));
  const reveal = easeInOut(ramp(frame, 52, 117));
  const camera = [mix(-1.4, 0.14, drift), 1.05, portrait ? 9.5 : 6.55] as const;
  const floor = "#2749a1";
  return (
    <ThreeCanvas width={width} height={height} gl={{ antialias: true }}>
      <color attach="background" args={[floor]} />
      <PerspectiveCamera
        makeDefault
        position={[...camera]}
        fov={32}
        quaternion={cameraOrientation(camera, [portrait ? 0 : -0.55, portrait ? 0.32 : 0.06, 0])}
      />
      <StudioEnvironment intensity={1.18} warmth="#fff0e1" sweep={0.68} />
      <ambientLight intensity={0.26} />
      <directionalLight color="#fff5e3" intensity={2.4} position={[-3, 4, 4]} />
      <directionalLight color="#a6c9fc" intensity={2.1} position={[3, 1, -4]} />
      <mesh position={[0, -1.075, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[150, 150]} />
        <meshBasicMaterial color={floor} toneMapped={false} />
      </mesh>
      <group rotation={[0.07, mix(0.04, -0.23, drift), -0.05]}>
        <mesh position={[0.24, 0, -0.11]}>
          <torusGeometry args={[0.78, 0.285, 40, 144]} />
          <meshPhysicalMaterial color="#ef5e12" metalness={0.08} roughness={0.19} clearcoat={0.8} />
        </mesh>
        {Array.from({ length: 6 }, (_, index) => (
          <mesh key={index} position={[0.24, 0, 0.18 - index * 0.016]}>
            <torusGeometry args={[0.39 + index * 0.071, 0.012, 12, 120]} />
            <meshStandardMaterial color={index % 2 ? "#ea6629" : "#fed386"} metalness={0.46} roughness={0.23} />
          </mesh>
        ))}
        <mesh position={[0.24, 0, -0.23]} scale={[1.18, 1.18, 0.38]}>
          <sphereGeometry args={[0.51, 64, 32]} />
          <meshPhysicalMaterial color="#223e8f" metalness={0.63} roughness={0.13} clearcoat={1} />
        </mesh>
      </group>
      <ContactShadows position={[0, -1.068, 0]} scale={6} far={2.8} blur={2.8} opacity={0.52} resolution={256} />
      <RoundedBox
        position={[mix(-0.37, -3.5, reveal), 0.15, 0.85]}
        rotation={[0.015, mix(0.16, -0.23, reveal), mix(-0.12, 0.12, reveal)]}
        args={[1.52, 2.24, 0.135]}
        radius={0.09}
        smoothness={5}
      >
        {control ? (
          <meshStandardMaterial transparent opacity={0.32} color="#d8eeff" roughness={0.32} />
        ) : (
          <MeshTransmissionMaterial
            transmission={1}
            thickness={0.24}
            ior={1.44}
            roughness={0.38}
            resolution={512}
            samples={8}
            temporalDistortion={0}
            distortion={0}
            chromaticAberration={0.018}
            color="#e2f2ff"
          />
        )}
      </RoundedBox>
    </ThreeCanvas>
  );
};
