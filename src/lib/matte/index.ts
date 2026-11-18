import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { defaultEngineDirectory, matteStatus } from "../local-engines/prepare";
import { assetStatus, loadAssets, resolveTarget } from "../shared-assets";
import {
  MatteReceiptSchema,
  type MatteEngine,
  type MatteEngineRequest,
  type MatteKind,
  type MatteReceipt,
} from "../../types/matte";
import { modelName, ONNX_MODEL_ID, selectEngine, type EngineFacts } from "./engine";
import {
  FRAME_PATTERN,
  IMAGE_EXTENSIONS,
  extractImage,
  extractVideoFrames,
  frameName,
  greyFrames,
  greyWriter,
  mergeAlpha,
  pixelFormat,
  probeMedia,
  writeProres,
} from "./io";
import { runOnnxMatte } from "./onnx";
import {
  DEFAULT_TEMPORAL,
  accumulateFlicker,
  blockMeans,
  cellFor,
  coverage as alphaCoverage,
  emptyFlicker,
  flickerReport,
  guidedRefine,
  motionGrid,
  smoothStep,
  type Grid,
} from "./temporal";
import { runVisionMatte, type LocalMatteConfig } from "./vision";

export { selectEngine } from "./engine";

export type MatteOptions = {
  input: string;
  /** Output folder. For an image the cut-out is `<out>/<stem>.png`; for frames `<out>/cutout/frame-%05d.png`. */
  out?: string;
  /** Image only: the exact cut-out path, as `pnpm rmbg --output` takes it. */
  output?: string;
  kind: MatteKind;
  engine: MatteEngineRequest;
  quality: "fast" | "balanced" | "accurate";
  startFrame?: number;
  endFrame?: number;
  maxFrames: number;
  temporal: "ema" | "none";
  strength: number;
  refine: boolean;
  prores: boolean;
  force: boolean;
  engineDirectory?: string;
  threads?: number;
};

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

export function macosMajor(): number | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
  const major = Number.parseInt(result.stdout ?? "", 10);
  return Number.isFinite(major) ? major : undefined;
}

/** What each engine can do on this host, without running a matte. Used by `pnpm matte --probe` and preflight. */
export async function engineFacts(
  options: { engineDirectory?: string; probeVision?: boolean } = {},
): Promise<EngineFacts & { visionConfig?: LocalMatteConfig; onnxModel?: string }> {
  const entry = loadAssets(process.cwd(), ["models"]).find((asset) => asset.id === ONNX_MODEL_ID);
  const state = entry ? assetStatus(entry) : undefined;
  const onnx =
    entry && state?.state === "present"
      ? { available: true }
      : {
          available: false,
          reason: state
            ? `${resolveTarget(entry!.target)} is ${state.state}`
            : `${ONNX_MODEL_ID} is not in the manifest`,
        };
  let vision: EngineFacts["vision"] = { available: false, reason: "not macOS" };
  let visionConfig: LocalMatteConfig | undefined;
  if (process.platform === "darwin" && options.probeVision !== false) {
    const status = await matteStatus(options.engineDirectory ?? defaultEngineDirectory());
    vision = status.available ? { available: true } : { available: false, reason: status.reason };
    if (status.available) visionConfig = status.config;
  }
  return {
    platform: process.platform,
    macosMajor: macosMajor(),
    vision,
    onnx,
    visionConfig,
    onnxModel: entry ? resolveTarget(entry.target) : undefined,
  };
}

type Source = {
  kind: "image" | "video" | "sequence";
  files?: string[];
  width: number;
  height: number;
  fps?: number;
  start: number;
  end: number;
  sha256: string;
};

async function describeInput(options: MatteOptions): Promise<Source> {
  const input = path.resolve(options.input);
  if (!existsSync(input))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Input not found: ${options.input}` });
  if (statSync(input).isDirectory()) {
    const all = readdirSync(input)
      .filter((name) => IMAGE_EXTENSIONS.test(name))
      .sort()
      .map((name) => path.join(input, name));
    if (!all.length) throw new CliErrorObject({ code: "INVALID_INPUT", message: `${options.input} holds no images` });
    const start = options.startFrame ?? 0;
    const end = Math.min(all.length, options.endFrame ?? all.length);
    const files = all.slice(start, end);
    const info = probeMedia(files[0]!);
    const hash = createHash("sha256");
    for (const file of files) hash.update(await sha256File(file));
    return { kind: "sequence", files, width: info.width, height: info.height, start, end, sha256: hash.digest("hex") };
  }
  const info = probeMedia(input);
  const sha256 = await sha256File(input);
  if (IMAGE_EXTENSIONS.test(input))
    return { kind: "image", width: info.width, height: info.height, start: 0, end: 1, sha256 };
  const start = options.startFrame ?? 0;
  const end = options.endFrame ?? info.frames ?? Math.max(start + 1, start + options.maxFrames);
  return { kind: "video", width: info.width, height: info.height, fps: info.fps, start, end, sha256 };
}

/** Repository-relative inside the working directory, absolute outside it. */
const shown = (file: string) => {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
};
const stats = (values: number[]) => ({
  mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
  max: Math.max(0, ...values),
});
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Smooths (and optionally refines) the raw alpha sequence into `alphaDir`, measuring flicker before and after. */
async function temporalPass(
  work: { source: string; raw: string; alpha: string },
  source: Source,
  options: MatteOptions,
) {
  const { width, height, start } = source;
  const frames = source.end - source.start;
  const cell = cellFor(width, height);
  const smooth = options.temporal === "ema" && frames > 1;
  const writer = greyWriter(path.join(work.alpha, FRAME_PATTERN), start, width, height);
  const luma = greyFrames(path.join(work.source, FRAME_PATTERN), start, width, height);
  const raw = greyFrames(path.join(work.raw, FRAME_PATTERN), start, width, height);
  const before = emptyFlicker();
  const after = emptyFlicker();
  let previousGrid: Grid | null = null;
  let previousRaw: Uint8Array | null = null;
  let previousSmooth: Uint8Array | null = null;
  let previousOut: Uint8Array | null = null;
  const coverages: number[] = [];
  for (let index = 0; index < frames; index++) {
    const [l, r] = await Promise.all([luma.next(), raw.next()]);
    if (l.done || r.done)
      throw new CliErrorObject({ code: "INTERNAL", message: `temporal pass ran out of frames at ${start + index}` });
    const grid = blockMeans({ width, height, data: l.value }, cell);
    const motion = previousGrid ? motionGrid(previousGrid, grid) : null;
    const smoothed: Uint8Array = smooth
      ? smoothStep({ width, height, data: r.value }, previousSmooth, motion, { strength: options.strength })
      : r.value;
    const out: Uint8Array = options.refine
      ? guidedRefine({ width, height, data: smoothed }, { width, height, data: l.value })
      : smoothed;
    if (motion && previousRaw && previousOut) {
      accumulateFlicker(before, previousRaw, r.value, motion, width, height);
      accumulateFlicker(after, previousOut, out, motion, width, height, r.value);
    }
    await writer.write(out);
    coverages.push(alphaCoverage(out));
    previousGrid = grid;
    previousRaw = r.value;
    previousSmooth = smoothed;
    previousOut = out;
  }
  await writer.close();
  const pixels = width * height;
  return {
    coverages,
    flickerBefore: frames > 1 ? flickerReport(before, pixels) : undefined,
    flickerAfter: frames > 1 && (smooth || options.refine) ? flickerReport(after, pixels) : undefined,
  };
}

export type MatteResult = { outputs: string[]; receiptFile: string; receipt: MatteReceipt };

export async function runMatte(options: MatteOptions): Promise<MatteResult> {
  const began = Date.now();
  const loadAverage = round(loadavg()[0] ?? 0, 2);
  const source = await describeInput(options);
  if (source.kind === "image" && !options.out && !options.output)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Give --out <dir> (or --output <file.png> for one image)",
    });
  if (source.kind !== "image" && !options.out)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Frames need --out <dir>" });
  if (source.kind !== "image" && options.output)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--output is for one image; use --out <dir> for frames",
    });
  const frames = source.end - source.start;
  if (frames < 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Empty frame range ${source.start}..${source.end}` });
  if (frames > options.maxFrames)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${frames} frames exceed --max-frames ${options.maxFrames}; give --start-frame/--end-frame or raise --max-frames`,
    });

  const facts = await engineFacts({ engineDirectory: options.engineDirectory, probeVision: options.engine !== "onnx" });
  const choice = selectEngine(options.engine, options.kind, facts);
  if (!choice.ok)
    throw new CliErrorObject({ code: choice.code, message: choice.message, details: { fix: choice.fix } });
  const engine: MatteEngine = choice.engine;

  // Output paths.
  const image = source.kind === "image";
  const outDir = path.resolve(options.out ?? path.dirname(options.output!));
  const stem = path.basename(options.input).replace(/\.[^.]+$/, "");
  const cutoutFile = image
    ? path.resolve(options.output ?? path.join(outDir, `${stem}.png`))
    : path.join(outDir, "cutout", FRAME_PATTERN);
  const alphaFile = image
    ? cutoutFile.replace(/\.png$/i, "") + ".alpha.png"
    : path.join(outDir, "alpha", FRAME_PATTERN);
  const receiptFile = image ? cutoutFile.replace(/\.png$/i, "") + ".matte.json" : path.join(outDir, "matte.json");
  const proresFile = options.prores && !image ? path.join(outDir, "cutout.mov") : undefined;
  if (image && !/\.png$/i.test(cutoutFile))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must be a .png (RGBA cut-out)" });
  if (
    !options.force &&
    [image ? cutoutFile : path.join(outDir, "cutout"), receiptFile].some((file) => existsSync(file))
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Output exists in ${outDir}; pass --force to replace it`,
    });

  mkdirSync(outDir, { recursive: true });
  const work = path.join(outDir, `.matte-work-${randomUUID().slice(0, 8)}`);
  const dirs = {
    source: path.join(work, "source"),
    raw: path.join(work, "raw"),
    alpha: image ? work : path.join(outDir, "alpha"),
    cutout: path.join(outDir, "cutout"),
  };
  try {
    for (const dir of [dirs.source, dirs.raw]) mkdirSync(dir, { recursive: true });
    if (!image) {
      rmSync(dirs.alpha, { recursive: true, force: true });
      rmSync(dirs.cutout, { recursive: true, force: true });
      mkdirSync(dirs.alpha, { recursive: true });
      mkdirSync(dirs.cutout, { recursive: true });
    }
    emitProgress(
      `matte: ${frames} frame(s), ${options.kind}, engine ${engine}${choice.ok && choice.fallback ? ` (${choice.fallback})` : ""}`,
    );
    // 1. Source frames as RGB PNGs named by source frame number.
    if (source.kind === "image") extractImage(path.resolve(options.input), path.join(dirs.source, frameName(0)));
    else if (source.kind === "video")
      extractVideoFrames(path.resolve(options.input), dirs.source, source.start, source.end);
    else
      source.files!.forEach((file, index) =>
        extractImage(file, path.join(dirs.source, frameName(source.start + index))),
      );
    const numbers = Array.from({ length: frames }, (_, index) => source.start + index);
    const missing = numbers.filter((frame) => !existsSync(path.join(dirs.source, frameName(frame))));
    if (missing.length)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Source has no frame(s) ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}; the range ends past the clip`,
      });
    const jobs = numbers.map((frame) => ({
      input: path.join(dirs.source, frameName(frame)),
      output: path.join(dirs.raw, frameName(frame)),
    }));

    // 2. The engine.
    const engineStart = Date.now();
    let perFrame: number[] = [];
    let loadMs = 0;
    let runtime = "";
    let engineSha = "";
    let rawCoverage: number[] = [];
    let cpuFallbacks = 0;
    if (engine === "vision") {
      const config = facts.visionConfig!;
      const batch = 32;
      for (let index = 0; index < jobs.length; index += batch) {
        const response = await runVisionMatte(
          { ...config, timeoutMs: config.timeoutMs ?? 600_000 },
          { kind: options.kind, quality: options.quality, frames: jobs.slice(index, index + batch) },
        );
        perFrame.push(...response.frames.map((frame) => frame.ms));
        rawCoverage.push(...response.frames.map((frame) => frame.coverage));
        runtime = `macOS ${response.runtime.osVersion}`;
        cpuFallbacks += response.cpuFallbacks;
        emitProgress(`matte ${Math.min(jobs.length, index + batch)}/${jobs.length}`);
      }
      engineSha = config.executableHash;
      loadMs = Math.max(0, Date.now() - engineStart - perFrame.reduce((sum, ms) => sum + ms, 0));
    } else {
      const response = await runOnnxMatte({ model: facts.onnxModel!, frames: jobs, threads: options.threads });
      perFrame = response.frames.map((frame) => frame.ms);
      rawCoverage = response.frames.map((frame) => frame.coverage);
      loadMs = response.runtime.loadMs;
      runtime = `onnxruntime ${response.runtime.onnxruntime} ${response.runtime.provider}`;
      engineSha = loadAssets(process.cwd(), ["models"]).find((asset) => asset.id === ONNX_MODEL_ID)!.sha256!;
    }

    // 3. Temporal smoothing and edge refine (frames), or the raw alpha as is.
    const temporalStart = Date.now();
    let coverages = rawCoverage;
    let flickerBefore: MatteReceipt["temporal"]["flickerBefore"];
    let flickerAfter: MatteReceipt["temporal"]["flickerAfter"];
    if (!image || options.refine) {
      const pass = await temporalPass({ source: dirs.source, raw: dirs.raw, alpha: dirs.alpha }, source, options);
      coverages = pass.coverages;
      flickerBefore = pass.flickerBefore;
      flickerAfter = pass.flickerAfter;
    } else renameSync(path.join(dirs.raw, frameName(0)), path.join(dirs.alpha, frameName(0)));
    const temporalMs = Date.now() - temporalStart;

    // 4. RGBA cut-outs (and ProRes 4444).
    const outputs: string[] = [];
    if (image) {
      mkdirSync(path.dirname(cutoutFile), { recursive: true });
      mergeAlpha(path.join(dirs.source, frameName(0)), path.join(dirs.alpha, frameName(0)), cutoutFile);
      renameSync(path.join(dirs.alpha, frameName(0)), alphaFile);
      outputs.push(cutoutFile, alphaFile);
    } else {
      mergeAlpha(
        path.join(dirs.source, FRAME_PATTERN),
        path.join(dirs.alpha, FRAME_PATTERN),
        path.join(dirs.cutout, FRAME_PATTERN),
        source.start,
      );
      outputs.push(path.join(dirs.cutout, frameName(source.start)), path.join(dirs.alpha, frameName(source.start)));
      if (proresFile) {
        writeProres(path.join(dirs.cutout, FRAME_PATTERN), source.start, source.fps ?? 30, proresFile);
        const format = pixelFormat(proresFile);
        if (format !== "yuva444p10le" && format !== "yuva444p12le")
          throw new CliErrorObject({ code: "INTERNAL", message: `ProRes 4444 came out as ${format}, without alpha` });
        outputs.push(proresFile);
      }
    }

    const warnings: string[] = [];
    const emptyFrames = numbers.filter((_, index) => rawCoverage[index]! === 0);
    if (cpuFallbacks) warnings.push(`Vision ran ${cpuFallbacks} frame(s) on the CPU: the Neural Engine was busy`);
    if (emptyFrames.length)
      warnings.push(`no subject found in ${emptyFrames.length} frame(s); those cut-outs are fully transparent`);
    if (engine === "onnx" && options.kind === "person")
      warnings.push(
        "onnx has no person-specific model: BiRefNet general segments the salient subject; check that it is the person",
      );
    if (loadAverage > 2 * (await import("node:os")).cpus().length)
      warnings.push(`busy host (load ${loadAverage}): timings are slower than the engine's speed`);
    const receipt = MatteReceiptSchema.parse({
      version: 1,
      createdAt: new Date().toISOString(),
      kind: options.kind,
      requestedEngine: options.engine,
      engine: {
        name: engine,
        model: modelName(engine, options.kind),
        runtime,
        ...(engine === "vision" && options.kind === "person" ? { quality: options.quality } : {}),
        sha256: engineSha,
      },
      ...(choice.fallback ? { fallback: choice.fallback } : {}),
      input: {
        path: shown(path.resolve(options.input)) || options.input,
        sha256: source.sha256,
        kind: source.kind,
        width: source.width,
        height: source.height,
        ...(source.fps ? { fps: round(source.fps, 3) } : {}),
        startFrame: source.start,
        frames,
      },
      outputs: {
        cutout: shown(cutoutFile),
        alpha: shown(alphaFile),
        ...(proresFile ? { prores: shown(proresFile) } : {}),
      },
      timings: {
        totalMs: Date.now() - began,
        loadMs: round(loadMs),
        perFrameMs: { mean: round(stats(perFrame).mean), max: round(stats(perFrame).max) },
        temporalMs,
        loadAverage,
      },
      coverage: {
        mean: round(stats(coverages).mean, 4),
        min: round(Math.min(...coverages), 4),
        max: round(Math.max(...coverages), 4),
        emptyFrames,
      },
      temporal: {
        mode: !image && options.temporal === "ema" && frames > 1 ? "ema" : "none",
        strength: !image && options.temporal === "ema" && frames > 1 ? options.strength : 0,
        refine: options.refine,
        ...(flickerBefore ? { flickerBefore } : {}),
        ...(flickerAfter ? { flickerAfter } : {}),
      },
      warnings,
    });
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
    return { outputs: [...outputs.map((file) => shown(file)), shown(receiptFile)], receiptFile, receipt };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export { DEFAULT_TEMPORAL };
