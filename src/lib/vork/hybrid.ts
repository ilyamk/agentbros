import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HybridVorkReceiptSchema, VorkLightingSchema, VorkReceiverSchema, defaultVfxLighting } from "../../types/vork";
import { inspectAsset, inspectGlbFile } from "../assets/inspect";
import { probeVideo } from "../vision/media";
import { planBlenderRun, runBlender, type BlenderRunRequest } from "../backends/blender-run";
import { exportVork, relativePin, sceneInputs, readTask, verifyPins } from "./render";
import { executionIdentity, filesIn, hashFile, json, writeNew } from "./runtime";
import { bridgeVork } from "./bridge";
import { normaliseCamera } from "./camera";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const worker = path.join(repository, "scripts/workers/blender/avc_vork_vfx.py");
const blenderWorkers = ["avc_run.py", "avc_export.py", "avc_vork_outputs.py"].map((file) =>
  path.join(repository, "scripts/workers/blender", file),
);
export const HybridJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    renderBackend: z.literal("blender-cycles"),
    scene: z.string(),
    task: z.string(),
    camera: z.string(),
    plate: z.string(),
    matte: z.string().optional(),
    proxy: z.string().optional(),
    fps: z.number().positive(),
    frames: z.number().int().positive(),
    resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    seed: z.number().int().nonnegative(),
    lighting: VorkLightingSchema.default(defaultVfxLighting),
    receiver: VorkReceiverSchema,
  })
  .strict();

/** Explicit supported-geometry hand-off. Shader/compute/simulation loss is never accepted here. */
type VfxRenderOptions = {
  samples?: number;
  frames?: [number, number];
  resolution?: [number, number];
  firstFrame?: number;
  purpose?: "draft" | "production";
  blender?: string;
  executable?: string;
  device?: "auto" | "cpu" | "gpu";
};

export function planHybridVfx(jobFile: string, options: VfxRenderOptions = {}) {
  const job = HybridJobSchema.parse(json(jobFile)),
    base = path.dirname(path.resolve(jobFile));
  const resolve = (file: string) => path.resolve(base, file);
  const sceneFile = resolve(job.scene),
    scene = json(sceneFile) as {
      nodes: Array<{ name?: string; materials?: unknown }>;
      programs?: unknown;
      simulation?: unknown;
      animation?: unknown[];
    };
  // This route transfers a static supported native mesh, not a render-only procedural effect.
  if (
    scene.animation?.length ||
    scene.programs ||
    scene.simulation ||
    scene.nodes.length !== 1 ||
    scene.nodes[0]?.name !== "hero"
  )
    throw new Error(
      "Hybrid requires an isolated static hero with supported native materials; bake or author another route explicitly",
    );
  const camera = normaliseCamera(json(resolve(job.camera)), job.fps);
  if (
    camera.image_size.some((n, i) => n !== job.resolution[i]) ||
    Math.abs(camera.K[2]! - job.resolution[0] / 2) > 1e-6 ||
    Math.abs(camera.K[5]! - job.resolution[1] / 2) > 1e-6 ||
    camera.frames.slice(0, job.frames).some((pose, index) => Math.abs(pose.time - index / job.fps) > 1e-5)
  )
    throw new Error("Hybrid requires centred, constant pinhole calibration on the nominal source frame clock");
  const plate = probeVideo(resolve(job.plate));
  if (
    plate.width !== job.resolution[0] ||
    plate.height !== job.resolution[1] ||
    Math.abs(plate.fps - job.fps) > 0.001 ||
    plate.frameCount < job.frames
  )
    throw new Error("Hybrid plate raster, clock or complete frame count differs from the job");
  if (camera.frames.length < job.frames) throw new Error("Hybrid camera does not cover the clip");
  const range = options.frames ?? [0, job.frames - 1],
    first = options.firstFrame ?? 1;
  const resolution = options.resolution ?? job.resolution,
    samples = options.samples ?? 64;
  if (
    !Number.isInteger(first) ||
    first < 0 ||
    range.some((n) => !Number.isInteger(n) || n < 0) ||
    range[0] > range[1] ||
    range[1] >= job.frames ||
    !Number.isInteger(samples) ||
    samples < 1
  )
    throw new Error("Invalid hybrid frame range, start or samples");
  if (resolution[0] / resolution[1] !== job.resolution[0] / job.resolution[1])
    throw new Error("Hybrid preview must preserve the calibrated aspect ratio");
  if (resolution.some((n) => !Number.isInteger(n) || n < 16 || n > 16384 || n % 2 !== 0))
    throw new Error("Hybrid H.264 raster must have even dimensions from 16 to 16384");
  const task = readTask(resolve(job.task));
  if (
    task.scene !== sceneFile ||
    task.task.renderBackend !== "blender-cycles" ||
    task.task.seed !== job.seed ||
    Math.abs(task.task.fps - job.fps) > 1e-6 ||
    Math.ceil(task.task.duration * job.fps) !== job.frames
  )
    throw new Error("Hybrid job differs from its declared task scene, renderer, seed or clock");
  if (job.proxy) {
    const inspected = inspectAsset(resolve(job.proxy), { nonMedia: true });
    if (inspected.kind !== "model3d" || inspected.media.hasAnimations)
      throw new Error("Hybrid receiver proxy must be supported static glTF geometry");
  }
  const inputs = sceneInputs(sceneFile, [
    jobFile,
    resolve(job.task),
    ...task.inputs,
    resolve(job.camera),
    resolve(job.plate),
    ...(job.proxy ? [resolve(job.proxy)] : []),
  ]);
  if (job.matte) {
    const pattern = path
      .basename(job.matte)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/%0?\d*d/, "\\d+");
    const masks = filesIn(path.dirname(resolve(job.matte))).filter((file) =>
      new RegExp(`^${pattern}$`).test(path.basename(file)),
    );
    if (masks.length !== job.frames) throw new Error("Hybrid holdout must cover every source frame");
    inputs.push(...masks);
  }
  const pins = inputs.map((file) => relativePin(file, process.cwd()));
  return { job, base, sceneFile, camera, range, first, resolution, samples, pins };
}

export async function renderHybridVfx(jobFile: string, output: string, options: VfxRenderOptions = {}) {
  const started = Date.now();
  output = path.resolve(output);
  if (existsSync(output)) throw new Error("Hybrid output exists; choose a fresh revision");
  const { job, base, sceneFile, camera, range, first, resolution, samples, pins } = planHybridVfx(jobFile, options);
  const resolve = (file: string) => path.resolve(base, file);
  mkdirSync(output, { recursive: true });
  const geometry = await exportVork(sceneFile, path.join(output, "hero.glb"), {
    node: "hero",
    executable: options.executable,
    purpose: options.purpose ?? "draft",
  });
  if (geometry.receipt?.warnings.length)
    throw new Error("Hybrid geometry transfer reported unsupported loss; no physical proxy substitution is allowed");
  if (inspectGlbFile(geometry.output).media.hasAnimations)
    throw new Error("Static hybrid transfer refuses embedded GLB animation; use an explicit animated or pass route");
  if (!geometry.receiptFile) throw new Error("Missing geometry export receipt");
  const config = writeNew(path.join(output, "request.json"), {
    ...job,
    camera,
    input: geometry.output,
    plate: resolve(job.plate),
    matte: job.matte && resolve(job.matte),
    proxy: job.proxy && resolve(job.proxy),
    output,
    firstFrame: first,
    sourceRange: range,
    resolution,
    samples,
  });
  const request: BlenderRunRequest = {
    script: worker,
    output: path.join(output, "frames"),
    format: "png",
    engine: "cycles",
    samples,
    resolution,
    frames: [first + range[0], first + range[1]],
    device: options.device ?? "auto",
    factoryStartup: true,
    noRender: false,
    overwrite: false,
    resume: false,
    scriptArgs: [config],
    executable: options.blender,
    timeoutSec: 7200,
    encode: "h264",
  };
  const plan = planBlenderRun(request);
  const runtime = [
    ...[worker, ...blenderWorkers].map((file) => relativePin(file, process.cwd())),
    { file: plan.executable, sha256: hashFile(plan.executable) },
  ];
  const result = await runBlender(request);
  verifyPins(pins, process.cwd());
  verifyPins(runtime, process.cwd());
  verifyPins(geometry.receipt!.runtime, process.cwd());
  if (filesIn(path.join(output, "linear")).filter((file) => file.endsWith(".exr")).length !== range[1] - range[0] + 1)
    throw new Error("Missing linear physical render passes");
  if (
    !result.encoded ||
    result.frames.length !== range[1] - range[0] + 1 ||
    Math.abs(result.render.fps - job.fps) > 1e-5
  )
    throw new Error("Incomplete hybrid output or changed source clock");
  writeNew(path.join(output, "execution.json"), executionIdentity(result.render.device));
  const metadata = writeNew(path.join(output, "hybrid-render.json"), {
    ...result,
    renderBackend: "blender-cycles",
    linearComposition: true,
    limitations: [
      "Supported static Vork mesh and OpenPBR subset only",
      "Lighting and receiver material are authored estimates, not recovered physical ground truth",
    ],
  });
  const receipt = HybridVorkReceiptSchema.parse({
    schemaVersion: 2,
    engine: "vork-blender",
    version: "0.5.1",
    renderBackend: "blender-cycles",
    blenderVersion: result.render.blenderVersion,
    geometryReceipt: relativePin(geometry.receiptFile, process.cwd()),
    frameMapping: { sourceFirst: 0, blenderFirst: first },
    purpose: options.purpose ?? "draft",
    operation: "render",
    createdAt: new Date().toISOString(),
    root: ".",
    tool: { file: plan.executable, sha256: hashFile(plan.executable) },
    runtime: [...geometry.receipt!.runtime, ...runtime],
    inputs: pins,
    outputs: filesIn(output)
      .filter((file) => !file.endsWith(".log"))
      .map((file) => relativePin(file, process.cwd())),
    settings: { profile: "blender-cycles", seed: job.seed, fps: job.fps, resolution, frames: range, samples },
    warnings: [],
    elapsedMs: Date.now() - started,
    metadata: path.relative(process.cwd(), metadata),
  });
  const receiptFile = writeNew(path.join(output, "vork-receipt.json"), receipt);
  // A direct sidecar keeps the encoded movie discoverable through the existing import/delivery path.
  writeNew(result.encoded.path + ".vork-receipt.json", receipt);
  return { output, video: result.encoded.path, receipt, receiptFile, metadata };
}

/** Present returned native geometry with an explicitly named Blender renderer and the same provenance guard. */
export async function renderReturnedGeometry(
  scene: string,
  output: string,
  options: {
    frames?: number;
    range?: [number, number];
    resolution?: [number, number];
    samples?: number;
    purpose?: "draft" | "production";
    device?: "auto" | "cpu" | "gpu";
    executable?: string;
    blender?: string;
  } = {},
) {
  output = path.resolve(output);
  scene = path.resolve(scene);
  if (existsSync(output)) throw new Error("Returned geometry output exists; choose a fresh revision");
  const started = Date.now(),
    count = options.frames ?? 90,
    range = options.range ?? [0, count - 1],
    resolution = options.resolution ?? [1920, 1080],
    samples = options.samples ?? 64;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    range.some((n) => !Number.isInteger(n) || n < 0) ||
    range[0] > range[1] ||
    range[1] >= count
  )
    throw new Error("Invalid geometry presentation frame range");
  if ((json(scene) as { animation?: unknown[] }).animation?.length)
    throw new Error("Static returned-geometry presentation refuses animation; use an explicit animated or pass route");
  const inputs = sceneInputs(scene).map((file) => relativePin(file, process.cwd()));
  const bridge = await bridgeVork("to-blender", scene, path.join(output, "bridge"), {
    frames: count,
    executable: options.executable,
    blender: options.blender,
    purpose: options.purpose,
    diagnostics: output,
  });
  const geometry = bridge.geometry;
  if (!geometry?.receiptFile || !geometry.receipt || geometry.receipt.warnings.length)
    throw new Error("Returned geometry needs a loss-free native export receipt");
  if (inspectGlbFile(geometry.output).media.hasAnimations)
    throw new Error("Static returned-geometry presentation refuses embedded GLB animation");
  const runtime = [
    ...geometry.receipt.runtime,
    ...[path.join(repository, "scripts/workers/blender/avc_vork_bridge.py"), ...blenderWorkers].map((file) =>
      relativePin(file, process.cwd()),
    ),
  ];
  const request: BlenderRunRequest = {
    blend: bridge.scene,
    output: path.join(output, "frames"),
    frames: [range[0] + 1, range[1] + 1],
    resolution,
    samples,
    engine: "cycles",
    format: "png",
    device: options.device ?? "auto",
    factoryStartup: true,
    noRender: false,
    overwrite: false,
    resume: false,
    scriptArgs: [],
    executable: options.blender,
    timeoutSec: 7200,
    encode: "h264",
  };
  const plan = planBlenderRun(request);
  runtime.push({ file: plan.executable, sha256: hashFile(plan.executable) });
  const result = await runBlender(request);
  verifyPins(inputs, process.cwd());
  verifyPins(runtime, process.cwd());
  if (!result.encoded || result.frames.length !== range[1] - range[0] + 1 || result.render.fps !== 30)
    throw new Error("Incomplete returned geometry presentation");
  writeNew(path.join(output, "execution.json"), executionIdentity(result.render.device));
  const metadata = writeNew(path.join(output, "hybrid-render.json"), {
    ...result,
    workflow: "geometry-to-blender",
    renderBackend: "blender-cycles",
  });
  const receipt = HybridVorkReceiptSchema.parse({
    schemaVersion: 2,
    engine: "vork-blender",
    version: "0.5.1",
    renderBackend: "blender-cycles",
    blenderVersion: result.render.blenderVersion,
    geometryReceipt: relativePin(geometry.receiptFile, process.cwd()),
    frameMapping: { sourceFirst: 0, blenderFirst: 1 },
    purpose: options.purpose ?? "draft",
    operation: "render",
    createdAt: new Date().toISOString(),
    root: ".",
    tool: { file: plan.executable, sha256: hashFile(plan.executable) },
    runtime,
    inputs,
    outputs: filesIn(output)
      .filter((file) => !file.endsWith(".log"))
      .map((file) => relativePin(file, process.cwd())),
    settings: { profile: "blender-cycles", seed: 42, fps: 30, resolution, frames: range, samples },
    warnings: [],
    elapsedMs: Date.now() - started,
    metadata: path.relative(process.cwd(), metadata),
  });
  const receiptFile = writeNew(path.join(output, "vork-receipt.json"), receipt);
  writeNew(result.encoded.path + ".vork-receipt.json", receipt);
  return { output, video: result.encoded.path, receiptFile, receipt };
}
