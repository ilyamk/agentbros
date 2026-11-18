import { FRAME_ASPECT, FRAME_WIDTH_PX, MAX_UPSCALE } from "../../photo/crop";
import type { StockFormat } from "./types";

/** Output frame size of a format (the same frames photo:focus and photo-move plan for). */
export function frameSize(format: StockFormat): { width: number; height: number } {
  const width = FRAME_WIDTH_PX[format];
  return { width, height: Math.round(width / FRAME_ASPECT[format]) };
}

/**
 * Source pixels a frame needs: `ideal` shows the pushed-in crop without enlargement,
 * `minimum` stops at the house upscale limit (MAX_UPSCALE). Sizes are for a source of the frame's own aspect;
 * any source must at least meet `minimum` on both axes to fill the frame.
 */
export function requiredSourceSize(format: StockFormat, zoom = 1) {
  const frame = frameSize(format);
  const ideal = { width: Math.ceil(frame.width * zoom), height: Math.ceil(frame.height * zoom) };
  return {
    frame,
    ideal,
    minimum: { width: Math.ceil(ideal.width / MAX_UPSCALE), height: Math.ceil(ideal.height / MAX_UPSCALE) },
  };
}

/** Enlargement the frame's fullest crop of this source needs at the given push-in; at most 1 is ideal. */
export function upscaleFor(source: { width?: number; height?: number }, format: StockFormat, zoom = 1) {
  if (!source.width || !source.height) return undefined;
  const aspect = FRAME_ASPECT[format];
  const cropWidth = Math.min(source.width, source.height * aspect);
  return (FRAME_WIDTH_PX[format] * zoom) / cropWidth;
}

export type ResolutionFit = { upscale?: number; status: "ideal" | "acceptable" | "too-small" | "unknown" };
export function resolutionFit(
  source: { width?: number; height?: number },
  format: StockFormat,
  zoom = 1,
): ResolutionFit {
  const upscale = upscaleFor(source, format, zoom);
  if (upscale === undefined) return { status: "unknown" };
  const rounded = Math.round(upscale * 100) / 100;
  return {
    upscale: rounded,
    status: upscale <= 1 ? "ideal" : upscale <= MAX_UPSCALE + 1e-9 ? "acceptable" : "too-small",
  };
}

/** Pixel size to request from a resizing CDN so the frame's crop lands at 1:1, never enlarging the original. */
export function downloadSize(
  source: { width: number; height: number },
  format: StockFormat | undefined,
  zoom = 1,
  longSideCap = 4096,
): { width: number; height: number } {
  let scale: number;
  // A source larger than needed shrinks by exactly its spare factor; a smaller one is never enlarged.
  if (format) scale = Math.min(1, upscaleFor(source, format, zoom) ?? 1);
  else scale = Math.min(1, longSideCap / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

export const orientationFor = (format: StockFormat) =>
  format === "vertical" ? "portrait" : format === "landscape" ? "landscape" : "square";
