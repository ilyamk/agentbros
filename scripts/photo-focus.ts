import { appleFrameDetections } from "../src/lib/apple/detections";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { ensureModel, YUNET } from "../src/lib/multicam/models";
import type { Detections } from "../src/lib/multicam/reframe";
import { runMulticamWorker } from "../src/lib/multicam/worker";
import { MIN_SPEED, type PhotoEasing, type PhotoFormat } from "../src/lib/photo/crop";
import { buildFocus, CANVAS, listPhotos, stagePhoto, unpad, type PhotoInput } from "../src/lib/photo/focus";

const FORMATS = ["vertical", "square", "landscape"] as const;
const SPECS = [
  {
    name: "input",
    required: true,
    description: "A folder of photos (jpg, png, webp; not recursive) or a comma-separated list of files",
  },
  {
    name: "output",
    required: true,
    description:
      "Focus JSON: per photo its displayed size, orientation, face and person boxes, and start and end crops per format",
  },
  { name: "formats", default: FORMATS.join(","), description: "Comma-separated formats to suggest crops for" },
  {
    name: "duration",
    type: "number",
    default: 4,
    description: "Seconds each photo is on screen, for the minimum-speed check",
  },
  {
    name: "easing",
    choices: ["linear", "ease-in", "ease-out", "ease-in-out"],
    default: "linear",
    description: "Easing the photo-move block will use; eased moves need a longer path",
  },
  {
    name: "min-speed",
    type: "number",
    default: MIN_SPEED,
    description: "Slowest motion, share of the frame a second (0.02 measured as never frozen)",
  },
  {
    name: "detector",
    choices: ["opencv", "vision"],
    default: "opencv",
    description: "Explicit detector backend; Vision uses prepared native frame requests",
  },
  {
    name: "detect",
    choices: ["on", "off"],
    default: "on",
    description: "Find faces and people with local YuNet and HOG (free); off suggests centre crops",
  },
  {
    name: "alternate",
    choices: ["on", "off"],
    default: "on",
    description: "Alternate push in and pull out between neighbouring photos",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  const formats = args.formats!.split(",").map((f) => f.trim()) as PhotoFormat[];
  if (!formats.length || formats.some((f) => !FORMATS.includes(f as (typeof FORMATS)[number])))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--formats takes ${FORMATS.join(", ")}; got "${args.formats}"`,
    });
  if (!(args.duration > 0)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--duration must be positive" });
  const { photos, skipped } = listPhotos(args.input!);
  const work = mkdtempSync(path.join(tmpdir(), "photo-focus-"));
  try {
    const staged = photos.map((file, index) => {
      emitProgress(`Reading ${index + 1}/${photos.length}: ${path.basename(file)}`);
      return {
        file,
        ...stagePhoto(
          file,
          path.join(work, `canvas-${String(index).padStart(4, "0")}.jpg`),
          path.join(work, `proxy-${index}.jpg`),
        ),
      };
    });
    let samples = new Map<number, Detections["samples"][number]>();
    if (args.detect === "on" && staged.length && args.detector === "vision") {
      const rows = await appleFrameDetections(
        staged.map((_, index) => ({
          id: String(index),
          file: path.join(work, `canvas-${String(index).padStart(4, "0")}.jpg`),
        })),
      );
      samples = new Map(
        rows.map((row) => [
          Number(row.id),
          { frame: Number(row.id), faces: row.faces ?? [], people: row.people ?? [] },
        ]),
      );
    } else if (args.detect === "on" && staged.length) {
      const video = path.join(work, "canvas.avi");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-framerate",
        "1",
        "-i",
        path.join(work, "canvas-%04d.jpg"),
        "-c:v",
        "mjpeg",
        "-q:v",
        "2",
        video,
      ]);
      const model = await ensureModel(YUNET, "reframe", ".onnx");
      emitProgress(`Detecting faces in ${staged.length} photo(s)`);
      const detections = runMulticamWorker<Detections>("detect", {
        media: video,
        model,
        sampleFps: 1,
        maxWidth: CANVAS,
        faceScore: 0.6,
        personScore: 0.5,
      });
      samples = new Map(detections.samples.map((sample) => [sample.frame, sample]));
    }
    const inputs: PhotoInput[] = staged.map((photo, index) => {
      const sample = samples.get(index);
      return {
        file: photo.file,
        width: photo.width,
        height: photo.height,
        faces: unpad(sample?.faces ?? [], photo.scaledW, photo.scaledH),
        people: unpad(sample?.people ?? [], photo.scaledW, photo.scaledH),
      };
    });
    const focus = buildFocus(inputs, {
      formats,
      durationSec: args.duration,
      easing: args.easing as PhotoEasing,
      minSpeed: args["min-speed"],
      root: process.cwd(),
      alternate: args.alternate === "on",
    });
    const document = {
      schemaVersion: 1,
      detector: args.detect === "on" ? (args.detector === "vision" ? "apple-vision" : YUNET.name) : "off",
      durationSec: args.duration,
      easing: args.easing,
      minSpeed: args["min-speed"],
      photos: focus,
      skipped,
    };
    mkdirSync(path.dirname(path.resolve(args.output!)), { recursive: true });
    writeFileSync(args.output!, `${JSON.stringify(document, null, 2)}\n`);
    return {
      outputs: [args.output!],
      metadata: {
        photos: focus.length,
        withFaces: focus.filter((p) => p.subject === "faces").length,
        blurFill: focus.flatMap((p) =>
          Object.entries(p.formats)
            .filter(([, s]) => s.fill === "blur")
            .map(([format]) => `${path.basename(p.file)}:${format}`),
        ),
        tooSlow: focus.flatMap((p) =>
          Object.entries(p.formats)
            .filter(([, s]) => s.tooSlow)
            .map(([format]) => `${path.basename(p.file)}:${format}`),
        ),
        skipped,
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
