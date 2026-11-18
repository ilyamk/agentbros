import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VorkPinSchema, VorkReceiptSchema, VorkTaskSchema } from "../../types/vork";
import { determinism, recipeQuality } from "../blender-arsenal/recipe-quality";
import { readRecipeFrame } from "../blender-arsenal/recipes";
import { RgbImage } from "../vision/image";
import { probeVideo } from "../vision/media";
import { assertVorkResult, relativePin, verifyPins } from "./render";
import { digest, hashFile, json, writeNew } from "./runtime";

const criterion = z.string().min(1);
const framing = z
  .object({
    maskFiles: z.array(z.string()).min(1),
    objectIds: z.array(z.number().int().min(0).max(65534)).min(1).default([1]),
    subjects: z.array(z.string().min(1)).min(1).default(["hero"]),
    minimumInset: z.number().min(0.05).max(0.4).default(0.05),
  })
  .strict();
export const QualificationCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    source: z.string().min(1),
    movie: z.string().min(1),
    receipt: z.string().min(1),
    duration: z.number().positive(),
    fps: z.number().positive(),
    resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    criteria: z.array(criterion).min(1),
    requireActivity: z.boolean().default(true),
    repeat: z.object({ receipt: z.string(), frame: z.number().int().nonnegative() }).strict(),
    framing: framing.optional(),
    tracking: z.object({ report: z.string(), plate: z.string(), camera: z.string() }).strict().optional(),
  })
  .strict()
  .refine((row) => new Set(row.criteria).size === row.criteria.length, "Criteria must be unique");
export const QualificationSuiteSchema = z
  .object({ schemaVersion: z.literal(1), cases: z.array(QualificationCaseSchema).min(1) })
  .strict()
  .refine((suite) => new Set(suite.cases.map((row) => row.id)).size === suite.cases.length, "Case IDs must be unique");
export const QualificationReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewer: z.string().min(1),
    order: z.enum(["forward", "reverse"]),
    suiteSha256: z.string().regex(/^[a-f0-9]{64}$/),
    assessments: z
      .array(
        z
          .object({
            id: z.string(),
            movieSha256: z.string().regex(/^[a-f0-9]{64}$/),
            scores: z.record(z.string(), z.number().min(1).max(5)),
            criticalDefects: z.array(z.string()),
            observations: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
type Case = z.infer<typeof QualificationCaseSchema>;
type Review = z.infer<typeof QualificationReviewSchema>;

export function visualQualification(row: Case, movieHash: string, suiteHash: string, reviews: Review[]) {
  const reviewers = new Set(reviews.map((review) => review.reviewer));
  const orders = new Set(reviews.map((review) => review.order));
  const valid =
    reviews.length === 2 &&
    reviewers.size === 2 &&
    orders.size === 2 &&
    reviews.every((review) => {
      if (review.suiteSha256 !== suiteHash) return false;
      const matches = review.assessments.filter((assessment) => assessment.id === row.id);
      const assessment = matches[0];
      return (
        matches.length === 1 &&
        assessment?.movieSha256 === movieHash &&
        assessment.criticalDefects.length === 0 &&
        Object.keys(assessment.scores).length === row.criteria.length &&
        row.criteria.every((key) => (assessment.scores[key] ?? 0) >= 4)
      );
    });
  return {
    pass: valid,
    status: reviews.length ? (valid ? "passed" : "failed") : "pending",
    criteria: row.criteria,
    reviewers: [...reviewers],
    note: "Independent agent assessment; user creative approval remains separate",
  };
}

/** Inspect every full-resolution binary mask, including empty masks and clipped silhouettes. */
export function maskInset(data: Uint8Array, width: number, height: number, minimum = 0.05) {
  if (data.length !== width * height || width < 1 || height < 1) throw new Error("Invalid framing mask dimensions");
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[y * width + x]! >= 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  const inset =
    right < 0
      ? null
      : Math.min(left / width, top / height, (width - 1 - right) / width, (height - 1 - bottom) / height);
  return { pass: inset !== null && inset >= minimum, inset, bounds: [left, top, right, bottom] };
}
function decode(file: string, size: [number, number], grey = false) {
  const run = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      ...(grey ? [] : ["-vf", `scale=${size[0]}:${size[1]}`]),
      "-f",
      "rawvideo",
      "-pix_fmt",
      grey ? "gray" : "rgb24",
      "pipe:1",
    ],
    { maxBuffer: size[0] * size[1] * 4 + 4096, timeout: 30000, shell: false },
  );
  if (run.status !== 0 || run.stdout.length !== size[0] * size[1] * (grey ? 1 : 3))
    throw new Error(`Cannot decode qualification frame: ${file}`);
  return { width: size[0], height: size[1], data: run.stdout };
}
function sourceClock(row: Case, receipt: z.infer<typeof VorkReceiptSchema>, base: string, root: string) {
  const candidates = receipt.inputs
    .filter((pin) => pin.file.endsWith(".json"))
    .map((pin) => ({ file: path.resolve(root, pin.file), document: json(path.resolve(root, pin.file)) }));
  const tasks = candidates.flatMap((item) => {
    const parsed = VorkTaskSchema.safeParse(item.document);
    return parsed.success ? [{ ...item, task: parsed.data }] : [];
  });
  const selected = path.resolve(base, row.source);
  let duration: number, fps: number;
  if (tasks.length) {
    if (tasks.length !== 1 || tasks[0]!.file !== selected)
      throw new Error("Qualification source must identify the single bound shot task");
    const task = tasks[0]!.task;
    const scene = path.resolve(path.dirname(selected), task.scene);
    if (!receipt.inputs.some((pin) => path.resolve(root, pin.file) === scene))
      throw new Error("Shot task scene is not bound to this render");
    duration = task.duration;
    fps = task.fps;
  } else {
    const scenes = candidates.filter((item) => {
      const doc = item.document as { version?: number; nodes?: unknown };
      return doc?.version === 2 && Array.isArray(doc.nodes);
    });
    if (scenes.length !== 1 || scenes[0]!.file !== selected)
      throw new Error("Qualification source must identify the single bound native scene when no shot task exists");
    const scene = scenes[0]!.document as { render?: { duration?: number | string; fps?: number | string } };
    const scalar = (value: number | string | undefined, fallback: number) => {
      if (value === undefined) return fallback;
      if (typeof value === "number") return value;
      const parts = value.split("/").map(Number);
      return parts[0]! / (parts[1] ?? 1);
    };
    duration = scalar(scene.render?.duration, 1);
    fps = scalar(scene.render?.fps, 30);
  }
  if (
    !Number.isFinite(duration) ||
    !Number.isFinite(fps) ||
    Math.abs(duration - row.duration) > 1e-5 ||
    Math.abs(fps - row.fps) > 1e-5
  )
    throw new Error(
      "Qualification duration/FPS differ from the bound source contract; partial renders cannot be relabelled complete",
    );
  return { duration, fps, source: relativePin(selected, root) };
}
function execution(receipt: z.infer<typeof VorkReceiptSchema>, root: string) {
  const pin = receipt.outputs.find((pin) => path.basename(pin.file) === "execution.json");
  if (!pin) throw new Error("Qualification requires a bound execution identity; historical receipts remain importable");
  return z
    .object({ host: z.string(), platform: z.string(), arch: z.string(), osRelease: z.string(), backend: z.string() })
    .strict()
    .parse(json(path.resolve(root, pin.file)));
}
function objectMask(file: string, size: [number, number], ids: number[], native: boolean) {
  const header = readFileSync(file);
  if (
    header.length < 24 ||
    header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    header.readUInt32BE(16) !== size[0] ||
    header.readUInt32BE(20) !== size[1]
  )
    throw new Error("Framing pass raster differs from movie; never resize acceptance masks");
  if (!native) return decode(file, size, true).data;
  if (!file.endsWith(".object_index.png"))
    throw new Error("Native framing requires the bound object_index render pass");
  const run = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray16be", "pipe:1"],
    { maxBuffer: size[0] * size[1] * 2 + 4096, timeout: 30000, shell: false },
  );
  if (run.status !== 0 || run.stdout.length !== size[0] * size[1] * 2) throw new Error("Unreadable object-index pass");
  return Uint8Array.from({ length: size[0] * size[1] }, (_, index) =>
    ids.includes(run.stdout.readUInt16BE(index * 2)) ? 255 : 0,
  );
}
function boundFrames(receiptFile: string, root: string) {
  const receipt = VorkReceiptSchema.parse(json(receiptFile));
  verifyPins(receipt.inputs, root);
  verifyPins(receipt.outputs, root);
  if (!receipt.outputs.some((pin) => path.resolve(root, pin.file) === path.resolve(root, receipt.metadata)))
    throw new Error("Qualification metadata must be bound to the render receipt");
  const offset = receipt.schemaVersion === 2 ? receipt.frameMapping.blenderFirst : 0;
  const files = receipt.outputs
    .map((pin) => path.resolve(root, pin.file))
    .filter((file) =>
      receipt.schemaVersion === 1 ? /\/frames\/\d{6}\.png$/.test(file) : /\/frames\/frame-\d{6}\.png$/.test(file),
    );
  const indexed = files
    .map((file) => ({ file, frame: Number(/(\d{6})\.png$/.exec(file)![1]) - offset }))
    .sort((a, b) => a.frame - b.frame);
  const [first, last] = receipt.settings.frames;
  if (indexed.length !== last - first + 1 || indexed.some((item, i) => item.frame !== first + i))
    throw new Error("Receipt must bind every contiguous rendered PNG frame");
  return { receipt, indexed };
}

/** Qualify existing complete receipts; rendering and visual judgement remain explicit separate operations. */
export function evaluateQualification(input: string, output: string, reviewFiles: string[] = [], root = process.cwd()) {
  input = path.resolve(input);
  output = path.resolve(output);
  if (existsSync(output)) throw new Error("Qualification exists; retain it and choose a fresh directory");
  const suite = QualificationSuiteSchema.parse(json(input)),
    base = path.dirname(input),
    suiteHash = hashFile(input);
  const reviews = reviewFiles.map((file) => QualificationReviewSchema.parse(json(file)));
  const pins = [relativePin(input, root), ...reviewFiles.map((file) => relativePin(file, root))];
  mkdirSync(output, { recursive: true });
  const entries = suite.cases.map((row) => {
    try {
      const resolve = (file: string) => path.resolve(base, file),
        movie = resolve(row.movie),
        receiptFile = resolve(row.receipt);
      const movieHash = hashFile(movie);
      assertVorkResult(json(receiptFile), movieHash, root, true);
      const declared = sourceClock(row, VorkReceiptSchema.parse(json(receiptFile)), base, root);
      const full = boundFrames(receiptFile, root),
        receipt = full.receipt,
        settings = receipt.settings;
      const expected = Math.ceil(row.duration * row.fps),
        probe = probeVideo(movie);
      pins.push(relativePin(movie, root), relativePin(receiptFile, root), ...receipt.inputs, ...receipt.outputs);
      const completion = {
        pass:
          receipt.purpose === "production" &&
          receipt.operation === "render" &&
          settings.frames[0] === 0 &&
          settings.frames[1] === expected - 1 &&
          full.indexed.length === expected &&
          settings.resolution.every((n, i) => n === row.resolution[i]) &&
          Math.abs(settings.fps - row.fps) < 1e-6 &&
          receipt.outputs.some((pin) => path.resolve(root, pin.file) === movie && pin.sha256 === movieHash) &&
          probe.width === row.resolution[0] &&
          probe.height === row.resolution[1] &&
          Math.abs(probe.fps - row.fps) < 0.001 &&
          probe.frameCount === expected &&
          Math.abs(probe.durationSec - expected / row.fps) < 1 / row.fps &&
          row.resolution[0] * row.resolution[1] >= 1920 * 1080,
        expected,
        actual: full.indexed.length,
        declared,
        probe,
      };
      const warnings = {
        pass: receipt.warnings.every((w) => receipt.acknowledgedWarnings?.some((ack) => ack.code === w.code)),
        warnings: receipt.warnings,
      };
      const repeat = boundFrames(resolve(row.repeat.receipt), root);
      pins.push(relativePin(resolve(row.repeat.receipt), root), ...repeat.receipt.inputs, ...repeat.receipt.outputs);
      const frame = full.indexed.find((item) => item.frame === row.repeat.frame),
        isolated = repeat.indexed[0];
      const identity = execution(receipt, root),
        repeatIdentity = execution(repeat.receipt, root);
      const comparable =
        identity.backend !== "unknown" &&
        digest(JSON.stringify(identity)) === digest(JSON.stringify(repeatIdentity)) &&
        digest(JSON.stringify(receipt.runtime)) === digest(JSON.stringify(repeat.receipt.runtime)) &&
        repeat.indexed.length === 1 &&
        isolated?.frame === row.repeat.frame &&
        frame &&
        JSON.stringify({ ...settings, frames: undefined }) ===
          JSON.stringify({ ...repeat.receipt.settings, frames: undefined }) &&
        (receipt.schemaVersion !== 2 ||
          (repeat.receipt.schemaVersion === 2 &&
            JSON.stringify(receipt.frameMapping) === JSON.stringify(repeat.receipt.frameMapping))) &&
        receipt.schemaVersion === repeat.receipt.schemaVersion &&
        receipt.engine === repeat.receipt.engine &&
        receipt.tool.sha256 === repeat.receipt.tool.sha256 &&
        digest(JSON.stringify(receipt.inputs)) === digest(JSON.stringify(repeat.receipt.inputs));
      const repeatability = comparable
        ? determinism(
            readRecipeFrame(frame.file, row.resolution),
            readRecipeFrame(isolated.file, row.resolution),
            identity.backend.toUpperCase() === "METAL" ? "METAL" : "CPU",
          )
        : { pass: false, reason: "Isolated and range inputs/settings/tool must match" };
      const temporal = recipeQuality(
        full.indexed.map((item) => new RgbImage(320, 180, decode(item.file, [320, 180]).data)),
        undefined,
        { requireCoverage: false, requireActivity: row.requireActivity },
      );
      if (
        row.framing &&
        receipt.schemaVersion === 2 &&
        (JSON.stringify(row.framing.objectIds) !== "[1]" || JSON.stringify(row.framing.subjects) !== '["hero"]')
      )
        throw new Error("Hybrid framing uses the declared whole-hero mask at pass index one");
      if (row.framing && receipt.schemaVersion === 1) {
        const metadata = z
          .object({
            object_ids: z.array(
              z.object({
                name: z.string(),
                gltf_node_name: z.string().optional(),
                gltf_node_index: z.number().int().optional(),
                pass_index: z.number().int(),
              }),
            ),
          })
          .parse(json(path.resolve(root, receipt.metadata)));
        const identity = (item: (typeof metadata.object_ids)[number]) =>
          item.gltf_node_name
            ? `${item.name}/${item.gltf_node_name}`
            : item.gltf_node_index !== undefined
              ? `${item.name}/#${item.gltf_node_index}`
              : item.name;
        const declared = metadata.object_ids.filter((item) => row.framing!.subjects.includes(identity(item)));
        const ids = new Set(declared.map((item) => item.pass_index));
        if (
          !row.framing.subjects.every((name) => declared.some((item) => identity(item) === name)) ||
          ids.size !== row.framing.objectIds.length ||
          row.framing.objectIds.some((id) => !ids.has(id))
        )
          throw new Error(
            "Framing IDs must match every primitive of the declared subject names in native render metadata",
          );
      }
      const framingResult = row.framing
        ? {
            pass: row.framing.maskFiles.length === expected,
            frames: row.framing.maskFiles.map((file, index) => {
              const mask = resolve(file);
              if (!receipt.outputs.some((pin) => path.resolve(root, pin.file) === mask))
                throw new Error("Framing masks must be bound to the evaluated render receipt");
              pins.push(relativePin(mask, root));
              const numeric = Number(/(\d+)(?:\.object_index)?\.png$/.exec(mask)?.[1]);
              const offset = receipt.schemaVersion === 2 ? receipt.frameMapping.blenderFirst : 0;
              if (numeric !== index + offset || (receipt.schemaVersion === 2 && !mask.includes("/masks/")))
                throw new Error("Framing pass must match each source frame in order");
              return maskInset(
                objectMask(mask, row.resolution, row.framing!.objectIds, receipt.schemaVersion === 1),
                ...row.resolution,
                row.framing!.minimumInset,
              );
            }),
          }
        : { pass: false, frames: [], reason: "Full-resolution subject masks are required" };
      framingResult.pass &&= framingResult.frames.every((frame) => frame.pass);
      let tracking: { pass: boolean; maximumHeldOutP95Px?: number; reason?: string } = {
        pass: !row.criteria.includes("tracking"),
        reason: "Not applicable unless declared",
      };
      if (row.tracking) {
        const file = resolve(row.tracking.report),
          plate = resolve(row.tracking.plate),
          camera = resolve(row.tracking.camera);
        const report = z
          .object({
            source: z.object({ plateSha256: z.string(), cameraSha256: z.string() }),
            frames: z.array(
              z.object({
                frame: z.number().int(),
                heldOutCount: z.number().int().min(8),
                heldOutP95Px: z.number().finite().nonnegative(),
              }),
            ),
          })
          .parse(json(file));
        if (
          report.source.plateSha256 !== hashFile(plate) ||
          report.source.cameraSha256 !== hashFile(camera) ||
          ![plate, camera].every((file) =>
            receipt.inputs.some((pin) => path.resolve(root, pin.file) === file && pin.sha256 === hashFile(file)),
          )
        )
          throw new Error("Tracking report must bind the evaluated plate and camera inputs");
        pins.push(relativePin(file, root), relativePin(plate, root), relativePin(camera, root));
        tracking = {
          pass:
            report.frames.length === expected &&
            report.frames.every((frame, i) => frame.frame === i && frame.heldOutP95Px <= 2),
          maximumHeldOutP95Px: Math.max(...report.frames.map((frame) => frame.heldOutP95Px)),
        };
      }
      const visual = visualQualification(row, movieHash, suiteHash, reviews);
      const phases = { completion, warnings, repeatability, temporal, framing: framingResult, tracking, visual };
      return {
        id: row.id,
        pass: Object.values(phases).every((phase) => phase.pass),
        phases,
        movie: relativePin(movie, root),
        receipt: relativePin(receiptFile, root),
      };
    } catch (error) {
      return { id: row.id, pass: false, error: String(error) };
    }
  });
  // Recheck pinned bytes after decoding and assessment, rather than trusting an earlier manifest.
  verifyPins(pins, root);
  const report = {
    schemaVersion: 2,
    mode: "qualification",
    generatedAt: new Date().toISOString(),
    suite: relativePin(input, root),
    pass: entries.every((row) => row.pass),
    cases: entries,
    evidence: [...new Map(pins.map((pin) => [pin.file, pin])).values()],
    limitations: [
      "Same-host repeatability only",
      "Automated temporal checks do not replace independent visual assessment",
      "Agent qualification never records user approval",
    ],
  };
  return { file: writeNew(path.join(output, "evaluation.json"), report), report };
}
