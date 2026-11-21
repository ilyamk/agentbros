# Generated 3D in a film

Use a generated mesh for an invented prop or an approximate shape from a supplied image when no approved model or library block fits. It can save manual modelling, but still needs geometry, UV, material, scale and licence inspection. Use existing phone/laptop GLBs for devices, Blender for exact modelling, simulation or photoreal lighting, and real capture for visual evidence. A generated mesh supplies an asset; three.js or Blender still renders the shot.

The existing `studio-product-stage` block loads shared phone/laptop GLBs with `useGLTF(staticFile(...))` inside `<ThreeCanvas>`. For a self-contained project GLB, pass `model.src` on the single studio stage or use the controls in [3D shot techniques](../../../../docs/drei-techniques.md). A bespoke scene can follow the same loader/canvas path:

```tsx
import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { ThreeCanvas } from '@remotion/three';
import { staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

function ProjectMesh() {
  const { scene } = useGLTF(staticFile('projects/ID/assets/3d/prop.glb'));
  const object = useMemo(() => clone(scene), [scene]);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <group rotation={[0, (frame / fps) * 0.35, 0]}><primitive object={object} /></group>;
}

export function GeneratedPropShot() {
  const { width, height } = useVideoConfig();
  return (
    <ThreeCanvas width={width} height={height} camera={{ position: [0, 0, 4] }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 4, 5]} intensity={2} />
      <ProjectMesh />
    </ThreeCanvas>
  );
}
```

Adjust the static origin, camera and scale after inspecting the mesh. Suspense loading is held by `ThreeCanvas`; rotation depends only on the frame. No `useFrame`, wall-clock animation or automatic clip playback. For rigged models this example renders the rest pose; seek a mixer explicitly to `frame / fps` for each rendered frame, or bake the animation through Blender. Clone skinned scenes with `SkeletonUtils` so instances do not share skeleton state.

For Blender, read [the shot rules](../../../../scripts/blender/AGENTS.md) and the `blender-3d` skill. The existing `scripts/blender/studio_kit.py` helper `import_device(kind_or_path)` calls `bpy.ops.import_scene.gltf` and accepts a GLB path. The shot templates accept that path in their `device` field. Save project shot JSON as `public/projects/ID/assets/blender/prop.json`:

```json
{"device":"public/projects/ID/assets/3d/prop.glb","frames":60,"look":"dark"}
```

```bash
pnpm blender:run --script scripts/blender/hero_turntable.py --output out/ID/prop --frames 1-60 --samples 24 --resolution 1920x1080 --script-args '["public/projects/ID/assets/blender/prop.json"]'
```

The kit expects normalised device geometry (metres, Z up and a `screen` mesh for overlays). It imports and groups an arbitrary GLB without normalising it; generated props may need scale, orientation and material repair in a project scene script. Use a custom script for rigs, clip selection or non-device framing. Inspect look frames before rendering a sequence, then use `blender-plate` for the rendered plate.

Use `public/projects/<id>/assets/3d/<name>.glb` for GLB outputs and `ai-3d` AssetSpecs; publication registers `model3d` assets. See [verified endpoints](../../../../docs/fal-catalogue.md#verified-endpoints) for discovery, pricing bounds and partner-host restrictions.
