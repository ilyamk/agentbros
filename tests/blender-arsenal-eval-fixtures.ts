import type { ExecutableArsenalPlan } from "../src/lib/blender-arsenal/eval-schema";

export const sceneCode = `import bpy
scene = bpy.context.scene
scene.cycles.seed = 19
for i in range(24):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1)
dust = bpy.context.object
dust.location = (0, 0, 1)
dust.keyframe_insert(data_path='location', frame=1)
dust.location = (1, 0, 0)
dust.keyframe_insert(data_path='location', frame=64)
material = bpy.data.materials.new('Dust')
material.use_nodes = True
bsdf = material.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Roughness'].default_value = 0.4
bsdf.inputs['Metallic'].default_value = 0.2
dust.data.materials.append(material)
bpy.ops.object.camera_add(location=(0, -5, 1))
scene.camera = bpy.context.object
scene.camera.data.lens = 85
bpy.ops.object.light_add(type='AREA', location=(2, -3, 4))
bpy.context.object.data.energy = 800
bpy.context.object.data.use_nodes = True
blackbody = bpy.context.object.data.node_tree.nodes.new('ShaderNodeBlackbody')
blackbody.inputs['Temperature'].default_value = 5600
`;
export function executablePlan(): ExecutableArsenalPlan {
  return {
    version: 2,
    commands: [
      { argv: ["pnpm", "blender:run", "--help"], phase: "inspect", purpose: "Inspect parser." },
      {
        argv: [
          "pnpm",
          "blender:run",
          "--script",
          "shot.py",
          "--output",
          "out/qa/shot",
          "--frames",
          "1-64",
          "--samples",
          "16",
        ],
        phase: "local",
        purpose: "Render supplied native scene.",
      },
    ],
    choices: [{ kind: "builtin", id: "seeded-particles", reason: "Native dust trajectories." }],
    builtIn: {
      method: "Native mesh trajectories, procedural materials.",
      comparison: "The built-in Blender scene needs no extension or download.",
    },
    shot: {
      intent: "Hook: product lands with dust and holds.",
      camera: "85 mm camera pushes towards the product.",
      light: "Soft-product lighting in a warm studio.",
      kit: ["camera.Rig"],
    },
    determinism: {
      seed: 19,
      method: "frame-function",
      cachePath: null,
      pixelCheck: "Compare decoded pixels of frame 20 alone versus in a sequence.",
    },
    acquisition: { needsDownload: false, consent: "not-needed", note: "Native procedural scene with no acquisition." },
    credits: { required: false, lines: [] },
    execution: {
      scripts: [{ path: "shot.py", code: sceneCode }],
      recipes: [],
      assets: [],
      extensions: [],
      frames: [1, 64],
      lensMm: 85,
      cameraMove: "locked",
      lightPreset: "soft-product",
      keyFillRatio: 2.2,
      temperatureK: 5600,
      materials: [{ target: "Dust", shader: "Principled BSDF", roughness: 0.4, metallic: 0.2, assetId: null }],
    },
  };
}
