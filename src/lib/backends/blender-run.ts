import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approvedExtensions, extensionEnvironment } from "../blender-arsenal/extensions";
import { hashFile } from "../assets/registry";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, emitProgress } from "../cli";
import { probeVideo, writeImage } from "../vision/media";
import { buildStrip } from "../vision/sheets";
import { probeBlender, type BlenderProbe } from "./probe";

const worker = fileURLToPath(new URL("../../../scripts/workers/blender/avc_run.py", import.meta.url));
const SHEET_TILES = 24;
const PREVIEW_WIDTH = 640;
export const DEFAULT_TIMEOUT_SEC = 3600;

export type BlenderRunRequest = {
  /** Redirect every Blender profile location to this root when supplied. */
  userResources?: string;
  script?: string;
  blend?: string;
  output: string;
  frames?: [number, number];
  engine?: "cycles" | "eevee";
  samples?: number;
  resolution?: [number, number];
  filmTransparent?: boolean;
  format: "png" | "exr";
  device: "auto" | "cpu" | "gpu";
  encode?: "h264" | "prores4444";
  factoryStartup: boolean;
  noRender: boolean;
  overwrite: boolean;
  resume: boolean;
  extensions?: string;
  scriptArgs: string[];
  executable?: string;
  timeoutSec: number;
};
type WorkerResult = {
  blenderVersion: string;
  engine: string;
  device: string;
  samples: number | null;
  width: number;
  height: number;
  fps: number;
  filmTransparent: boolean;
  viewTransform: string;
  look: string;
  motionBlur: boolean;
  frameStart: number;
  frameEnd: number;
  rendered: boolean;
  extensions?: Array<{ id: string; version: string; enableMs: number }>;
};
export type RenderedFrame = { frame: number; path: string; sha256: string };

const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

export function parseResolution(value: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  const size: [number, number] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (size[0] < 16 || size[1] < 16 || size[0] > 16384 || size[1] > 16384)
    throw invalid(`--resolution must look like 1920x1080; got "${value}".`);
  return size;
}

export function validateBlenderRun(request: BlenderRunRequest): void {
  if (request.extensions !== undefined && !request.factoryStartup)
    throw invalid("--extensions requires --factory-startup.");
  if (!request.script && !request.blend) throw invalid("Provide --script, --blend or both.");
  for (const [flag, file] of [
    ["--script", request.script],
    ["--blend", request.blend],
  ] as const)
    if (file && (!existsSync(file) || !statSync(file).isFile()))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `${flag} not found: ${file}` });
  if (request.overwrite && request.resume) throw invalid("--overwrite and --resume cannot be combined.");
  if (request.samples !== undefined && (!Number.isInteger(request.samples) || request.samples < 1))
    throw invalid("--samples must be a positive whole number.");
  if (!Number.isFinite(request.timeoutSec) || request.timeoutSec <= 0)
    throw invalid("--timeout must be a positive number of seconds.");
  if (request.noRender && (request.encode || request.frames || request.resume || request.overwrite))
    throw invalid("--no-render cannot be combined with --encode, --frames, --resume or --overwrite.");
  if (request.encode && request.format === "exr")
    throw invalid("--encode needs --format png: EXR frames hold linear data for a finishing tool.");
  if (request.encode === "h264" && request.filmTransparent)
    throw invalid("H.264 has no alpha. Use --encode prores4444 or keep the PNG sequence.");
  if (request.encode && request.resolution && (request.resolution[0] % 2 || request.resolution[1] % 2))
    throw invalid("--encode needs even --resolution dimensions.");
}

/** Order matters: factory startup and autoexec must be settled before Blender loads the file. */
export function blenderArguments(
  request: Pick<BlenderRunRequest, "blend" | "factoryStartup" | "scriptArgs" | "extensions">,
): string[] {
  return [
    "--background",
    ...(request.factoryStartup ? ["--factory-startup"] : []),
    "--disable-autoexec",
    "--offline-mode",
    "--python-exit-code",
    "1",
    ...(request.blend && request.extensions === undefined ? [path.resolve(request.blend)] : []),
    "--python",
    worker,
    "--",
    ...request.scriptArgs,
  ];
}

export function resolveBlender(executable?: string, environment?: Record<string, string>): BlenderProbe {
  const probe = probeBlender(
    executable,
    environment
      ? (binary, argv) => {
          const result = spawnSync(binary, argv, { env: environment, encoding: "utf8", timeout: 30000, shell: false });
          return {
            status: result.status,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            error: result.error,
          };
        }
      : undefined,
  );
  if (!probe.available || !probe.path)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No usable Blender: ${probe.reason ?? "not found"}. Ask the user before installing it, or pass --executable.`,
    });
  return probe;
}

function framePath(output: string, frame: number, format: string): string {
  return path.join(output, `frame-${String(frame).padStart(6, "0")}.${format}`);
}

function runProcess(
  executable: string,
  args: string[],
  env: Record<string, string>,
  logFile: string,
  timeoutSec: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile);
    const child = spawn(executable, args, { detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
    let tail = "",
      partial = "",
      timedOut = false;
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutSec * 1000);
    const onSignal = () => {
      kill();
      process.exit(130);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const onData = (data: Buffer) => {
      log.write(data);
      const text = data.toString();
      tail = (tail + text).slice(-4000);
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^AGENTBROS_FRAME (\d+) (\d+) (\d+) ([\d.]+)/.exec(line);
        if (match)
          emitProgress(
            `Blender frame ${match[1]} (${Number(match[1]) - Number(match[2]) + 1}/${Number(match[3]) - Number(match[2]) + 1}, ${match[4]}s)`,
          );
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const finish = (error?: CliErrorObject) => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      log.end(() => {
        if (error) reject(error);
        else resolve();
      });
    };
    child.once("error", (error) =>
      finish(new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Could not start Blender: ${error.message}` })),
    );
    child.once("close", (code, signal) => {
      if (timedOut)
        finish(
          new CliErrorObject({
            code: "TIMEOUT",
            message: `Blender exceeded ${timeoutSec}s and was stopped. Frames written so far remain; use --resume after fixing the budget. Log: ${logFile}`,
          }),
        );
      else if (code !== 0)
        finish(
          new CliErrorObject({
            code: "INTERNAL",
            message: `Blender ${signal ? `crashed (${signal}); the log names its crash report` : `exited with code ${code}`}. Log: ${logFile}\n${tail.slice(-1500)}`,
          }),
        );
      else finish();
    });
  });
}

function readBytes(file: string, bytes: number, position = 0): Buffer {
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const count = readSync(descriptor, buffer, 0, bytes, position);
    return buffer.subarray(0, count);
  } finally {
    closeSync(descriptor);
  }
}

/** A PNG cut short by a killed render fails here; its IEND trailer is missing. */
function assertFrame(file: string, format: string, width: number, height: number): void {
  if (!existsSync(file))
    throw new CliErrorObject({ code: "VALIDATION", message: `Blender reported success but did not write ${file}` });
  const size = statSync(file).size,
    head = readBytes(file, 24);
  if (format === "exr") {
    if (head.length < 4 || head.readUInt32LE(0) !== 0x01312f76)
      throw new CliErrorObject({ code: "VALIDATION", message: `Not an EXR file: ${file}` });
    return;
  }
  const complete = size > 32 && readBytes(file, 4, size - 8).toString("latin1") === "IEND";
  if (head.length < 24 || head.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || !complete)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid or truncated PNG: ${file}. Re-render it with --overwrite.`,
    });
  if (head.readUInt32BE(16) !== width || head.readUInt32BE(20) !== height)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${file} is ${head.readUInt32BE(16)}x${head.readUInt32BE(20)}, expected ${width}x${height}.`,
    });
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", "-nostdin", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg failed: ${result.error?.message ?? result.stderr.slice(-600)}`,
    });
}

const sequenceInput = (output: string, first: number, fps: number, format: string) => [
  "-framerate",
  String(fps),
  "-start_number",
  String(first),
  ...(format === "exr" ? ["-apply_trc", "iec61966_2_1"] : []),
  "-i",
  path.join(output, `frame-%06d.${format}`),
];

/** A small H.264 for the vision tools. Transparent pixels show as mid grey; it never carries alpha. */
function writeReviewMedia(output: string, result: WorkerResult, format: string) {
  const preview = path.join(output, "preview.mp4"),
    sheet = path.join(output, "contact-sheet.png");
  const count = result.frameEnd - result.frameStart + 1;
  const height = 2 * Math.round((PREVIEW_WIDTH * result.height) / result.width / 2);
  const input = sequenceInput(output, result.frameStart, result.fps, format);
  const encoding = ["-frames:v", String(count), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-an", preview];
  if (result.filmTransparent)
    ffmpeg([
      ...input,
      "-f",
      "lavfi",
      "-i",
      `color=c=0x808080:s=${PREVIEW_WIDTH}x${height}:r=${result.fps}`,
      "-filter_complex",
      `[0:v]scale=${PREVIEW_WIDTH}:${height}[fg];[1:v][fg]overlay=shortest=1`,
      ...encoding,
    ]);
  else ffmpeg([...input, "-vf", `scale=${PREVIEW_WIDTH}:${height}`, ...encoding]);
  const info = probeVideo(preview);
  const step = Math.max(1, Math.ceil(count / SHEET_TILES));
  const strip = buildStrip(preview, info, { startFrame: 0, endFrame: info.frameCount - 1, step, width: 320 });
  writeImage(strip.image, sheet);
  return {
    preview,
    sheet,
    sheetWidth: strip.image.width,
    sheetHeight: strip.image.height,
    sheetFrames: strip.frames.map((item) => item.frame + result.frameStart),
  };
}

function encodeVideo(
  output: string,
  result: WorkerResult,
  encode: NonNullable<BlenderRunRequest["encode"]>,
): { path: string; sha256: string; codec: string; alpha: boolean } {
  if (result.width % 2 || result.height % 2)
    throw invalid(`--encode needs even dimensions; the scene renders ${result.width}x${result.height}.`);
  const count = result.frameEnd - result.frameStart + 1;
  const input = sequenceInput(output, result.frameStart, result.fps, "png");
  const frames = ["-frames:v", String(count), "-an"];
  const target = path.join(output, encode === "h264" ? "render.mp4" : "render.mov");
  if (encode === "h264")
    ffmpeg([
      ...input,
      ...frames,
      "-c:v",
      "libx264",
      "-crf",
      "14",
      "-preset",
      "slow",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      target,
    ]);
  else
    ffmpeg([
      ...input,
      ...frames,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      result.filmTransparent ? "yuva444p10le" : "yuv444p10le",
      "-alpha_bits",
      "16",
      "-vendor",
      "apl0",
      target,
    ]);
  const info = probeVideo(target);
  if (info.frameCount !== count)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${target} has ${info.frameCount} frames, expected ${count}.`,
    });
  return {
    path: target,
    sha256: hashFile(target),
    codec: encode,
    alpha: encode === "prores4444" && result.filmTransparent,
  };
}

/** A camera export must be real JSON holding the frames it claims. */
export function readCameraExport(file: string): { frames: number; first: number; last: number } {
  const data = JSON.parse(readFileSync(file, "utf8")) as {
    frameStart: number;
    frameEnd: number;
    frames: Array<{ frame: number; projectionMatrix: number[]; threeMatrixWorld: number[] }>;
  };
  const expected = data.frameEnd - data.frameStart + 1;
  if (
    data.frames.length !== expected ||
    data.frames.some(
      (frame, index) =>
        frame.frame !== data.frameStart + index ||
        frame.projectionMatrix.length !== 16 ||
        frame.threeMatrixWorld.length !== 16,
    )
  )
    throw new CliErrorObject({ code: "VALIDATION", message: `Camera export is inconsistent: ${file}` });
  return { frames: expected, first: data.frameStart, last: data.frameEnd };
}

export function planBlenderRun(request: BlenderRunRequest) {
  validateBlenderRun(request);
  const extensions = approvedExtensions(process.cwd(), request.extensions, !request.noRender);
  const environment = extensionEnvironment();
  const probe = resolveBlender(request.executable, environment);
  return {
    environment,
    ...(request.extensions !== undefined ? { extensions } : {}),
    executable: probe.path!,
    version: probe.version,
    argv: blenderArguments(request),
    output: path.resolve(request.output),
  };
}

export async function runBlender(request: BlenderRunRequest) {
  const started = performance.now();
  const plan = planBlenderRun(request);
  ensureFfmpeg();
  ensureFfprobe();
  const output = plan.output;
  mkdirSync(output, { recursive: true });
  if (request.frames && !request.overwrite && !request.resume)
    for (let frame = request.frames[0]; frame <= request.frames[1]; frame++)
      if (existsSync(framePath(output, frame, request.format)))
        throw new CliErrorObject({
          code: "FILE_EXISTS",
          message: `${framePath(output, frame, request.format)} exists. Use a new --output, --overwrite or --resume.`,
        });
  const logFile = path.join(output, "blender.log");
  const temporary = mkdtempSync(path.join(tmpdir(), "avc-blender-run-"));
  try {
    const resultFile = path.join(temporary, "result.json"),
      requestFile = path.join(temporary, "request.json");
    writeFileSync(
      requestFile,
      JSON.stringify({
        blend: request.blend && request.extensions !== undefined ? path.resolve(request.blend) : undefined,
        script: request.script ? path.resolve(request.script) : undefined,
        output,
        frames: request.frames,
        engine: request.engine,
        samples: request.samples,
        resolution: request.resolution,
        filmTransparent: request.filmTransparent,
        format: request.format,
        device: request.device,
        extensions: plan.extensions,
        noRender: request.noRender,
        resume: request.resume,
        resultFile,
      }),
    );
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!]),
    );
    const custom =
      request.userResources && request.extensions === undefined ? path.resolve(request.userResources) : undefined;
    const isolated = custom
      ? {
          ...blenderProfileEnvironment(custom),
          HOME: custom,
          USERPROFILE: custom,
          XDG_CONFIG_HOME: path.join(custom, "xdg-config"),
          XDG_CACHE_HOME: path.join(custom, "xdg-cache"),
          BLENDER_SYSTEM_EXTENSIONS: path.join(custom, "system-extensions"),
        }
      : {};
    const profile: Record<string, string> = { ...plan.environment, ...isolated };
    for (const [key, directory] of Object.entries(profile))
      if (
        [
          "HOME",
          "USERPROFILE",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "BLENDER_USER_RESOURCES",
          "BLENDER_USER_CONFIG",
          "BLENDER_USER_SCRIPTS",
          "BLENDER_USER_EXTENSIONS",
          "BLENDER_USER_DATAFILES",
          "BLENDER_SYSTEM_EXTENSIONS",
        ].includes(key)
      )
        mkdirSync(directory, { recursive: true });
    await runProcess(
      plan.executable,
      plan.argv,
      { ...env, ...profile, AGENTBROS_BLENDER_REQUEST: requestFile },
      logFile,
      request.timeoutSec,
    );
    if (!existsSync(resultFile))
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Blender exited before the run finished (did the script call sys.exit?). Log: ${logFile}`,
      });
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as WorkerResult;
    const frames: RenderedFrame[] = [];
    if (result.rendered)
      for (let frame = result.frameStart; frame <= result.frameEnd; frame++) {
        const file = framePath(output, frame, request.format);
        assertFrame(file, request.format, result.width, result.height);
        frames.push({ frame, path: file, sha256: hashFile(file) });
      }
    const review = result.rendered ? writeReviewMedia(output, result, request.format) : undefined;
    const encoded = result.rendered && request.encode ? encodeVideo(output, result, request.encode) : undefined;
    const cameraFile = path.join(output, "camera.json");
    const camera = existsSync(cameraFile)
      ? { path: cameraFile, sha256: hashFile(cameraFile), ...readCameraExport(cameraFile) }
      : undefined;
    return {
      output,
      logFile,
      frames,
      review,
      encoded,
      camera,
      ...(plan.extensions ? { extensions: plan.extensions } : {}),
      render: result,
      elapsedSec: Number(((performance.now() - started) / 1000).toFixed(1)),
      executable: plan.executable,
      script: request.script ? { path: path.resolve(request.script), sha256: hashFile(request.script) } : undefined,
      blend: request.blend ? { path: path.resolve(request.blend), sha256: hashFile(request.blend) } : undefined,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Redirect every writable Blender profile location before the application starts. */
export function blenderProfileEnvironment(root: string): Record<string, string> {
  const directory = path.resolve(root);
  return {
    BLENDER_USER_RESOURCES: directory,
    BLENDER_USER_CONFIG: path.join(directory, "config"),
    BLENDER_USER_SCRIPTS: path.join(directory, "scripts"),
    BLENDER_USER_EXTENSIONS: path.join(directory, "extensions"),
    BLENDER_USER_DATAFILES: path.join(directory, "datafiles"),
    BLENDER_SYSTEM_EXTENSIONS: path.join(directory, "system-extensions"),
  };
}
