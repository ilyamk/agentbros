import { existsSync, mkdirSync, readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { NativeVorkReceiptSchema, VorkReceiptSchema, VorkTaskSchema, type VorkReceipt } from "../../types/vork";
import { CliErrorObject, assertPathWithin } from "../cli";
import { buildStrip } from "../vision/sheets";
import { probeVideo, writeImage } from "../vision/media";
import {
  executionIdentity,
  filesIn,
  hashFile,
  json,
  requireVork,
  runProcess,
  runtimePins,
  VORK_VERSION,
  writeNew,
} from "./runtime";

const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
export const relativePin = (file: string, root: string) => ({
  file: path.relative(root, path.resolve(file)).split(path.sep).join("/"),
  sha256: hashFile(file),
});
export function sceneInputs(scene: string, extra: string[] = []) {
  const found = new Set<string>();
  const shader = (source: string, directory: string) => {
    for (const match of source.matchAll(/(?:#include\s+"([^"\n]+)"|\bimport\s+([\w.]+)\s*;)/g)) {
      const dependency = path.resolve(directory, match[1] ?? match[2]!.replaceAll(".", "/") + ".slang");
      if (existsSync(dependency)) add(dependency);
      else if (match[1] && !/^(?:vork|std|fluid|cloth|blender)\//.test(match[1]))
        throw invalid(`Shader include missing: ${dependency}`);
    }
  };
  const add = (file: string) => {
    file = path.resolve(file);
    if (found.has(file)) return;
    if (!existsSync(file)) throw invalid(`Scene dependency missing: ${file}`);
    if (statSync(file).isDirectory()) {
      for (const child of filesIn(file)) add(child);
      return;
    }
    found.add(file);
    if (found.size > 10000) throw invalid("Scene exceeds 10000 source files; isolate the shot directory");
    if (/\.(?:json|gltf)$/i.test(file)) {
      const document = json(file) as { version?: number; nodes?: unknown };
      // Evidence JSON is opaque. Its file fields need not use scene-relative path semantics.
      if (
        file !== path.resolve(scene) &&
        !file.endsWith(".gltf") &&
        !(document.version === 2 && Array.isArray(document.nodes))
      )
        return;
      const walk = (value: unknown, key = "") => {
        if (Array.isArray(value)) value.forEach((v) => walk(v, key));
        else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
        else if (typeof value === "string" && key === "source") shader(value, path.dirname(file));
        else if (typeof value === "string" && ["file", "font", "uri"].includes(key) && !value.startsWith("data:")) {
          if (/^[a-z]+:\/\//i.test(value)) throw invalid("Scene resources must be local files");
          // Sequence membership is bound before rendering, including every source frame.
          if (/%(?:0\d+)?d/.test(value)) {
            const directory = path.resolve(path.dirname(file), path.dirname(value));
            const escaped = path
              .basename(value)
              .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              .replace(/%0?\d*d/, "\\d+");
            const matches = readdirSync(directory).filter((name) => new RegExp(`^${escaped}$`).test(name));
            if (!matches.length) throw invalid(`Empty image sequence: ${value}`);
            matches.forEach((name) => add(path.join(directory, name)));
          } else add(path.resolve(path.dirname(file), value));
        }
      };
      walk(document);
    } else if (/\.slang$/i.test(file)) {
      shader(readFileSync(file, "utf8"), path.dirname(file));
    }
  };
  add(scene);
  // Inline shaders may import sibling modules; pin the complete author-owned shader tree.
  for (const file of filesIn(path.dirname(scene)).filter((file) => /\.slang$/i.test(file))) add(file);
  extra.forEach(add);
  return [...found].sort();
}
export function verifyPins(pins: Array<{ file: string; sha256: string }>, root: string) {
  for (const pin of pins)
    if (hashFile(path.resolve(root, pin.file)) !== pin.sha256) throw invalid(`Source or output changed: ${pin.file}`);
}
export function readTask(file: string) {
  const task = VorkTaskSchema.parse(json(file));
  return {
    task,
    scene: path.resolve(path.dirname(file), task.scene),
    inputs: task.inputs.map((input) => path.resolve(path.dirname(file), input)),
  };
}
export function assertVorkResult(receiptInput: unknown, hash: string, root: string, production = false) {
  const receipt = VorkReceiptSchema.parse(receiptInput);
  if (!receipt.outputs.some((pin) => pin.sha256 === hash)) throw invalid("Vork receipt does not bind this output");
  if (
    production &&
    (receipt.purpose !== "production" ||
      receipt.warnings.some((warning) => !receipt.acknowledgedWarnings?.some((ack) => ack.code === warning.code)))
  )
    throw invalid("Vork draft or unresolved effect warning is preview-only");
  verifyPins(receipt.inputs, root);
  if (receipt.schemaVersion === 2) {
    const pin = receipt.geometryReceipt;
    if (!receipt.outputs.some((output) => output.file === pin.file && output.sha256 === pin.sha256))
      throw invalid("Hybrid receipt must bind its geometry export receipt");
    const file = path.resolve(root, pin.file);
    if (hashFile(file) !== pin.sha256) throw invalid("Hybrid geometry export receipt changed");
    const geometry = NativeVorkReceiptSchema.parse(json(file));
    if (
      geometry.operation !== "export" ||
      geometry.warnings.length ||
      (production && geometry.purpose !== "production")
    )
      throw invalid("Unsupported or draft hybrid geometry transfer");
    verifyPins(geometry.inputs, root);
    if (
      !geometry.outputs.every((output) =>
        receipt.outputs.some((bound) => output.file === bound.file && output.sha256 === bound.sha256),
      )
    )
      throw invalid("Hybrid receipt does not retain its exported geometry");
  }
  return receipt;
}
export type RenderOptions = {
  scene: string;
  output: string;
  root?: string;
  task?: string;
  executable?: string;
  profile?: string;
  seed?: number;
  fps?: number;
  resolution?: [number, number];
  samples?: number;
  frames?: [number, number];
  purpose?: "draft" | "production";
  channels?: string[];
  format?: "png" | "exr";
  encode?: "h264" | "prores4444";
  timeoutSec?: number;
  dryRun?: boolean;
};
export async function checkScene(scene: string, executable?: string, profile = "std/final") {
  sceneInputs(path.resolve(scene));
  return runProcess(requireVork(executable), ["check", path.resolve(scene), "--profile", profile], { timeoutSec: 600 });
}
export function renderPlan(options: RenderOptions) {
  const scene = path.resolve(options.scene),
    raw = json(scene) as {
      render?: {
        resolution?: number[];
        fps?: number | string;
        duration?: number | string;
        aovs?: Array<{ name: string }>;
      };
    };
  const rational = (value: number | string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value === "number") return value;
    const parts = value.split("/").map(Number);
    return parts.length === 2 ? parts[0]! / parts[1]! : Number(value);
  };
  const fps = options.fps ?? rational(raw.render?.fps, 30),
    duration = rational(raw.render?.duration, 1);
  const frames = options.frames ?? [0, Math.max(0, Math.ceil(duration * fps) - 1)];
  const resolution = options.resolution ?? raw.render?.resolution ?? [640, 360];
  if (
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    frames.some((f) => !Number.isInteger(f) || f < 0) ||
    frames[1]! < frames[0]!
  )
    throw invalid("Invalid FPS, duration or inclusive frame range");
  if (resolution.length !== 2 || resolution.some((n) => !Number.isInteger(n) || n < 16 || n > 16384))
    throw invalid("Resolution must contain two integers from 16 to 16384");
  if (
    options.samples !== undefined &&
    (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 4096)
  )
    throw invalid("Samples must be from 1 to 4096");
  const output = path.resolve(options.output);
  if (output === path.dirname(scene) || path.dirname(scene).startsWith(output + path.sep))
    throw invalid("Output cannot contain scene inputs");
  if (existsSync(output))
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Output exists; choose a fresh run directory" });
  const profile = options.profile ?? "std/final",
    seed = options.seed ?? 42;
  if (
    !["std/previs", "std/draft", "std/final", "std/path"].includes(profile) ||
    !Number.isSafeInteger(seed) ||
    seed < 0
  )
    throw invalid("Unknown profile or invalid seed");
  if (options.encode === "h264" && resolution.some((n) => n % 2)) throw invalid("H.264 requires even dimensions");
  if (options.encode && options.format === "exr")
    throw invalid("EXR is a linear finishing sequence; encode a display-transformed PNG revision");
  const builtins = ["color", "depth", "object_index", "view_normal", "motion", "camera", "shadow_catcher"];
  const channels = [
    ...new Set(
      (options.channels ?? ["color"]).flatMap((channel) =>
        channel === "all" ? [...builtins, ...(raw.render?.aovs ?? []).map((aov) => `aov:${aov.name}`)] : [channel],
      ),
    ),
  ];
  if (!channels.length || channels.some((channel) => !builtins.includes(channel) && !/^aov:[\w-]+$/.test(channel)))
    throw invalid("Unknown output channel");
  const target =
    options.format === "exr" ? path.join(output, "frames", "%06d.exr") : path.join(output, "frames") + path.sep;
  const argv = [
    "render",
    scene,
    "--profile",
    profile,
    "--out",
    target,
    "--frame-start",
    String(frames[0]),
    "--frame-end",
    String(frames[1]),
    "--set",
    `resolution=${resolution.join("x")}`,
    "--set",
    `fps=${fps}`,
    "--set",
    `seed=${seed}`,
    "--diagnostics",
    ...(options.samples === undefined ? [] : ["--set", `samples=${options.samples}`]),
    ...(options.channels ? ["--channels", options.channels.join(",")] : []),
  ];
  return {
    scene,
    output,
    target,
    argv,
    channels,
    settings: {
      profile,
      seed,
      fps,
      resolution: resolution as [number, number],
      frames: frames as [number, number],
      ...(options.samples === undefined ? {} : { samples: options.samples }),
    },
  };
}
function assertFrame(file: string, size: [number, number], format: "png" | "exr") {
  const bytes = readFileSync(file);
  if (format === "exr") {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x01312f76) throw invalid(`Invalid EXR: ${file}`);
    return;
  }
  if (
    bytes.length < 32 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(-8, -4).toString() !== "IEND" ||
    bytes.readUInt32BE(16) !== size[0] ||
    bytes.readUInt32BE(20) !== size[1]
  )
    throw invalid(`Incomplete or wrong-sized PNG: ${file}`);
}
export async function renderVork(options: RenderOptions) {
  const plan = renderPlan(options),
    root = path.resolve(options.root ?? process.cwd());
  const task = options.task ? readTask(options.task) : undefined;
  if (task?.task.renderBackend === "blender-cycles")
    throw invalid(
      "This task requires vork:vfx --action render --request hybrid-job.json; native Vork is not its renderer",
    );
  if (task && path.resolve(task.scene) !== plan.scene) throw invalid("Task scene differs from render scene");
  if (task && options.seed !== undefined && options.seed !== task.task.seed)
    throw invalid("Seed override differs from the authored task; create a new source revision");
  if (task && options.seed === undefined) {
    plan.settings.seed = task.task.seed;
    const index = plan.argv.findIndex((arg) => arg.startsWith("seed="));
    plan.argv[index] = `seed=${task.task.seed}`;
  }
  const inputs = sceneInputs(plan.scene, [...(task?.inputs ?? []), ...(options.task ? [options.task] : [])]).map(
    (file) => relativePin(file, root),
  );
  if (options.dryRun) return { state: "planned", ...plan, inputs };
  const executable = requireVork(options.executable),
    runtime = runtimePins(executable),
    start = Date.now();
  await checkScene(plan.scene, executable, plan.settings.profile);
  mkdirSync(path.join(plan.output, "frames"), { recursive: true });
  await runProcess(executable, plan.argv, {
    log: path.join(plan.output, "render.log"),
    timeoutSec: options.timeoutSec,
  });
  const metadataFile = path.join(plan.output, "frames", "meta.json");
  const metadata = json(metadataFile) as {
    version: number;
    fps: number;
    frames: Array<{ index: number; time: number }>;
    warnings: VorkReceipt["warnings"];
    exposure?: { coverage: number };
    render_settings: { resolution: number[]; samples: number };
  };
  if (
    metadata.version !== 3 ||
    !Array.isArray(metadata.frames) ||
    metadata.frames.length !== plan.settings.frames[1] - plan.settings.frames[0] + 1 ||
    !Array.isArray(metadata.warnings) ||
    metadata.fps !== plan.settings.fps ||
    JSON.stringify(metadata.render_settings?.resolution) !== JSON.stringify(plan.settings.resolution) ||
    metadata.frames.some(
      (frame, index) =>
        frame.index !== index + plan.settings.frames[0] ||
        !Number.isFinite(frame.time) ||
        Math.abs(frame.time - frame.index / plan.settings.fps) > 1e-5,
    )
  )
    throw invalid("Missing, mistimed or incomplete current Vork completion metadata");
  plan.settings.samples = metadata.render_settings.samples;
  if (task)
    for (const input of task.inputs.filter((file) => path.basename(file) === "export-report.json")) {
      const report = json(input) as { omissions?: Array<{ kind: string; detail: string }> };
      for (const omission of report.omissions ?? [])
        metadata.warnings.push({
          code: `blender:${omission.kind}`,
          requested: "source Blender scene",
          dropped: omission.detail,
        });
    }
  const format = options.format ?? "png";
  const colour = plan.channels.includes("color");
  if (plan.channels.includes("camera")) json(path.join(plan.output, "frames", "camera.json"));
  for (let frame = plan.settings.frames[0]; frame <= plan.settings.frames[1]; frame++) {
    if (format === "exr" || colour)
      assertFrame(
        path.join(plan.output, "frames", `${String(frame).padStart(6, "0")}.${format}`),
        plan.settings.resolution,
        format,
      );
    if (format === "png")
      for (const channel of plan.channels.filter((channel) => !["color", "camera"].includes(channel)))
        assertFrame(
          path.join(plan.output, "frames", `${String(frame).padStart(6, "0")}.${channel.replace("aov:", "aov.")}.png`),
          plan.settings.resolution,
          format,
        );
  }
  let video: string | undefined;
  if (options.encode && !colour) throw invalid("Video encoding needs the color channel");
  if (options.encode === "h264" && (metadata.exposure?.coverage ?? 0) < 1)
    throw invalid("H.264 would discard alpha; use ProRes 4444 or retain RGBA frames");
  if (format === "png" && colour) {
    const first = plan.settings.frames[0],
      count = plan.settings.frames[1] - first + 1;
    const input = [
      "-framerate",
      String(plan.settings.fps),
      "-start_number",
      String(first),
      "-i",
      path.join(plan.output, "frames", "%06d.png"),
    ];
    // Review explicitly flattens alpha; production RGBA stays in the PNG/EXR sequence or ProRes.
    const preview = path.join(plan.output, "preview.mp4");
    await runProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        ...input,
        "-frames:v",
        String(count),
        "-vf",
        "scale=640:-2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        preview,
      ],
      { timeoutSec: 600 },
    );
    const info = probeVideo(preview),
      strip = buildStrip(preview, info, {
        startFrame: 0,
        endFrame: info.frameCount - 1,
        step: Math.max(1, Math.floor(count / 12)),
        width: 240,
      });
    writeImage(strip.image, path.join(plan.output, "contact-sheet.png"));
    if (options.encode) {
      video = path.join(plan.output, options.encode === "h264" ? "render.mp4" : "render.mov");
      await runProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          ...input,
          "-frames:v",
          String(count),
          ...(options.encode === "h264"
            ? ["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p"]
            : ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]),
          "-an",
          video,
        ],
        { timeoutSec: 600 },
      );
      if (probeVideo(video).frameCount !== count) throw invalid("Encoded frame count differs from render");
    }
  }
  verifyPins(inputs, root);
  verifyPins(runtime, root);
  const log = readFileSync(path.join(plan.output, "render.log"), "utf8");
  writeNew(path.join(plan.output, "execution.json"), executionIdentity(/backend: (\w+)/.exec(log)?.[1] ?? "unknown"));
  const receipt = VorkReceiptSchema.parse({
    schemaVersion: 1,
    engine: "vork",
    version: VORK_VERSION,
    purpose: options.purpose ?? "draft",
    operation: "render",
    createdAt: new Date().toISOString(),
    root: ".",
    tool: { file: executable, sha256: hashFile(executable) },
    runtime,
    inputs,
    outputs: filesIn(plan.output)
      .filter((file) => !file.endsWith(".log") && !path.basename(file).startsWith("."))
      .map((file) => relativePin(file, root)),
    settings: plan.settings,
    warnings: metadata.warnings,
    ...(task?.task.acknowledgedWarnings ? { acknowledgedWarnings: task.task.acknowledgedWarnings } : {}),
    elapsedMs: Date.now() - start,
    metadata: path.relative(root, metadataFile),
  });
  const receiptFile = writeNew(path.join(plan.output, "vork-receipt.json"), receipt);
  return {
    state: receipt.warnings.some((warning) => !receipt.acknowledgedWarnings?.some((ack) => ack.code === warning.code))
      ? "needs-review"
      : "rendered",
    ...plan,
    video,
    receiptFile,
    receipt,
  };
}

export async function exportVork(
  scene: string,
  output: string,
  options: {
    executable?: string;
    root?: string;
    node?: string;
    allowLosses?: string[];
    dryRun?: boolean;
    purpose?: "draft" | "production";
  } = {},
) {
  const root = path.resolve(options.root ?? process.cwd()),
    destination = path.resolve(output);
  const reportFile = destination.replace(/\.(?:glb|gltf)$/i, ".export.json");
  if (!/\.glb$/i.test(destination)) throw invalid("Geometry export requires a .glb destination");
  if ([destination, reportFile, destination + ".vork-receipt.json"].some(existsSync))
    throw invalid("Geometry output already exists");
  const inputs = sceneInputs(path.resolve(scene)).map((file) => relativePin(file, root));
  const argv = [
    "export",
    path.resolve(scene),
    "--out",
    destination,
    ...(options.node ? ["--root", options.node] : []),
    ...(options.allowLosses ?? []).flatMap((loss) => ["--allow-loss", loss]),
  ];
  if (options.dryRun)
    return { output: destination, report: reportFile, inputs, argv, receiptFile: undefined, receipt: undefined };
  mkdirSync(path.dirname(destination), { recursive: true });
  const executable = requireVork(options.executable);
  const executed = await runProcess(executable, argv);
  verifyPins(inputs, root);
  const report = json(reportFile) as { issues?: Array<{ code: string; dropped: unknown; source: unknown }> };
  const raw = json(scene) as { render?: { fps?: number; resolution?: [number, number] } };
  const receipt = VorkReceiptSchema.parse({
    schemaVersion: 1,
    engine: "vork",
    version: VORK_VERSION,
    purpose: options.purpose ?? "draft",
    operation: "export",
    createdAt: new Date().toISOString(),
    root: ".",
    tool: { file: executable, sha256: hashFile(executable) },
    runtime: runtimePins(executable),
    inputs,
    outputs: [...sceneInputs(destination), reportFile].map((file) => relativePin(file, root)),
    settings: {
      profile: "geometry-export",
      seed: 42,
      fps: typeof raw.render?.fps === "number" ? raw.render.fps : 30,
      resolution: raw.render?.resolution ?? [640, 360],
      frames: [0, 0],
    },
    warnings: (report.issues ?? []).map((issue) => ({
      code: issue.code,
      requested: issue.source,
      dropped: issue.dropped,
    })),
    elapsedMs: executed.elapsedMs,
    metadata: path.relative(root, reportFile),
  });
  const receiptFile = writeNew(destination + ".vork-receipt.json", receipt);
  return { output: destination, report: reportFile, inputs, receiptFile, receipt };
}
