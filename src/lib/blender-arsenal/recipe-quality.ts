import type { RgbImage } from "../vision/image";
import { RecipeDeterminismSchema, RecipeQualitySchema } from "./recipe-schema";

function assertImage(image: RgbImage): void {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 3
  )
    throw new Error("Expected a non-empty RGB24 image");
}
function sameSize(a: RgbImage, b: RgbImage): void {
  assertImage(a);
  assertImage(b);
  if (a.width !== b.width || a.height !== b.height) throw new Error("Images must have equal dimensions");
}
const luminance = (image: RgbImage, i: number) =>
  0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!;

/** Compare decoded display pixels, never PNG bytes. null PSNR means an exact match (infinite PSNR). */
export function determinism(a: RgbImage, b: RgbImage, device = "CPU") {
  sameSize(a, b);
  let maxAbsDiff = 0,
    squared = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    maxAbsDiff = Math.max(maxAbsDiff, d);
    squared += d * d;
  }
  const psnr = squared ? 10 * Math.log10(255 ** 2 / (squared / a.data.length)) : null;
  const pass = squared === 0 || (device === "METAL" && maxAbsDiff <= 2 && psnr !== null && psnr >= 80);
  return RecipeDeterminismSchema.parse({ exact: squared === 0, pass, maxAbsDiff, psnr });
}
export type ContactRegion = { x: number; y: number; width: number; height: number };

/** Fixed display-space thresholds at proof resolution. An empty-stage render is required for subject coverage. */
export function recipeQuality(
  frames: RgbImage[],
  emptyStage?: RgbImage[],
  options: {
    requireActivity?: boolean;
    requireCoverage?: boolean;
    contactRegion?: ContactRegion;
    frameNumbers?: number[];
  } = {},
) {
  if (!frames.length) throw new Error("At least one proof frame is required");
  if (
    options.frameNumbers &&
    (options.frameNumbers.length !== frames.length ||
      options.frameNumbers.some(
        (frame, i) => !Number.isInteger(frame) || (i > 0 && frame <= options.frameNumbers![i - 1]!),
      ))
  )
    throw new Error("Frame numbers must match images and strictly increase");
  if (emptyStage && frames.length !== emptyStage.length) throw new Error("Baseline must match every proof frame");
  const failures: string[] = [];
  const stats = frames.map((image, index) => {
    assertImage(image);
    if (index) sameSize(frames[0]!, image);
    const base = emptyStage?.[index];
    if (base) sameSize(image, base);
    let sum = 0,
      squared = 0,
      clipped = 0,
      covered = 0,
      darkening = 0,
      contactPixels = 0;
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 3,
          l = luminance(image, i);
        sum += l;
        squared += l * l;
        if (image.data[i] === 255 || image.data[i + 1] === 255 || image.data[i + 2] === 255) clipped++;
        if (base) {
          const diff = Math.max(...[0, 1, 2].map((c) => Math.abs(image.data[i + c]! - base.data[i + c]!)));
          if (diff > 8) covered++;
          const r = options.contactRegion;
          if (r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) {
            darkening += luminance(base, i) - l;
            contactPixels++;
          }
        }
      }
    const pixels = image.width * image.height,
      mean = sum / pixels;
    return {
      mean,
      variance: Math.max(0, squared / pixels - mean ** 2),
      clippedShare: clipped / pixels,
      coverage: base ? covered / pixels : null,
      contactDarkening: contactPixels ? darkening / contactPixels : null,
    };
  });
  // Entrance and exit frames may deliberately contain little subject; judge the most occupied frame.
  if (stats.every((s) => s.mean < 2 || s.mean > 250 || s.variance < 3)) failures.push("empty-or-blank");
  if (stats.some((s) => s.clippedShare >= 0.03)) failures.push("clipped-highlights");
  if (!emptyStage && options.requireCoverage !== false) failures.push("coverage-baseline-missing");
  else if (emptyStage && Math.max(...stats.map((s) => s.coverage ?? 0)) < 0.005) failures.push("subject-coverage");
  const deltas = frames.slice(1).map((image, i) => {
    const before = frames[i]!;
    let sum = 0;
    for (let j = 0; j < image.data.length; j++) sum += Math.abs(image.data[j]! - before.data[j]!);
    return (
      sum / image.data.length / (options.frameNumbers ? options.frameNumbers[i + 1]! - options.frameNumbers[i]! : 1)
    );
  });
  const span = options.frameNumbers ? options.frameNumbers.at(-1)! - options.frameNumbers[0]! : deltas.length;
  const activity =
    deltas.reduce(
      (sum, delta, i) =>
        sum + delta * (options.frameNumbers ? options.frameNumbers[i + 1]! - options.frameNumbers[i]! : 1),
      0,
    ) / Math.max(1, span);
  const peakDelta = Math.max(0, ...deltas);
  const flickerRatios = deltas.map((delta, index) => {
    const neighbours = deltas
      .slice(Math.max(0, index - 3), index + 4)
      .filter((_, i) => i + Math.max(0, index - 3) !== index)
      .sort((a, b) => a - b);
    return delta / Math.max(0.1, neighbours[Math.floor(neighbours.length / 2)] ?? 0);
  });
  const flickerRatio = Math.max(0, ...flickerRatios);
  if (options.requireActivity !== false && (frames.length < 3 || activity <= 0.015))
    failures.push("no-temporal-activity");
  if (deltas.some((delta, index) => delta > 25 || (delta > 3 && flickerRatios[index]! > 12)))
    failures.push("temporal-flicker");
  if (options.contactRegion && !stats.some((s) => (s.contactDarkening ?? 0) > 0.1))
    failures.push("missing-contact-shadow");
  return RecipeQualitySchema.parse({
    pass: failures.length === 0,
    failures,
    frames: stats,
    activity,
    peakDelta,
    flickerRatio,
  });
}
