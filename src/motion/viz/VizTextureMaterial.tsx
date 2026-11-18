import React, { useMemo, useEffect } from "react";
import { useTexture } from "@react-three/drei";
import { staticFile } from "remotion";
import { RepeatWrapping, SRGBColorSpace, NoColorSpace } from "three";
import type { VizPlan } from "../../types/viz";
export const VizTextureMaterial: React.FC<{ plan: VizPlan; colour: string; opacity: number }> = ({
  plan,
  colour,
  opacity,
}) => {
  const maps = Object.entries(plan.spec.textures?.maps ?? {}).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
  );
  const textures = useTexture(maps.map(([, map]) => staticFile(map.path)));
  const owned = useMemo(() => textures.map((texture) => texture.clone()), [textures]);
  useEffect(() => () => owned.forEach((texture) => texture.dispose()), [owned]);
  const props: Record<string, unknown> = {};
  for (const [i, [role, map]] of maps.entries()) {
    const texture = owned[i]!;
    texture.colorSpace = map.colourSpace === "srgb" ? SRGBColorSpace : NoColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(...map.repeat);
    props[role === "baseColor" ? "map" : `${role === "metallic" ? "metalness" : role}Map`] = texture;
  }
  return (
    <meshPhysicalMaterial
      transmission={plan.spec.material === "glass" ? 0.8 : 0}
      thickness={0.2}
      ior={1.45}
      {...props}
      color={colour}
      transparent
      opacity={opacity}
      metalness={plan.spec.material === "metal" ? 0.9 : 0}
      roughness={plan.spec.material === "paper" ? 0.9 : 0.45}
    />
  );
};
