import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CliErrorObject, assertPathWithin, emitProgress } from "../cli";
import { DEFAULT_TIMEOUT_SEC, runBlender, validateBlenderRun, type BlenderRunRequest } from "../backends/blender-run";
import { RgbImage } from "../vision/image";
import { writeImage } from "../vision/media";
import { arsenalPaths } from "./paths";
import { acquirePdb } from "./pdb";
import { determinism, recipeQuality, type ContactRegion } from "./recipe-quality";
import {
  RecipeMetaSchema,
  RecipeProofSchema,
  RecipeStatsSchema,
  type RecipeMeta,
  type RecipeParams,
  type RecipeProof,
} from "./recipe-schema";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const workerDirectory = path.join(root, "scripts/workers/blender");
const renderScript = path.join(root, "scripts/blender/recipes/_render.py");
const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

/** ast.literal_eval reads only META; listing never imports bpy or executes a recipe. */
export function listRecipes(repositoryRoot = root): RecipeMeta[] {
  const code =
    "import sys,json; sys.path.insert(0,sys.argv[1]); from avc_recipes import catalogue; print(json.dumps(catalogue(sys.argv[2])))";
  const result = spawnSync(
    pythonUv(),
    pythonArgs("stdlib", ["-c", code, workerDirectory, arsenalPaths(repositoryRoot).recipes]),
    { env: pythonEnvironment("stdlib"), encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Cannot read recipe META: ${result.error?.message ?? result.stderr.slice(-1000)}`,
    });
  return z.array(RecipeMetaSchema).min(1).parse(JSON.parse(result.stdout));
}
export function findRecipe(id: string, recipes = listRecipes()): RecipeMeta {
  const meta = recipes.find((r) => r.id === id);
  if (!meta) throw invalid(`Unknown recipe: ${id}`);
  return meta;
}
export function validateRecipeParams(meta: RecipeMeta, input: unknown): RecipeParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Recipe params must be a JSON object");
  const params = input as Record<string, unknown>;
  const unknown = Object.keys(params).filter((key) => !Object.hasOwn(meta.params, key));
  if (unknown.length) throw invalid(`Unknown params for ${meta.id}: ${unknown.join(", ")}`);
  const values: RecipeParams = {};
  for (const [name, spec] of Object.entries(meta.params)) {
    const value = Object.hasOwn(params, name) ? params[name] : spec.default;
    const numeric = spec.type === "number" || spec.type === "integer";
    if (
      numeric
        ? typeof value !== "number" || !Number.isFinite(value) || (spec.type === "integer" && !Number.isInteger(value))
        : typeof value !== spec.type
    )
      throw invalid(`${name}: expected ${spec.type}`);
    if (
      typeof value === "number" &&
      ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))
    )
      throw invalid(`${name}: outside bounds`);
    values[name] = value as RecipeParams[string];
  }
  return values;
}
export type RecipeRenderOptions = {
  output: string;
  params?: unknown;
  frames?: [number, number];
  samples?: number;
  resolution?: [number, number];
  bare?: boolean;
  emptyStage?: boolean;
  bake?: boolean;
  engine?: "cycles" | "eevee";
  device?: "cpu" | "auto" | "gpu";
  executable?: string;
  timeoutSec?: number;
  extensions?: string;
};

/** A recipe is a trusted script request on the existing backend, with a worktree-local profile. */
export function recipeRequest(meta: RecipeMeta, options: RecipeRenderOptions): BlenderRunRequest {
  const params = validateRecipeParams(meta, options.params === undefined ? {} : options.params);
  const profile = path.join(arsenalPaths(root).trials, "recipe-profile");
  assertPathWithin(root, profile);
  const request: BlenderRunRequest = {
    extensions:
      options.extensions ?? (meta.requires?.extensions.length ? meta.requires.extensions.join(",") : undefined),
    script: renderScript,
    output: options.output,
    frames: options.bake ? undefined : (options.frames ?? [1, meta.frames_hint]),
    engine: options.engine ?? "cycles",
    samples: options.samples ?? 16,
    resolution: options.resolution ?? [640, 360],
    format: "png",
    device: options.device ?? "cpu",
    factoryStartup: true,
    noRender: options.bake ?? false,
    overwrite: false,
    resume: false,
    scriptArgs: [
      JSON.stringify({ id: meta.id, params, bare: options.bare ?? false, emptyStage: options.emptyStage ?? false }),
    ],
    executable: options.executable,
    timeoutSec: options.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    userResources: profile,
  };
  const frames = request.frames;
  if (
    frames &&
    (!frames.every(Number.isInteger) || frames[0] < 1 || frames[1] < frames[0] || frames[1] > meta.frames_hint)
  )
    throw invalid(`Frames must be an inclusive range within 1-${meta.frames_hint}`);
  if (
    request.resolution &&
    (!request.resolution.every(Number.isInteger) || request.resolution.some((v) => v < 16 || v > 16384))
  )
    throw invalid("Resolution must contain whole dimensions from 16 to 16384");
  validateBlenderRun(request);
  return request;
}
export async function renderRecipe(meta: RecipeMeta, options: RecipeRenderOptions) {
  let structure: Awaited<ReturnType<typeof acquirePdb>> | undefined;
  if (meta.id === "molecule") {
    const params = validateRecipeParams(meta, options.params ?? {});
    if (params.file && params.pdb_id) throw invalid("Choose a local file or a public pdb_id");
    if (params.pdb_id) {
      structure = await acquirePdb(String(params.pdb_id), root);
      options = { ...options, params: { ...params, file: structure.file } };
    }
  }
  const request = recipeRequest(meta, options);
  const result = await runBlender(request);
  const stats = RecipeStatsSchema.parse(
    JSON.parse(readFileSync(path.join(result.output, "recipe-stats.json"), "utf8")),
  );
  const manifest = path.join(result.output, "blender-recipe.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        ...result,
        structure: structure?.receipt,
        recipe: meta,
        params: validateRecipeParams(meta, options.params === undefined ? {} : options.params),
        stats,
      },
      null,
      2,
    ),
  );
  return { ...result, stats, manifest };
}
export function readRecipeFrame(file: string, resolution: [number, number]): RgbImage {
  const [width, height] = resolution;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "1", "pipe:1"],
    { maxBuffer: width * height * 3 + 4096 },
  );
  if (result.error || result.status !== 0 || result.stdout.length !== width * height * 3)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Cannot decode ${file}: ${result.error?.message ?? result.stderr.toString().slice(-300)}`,
    });
  return new RgbImage(width, height, result.stdout);
}
const grounded = new Set([
  "scatter-surface",
  "grow-in",
  "dissolve",
  "cloth-drape",
  "light-sweep",
  "caustics-glass",
  "text-3d",
  "studio-floor",
]);
export type ProofDependencies = {
  render: typeof renderRecipe;
  readFrame: typeof readRecipeFrame;
  sheet: typeof writeImage;
};

/** Re-render the midpoint alone on CPU, compare every range frame with the same empty stage, retain failures. */
export async function proofRecipes(
  recipes: RecipeMeta[],
  options: Omit<RecipeRenderOptions, "params" | "bake" | "emptyStage" | "bare">,
  dependencies: ProofDependencies = { render: renderRecipe, readFrame: readRecipeFrame, sheet: writeImage },
): Promise<RecipeProof> {
  const frames = options.frames ?? [1, 64],
    resolution = options.resolution ?? [640, 360],
    samples = options.samples ?? 16;
  if (frames[1] - frames[0] < 2) throw invalid("Proof needs at least three consecutive frames");
  const output = path.resolve(options.output);
  mkdirSync(output, { recursive: true });
  if (existsSync(path.join(output, "index.json")))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Proof index exists; choose a new output directory to preserve before/after evidence",
    });
  const report: RecipeProof = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    settings: { samples, resolution, frames, engine: options.engine ?? "cycles", device: options.device ?? "cpu" },
    pass: false,
    recipes: [],
    sheet: null,
  };
  const tiles: Array<{ id: string; image: RgbImage }> = [];
  for (const meta of recipes) {
    const entry: RecipeProof["recipes"][number] = { id: meta.id, status: "failed" };
    report.recipes.push(entry);
    emitProgress(`Recipe proof: ${meta.id}`);
    try {
      const directory = path.join(output, meta.id),
        middle = Math.floor((frames[0] + frames[1]) / 2);
      const range = await dependencies.render(meta, {
        ...options,
        output: path.join(directory, "range"),
        frames,
        samples,
        resolution,
      });
      entry.sheet = range.review?.sheet;
      entry.stats = range.stats;
      entry.device = range.render.device;
      entry.blenderVersion = range.render.blenderVersion;
      report.settings.blenderVersion ??= entry.blenderVersion;
      const sameVersion = (...renders: Array<typeof range>) => {
        if (renders.some((render) => render.render.blenderVersion !== report.settings.blenderVersion))
          throw new Error("Blender version changed during proof; use a stable --executable and a fresh output");
      };
      sameVersion(range);
      entry.secondsPerFrame = range.elapsedSec / range.frames.length;
      if (existsSync(range.logFile)) {
        const times = [...readFileSync(range.logFile, "utf8").matchAll(/^AGENTBROS_FRAME \d+ \d+ \d+ ([\d.]+)/gm)];
        if (times.length) entry.renderSecondsPerFrame = Number(times.at(-1)![1]) / range.frames.length;
      }
      const alone = await dependencies.render(meta, {
        ...options,
        output: path.join(directory, "alone"),
        frames: [middle, middle],
        samples,
        resolution,
      });
      const animatedStage = meta.id === "light-sweep" || meta.id === "caustics-glass";
      const baseline = await dependencies.render(meta, {
        ...options,
        output: path.join(directory, "empty"),
        frames: animatedStage ? frames : [middle, middle],
        samples,
        resolution,
        emptyStage: true,
      });
      sameVersion(alone, baseline);
      const images = range.frames.map((f) => dependencies.readFrame(f.path, resolution));
      const baselineImages = baseline.frames.map((f) => dependencies.readFrame(f.path, resolution));
      const empty = animatedStage ? baselineImages : images.map(() => baselineImages[0]!);
      const single = dependencies.readFrame(alone.frames[0]!.path, resolution);
      entry.determinism = determinism(images[middle - frames[0]]!, single, entry.device);
      if (entry.device === "METAL") {
        const cpuRange = await dependencies.render(meta, {
          ...options,
          output: path.join(directory, "cpu-range"),
          frames: [middle - 1, middle + 1],
          samples,
          resolution,
          device: "cpu",
        });
        const cpuAlone = await dependencies.render(meta, {
          ...options,
          output: path.join(directory, "cpu-alone"),
          frames: [middle, middle],
          samples,
          resolution,
          device: "cpu",
        });
        sameVersion(cpuRange, cpuAlone);
        entry.cpuDeterminism = determinism(
          dependencies.readFrame(cpuRange.frames[1]!.path, resolution),
          dependencies.readFrame(cpuAlone.frames[0]!.path, resolution),
        );
      }
      const regionFile = path.join(range.output, "contact-region.json");
      const region = grounded.has(meta.id)
        ? (JSON.parse(readFileSync(regionFile, "utf8")) as ContactRegion)
        : undefined;
      entry.quality = recipeQuality(images, empty, {
        requireActivity: !["studio-floor", "terrain", "sky-atmosphere"].includes(meta.id),
        contactRegion: region,
      });
      if (meta.needs_bake) {
        const reuse = await dependencies.render(meta, {
          ...options,
          output: path.join(directory, "cache-reuse"),
          bake: true,
        });
        sameVersion(reuse);
        entry.cacheReuse = reuse.stats.result.bake;
      }
      const cachePass =
        !meta.needs_bake ||
        (entry.cacheReuse?.reused === true && entry.cacheReuse.path === range.stats.result.bake?.path);
      entry.status =
        entry.quality.pass && entry.determinism.pass && (entry.cpuDeterminism?.pass ?? true) && cachePass
          ? "passed"
          : "failed";
      tiles.push({ id: meta.id, image: images[middle - frames[0]]! });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    // Write after every recipe, including crashes. An interrupted proof never looks successful.
    writeFileSync(path.join(output, "index.json"), JSON.stringify(RecipeProofSchema.parse(report), null, 2));
  }
  if (tiles.length) {
    const columns = Math.min(4, tiles.length),
      [width, height] = resolution;
    const sheet = RgbImage.filled(width * columns, (height + 24) * Math.ceil(tiles.length / columns), [15, 19, 23]);
    tiles.forEach(({ id, image }, i) => {
      const x = (i % columns) * width,
        y = Math.floor(i / columns) * (height + 24);
      sheet.blit(image, x, y);
      sheet.drawText(id, x + 5, y + height + 6, 1);
    });
    report.sheet = dependencies.sheet(sheet, path.join(output, "contact-sheet.png"));
  }
  report.pass = recipes.length > 0 && report.recipes.every((r) => r.status === "passed");
  const parsed = RecipeProofSchema.parse(report);
  writeFileSync(path.join(output, "index.json"), JSON.stringify(parsed, null, 2));
  return parsed;
}
