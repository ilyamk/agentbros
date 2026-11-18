import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { random } from "remotion";
import { VorkTaskSchema } from "../../types/vork";
import { CliErrorObject } from "../cli";
import { requireVork, runProcess, writeNew } from "./runtime";

export const recipeParams = z
  .object({
    seed: z.number().int().min(0).default(42),
    duration: z.number().positive().max(30).default(3),
    fps: z.number().int().min(1).max(60).default(30),
    count: z.number().int().min(1).max(1000000).default(10000),
    simulationQuality: z.enum(["preview", "final"]).default("preview"),
    colour: z
      .tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
      .default([0.08, 0.32, 0.38]),
  })
  .strict();
export const VORK_RECIPES = [
  {
    id: "product-stage",
    capability: "materials-camera",
    purpose: "A machined vessel revealed by a deliberate camera push and warm edge light",
    profile: "std/final",
  },
  {
    id: "procedural-vessel",
    capability: "native-geometry-export",
    purpose: "A ribbed sculptural vessel from an authored radial profile, ready for GLB hand-off",
    profile: "std/final",
  },
  {
    id: "surface-reveal",
    capability: "surface-displacement",
    purpose: "A dark sculptural form reveals a luminous procedural surface",
    profile: "std/final",
  },
  {
    id: "gpu-swarm",
    capability: "gpu-compute-instances",
    purpose: "A seeded GPU-authored ribbon of opaque copper instances with independent trajectories",
    profile: "std/draft",
  },
  {
    id: "fluid-basin",
    capability: "fluid",
    purpose: "A small bounded APIC water study; final starts as a hydrostatic pool, not a resolved impact",
    profile: "std/path",
  },
  {
    id: "cloth-banner",
    capability: "cloth",
    purpose: "A pinned native triangular fabric patch driven by gravity and authored acceleration",
    profile: "std/final",
  },
  {
    id: "fog-volume",
    capability: "medium",
    purpose: "A finite homogeneous illuminated medium; no arbitrary smoke density",
    profile: "std/path",
  },
  {
    id: "optical-field",
    capability: "propagation-camera-sensor",
    purpose: "An authored curved ray field around a glowing sculpture; artistic optics",
    profile: "std/path",
  },
  {
    id: "plate-insert",
    capability: "compositor-aov",
    purpose: "CG beauty and an authored linear compositor; attach a real plate through vork:vfx",
    profile: "std/final",
  },
  {
    id: "program-hooks",
    capability: "camera-sensor-display-aov",
    purpose: "Small explicit camera, detector, display and custom normal-AOV programmes",
    profile: "std/path",
  },
] as const;
export function recipeById(id: string) {
  const recipe = VORK_RECIPES.find((row) => row.id === id);
  if (!recipe) throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown Vork recipe: ${id}` });
  return recipe;
}
export type Scene = {
  version: number;
  nodes: Record<string, unknown>[];
  render: Record<string, unknown>;
  animation?: unknown[];
  buffers?: Record<string, unknown>;
  programs?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
  materials?: Record<string, unknown>;
  [key: string]: unknown;
};
const metal = (colour: number[]) => ({
  inputs: { base_color: colour, base_metalness: 0.75, specular_roughness: 0.24 },
});
function roundedProfile(points: number[][], radius: number): number[][] {
  const result = [points[0]!];
  const distance = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      c = points[i + 1]!;
    const r = Math.min(radius, distance(a, b) * 0.3, distance(b, c) * 0.3);
    const enter = b.map((value, j) => value + ((a[j]! - value) * r) / distance(a, b));
    const exit = b.map((value, j) => value + ((c[j]! - value) * r) / distance(b, c));
    for (let step = 0; step <= 6; step++) {
      const t = step / 6;
      result.push(b.map((value, j) => (1 - t) ** 2 * enter[j]! + 2 * (1 - t) * t * value + t * t * exit[j]!));
    }
  }
  result.push(points.at(-1)!);
  return result;
}
export function baseScene(params = recipeParams.parse({})): Scene {
  const end = params.duration;
  return {
    version: 2,
    nodes: [
      {
        type: "mesh",
        name: "hero",
        geometry: {
          std: "revolve",
          profile: roundedProfile(
            [
              [0, 0],
              [0.62, 0],
              [0.65, 0.08],
              [0.46, 0.22],
              [0.39, 0.82],
              [0.5, 0.94],
              [0.46, 1],
              [0.3, 1],
              [0.32, 0.86],
              [0.34, 0.24],
              [0, 0.16],
            ],
            0.024,
          ),
          segments: 192,
        },
        materials: [metal(params.colour)],
      },
      {
        type: "mesh",
        name: "plinth",
        geometry: {
          std: "revolve",
          profile: roundedProfile(
            [
              [0, -0.06],
              [0.95, -0.06],
              [0.95, 0.06],
              [0, 0.06],
            ],
            0.012,
          ),
          segments: 192,
        },
        translation: [0, -0.06, 0],
        materials: [metal([0.12, 0.13, 0.14])],
      },
      {
        type: "mesh",
        name: "floor",
        geometry: { std: "grid", size: [200, 200] },
        translation: [0, -0.13, 0],
        materials: [{ inputs: { base_color: [0.045, 0.05, 0.065], specular_roughness: 0.4 } }],
      },
      {
        type: "light",
        shape: "rectangle",
        name: "key",
        translation: [-2, 3, 3],
        target: [0, 0.5, 0],
        energy: 350,
        size: 3,
        color: [0.75, 0.86, 1],
      },
      {
        type: "light",
        shape: "rectangle",
        name: "rim",
        translation: [1.8, 1.8, -1.5],
        target: [0, 0.5, 0],
        energy: 650,
        size: 2,
        color: [1, 0.63, 0.28],
      },
      { type: "light", shape: "environment", energy: 0.12, color: [0.3, 0.4, 0.6] },
      {
        type: "camera",
        name: "camera",
        translation: [2.9, 1.85, 4.5],
        target: [0, 0.45, 0],
        material: { program: "std/camera", inputs: { lens: 60, clip_start: 0.01, clip_end: 300 } },
      },
    ],
    animation: [
      {
        tracks: [
          {
            path: ["nodes", "camera", "translation"],
            interpolation: "CUBICSPLINE",
            keys: [
              [0, [2.9, 1.85, 4.5]],
              [end * 0.8, [2.6, 1.65, 4.1]],
              [end, [2.6, 1.65, 4.1]],
            ],
          },
          {
            path: ["nodes", "hero", "rotation"],
            keys: [
              [0, [0, -0.3, 0, Math.sqrt(0.91)]],
              [end, [0, 0.3, 0, Math.sqrt(0.91)]],
            ],
          },
        ],
      },
    ],
    render: {
      camera: "camera",
      resolution: [640, 360],
      fps: params.fps,
      duration: params.duration,
      background: [0.025, 0.035, 0.05],
      display: { program: "std/agx", inputs: { look: "high_contrast", dither_intensity: 0 } },
    },
  };
}
export async function buildRecipe(id: string, output: string, input: unknown = {}, executable?: string) {
  const recipe = recipeById(id),
    params = recipeParams.parse(input),
    directory = path.resolve(output);
  if (existsSync(directory))
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Recipe source directory exists; choose a new revision" });
  mkdirSync(directory, { recursive: true });
  const scene = baseScene(params),
    hero = scene.nodes[0]!;
  if (id === "product-stage") {
    writeFileSync(
      path.join(directory, "machined.slang"),
      `import vork;
struct Inputs {float3 colour=float3(.08,.32,.38); Attribute<float2> uv;};
Closure surface(ShadingContext c,Inputs i) {
 AttributeSample<float2> uv=read_attribute(i.uv,c); float footprint=max(length(uv.dx),length(uv.dy));
 float rings=sin(uv.value.y*1507.9645)*exp(-pow(footprint*480.,2.));
 float3 tangent=cross(float3(0,1,0),c.NORMAL);
 Closure m={}; m.base_color=saturate(i.colour*(1.+.025*rings)); m.base_metalness=.95;
 m.specular_roughness=.25+.025*rings; m.specular_roughness_anisotropy=.32;
 m.geometry_tangent=length(tangent)>.001?normalize(tangent):float3(1,0,0); return m;
}
`,
    );
    hero.materials = [
      { program: { file: "machined.slang" }, inputs: { colour: params.colour, uv: { attribute: "TEXCOORD_0" } } },
    ];
    scene.nodes.find((node) => node.name === "camera")!.translation = [3, 2.35, 4.8];
    scene.animation = [
      {
        tracks: [
          {
            path: ["nodes", "camera", "translation"],
            interpolation: "CUBICSPLINE",
            keys: [
              [0, [3, 2.35, 4.8]],
              [params.duration * 0.87, [1.2, 1.9, 4.9]],
              [params.duration, [1.2, 1.9, 4.9]],
            ],
          },
        ],
      },
    ];
  }
  if (id === "procedural-vessel") {
    const profile = [
      [0, 0],
      [0.48, 0],
    ];
    for (let i = 0; i <= 128; i++) {
      const y = i / 128;
      profile.push([0.42 + 0.09 * Math.cos((i * Math.PI) / 8) + 0.09 * Math.sin(y * Math.PI), y + 0.03]);
    }
    profile.push([0.44, 1.06], [0.3, 1.06], [0.29, 1], [0.27, 0.14], [0, 0.14]);
    hero.geometry = { std: "revolve", profile, segments: 96 };
    // Static geometry hand-off intentionally carries no animated optics or render-only programmes.
    delete scene.animation;
  }
  if (id === "surface-reveal") {
    writeFileSync(
      path.join(directory, "reveal.slang"),
      `import vork;
struct Inputs { float3 colour=float3(.04,.24,.3); };
Closure surface(ShadingContext c, Inputs i) {
 float progress=smoothstep(0.,1.,c.time/${params.duration});
 float sweep=-.15+progress*1.5; float line=exp(-pow((c.POSITION.y-sweep)*5.,2.));
 float reveal=smoothstep(-.15,.15,sweep-c.POSITION.y);
 Closure m={}; m.base_color=i.colour; m.base_metalness=.8; m.specular_roughness=lerp(.32,.18,reveal);
 m.emission_color=float3(.15,.8,1.); m.emission_luminance=2.*line; return m;
}
float3 displace(DisplacementContext c,Inputs i) { return c.NORMAL*(.003*sin(c.POSITION.y*55.+c.time*2.)); }
`,
    );
    hero.materials = [{ program: { file: "reveal.slang" }, inputs: { colour: params.colour } }];
  }
  if (id === "gpu-swarm") {
    scene.buffers = { positions: { type: "vec3", data: Array.from({ length: params.count }, () => [0, 0, 0]) } };
    scene.programs = {
      placement: {
        file: "swarm.slang",
        schedule: "frame",
        dispatch: params.count,
        bindings: { positions: "positions" },
      },
    };
    writeFileSync(
      path.join(directory, "swarm.slang"),
      `import vork;
struct Inputs {};
float unit(uint x) { x^=x>>16; x*=2246822519u; x^=x>>13; x*=3266489917u; x^=x>>16; return float(x&16777215u)/16777216.; }
void compute(ComputeContext c, Inputs i) {
 uint n=c.id.x; float a=unit(n+${params.seed}u)*6.2831853; float b=unit(n*3u+19u); float r=.55+.55*b;
 float u=saturate(c.time/${params.duration}); float t=(u*u*(3.-2.*u))*2.8; float3 p=float3(r*cos(a+t), .55+.55*sin(a*3.+t*1.3)+.25*(unit(n+74u)-.5), .45*r*sin(a+t));
 positions_store(n,p);
}
`,
    );
    hero.geometry = { std: "box", size: [0.012, 0.006, 0.025] };
    hero.instances = { attributes: { TRANSLATION: "positions" } };
    delete scene.animation;
    const attributes = (hero.instances as { attributes: Record<string, unknown> }).attributes;
    attributes.SCALE = {
      type: "vec3",
      data: Array.from({ length: params.count }, (_, n) => {
        const scale = 0.65 + random(`${params.seed}:scale:${n}`) * 0.65;
        return [scale, scale, scale];
      }),
    };
    attributes.ROTATION = {
      type: "vec4",
      data: Array.from({ length: params.count }, (_, n) => {
        const angle = (random(`${params.seed}:angle:${n}`) - 0.5) * Math.PI;
        return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
      }),
    };
    attributes.finish = {
      type: "f32",
      data: Array.from({ length: params.count }, (_, n) => 0.24 + random(`${params.seed}:finish:${n}`) * 0.12),
    };
    hero.materials = [
      { inputs: { base_color: [0.5, 0.19, 0.045], base_metalness: 0.75, specular_roughness: { attribute: "finish" } } },
    ];
    scene.nodes.find((node) => node.name === "plinth")!.geometry = {
      std: "revolve",
      profile: roundedProfile(
        [
          [0, -0.06],
          [1.3, -0.06],
          [1.3, 0.06],
          [0, 0.06],
        ],
        0.012,
      ),
      segments: 192,
    };
    scene.nodes.find((node) => node.name === "key")!.size = 4;
    scene.nodes.find((node) => node.name === "rim")!.energy = 420;
    const camera = scene.nodes.find((node) => node.name === "camera")!;
    camera.translation = [3.3, 2, 4.7];
    camera.target = [0, 0.55, 0];
    camera.material = { program: "std/camera", inputs: { lens: 55, clip_start: 0.01, clip_end: 300 } };
  }
  if (id === "fog-volume") {
    scene.programs = {
      fog: {
        source: `import vork; struct Inputs {}; MediumCoefficients medium(MediumContext c,Inputs i) {
 float u=saturate(c.time/${params.duration}); float density=(.003+.017*smoothstep(0.,.3,u))*(1.-.35*smoothstep(.65,1.,u));
 MediumCoefficients m; m.scattering=float3(density); m.absorption=float3(.002,.003,.005); m.anisotropy=.2; return m;
}`,
      },
    };
    hero.materials = [
      {
        inputs: {
          base_color: params.colour,
          base_metalness: 1,
          specular_roughness: 0.24,
          specular_roughness_anisotropy: 0.25,
          geometry_tangent: [0, 1, 0],
        },
      },
    ];
    scene.nodes.push({
      type: "mesh",
      name: "fog",
      geometry: { std: "sphere", radius: 1, segments: 64, rings: 32 },
      translation: [0, 1, -3],
      scale: [6, 3, 2.2],
      materials: [{ program: "fog" }],
    });
  }
  if (id === "optical-field") {
    scene.programs = {
      bending: {
        source: `import vork; struct Inputs {}; PropagationStep propagation(PropagationContext c,Inputs i) { PropagationStep s; float3 p=c.position-float3(0,.5,0); float r=max(length(p),.3); s.direction=normalize(c.direction-p*(.012*(.5-.5*cos(6.2831853*saturate(c.time/${params.duration}))))/(r*r*r)); s.distance=.15; return s; }`,
      },
    };
    scene.propagation = {
      program: "bending",
      bounds: [
        [-3, -2, -3],
        [3, 3, 3],
      ],
    };
    for (const x of [-0.8, 0.8])
      scene.nodes.push({
        type: "mesh",
        name: `optical-reference-${x}`,
        geometry: { std: "cylinder", radius: 0.025, height: 1.5 },
        translation: [x, 0.62, -0.6],
        materials: [metal([0.65, 0.67, 0.7])],
      });
  }
  if (id === "plate-insert") {
    scene.programs = {
      finish: {
        source:
          "import vork; struct Inputs {}; float4 composite(CompositeContext c,Inputs i) { float4 p=compositor_sample(c.uv); float v=1.-.2*dot(c.uv-.5,c.uv-.5); return float4(p.rgb*v,p.a); }",
      },
    };
    scene.render.compositor = ["finish"];
    scene.materials = { finish: { program: "finish" } };
  }
  if (id === "program-hooks") {
    scene.programs = {
      detector: {
        source: `import vork; struct Inputs {};
CameraRay camera(CameraContext c,Inputs i) { float2 p=(c.uv-.5)*float2(c.film_size.x/c.film_size.y,-1.); CameraRay r; r.origin=c.origin; r.direction=normalize(c.forward+c.right*p.x*.6+c.up*p.y*.6); r.t_min=.01;r.t_max=300.;return r; }
float3 sensor(SensorContext c,Inputs i) { return float3(1.,.98,.96); }`,
      },
      surface_probe: {
        source: `import vork; struct Inputs { Aov normal_proof; };
Closure surface(ShadingContext c,Inputs i) { Closure m={};m.base_color=float3(.08,.32,.38);m.base_metalness=.7;m.specular_roughness=.25;return m; }
void aov(ShadingContext c,Inputs i,inout AovOutputs result) { write_aov(result,i.normal_proof,abs(c.NORMAL)); }`,
      },
      display_probe: {
        source:
          "import vork; struct Inputs {}; float3 display(DisplayContext c,Inputs i) { return pow(max(c.color/(1.+c.color),float3(0.)),float3(1./2.2)); }",
      },
    };
    hero.materials = [{ program: "surface_probe", inputs: { normal_proof: { aov: "normal_proof" } } }];
    scene.nodes.find((node) => node.name === "camera")!.material = { program: "detector" };
    scene.render.display = { program: "display_probe" };
    scene.render.aovs = [{ name: "normal_proof", type: "color" }];
  }
  const sceneFile = writeNew(path.join(directory, "scene.json"), scene);
  if (id === "fluid-basin" || id === "cloth-banner") {
    const binary = requireVork(executable);
    const worker = fileURLToPath(new URL("../../../scripts/workers/vork-simulation.py", import.meta.url));
    await runProcess(
      pythonUv(),
      [
        "--offline",
        ...pythonArgs("stdlib", [
          worker,
          id,
          sceneFile,
          path.join(path.dirname(binary), "python"),
          String(params.seed),
          params.simulationQuality,
        ]),
      ],
      { env: pythonEnvironment("stdlib"), timeoutSec: 120 },
    );
  }
  const task = VorkTaskSchema.parse({
    schemaVersion: 1,
    id,
    intent: recipe.purpose,
    notice: "The hero and its motivated transformation",
    workflow: id === "procedural-vessel" ? "geometry-to-blender" : "standalone",
    scene: "scene.json",
    inputs: [],
    duration: params.duration,
    fps: params.fps,
    seed: params.seed,
    camera: "60 mm deliberate push; preserve the settled last frame",
    light: "Cool broad key and warm separating rim",
    material: "Authored copper/teal OpenPBR, linear Rec.709",
    motion: "Frame-driven or fixed-clock seeded simulation; inspect a contiguous sequence",
    effect: recipe.purpose,
    profile: recipe.profile,
    acceptance: [
      "Complete frames and metadata",
      "No unexplained dropped effect",
      "Inspect subject, contact, highlights and temporal continuity",
    ],
  });
  const taskFile = writeNew(path.join(directory, "task.json"), task);
  return { scene: sceneFile, taskFile, recipe, params, status: "experimental-until-proof" };
}
