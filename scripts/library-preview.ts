import { attachStillReview } from "../src/lib/vision/review-adapters";
import { FORMAT_SIZE } from "../src/motion/library/types";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { CliErrorObject, emitProgress, ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { categorySheet, compositionId, previewEntry, previewImage } from "../src/lib/library/paths";
import { GL_CHOICES, withComposition } from "../src/lib/vision/composition";
import { BACKGROUND, RgbImage } from "../src/lib/vision/image";
import { composeGrid, type Cell } from "../src/lib/vision/sheets";
import type { LibraryCategory, LibraryItem } from "../src/motion/library/types";
import { AssetMissingError, ensureAssets } from "../src/lib/shared-assets";
import { needsForLibraryItems } from "../src/lib/shared-assets/needs";

const CATEGORIES = [
  "typography",
  "finish",
  "backgrounds",
  "ui",
  "transitions",
  "camera",
  "three",
  "data",
  "scenes",
  "kinetic",
  "effects",
  "captions",
] as const;
const GAP = 4;
const JPEG_QUALITY = "5";
const MOMENTS = [
  { label: "EARLY", at: 0.12 },
  { label: "MID", at: 0.5 },
  { label: "LATE", at: 0.88 },
] as const;

const SPECS = [
  { name: "id", description: "Render one item's sheet" },
  {
    name: "category",
    choices: CATEGORIES,
    description: "Render every item of a category plus its _<category>.jpg overview",
  },
  {
    name: "overview-only",
    type: "boolean",
    description:
      "Render only the late frame of each item and rewrite the _<category>.jpg overviews; item sheets stay as they are",
  },
  { name: "width", type: "number", default: 1200, description: "Sheet width in pixels" },
  { name: "public-dir", default: "public", description: "Public directory served to the compositions" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

type Rendered = { item: LibraryItem; composition: string; frames: number[]; stills: string[] };

function run(binary: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(binary, args, { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `${binary} failed: ${result.error?.message ?? result.stderr?.toString().trim().slice(-600)}`,
    });
  return result.stdout;
}

/** Fits a still inside a tile, letterboxed on the sheet background. */
function loadTile(file: string, width: number, height: number): RgbImage {
  const pad = BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("");
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${pad}`;
  return new RgbImage(
    width,
    height,
    run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]),
  );
}

function writeJpeg(image: RgbImage, output: string): string {
  mkdirSync(path.dirname(output), { recursive: true });
  run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${image.width}x${image.height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-update",
      "1",
      "-q:v",
      JPEG_QUALITY,
      "-y",
      output,
    ],
    image.data,
  );
  return output;
}

const tileWidthFor = (sheetWidth: number, columns: number) =>
  Math.floor((sheetWidth - GAP * 2 - GAP * (columns - 1)) / columns);

function itemSheet({ item, composition, frames, stills }: Rendered, sheetWidth: number): string {
  const format = item.formats[0]!;
  const width = tileWidthFor(sheetWidth, MOMENTS.length);
  const aspect = format === "vertical" ? 16 / 9 : format === "square" ? 1 : 9 / 16;
  const height = Math.round(width * aspect);
  const cells: Cell[] = stills.map((still, index) => ({
    image: loadTile(still, width, height),
    label: `${MOMENTS[index]!.label} F${frames[index]}`,
  }));
  const title = `${item.id} - ${item.title} - ${composition} - ${item.durationInFrames}F`;
  return writeJpeg(composeGrid(cells, { title, columns: MOMENTS.length }), previewImage(item.id));
}

function overviewSheet(category: LibraryCategory, rendered: Rendered[], sheetWidth: number): string {
  const columns = Math.min(4, rendered.length);
  const width = tileWidthFor(sheetWidth, columns);
  const height = Math.round((width * 9) / 16);
  const cells: Cell[] = rendered.map(({ item, stills }) => ({
    image: loadTile(stills.at(-1)!, width, height),
    label: item.id,
    caption: item.title,
  }));
  return writeJpeg(
    composeGrid(cells, { title: `library: ${category} (${rendered.length} items, late frame)`, columns }),
    categorySheet(category),
  );
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.id && args.category)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --id or --category, not both." });
  if (args.id && args["overview-only"])
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--overview-only works on categories; it cannot be combined with --id.",
    });
  const moments = args["overview-only"] ? MOMENTS.slice(-1) : MOMENTS;
  const sheetWidth = args.width!;
  if (!Number.isInteger(sheetWidth) || sheetWidth < 480 || sheetWidth > 3840)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--width must be a whole number between 480 and 3840, got ${sheetWidth}.`,
    });
  ensureFfmpeg();
  const { loadLibrary } = await import("../src/lib/library/load");
  const { items } = await loadLibrary();
  const selected = items.filter((item) =>
    args.id ? item.id === args.id : !args.category || item.category === args.category,
  );
  if (!selected.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: args.id
        ? `Unknown library item "${args.id}". Run library:list to see the ids.`
        : "No library items to render.",
    });

  const failed: Array<{ id: string; error: string }> = [];
  const ready: LibraryItem[] = [];
  for (const item of selected) {
    try {
      if (args["public-dir"] === "public")
        await ensureAssets(needsForLibraryItems([item.id]), { onProgress: emitProgress });
      ready.push(item);
    } catch (error) {
      if (!(error instanceof AssetMissingError)) throw error;
      if (args.id)
        throw new CliErrorObject({
          code: "ASSET_MISSING",
          message: error.message,
          details: { missing: error.missing },
        });
      failed.push({ id: item.id, error: `ASSET_MISSING: ${error.message}` });
    }
  }

  const byEntry = new Map<string, LibraryItem[]>();
  for (const item of ready)
    byEntry.set(previewEntry(item.category), [...(byEntry.get(previewEntry(item.category)) ?? []), item]);

  const stillsDir = mkdtempSync(path.join(tmpdir(), "library-preview-"));
  const rendered: Rendered[] = [];
  const reviews: Array<{ id: string; manifest: string }> = [];
  const reviewOutputs: string[] = [];
  try {
    for (const [entry, group] of byEntry) {
      const first = compositionId(group[0]!.id, group[0]!.formats[0]!);
      await withComposition(
        { entry, composition: first, publicDir: args["public-dir"]!, gl: args.gl! },
        async ({ serveUrl, browser, chromiumOptions }) => {
          for (const item of group) {
            const id = compositionId(item.id, item.formats[0]!);
            try {
              emitProgress(`Rendering ${id}`);
              const composition = await selectComposition({
                serveUrl,
                id,
                inputProps: {},
                puppeteerInstance: browser,
                chromiumOptions,
                logLevel: "error",
              });
              const last = composition.durationInFrames - 1;
              const frames = moments.map(({ at }) => Math.min(last, Math.round(last * at)));
              const stills: string[] = [];
              for (const frame of frames) {
                const output = path.join(stillsDir, `${item.id}-${frame}.png`);
                await renderStill({
                  serveUrl,
                  composition,
                  frame,
                  output,
                  imageFormat: "png",
                  overwrite: true,
                  puppeteerInstance: browser,
                  chromiumOptions,
                  logLevel: "error",
                });
                stills.push(output);
              }
              rendered.push({ item, composition: id, frames, stills });
              if (!args["overview-only"]) {
                const cues = item.cues?.(item.defaultProps) ?? [];
                const detailedFrames = [
                  ...new Set(
                    [0, last, ...frames, ...cues.flatMap((cue) => [cue.frame - 1, cue.frame, cue.frame + 1])].filter(
                      (frame) => frame >= 0 && frame <= last,
                    ),
                  ),
                ].sort((a, b) => a - b);
                const fullStills: Array<{ frame: number; path: string }> = [];
                for (const frame of detailedFrames) {
                  const file = path.join(stillsDir, `${item.id}-review-${frame}.png`);
                  await renderStill({
                    serveUrl,
                    composition,
                    frame,
                    output: file,
                    imageFormat: "png",
                    overwrite: true,
                    puppeteerInstance: browser,
                    chromiumOptions,
                    logLevel: "error",
                  });
                  fullStills.push({ frame, path: file });
                }
                const review = attachStillReview(
                  fullStills,
                  {
                    ...FORMAT_SIZE[item.formats[0]!],
                    fps: composition.fps,
                    frameCount: composition.durationInFrames,
                    durationSec: composition.durationInFrames / composition.fps,
                    hasAudio: false,
                  },
                  path.resolve("out/qa/library", item.id),
                  cues.map((cue) => ({
                    frame: cue.frame,
                    reasons: [`cue ${cue.kind}: ${cue.label ?? ""}; not a settle guarantee`],
                    basis: "declared",
                  })),
                  { composition: id, props: item.defaultProps },
                );
                reviews.push({ id: item.id, manifest: review.reviewPack });
                reviewOutputs.push(...review.outputs);
              }
            } catch (error) {
              failed.push({ id: item.id, error: error instanceof Error ? error.message.slice(0, 400) : String(error) });
            }
          }
        },
      );
    }
    const outputs = args["overview-only"] ? [] : rendered.map((entry) => itemSheet(entry, sheetWidth));
    const categories = args.id ? [] : [...new Set(rendered.map(({ item }) => item.category))];
    for (const category of categories)
      outputs.push(
        overviewSheet(
          category,
          rendered.filter(({ item }) => item.category === category),
          sheetWidth,
        ),
      );
    outputs.push(...reviewOutputs);
    const report = {
      reviews,
      rendered: rendered.map(({ item, composition, frames }) => ({
        id: item.id,
        composition,
        frames,
        ...(args["overview-only"] ? {} : { sheet: previewImage(item.id) }),
      })),
      failed,
    };
    if (failed.length)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `${failed.length} of ${selected.length} item(s) failed to render.`,
        details: { outputs, ...report },
      });
    return { outputs, metadata: report };
  } finally {
    rmSync(stillsDir, { recursive: true, force: true });
  }
});
